// What may be sold, where, and at what price. One implementation, used by the
// server (to validate sales) and the tablet (to draw the menu), so they cannot
// disagree about a price.
import { paise, type Paise } from './money.ts';

export type MenuMode = 'all' | 'listed';

export interface CatalogueItem { id: string; categoryId: string; name: string; sortOrder: number; hsnCode?: string | null }
export interface ChannelPrice { itemId: string; channel: string; pricePaise: number; gstRateBp: number }
/** listed: the manager's choice, or null = no opinion (e.g. the row only records a stock toggle). */
export interface OutletRule { itemId: string; listed: boolean | null; available: boolean }
export interface OutletPriceOverride { itemId: string; channel: string; pricePaise: number }
export interface CounterRule { itemId: string; listed: boolean; pricePaise: number | null }

export interface MenuEntry {
  itemId: string;
  categoryId: string;
  name: string;
  sortOrder: number;
  hsnCode: string | null;
  pricePaise: Paise; // before GST
  gstRateBp: number; // item's rate, or 0 when the outlet is not GST-enabled
  available: boolean; // outlet stock toggle; absent = available
}

const shown = (mode: MenuMode, listed: boolean | null | undefined) => (mode === 'listed' ? listed === true : listed !== false);

/**
 * Rules, applied in this order:
 *  1. An item with no live catalogue price for `channel` cannot be sold on it.
 *  2. Outlet visibility: mode 'all' hides items with listed=false; mode 'listed' shows only listed=true.
 *  3. Counter visibility (counter channel only), same rule, can only NARROW what the outlet shows.
 *  4. Price: counter override (counter channel only) > outlet override for this channel > catalogue.
 *     An override of 0 is a real price. No override can make an unpriced item sellable.
 *  5. GST rate is the item's, and 0 if the outlet is not GST-enabled. Overrides never change tax.
 */
export function resolveMenu(input: {
  channel: string;
  gstEnabled: boolean;
  items: CatalogueItem[];
  prices: ChannelPrice[];
  outlet: { mode: MenuMode; rules: OutletRule[]; prices: OutletPriceOverride[] };
  counter?: { mode: MenuMode; rules: CounterRule[] };
}): MenuEntry[] {
  const { channel } = input;
  const base = new Map(input.prices.filter((p) => p.channel === channel).map((p) => [p.itemId, p]));
  const outletRule = new Map(input.outlet.rules.map((r) => [r.itemId, r]));
  const outletPrice = new Map(input.outlet.prices.filter((p) => p.channel === channel).map((p) => [p.itemId, p.pricePaise]));
  const counter = channel === 'counter' ? input.counter : undefined;
  const counterRule = new Map((counter?.rules ?? []).map((r) => [r.itemId, r]));

  const out: MenuEntry[] = [];
  for (const it of input.items) {
    const catalogue = base.get(it.id);
    if (!catalogue) continue;
    if (!shown(input.outlet.mode, outletRule.get(it.id)?.listed)) continue;
    const cr = counterRule.get(it.id);
    if (counter && !shown(counter.mode, cr?.listed)) continue;
    out.push({
      itemId: it.id,
      categoryId: it.categoryId,
      name: it.name,
      sortOrder: it.sortOrder,
      hsnCode: it.hsnCode ?? null,
      pricePaise: paise(cr?.pricePaise ?? outletPrice.get(it.id) ?? catalogue.pricePaise),
      gstRateBp: input.gstEnabled ? catalogue.gstRateBp : 0,
      available: outletRule.get(it.id)?.available ?? true,
    });
  }
  return out.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
}
