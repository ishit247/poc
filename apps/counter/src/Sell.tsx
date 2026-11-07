import { useEffect, useMemo, useRef, useState } from 'react';
import { liveQuery } from 'dexie';
import { addItem, formatRupees, paise, setQty, totals, type Cart, type MenuEntry, type Tender } from '@pos/shared';
import { db, type DeviceInfo, type LocalSale } from './db.ts';
import type { MenuView } from './menu.ts';
import { createSale, payOrder, type Actor } from './sale.ts';
import { addToOrder, openOrder, orderById, setLineQty, tableMode, tableStates, voidOrder } from './order.ts';
import { useItemImageUrl } from './itemImages.ts';
import { PayDialog } from './PayDialog.tsx';
import { Receipt } from './Receipt.tsx';
import { DraftBill, type DraftLine, type DraftTotals } from './DraftBill.tsx';

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
  return url ? <img src={url} alt="" loading="lazy" decoding="async" width={48} height={48} data-testid="item-picture" /> : null;
}

/** One line as the cart shows it, whether it belongs to a draft cart or to a running order. */
interface ShownLine { key: string; name: string; qty: number; netPaise: number; more: () => void; less: () => void }

export function Sell({ device, actor, menu }: { device: DeviceInfo; actor: Actor; menu: MenuView }) {
  const [cart, setCart] = useState<Cart>([]);          // draft: items not yet on any order (a cafe's pay-now cart)
  const [orderId, setOrderId] = useState<string | null>(null); // the running order being edited, if any
  const [tableId, setTableId] = useState<string | null>(null); // restaurant: the table chosen (its order, or the one to open)
  const [category, setCategory] = useState<string>('all');
  const [diet, setDiet] = useState<string>('');        // '' | 'veg' | 'egg' | 'non_veg'
  const [tag, setTag] = useState<string>('');          // '' | a tag id
  const [openSec, setOpenSec] = useState<'types' | 'cats' | 'tags'>('cats'); // sidebar: one group open at a time, Category by default
  const [q, setQ] = useState('');
  const [message, setMessage] = useState('');
  const [paying, setPaying] = useState<'cash' | 'upi' | null>(null);
  const [mapOpen, setMapOpen] = useState(false);
  const [heldOpen, setHeldOpen] = useState(false);     // the held-orders popup
  const [bill, setBill] = useState<{ lines: DraftLine[]; totals: DraftTotals } | null>(null); // snapshot for the draft bill
  const [done, setDone] = useState<LocalSale | null>(null);
  const [popular, setPopular] = useState<string[]>([]);
  const [voiding, setVoiding] = useState<string | null>(null); // the reason being typed, while the void form is open
  const searchRef = useRef<HTMLInputElement>(null);

  const mode = useLive(tableMode, 'default' as 'default' | 'map');
  const states = useLive(tableStates, []);
  const order = useLive(async () => (orderId ? (await orderById(orderId)) ?? null : null), null as LocalSale | null, [orderId]);
  const activeOrder = order && order.status === 'open' ? order : null;
  const otherDevice = !!activeOrder?.ownerDeviceId; // another device's order: it may be added to and paid here (step 7b)
  // Step 7c: a cashier voids any open order here, a waiter only one they opened (the server checks the same).
  const mayVoid = !!activeOrder && (actor.role === 'cashier' || activeOrder.createdBy === actor.id);
  useEffect(() => setVoiding(null), [activeOrder?.id]);
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
  const hold = () => guard(async () => { await holdDraft(); setOrderId(null); setHeldOpen(false); });
  const resume = (id: string) => guard(async () => { await holdDraft(); setOrderId(id); setHeldOpen(false); });
  /** Freezes what is on screen as a draft bill (nothing is saved; no receipt number is used). */
  const showBill = () => setBill({
    lines: inOrder
      ? activeOrder.lines.map((l) => ({ name: l.name, qty: l.qty, unitPaise: l.unitPaise, netPaise: l.netPaise, gstRateBp: l.gstRateBp, taxPaise: l.taxPaise }))
      : draftT.lines.map((l) => ({ name: l.name, qty: l.qty, unitPaise: l.unitPaise, netPaise: l.net, gstRateBp: l.gstRateBp, taxPaise: l.tax })),
    totals: { subtotalPaise: subtotal, taxPaise: tax, roundOffPaise: roundOff, totalPaise: total },
  });
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

  const confirmVoid = async () => {
    if (!activeOrder || voiding === null) return;
    try {
      await voidOrder({ device, actor, saleId: activeOrder.id, reason: voiding });
      setOrderId(null); setVoiding(null); setMessage('Order voided.');
    } catch (e) { setMessage(e instanceof Error ? e.message : 'Not allowed.'); }
  };

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

  // Search: "0102" (full code prefix) | "tea" (item name) | "<category name part or code> <item name or code>".
  const byCode = /^\d+$/.test(q);
  const matches = (e: MenuEntry): boolean => {
    const x = menu.extras[e.itemId];
    const ql = q.toLowerCase();
    if (byCode) return (x?.code ?? '').startsWith(q);
    const sp = ql.indexOf(' ');
    if (sp > 0) {
      const cq = ql.slice(0, sp), iq = ql.slice(sp + 1).trim();
      const cat = menu.categories.find((c) => c.id === e.categoryId);
      if (!cat || !(cat.name.toLowerCase().includes(cq) || cat.code.toLowerCase().startsWith(cq))) return false;
      const own = (x?.code ?? '').slice(cat.code.length);
      return !iq || e.name.toLowerCase().includes(iq) || own.startsWith(iq);
    }
    return e.name.toLowerCase().includes(ql);
  };
  const visible = useMemo(() => menu.entries.filter((e) => {
    const x = menu.extras[e.itemId];
    if (q) return matches(e);
    if (diet && x?.diet !== diet) return false;
    return !tag || (x?.tagIds ?? []).includes(tag);
  }), [menu, q, byCode, diet, tag]); // eslint-disable-line react-hooks/exhaustive-deps
  // Category groups in menu order; empty groups are left out.
  const groups = menu.categories.map((c) => ({ cat: c, items: visible.filter((e) => e.categoryId === c.id) })).filter((g) => g.items.length > 0);
  const known = new Set(menu.categories.map((c) => c.id));
  const loose = visible.filter((e) => !known.has(e.categoryId));
  const gotoCategory = (id: string) => {
    setCategory(id);
    document.getElementById(`cat-${id}`)?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  };
  const exact = byCode ? menu.entries.filter((e) => menu.extras[e.itemId]?.code === q) : [];
  const exactEntry = exact.length === 1 && exact[0]!.available ? exact[0]! : null;
  const quickAdd = () => { if (!exactEntry) return; void add(exactEntry); setQ(''); searchRef.current?.focus(); };

  const dietMarks = (['veg', 'egg', 'non_veg'] as const).filter((d) => Object.values(menu.extras).some((x) => x.diet === d));
  const showPopular = !q && !diet && !tag;
  const popularEntries = popular.map((id) => menu.entries.find((e) => e.itemId === id)).filter((e): e is MenuEntry => !!e && e.available);

  const tile = (e: MenuEntry, prefix = '') => {
    const x = menu.extras[e.itemId];
    return (
      <button key={prefix + e.itemId} data-testid={`${prefix}item-${e.name}`} className="item" title={x?.description || undefined} disabled={!e.available} onClick={() => void add(e)}>
        <ItemPicture sha={x?.imageSha256} />
        <span className="txt">
          <span className="nm">{e.name}</span>
          <small>{e.available ? <><b className="pr">₹{rs(e.pricePaise)}</b>{x?.code && <> <span className="code" data-testid={`code-${e.name}`}>{x.code}</span></>}</> : 'Sold out'}</small>
        </span>
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
        {mode === 'map' && (
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
        )}
        <div className="srow" data-testid="held-strip">
          {mode !== 'map' && (
            <button data-testid="held-btn" className={`chipbtn ${heldOrders.length ? 'busy' : ''}`} aria-label={`${heldOrders.length} held orders`} title={heldOrders.length ? `${heldOrders.length} held orders` : 'Held orders'} onClick={() => setHeldOpen(true)}>{defaultTable?.code ?? '…'}</button>
          )}
          <input ref={searchRef} className="search" data-testid="search" value={q} onChange={(e) => setQ(e.target.value.replace(/^\s+/, ''))} onKeyDown={(e) => { if (e.key === 'Enter') quickAdd(); }}
            placeholder="Item, code, or category item (e.g. tea, 0102, bev chai)" aria-label="Search item or code" inputMode="search" autoComplete="off" />
          <button className="primary" data-testid="add-code" disabled={!exactEntry} onClick={quickAdd} aria-label="Add" title="Add">+</button>
        </div>
        {hint && <div className="muted hint" data-testid="code-hint">{hint}</div>}
        <div className="browse">
          <nav className="side" data-testid="filter-row" aria-label="Menu filters">
            {dietMarks.length > 0 && (
              <>
                <button className={`sechead ${openSec === 'types' ? 'open' : ''}`} data-testid="types-toggle" aria-expanded={openSec === 'types'} onClick={() => setOpenSec('types')}>Type <span>{openSec === 'types' ? '▾' : '▸'}</span></button>
                {openSec === 'types' && (
                  <div className="seclist">
                    {dietMarks.map((d) => <button key={d} data-testid={`filter-${d}`} className={diet === d ? 'active' : ''} aria-pressed={diet === d} onClick={() => setDiet(diet === d ? '' : d)}>{d === 'non_veg' ? 'Non-veg' : d[0]!.toUpperCase() + d.slice(1)}</button>)}
                  </div>
                )}
              </>
            )}
            <>
                <button className={`sechead ${openSec === 'cats' ? 'open' : ''}`} data-testid="cats-toggle" aria-expanded={openSec === 'cats'} onClick={() => setOpenSec('cats')}>Category <span>{openSec === 'cats' ? '▾' : '▸'}</span></button>
                {openSec === 'cats' && (
                  <div className="seclist">
                    {menu.categories.map((c) => <button key={c.id} className={category === c.id ? 'active' : ''} onClick={() => gotoCategory(c.id)}>{c.name}</button>)}
                  </div>
                )}
            </>
            {menu.tags.length > 0 && (
              <>
                <button className={`sechead ${openSec === 'tags' ? 'open' : ''}`} data-testid="tags-toggle" aria-expanded={openSec === 'tags'} onClick={() => setOpenSec('tags')}>Tags <span>{openSec === 'tags' ? '▾' : '▸'}</span></button>
                {openSec === 'tags' && (
                  <div className="seclist">
                    {menu.tags.map((t) => <button key={t.id} data-testid={`filter-${t.name}`} className={tag === t.id ? 'active' : ''} aria-pressed={tag === t.id} onClick={() => setTag(tag === t.id ? '' : t.id)}>{t.name}</button>)}
                  </div>
                )}
              </>
            )}
          </nav>
          <div className="items">
            {showPopular && popularEntries.length > 0 && (
              <div data-testid="popular">
                <div className="divider"><span>Popular</span></div>
                <div className="grid pop">{popularEntries.map((e) => tile(e, 'pop-'))}</div>
              </div>
            )}
            {visible.length === 0 && <p className="muted">{q ? 'No match.' : 'Nothing to sell here yet.'}</p>}
            {groups.map(({ cat, items }) => (
              <div key={cat.id} id={`cat-${cat.id}`} className="catgroup" data-testid={`group-${cat.name}`}>
                <div className="divider"><span>{cat.name}{cat.code && ` (${cat.code})`}</span></div>
                <div className="grid">{items.map((e) => tile(e))}</div>
              </div>
            ))}
            {loose.length > 0 && <div className="catgroup"><div className="divider"><span>Other ({loose.length})</span></div><div className="grid">{loose.map((e) => tile(e))}</div></div>}
          </div>
        </div>
      </section>
      <aside className="cart">
        {(inOrder || (mode === 'map' && tableId)) && <h2>{inOrder ? `Order · ${states.find((s) => s.table.id === activeOrder.tableId)?.table.code ?? ''}` : mode === 'map' && tableId ? `Table ${states.find((s) => s.table.id === tableId)?.table.code ?? ''}` : ''}</h2>}
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
        {otherDevice && <p className="warn" data-testid="other-device">Opened on another device. Paid here, it goes on this counter's receipt and drawer.</p>}
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
          <button data-testid="print-bill" disabled={lines.length === 0} onClick={showBill}>Print bill</button>
          {mayVoid && voiding === null && <button data-testid="void-order" onClick={() => setVoiding('')}>Void order</button>}
        </div>
        {mayVoid && voiding !== null && (
          <div className="row" data-testid="void-form">
            <input data-testid="void-reason" value={voiding} maxLength={200} placeholder="Reason (required)" onChange={(e) => setVoiding(e.target.value)} />
            <button data-testid="void-go" className="primary" disabled={!voiding.trim()} onClick={() => void confirmVoid()}>Void</button>
            <button data-testid="void-cancel" onClick={() => setVoiding(null)}>Cancel</button>
          </div>
        )}
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
      {heldOpen && (
        <div className="overlay" role="dialog" aria-label="Held orders">
          <div className="dialog">
            <div className="row"><h2>Held orders</h2><span className="spacer" /><button data-testid="held-close" onClick={() => setHeldOpen(false)}>Close</button></div>
            <button data-testid="hold" className="primary" disabled={cart.length === 0 && !inOrder} onClick={() => void hold()}>Hold current &amp; start new</button>
            {heldOrders.length === 0 && <p className="muted">No held orders.</p>}
            {heldOrders.map((o) => (
              <button key={o.id} data-testid="held-order" className="tbl busy" onClick={() => void resume(o.id)}>
                {o.lines.map((l) => `${l.qty} × ${l.name}`).join(', ')} · ₹{rs(o.totalPaise)}
              </button>
            ))}
          </div>
        </div>
      )}
      {bill && <DraftBill lines={bill.lines} totals={bill.totals} device={device} staffName={actor.name} onClose={() => setBill(null)} />}
      {paying && <PayDialog key={paying} initialMode={paying} total={paise(total)} onCancel={() => setPaying(null)} onConfirm={finish} />}
    </div>
  );
}
