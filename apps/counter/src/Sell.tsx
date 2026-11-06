import { useEffect, useMemo, useRef, useState } from 'react';
import { liveQuery } from 'dexie';
import { addItem, formatRupees, paise, setQty, totals, type Cart, type MenuEntry, type Tender } from '@pos/shared';
import { db, type DeviceInfo, type LocalSale } from './db.ts';
import type { MenuView } from './menu.ts';
import { createSale, payOrder, type Actor } from './sale.ts';
import { addToOrder, openOrder, setLineQty, tableMode, tableStates } from './order.ts';
import { useItemImageUrl } from './itemImages.ts';
import { PayDialog } from './PayDialog.tsx';
import { Receipt } from './Receipt.tsx';

const rs = (n: number) => formatRupees(paise(n));
const AUTO_RETURN_MS = 6000;
const POPULAR_COUNT = 6;

function useLive<T>(query: () => Promise<T>, initial: T, deps: unknown[] = []): T {
  const [v, setV] = useState(initial);
  useEffect(() => {
    const sub = liveQuery(query).subscribe({ next: setV, error: (e) => console.error(e) });
    return () => sub.unsubscribe();
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  return v;
}

/** The cached picture, or nothing: a tile without one (or before it has arrived) is just text, as before. */
function ItemPicture({ sha }: { sha: string | null | undefined }) {
  const url = useItemImageUrl(sha);
  return url ? <img src={url} alt="" loading="lazy" decoding="async" width={120} height={120} data-testid="item-picture" /> : null;
}

/** One line as the cart shows it, whether it belongs to a draft cart or to a running order. */
interface ShownLine { key: string; name: string; qty: number; netPaise: number; more: () => void; less: () => void }

export function Sell({ device, actor, menu }: { device: DeviceInfo; actor: Actor; menu: MenuView }) {
  const [cart, setCart] = useState<Cart>([]);          // draft: items not yet on any order (a cafe's pay-now cart)
  const [orderId, setOrderId] = useState<string | null>(null); // the running order being edited, if any
  const [tableId, setTableId] = useState<string | null>(null); // restaurant: the table chosen (its order, or the one to open)
  const [category, setCategory] = useState<string>('all');
  const [filter, setFilter] = useState<string>('');    // '' | 'veg' | 'egg' | 'non_veg' | tag id
  const [q, setQ] = useState('');
  const [message, setMessage] = useState('');
  const [paying, setPaying] = useState<'cash' | 'upi' | null>(null);
  const [mapOpen, setMapOpen] = useState(false);
  const [done, setDone] = useState<LocalSale | null>(null);
  const [popular, setPopular] = useState<string[]>([]);
  const searchRef = useRef<HTMLInputElement>(null);

  const mode = useLive(tableMode, 'default' as 'default' | 'map');
  const states = useLive(tableStates, []);
  const order = useLive(async () => (orderId ? (await db.sales.get(orderId)) ?? null : null), null as LocalSale | null, [orderId]);
  const activeOrder = order && order.status === 'open' ? order : null;
  const defaultTable = states.find((s) => s.table.isDefault)?.table;

  // The items this counter sells most, from its own sales: nothing to maintain, and empty on a new counter.
  useEffect(() => {
    void db.sales.filter((s) => s.status !== 'void').toArray().then((sales) => {
      const count = new Map<string, number>();
      for (const s of sales) for (const l of s.lines) count.set(l.itemId, (count.get(l.itemId) ?? 0) + l.qty);
      setPopular([...count.entries()].sort((a, b) => b[1] - a[1]).slice(0, POPULAR_COUNT).map(([id]) => id));
    });
  }, [done]);

  const draftT = totals(cart, menu.settings);
  const inOrder = activeOrder !== null;
  const subtotal = inOrder ? activeOrder.subtotalPaise : draftT.subtotal;
  const tax = inOrder ? activeOrder.taxPaise : draftT.tax;
  const roundOff = inOrder ? activeOrder.roundOffPaise : draftT.roundOff;
  const total = inOrder ? activeOrder.totalPaise : draftT.total;

  const guard = async (f: () => Promise<void> | void) => {
    try { await f(); setMessage(''); } catch (e) { setMessage(e instanceof Error ? e.message : 'Not allowed.'); }
  };

  const lines: ShownLine[] = inOrder
    ? activeOrder.lines.map((l) => ({
      key: l.lineId ?? l.itemId, name: l.name, qty: l.qty, netPaise: l.netPaise,
      more: () => void guard(async () => { await setLineQty({ device, actor, settings: menu.settings, saleId: activeOrder.id, lineId: l.lineId!, qty: l.qty + 1 }); }),
      less: () => void guard(async () => { await setLineQty({ device, actor, settings: menu.settings, saleId: activeOrder.id, lineId: l.lineId!, qty: l.qty - 1 }); }),
    }))
    : draftT.lines.map((l) => ({
      key: l.itemId, name: l.name, qty: l.qty, netPaise: l.net,
      more: () => void guard(() => { setCart(setQty(cart, l.itemId, l.qty + 1, menu.settings)); }),
      less: () => void guard(() => { setCart(setQty(cart, l.itemId, l.qty - 1, menu.settings)); }),
    }));

  const add = (entry: MenuEntry) => guard(async () => {
    if (inOrder) { await addToOrder({ device, actor, settings: menu.settings, saleId: activeOrder.id, entry }); return; }
    if (mode === 'map') {
      // A restaurant table's order is a running order from its first item.
      if (!tableId) throw new Error('Choose a table first.');
      const sale = await openOrder({ device, actor, settings: menu.settings, menuVersion: menu.menuVersion, tableId, cart: addItem([], entry, 1, menu.settings) });
      setOrderId(sale.id);
      return;
    }
    setCart(addItem(cart, entry, 1, menu.settings));
  });

  /** Parks the draft as an open order on the default table, so the counter can start the next customer. */
  const holdDraft = async (): Promise<boolean> => {
    if (cart.length === 0) return true;
    await openOrder({ device, actor, settings: menu.settings, menuVersion: menu.menuVersion, cart });
    setCart([]);
    return true;
  };
  const hold = () => guard(async () => { await holdDraft(); setOrderId(null); });
  const resume = (id: string) => guard(async () => { await holdDraft(); setOrderId(id); });
  const pickTable = (id: string) => guard(async () => {
    const s = states.find((x) => x.table.id === id);
    setTableId(id);
    setOrderId(s?.orders[0]?.id ?? null);
    setMapOpen(false);
  });
  const clear = () => guard(async () => {
    if (inOrder) {
      for (const l of activeOrder.lines) await setLineQty({ device, actor, settings: menu.settings, saleId: activeOrder.id, lineId: l.lineId!, qty: 0 });
    } else setCart([]);
  });

  const finish = async (tenders: Tender[]) => {
    const sale = inOrder
      ? await payOrder({ device, actor, saleId: activeOrder.id, tenders })
      : await createSale({ device, actor, cart, settings: menu.settings, menuVersion: menu.menuVersion, tenders });
    setCart([]); setOrderId(null); setPaying(null); setQ('');
    setDone(sale);
  };

  // Auto-return: a paid receipt goes back to the Sell screen by itself, so the next customer is one tap away.
  useEffect(() => {
    if (!done?.receiptNo) return;
    const t = setTimeout(() => setDone(null), AUTO_RETURN_MS);
    return () => clearTimeout(t);
  }, [done]);

  // Keep the chosen table in view in the strip (a restaurant can have more tables than fit).
  useEffect(() => {
    document.querySelector('[data-testid="table-strip"] .tbl.cur')?.scrollIntoView?.({ inline: 'center', block: 'nearest' });
  }, [tableId, states.length]);

  // Quick codes (D16): digits only match the code prefix across the whole menu; anything else matches names.
  const byCode = /^\d+$/.test(q);
  const visible = useMemo(() => menu.entries.filter((e) => {
    const x = menu.extras[e.itemId];
    if (byCode) return (x?.code ?? '').startsWith(q);
    if (q) return e.name.toLowerCase().includes(q.toLowerCase());
    if (category !== 'all' && e.categoryId !== category) return false;
    if (!filter) return true;
    return x?.diet === filter || (x?.tagIds ?? []).includes(filter);
  }), [menu, q, byCode, category, filter]);
  const exact = byCode ? menu.entries.filter((e) => menu.extras[e.itemId]?.code === q) : [];
  const exactEntry = exact.length === 1 && exact[0]!.available ? exact[0]! : null;
  const quickAdd = () => { if (!exactEntry) return; void add(exactEntry); setQ(''); searchRef.current?.focus(); };

  const dietMarks = (['veg', 'egg', 'non_veg'] as const).filter((d) => Object.values(menu.extras).some((x) => x.diet === d));
  const showPopular = !q && category === 'all' && !filter;
  const popularEntries = popular.map((id) => menu.entries.find((e) => e.itemId === id)).filter((e): e is MenuEntry => !!e && e.available);

  const tile = (e: MenuEntry, prefix = '') => {
    const x = menu.extras[e.itemId];
    return (
      <button key={prefix + e.itemId} data-testid={`${prefix}item-${e.name}`} className="item" disabled={!e.available} onClick={() => void add(e)}>
        <ItemPicture sha={x?.imageSha256} />
        <span>{e.name}</span>
        {x?.description && <span className="desc" data-testid={`desc-${e.name}`}>{x.description}</span>}
        <small>{e.available ? <>₹{rs(e.pricePaise)}{x?.code && <> · <span className="code" data-testid={`code-${e.name}`}>{x.code}</span></>}</> : 'Sold out'}</small>
      </button>
    );
  };

  const hint = byCode
    ? exactEntry ? `Add ${exactEntry.name}` : exact.length === 1 ? `${exact[0]!.name} is sold out` : visible.length === 1 ? `${visible[0]!.name} is ${menu.extras[visible[0]!.itemId]?.code}` : visible.length ? `${visible.length} items start with ${q}` : 'No such code'
    : '';

  if (done) return <Receipt sale={done} device={device} onClose={() => setDone(null)} />;

  const heldOrders = states.filter((s) => s.table.isDefault).flatMap((s) => s.orders).filter((o) => o.id !== activeOrder?.id);
  const stateOf = (orders: LocalSale[]) => (orders.length ? 'busy' : 'free');
  const shownTableId = tableId ?? defaultTable?.id ?? null;

  return (
    <div className="sell">
      <section className="menu">
        {mode === 'map' ? (
          <div className="strip" data-testid="table-strip">
            <div className="tables">
              {states.map(({ table, orders }) => (
                <button key={table.id} data-testid={`table-${table.code}`} className={`tbl ${stateOf(orders)} ${table.id === shownTableId ? 'cur' : ''}`} onClick={() => void pickTable(table.id)}>
                  <b>{table.code}</b> {orders.length ? `₹${rs(orders.reduce((s, o) => s + o.totalPaise, 0))}` : 'Free'}
                </button>
              ))}
            </div>
            <button data-testid="all-tables" onClick={() => setMapOpen(true)}>⊞ All tables</button>
          </div>
        ) : (
          <div className="strip" data-testid="held-strip">
            <span className="muted">Order on <b>{defaultTable?.code ?? '…'}</b></span>
            <div className="tables">
              {heldOrders.map((o) => (
                <button key={o.id} data-testid="held-order" className="tbl busy" onClick={() => void resume(o.id)}>held · ₹{rs(o.totalPaise)}</button>
              ))}
            </div>
            <button data-testid="hold" disabled={cart.length === 0 && !inOrder} onClick={() => void hold()}>Hold &amp; new</button>
          </div>
        )}
        <div className="srow">
          <input ref={searchRef} className="search" data-testid="search" value={q} onChange={(e) => setQ(e.target.value.trim())} onKeyDown={(e) => { if (e.key === 'Enter') quickAdd(); }}
            placeholder="Search item, or type a code (e.g. 0102)" aria-label="Search item or code" inputMode="search" autoComplete="off" />
          <button className="primary" data-testid="add-code" disabled={!exactEntry} onClick={quickAdd}>Add</button>
        </div>
        <div className="muted hint" data-testid="code-hint">{hint}</div>
        {showPopular && popularEntries.length > 0 && (
          <div data-testid="popular"><h3>Popular</h3><div className="grid pop">{popularEntries.map((e) => tile(e, 'pop-'))}</div></div>
        )}
        <div className="cats">
          <button className={category === 'all' ? 'active' : ''} onClick={() => setCategory('all')}>All</button>
          {menu.categories.map((c) => <button key={c.id} className={category === c.id ? 'active' : ''} onClick={() => setCategory(c.id)}>{c.name}</button>)}
        </div>
        {(dietMarks.length > 0 || menu.tags.length > 0) && (
          <div className="cats" data-testid="filter-row">
            {dietMarks.map((d) => <button key={d} data-testid={`filter-${d}`} className={filter === d ? 'active' : ''} onClick={() => setFilter(filter === d ? '' : d)}>{d === 'non_veg' ? 'Non-veg' : d[0]!.toUpperCase() + d.slice(1)}</button>)}
            {menu.tags.map((t) => <button key={t.id} data-testid={`filter-${t.name}`} className={filter === t.id ? 'active' : ''} onClick={() => setFilter(filter === t.id ? '' : t.id)}>{t.name}</button>)}
          </div>
        )}
        <div className="grid">
          {visible.length === 0 && <p className="muted">{q ? 'No match.' : 'Nothing to sell here yet.'}</p>}
          {visible.map((e) => tile(e))}
        </div>
      </section>
      <aside className="cart">
        <h2>{inOrder ? `Order · ${states.find((s) => s.table.id === activeOrder.tableId)?.table.code ?? ''}` : mode === 'map' && tableId ? `Table ${states.find((s) => s.table.id === tableId)?.table.code ?? ''}` : 'Order'}</h2>
        <ul data-testid="cart-lines">
          {lines.length === 0 && <li className="muted">{mode === 'map' && !tableId ? 'Choose a table' : 'Tap an item to start'}</li>}
          {lines.map((l) => (
            <li key={l.key}>
              <span className="name">{l.name}</span>
              <span className="qty">
                <button aria-label={`less ${l.name}`} onClick={l.less}>−</button>
                <b data-testid={`qty-${l.name}`}>{l.qty}</b>
                <button aria-label={`more ${l.name}`} onClick={l.more}>+</button>
              </span>
              <span className="amt">₹{rs(l.netPaise)}</span>
            </li>
          ))}
        </ul>
        {message && <p className="error" role="alert" data-testid="sell-message">{message}</p>}
        <dl className="sums">
          <dt>Subtotal</dt><dd data-testid="subtotal">₹{rs(subtotal)}</dd>
          {tax > 0 && (<><dt>GST</dt><dd data-testid="tax">₹{rs(tax)}</dd></>)}
          {roundOff !== 0 && (<><dt>Round off</dt><dd data-testid="round-off">{roundOff < 0 ? '−' : '+'}₹{rs(Math.abs(roundOff))}</dd></>)}
          <dt className="total">Total</dt><dd className="total" data-testid="total">₹{rs(total)}</dd>
        </dl>
        {actor.role === 'cashier' && (
          <div className="payrow">
            <button data-testid="pay-cash" className="primary" disabled={lines.length === 0} onClick={() => setPaying('cash')}>Cash ₹{rs(total)}</button>
            <button data-testid="pay-upi" className="primary" disabled={lines.length === 0} onClick={() => setPaying('upi')}>UPI ₹{rs(total)}</button>
          </div>
        )}
        <div className="actions">
          <button data-testid="clear" disabled={lines.length === 0} onClick={() => void clear()}>Clear</button>
          {!inOrder && mode === 'default' && (
            <button data-testid="save-order" disabled={cart.length === 0} onClick={() => void guard(async () => { await holdDraft(); setMessage('Order saved.'); })}>Save order</button>
          )}
        </div>
      </aside>
      {mapOpen && (
        <div className="overlay" role="dialog" aria-label="All tables">
          <div className="dialog wide">
            <div className="row"><h2>All tables</h2><span className="spacer" /><button data-testid="map-close" onClick={() => setMapOpen(false)}>Close</button></div>
            <div className="map" data-testid="table-map">
              {states.map(({ table, orders }) => (
                <button key={table.id} data-testid={`map-${table.code}`} className={`tbl ${stateOf(orders)} ${table.id === shownTableId ? 'cur' : ''}`} onClick={() => void pickTable(table.id)}>
                  {table.code}<small>{orders.length ? `Busy · ₹${rs(orders.reduce((s, o) => s + o.totalPaise, 0))}` : 'Free'}</small>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
      {paying && <PayDialog key={paying} initialMode={paying} total={paise(total)} onCancel={() => setPaying(null)} onConfirm={finish} />}
    </div>
  );
}
