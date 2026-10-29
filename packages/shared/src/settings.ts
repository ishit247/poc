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

export const LOGO_MAX_BYTES = 256 * 1024;
export const LOGO_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export type LogoType = (typeof LOGO_TYPES)[number];

/** The image's real type from its first bytes, or null. A declared Content-Type is never trusted on its own. */
export function sniffLogo(b: Uint8Array): LogoType | null {
  const at = (i: number, ...v: number[]) => v.every((x, k) => b[i + k] === x);
  if (b.length > 8 && at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (b.length > 3 && at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (b.length > 12 && at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'image/webp';
  return null;
}
