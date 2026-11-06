// Outbox event payloads. Each carries a schema version so an old tablet's queued
// events stay readable after the server learns a new shape (phase 4 ingests them).
import { z } from 'zod';
import { QTY_CAP_MAX } from './settings.ts';

export const EVENT_SCHEMA_VERSION = 1;

const paiseInt = z.number().int().nonnegative();
const uuid = z.string().uuid();

export const SaleLine = z.object({
  itemId: uuid,
  name: z.string().min(1),
  unitPaise: paiseInt,
  gstRateBp: z.number().int().min(0).max(10000),
  qty: z.number().int().min(1).max(QTY_CAP_MAX),
  netPaise: paiseInt,
  taxPaise: paiseInt,
});

export const SaleCreated = z.object({
  type: z.literal('sale.created'),
  schemaVersion: z.literal(EVENT_SCHEMA_VERSION),
  saleId: uuid,
  channel: z.enum(['counter', 'zomato', 'swiggy']),
  createdBy: uuid,
  businessDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  createdAtDevice: z.string().datetime({ offset: true }),
  menuVersion: z.number().int().nonnegative(),
  lines: z.array(SaleLine).min(1),
  subtotalPaise: paiseInt,
  taxPaise: paiseInt,
  roundOffPaise: z.number().int(), // signed bill round-off
  totalPaise: paiseInt.positive(),
}).refine((e) => e.totalPaise === e.subtotalPaise + e.taxPaise + e.roundOffPaise, { message: 'total must equal subtotal + tax + round-off' });

// Schema versions are per event type: an event's version is the version of ITS shape. Types that never changed stay
// at 1, `payment.taken` exists as 1 and 2, and the phase 12 order events start at 2 (PLAN 7.8, N-1: the server keeps
// accepting every version listed here). EVENT_SCHEMA_VERSION is what today's tablet writes for unchanged types.
export const ORDER_SCHEMA_VERSION = 2;
const businessDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const deviceTime = z.string().datetime({ offset: true });

const paymentFields = {
  type: z.literal('payment.taken'),
  saleId: uuid,
  // The cashier's open shift, whose drawer this money went into. Absent only on events from before shifts existed.
  shiftId: uuid.optional(),
  // The date the receipt number was issued on. The sale takes this as its business date at payment,
  // so (device, business date, receipt seq) stays unique even if the order was saved the day before.
  businessDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  receiptNo: z.string().min(1),
  receiptSeq: z.number().int().positive(),
  payments: z
    .array(
      z.object({
        method: z.enum(['cash', 'upi']),
        amountPaise: paiseInt.positive(),
        tenderedPaise: paiseInt.nullable(),
        changePaise: paiseInt,
        upiRef: z.string().nullable(),
      }),
    )
    .min(1),
};

const PaymentTakenV1 = z.object({ ...paymentFields, schemaVersion: z.literal(EVENT_SCHEMA_VERSION) });

// v2 pays for a running order (D15): exactly the lines the cashier saw, at the quantities the cashier saw, for the
// total the cashier charged. The payment wins (decided 2026-11-06): the sale is paid as listed even if another device
// changed or removed one of those lines first; what it held beyond the payment is split off as late lines.
const PaymentTakenV2 = z
  .object({
    ...paymentFields,
    schemaVersion: z.literal(ORDER_SCHEMA_VERSION),
    lines: z
      .array(z.object({ lineId: uuid, qty: z.number().int().min(1).max(QTY_CAP_MAX) }))
      .min(1)
      .refine((ls) => new Set(ls.map((l) => l.lineId)).size === ls.length, { message: 'lines must be unique' }),
    totalPaise: paiseInt.positive(),
  })
  .refine((e) => e.payments.reduce((s, p) => s + p.amountPaise, 0) === e.totalPaise, { message: 'payments must add up to totalPaise' });

export const PaymentTaken = z.discriminatedUnion('schemaVersion', [PaymentTakenV1, PaymentTakenV2]);

// --- Running orders (phase 12, D15): an open sale is the fold of these events, see order.ts.
// Every line event says who did it and when (device clock, kept non-decreasing per device by the tablet): any staff
// member at the outlet may change an open order (D18), and the fold breaks ties between devices by that time.

/** Opens an empty order on a table. Lines arrive as `order.line_added`. */
export const OrderOpened = z.object({
  type: z.literal('order.opened'),
  schemaVersion: z.literal(ORDER_SCHEMA_VERSION),
  saleId: uuid,
  tableId: uuid,
  createdBy: uuid,
  businessDate,
  createdAtDevice: deviceTime,
  menuVersion: z.number().int().nonnegative(),
});

