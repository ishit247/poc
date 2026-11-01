import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

// The adapter boundary (PLAN 11). NOTHING HERE IS VERIFIED AGAINST A REAL PLATFORM: there is no partner access yet,
// so the payload shape and the signature scheme below are our own placeholders. When a platform's documentation
// arrives, change only `parseInbound`, `storeIdOf`, `verifySignature` and the sender for that platform.

export type Channel = 'zomato' | 'swiggy';

export type NormalisedOrder = {
  externalOrderId: string;
  customerLabel?: string;
  deliveryNote?: string;
  lines: { externalItemId: string; name: string; qty: number; unitPaise: number }[];
};

export interface OrderProvider {
  id: Channel;
  /** Which outlet the platform says this is for. Read before the signature is checked, so trust nothing but the lookup key. */
  storeIdOf(raw: unknown): string | null;
  parseInbound(raw: unknown): NormalisedOrder;
  verifySignature(secret: string, timestamp: string, rawBody: string, signature: string, nowMs?: number): boolean;
}

/** A timestamp older or newer than this is refused, so a captured request cannot be replayed later. */
export const MAX_SKEW_MS = 5 * 60_000;

/** ASSUMED scheme: hex HMAC-SHA256 over `${unix seconds}.${raw body}` with the outlet's webhook secret. */
export function sign(secret: string, timestamp: string, rawBody: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
}

function verify(secret: string, timestamp: string, rawBody: string, signature: string, nowMs = Date.now()): boolean {
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowMs - ts * 1000) > MAX_SKEW_MS) return false;
  const want = Buffer.from(sign(secret, timestamp, rawBody), 'hex');
  const got = Buffer.from(signature, 'hex');
  return got.length === want.length && timingSafeEqual(got, want);
}

// ASSUMED payload; money in integer paise.
const inbound = z.object({
  store_id: z.string().min(1).max(64),
  order_id: z.string().trim().min(1).max(64),
  customer_label: z.string().trim().max(120).optional(),
  delivery_note: z.string().trim().max(300).optional(),
  lines: z.array(z.object({
    item_id: z.string().min(1).max(64),
    name: z.string().max(120).default(''),
    qty: z.number().int().min(1).max(99),
    unit_price_paise: z.number().int().min(0).max(100_000_000),
  })).min(1).max(50),
});

function adapter(id: Channel): OrderProvider {
  return {
    id,
    storeIdOf(raw) {
      const s = z.object({ store_id: z.string().min(1).max(64) }).safeParse(raw);
      return s.success ? s.data.store_id : null;
    },
    parseInbound(raw) {
      const p = inbound.parse(raw);
      return {
        externalOrderId: p.order_id,
        customerLabel: p.customer_label,
        deliveryNote: p.delivery_note,
        lines: p.lines.map((l) => ({ externalItemId: l.item_id, name: l.name, qty: l.qty, unitPaise: l.unit_price_paise })),
      };
    },
    verifySignature: verify,
  };
}

export const providers: Record<Channel, OrderProvider> = { zomato: adapter('zomato'), swiggy: adapter('swiggy') };
