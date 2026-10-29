// Builds the sellable menu from the pulled rows, with the same resolveMenu() the server uses.
import { DEFAULT_SETTINGS, resolveMenu, type MenuEntry, type TradingSettings } from '@pos/shared';
import { db, getMeta } from './db.ts';

export interface MenuView {
  categories: { id: string; name: string; sortOrder: number }[];
  entries: MenuEntry[];
  settings: TradingSettings;
  menuVersion: number;
  staff: { id: string; name: string; role: 'cashier' | 'waiter'; pinVerifier: string }[];
}

export async function loadMenu(): Promise<MenuView> {
  const rows = await db.entities.toArray();
  const of = (type: string) => rows.filter((r) => r.type === type);
  const outlet = of('outlet')[0]?.data;
  const counter = of('counter')[0]?.data;
  const entries = resolveMenu({
    channel: 'counter',
    gstEnabled: outlet?.gstEnabled === true,
    items: of('item').map((r) => ({ id: r.id, categoryId: r.data.categoryId, name: r.data.name, sortOrder: r.data.sortOrder, hsnCode: r.data.hsnCode })),
    prices: of('item_price').map((r) => ({ itemId: r.data.itemId, channel: r.data.channel, pricePaise: r.data.pricePaise, gstRateBp: r.data.gstRateBp })),
    outlet: {
      mode: outlet?.menuMode ?? 'all',
      rules: of('outlet_item').map((r) => ({ itemId: r.id, listed: r.data.listed, available: r.data.available })),
      prices: of('outlet_price').map((r) => ({ itemId: r.data.itemId, channel: r.data.channel, pricePaise: r.data.pricePaise })),
    },
    counter: { mode: counter?.menuMode ?? 'all', rules: of('counter_item').map((r) => ({ itemId: r.id, listed: r.data.listed, pricePaise: r.data.pricePaise })) },
  });
  return {
    categories: of('category').map((r) => ({ id: r.id, name: r.data.name, sortOrder: r.data.sortOrder })).sort((a, b) => a.sortOrder - b.sortOrder),
    entries,
    settings: { ...DEFAULT_SETTINGS, ...(of('tenant_setting')[0]?.data as Partial<TradingSettings> | undefined) },
    menuVersion: (await getMeta('cursor')) ?? 0,
    staff: of('user').map((r) => ({ id: r.id, name: r.data.name, role: r.data.role, pinVerifier: r.data.pinVerifier })).sort((a, b) => a.name.localeCompare(b.name)),
  };
}