/** `lineId` is a client uuid: a second add with the same lineId is the same line, never a new one. */
export const OrderLineAdded = z.object({
  type: z.literal('order.line_added'),
  schemaVersion: z.literal(ORDER_SCHEMA_VERSION),
  saleId: uuid,
  lineId: uuid,
  itemId: uuid,
  name: z.string().min(1),
  unitPaise: paiseInt,
  gstRateBp: z.number().int().min(0).max(10000),
  qty: z.number().int().min(1).max(QTY_CAP_MAX),
  by: uuid,
  at: deviceTime,
});

/** Sets a line's quantity (absolute, not a delta). Removing a line is `order.line_removed`, never qty 0. */
export const OrderLineChanged = z.object({
  type: z.literal('order.line_changed'),
  schemaVersion: z.literal(ORDER_SCHEMA_VERSION),
  saleId: uuid,
  lineId: uuid,
  qty: z.number().int().min(1).max(QTY_CAP_MAX),
  by: uuid,
  at: deviceTime,
});

/** Soft removal: the line is kept with who removed it and when, so reports can show it. Final. */
export const OrderLineRemoved = z.object({
  type: z.literal('order.line_removed'),
  schemaVersion: z.literal(ORDER_SCHEMA_VERSION),
  saleId: uuid,
  lineId: uuid,
  by: uuid,
  at: deviceTime,
});

/** Moves the order to another table of the same outlet. Informational; the latest move wins. */
export const OrderMoved = z.object({
  type: z.literal('order.moved'),
  schemaVersion: z.literal(ORDER_SCHEMA_VERSION),
  saleId: uuid,
  tableId: uuid,
  by: uuid,
  at: deviceTime,
});

// A copy of a paid receipt was printed again. Reprints are a classic way to hide a cash sale or
// to hand out duplicate bills, so each one is recorded with who and when.
export const PrintReprinted = z.object({
  type: z.literal('print.reprinted'),
  schemaVersion: z.literal(EVENT_SCHEMA_VERSION),
  saleId: uuid,
  reprintedBy: uuid,
  at: z.string().datetime({ offset: true }),
});

// A cashier starts a till session on this device with a counted float.
export const ShiftOpened = z.object({
  type: z.literal('shift.opened'),
  schemaVersion: z.literal(EVENT_SCHEMA_VERSION),
  shiftId: uuid,
  userId: uuid,
  openingCashPaise: paiseInt,
  at: z.string().datetime({ offset: true }),
});

// The cashier's blind count of the drawer. Expected cash and variance are the SERVER's to work out
// from the payments it holds, so the tablet never sends (or shows beforehand) the figure to match.
export const ShiftClosed = z.object({
  type: z.literal('shift.closed'),
  schemaVersion: z.literal(EVENT_SCHEMA_VERSION),
  shiftId: uuid,
  countedCashPaise: paiseInt,
  at: z.string().datetime({ offset: true }),
});

// An order that was never paid, cancelled by the tablet that holds it. Only unpaid orders can be voided
// this way; a paid sale is never undone by a tablet (refunds and manager voids are a separate matter).
export const SaleVoided = z.object({
  type: z.literal('sale.voided'),
  schemaVersion: z.literal(EVENT_SCHEMA_VERSION),
  saleId: uuid,
  reason: z.enum(['abandoned_at_shift_close']),
  at: z.string().datetime({ offset: true }),
});

export const OutboxEvent = z.discriminatedUnion('type', [
  SaleCreated, PaymentTaken, PrintReprinted, ShiftOpened, ShiftClosed, SaleVoided,
  OrderOpened, OrderLineAdded, OrderLineChanged, OrderLineRemoved, OrderMoved,
]);
export const OrderEvent = z.discriminatedUnion('type', [OrderOpened, OrderLineAdded, OrderLineChanged, OrderLineRemoved, OrderMoved]);
export type OrderOpened = z.infer<typeof OrderOpened>;
export type OrderLineAdded = z.infer<typeof OrderLineAdded>;
export type OrderLineChanged = z.infer<typeof OrderLineChanged>;
export type OrderLineRemoved = z.infer<typeof OrderLineRemoved>;
export type OrderMoved = z.infer<typeof OrderMoved>;
export type OrderEvent = z.infer<typeof OrderEvent>;
export type SaleVoided = z.infer<typeof SaleVoided>;
export type ShiftOpened = z.infer<typeof ShiftOpened>;
export type ShiftClosed = z.infer<typeof ShiftClosed>;
export type SaleCreated = z.infer<typeof SaleCreated>;
export type PaymentTaken = z.infer<typeof PaymentTaken>;
export type PrintReprinted = z.infer<typeof PrintReprinted>;
export type OutboxEvent = z.infer<typeof OutboxEvent>;
