import type pg from 'pg';
import { resolveMenu, type MenuMode } from '@pos/shared';

/** Loads everything the shared resolver needs for one outlet (and optionally one counter). Call inside withTenant. */
export async function resolveForOutlet(
  c: pg.PoolClient,
  outletId: string,
  channel: string,
  counter?: { id: string; mode: MenuMode },
) {
  const outlet = (await c.query('SELECT menu_mode, gst_enabled FROM outlet WHERE id = $1', [outletId])).rows[0] as
    { menu_mode: MenuMode; gst_enabled: boolean } | undefined;
  if (!outlet) return null;
  const [items, prices, rules, oprices, crules] = await Promise.all([
    c.query('SELECT id, category_id AS "categoryId", name, sort_order AS "sortOrder", hsn_code AS "hsnCode" FROM item WHERE deleted_at IS NULL'),
    c.query('SELECT item_id AS "itemId", channel, price_paise::int AS "pricePaise", gst_rate_bp AS "gstRateBp" FROM item_price WHERE deleted_at IS NULL'),
    c.query('SELECT item_id AS "itemId", listed, available FROM outlet_item WHERE outlet_id = $1 AND deleted_at IS NULL', [outletId]),
    c.query('SELECT item_id AS "itemId", channel, price_paise::int AS "pricePaise" FROM outlet_price WHERE outlet_id = $1 AND deleted_at IS NULL', [outletId]),
    counter
      ? c.query('SELECT item_id AS "itemId", listed, price_paise::int AS "pricePaise" FROM counter_item WHERE counter_id = $1 AND deleted_at IS NULL', [counter.id])
      : Promise.resolve({ rows: [] }),
  ]);
  return resolveMenu({
    channel,
    gstEnabled: outlet.gst_enabled,
    items: items.rows,
    prices: prices.rows,
    outlet: { mode: outlet.menu_mode, rules: rules.rows, prices: oprices.rows },
    ...(counter ? { counter: { mode: counter.mode, rules: crules.rows } } : {}),
  });
}
