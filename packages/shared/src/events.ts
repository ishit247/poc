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

export const PaymentTaken = z.object({
  type: z.literal('payment.taken'),
  schemaVersion: z.literal(EVENT_SCHEMA_VERSION),
  saleId: uuid,
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
});

export const OutboxEvent = z.discriminatedUnion('type', [SaleCreated, PaymentTaken]);
export type SaleCreated = z.infer<typeof SaleCreated>;
export type PaymentTaken = z.infer<typeof PaymentTaken>;
export type OutboxEvent = z.infer<typeof OutboxEvent>;
