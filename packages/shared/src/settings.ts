// Per-tenant trading settings, set by a manager and delivered to tablets by pull
// (type 'tenant_setting'). One zod schema serves the API body and the tablet.
import { z } from 'zod';
import type { GstRounding } from './money.ts';

export const QTY_CAP_MAX = 999;
export const ROUND_OFF_STEPS = [0, 10, 50, 100] as const; // paise; 0 = no bill round-off

export const TradingSettings = z
  .object({
    maxLineQty: z.number().int().min(1).max(QTY_CAP_MAX),
    gstRounding: z.enum(['half_up', 'up', 'down']),
    billRoundTo: z.union([z.literal(0), z.literal(10), z.literal(50), z.literal(100)]),
    offlineDays: z.number().int().min(1).max(60),
  })
  .strict();

export type TradingSettings = Omit<z.infer<typeof TradingSettings>, 'gstRounding'> & { gstRounding: GstRounding };

/** Used until a tenant has saved settings; matches the column defaults in 0004. */
export const DEFAULT_SETTINGS: TradingSettings = { maxLineQty: 99, gstRounding: 'half_up', billRoundTo: 0, offlineDays: 7 };
