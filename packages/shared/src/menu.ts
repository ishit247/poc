// What a counter may sell, and at what price. One implementation, used by the
// server (to validate sales) and the tablet (to draw the menu), so they cannot
// disagree about a price.
import { paise, type Paise } from './money.ts';

export type MenuMode = 'all' | 'listed';

export interface CatalogueItem { id: string; categoryId: string; name: string; sortOrder: number }
export interface ChannelPrice { itemId: string; channel: string; pricePaise: number; gstRateBp: number }
export interface OutletStock { itemId: string; available: boolean }
export interface CounterRule { itemId: string; listed: boolean; pricePaise: number | null }

export interface CounterMenuEntry {
  itemId: string;
  categoryId: string;
  name: string;
  sortOrder: number;
  pricePaise: Paise; // before GST
  gstRateBp: number; // always the item's rate: a counter can change price, never tax
  available: boolean; // outlet stock toggle; absent = available
}

/**
 * Rules:
 *  - An item with no live 'counter' channel price cannot be sold at a counter.
 *  - mode 'all':    shown unless the counter has a rule with listed=false.
 *  - mode 'listed': shown only if the counter has a rule with listed=true.
 *  - A rule's pricePaise (if not null) replaces the counter-channel price here only.
 *  - GST rate is the item's, whatever the counter says.
 */
export function resolveCounterMenu(input: {
  mode: MenuMode;
  items: CatalogueItem[];
  prices: ChannelPrice[];
  stock: OutletStock[];
  rules: CounterRule[];
}): CounterMenuEntry[] {
  const price = new Map(input.prices.filter((p) => p.channel === 'counter').map((p) => [p.itemId, p]));
  const stock = new Map(input.stock.map((s) => [s.itemId, s.available]));
  const rule = new Map(input.rules.map((r) => [r.itemId, r]));

  const out: CounterMenuEntry[] = [];
  for (const it of input.items) {
    const base = price.get(it.id);
    if (!base) continue;
    const r = rule.get(it.id);
    const shown = input.mode === 'listed' ? r?.listed === true : r?.listed !== false;
    if (!shown) continue;
    out.push({
      itemId: it.id,
      categoryId: it.categoryId,
      name: it.name,
      sortOrder: it.sortOrder,
      pricePaise: paise(r?.pricePaise ?? base.pricePaise),
      gstRateBp: base.gstRateBp,
      available: stock.get(it.id) ?? true,
    });
  }
  return out.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
}
