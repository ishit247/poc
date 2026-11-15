import { useEffect, useMemo, useRef, useState, type ComponentProps } from 'react';
import { liveQuery } from 'dexie';
import { addItem, formatRupees, paise, setQty, totals, type BillDiscount, type Cart, type MenuEntry, type Tender } from '@pos/shared';
import { db, type DeviceInfo, type LocalSale } from './db.ts';
import type { MenuView } from './menu.ts';
import { useT } from './i18n.ts';
import { createSale, discountProblem, payOrder, type Actor } from './sale.ts';
import { addToOrder, openOrder, orderById, orderDiscount, orderDue, setLineQty, setOrderDiscount, tableMode, tableStates, voidOrder } from './order.ts';
import { useItemImageUrl } from './itemImages.ts';
import { DiscountDialog } from './DiscountDialog.tsx';
import { PayDialog } from './PayDialog.tsx';
import { Receipt } from './Receipt.tsx';
import { DraftBill, discountedBill, type DraftLine, type DraftTotals } from './DraftBill.tsx';

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

const svgProps = { width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true } as const;

/** One line as the cart shows it, whether it belongs to a draft cart or to a running order. */
interface ShownLine { key: string; name: string; qty: number; netPaise: number; more: () => void; less: () => void }

export function Sell({ device, actor, menu }: { device: DeviceInfo; actor: Actor; menu: MenuView }) {
  const t = useT();
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
  const [bill, setBill] = useState<{ lines: DraftLine[]; totals: DraftTotals; discount: ComponentProps<typeof DraftBill>['discount'] } | null>(null); // snapshot for the draft bill
  const [draftDiscount, setDraftDiscount] = useState<BillDiscount | null>(null); // a cashier's discount on the draft cart, saved with the order
  const [discounting, setDiscounting] = useState(false); // the Discount dialog is open
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
  const mayVoid = !!activeOrder && (actor.role === 'cashier' || activeOrder.createdBy === actor.id || activeOrder.lines.length === 0);
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

  // The draft cart's discount applies only while it still fits the bill and the cap; otherwise it is shown as not applied.
  const draftGross = totals(cart, menu.settings);
  const draftWhy = draftDiscount ? (cart.length ? discountProblem(draftGross.subtotal, draftDiscount, menu.settings) : t('There is nothing on this bill to discount.')) : null;
  const draftApplied = draftDiscount && !draftWhy ? draftDiscount : null;
  const draftT = draftApplied ? totals(cart, menu.settings, draftApplied) : draftGross;
  useEffect(() => { if (cart.length === 0) setDraftDiscount(null); }, [cart.length]);
  const inOrder = activeOrder !== null;
  // An open order's totals are its bill with the saved discount (`saved`), when it has one (docs/discounts-plan.md).
  const saved = inOrder ? activeOrder.saved : undefined;
  const subtotal = inOrder ? activeOrder.subtotalPaise : draftT.subtotal;
  const tax = inOrder ? saved?.taxPaise ?? activeOrder.taxPaise : draftT.tax;
  const roundOff = inOrder ? saved?.roundOffPaise ?? activeOrder.roundOffPaise : draftT.roundOff;
  const total = inOrder ? orderDue(activeOrder) : draftT.total;
  const grossTotal = inOrder ? activeOrder.totalPaise : draftGross.total; // the bill before the discount: what Pay starts from
  const discountRule = inOrder ? orderDiscount(activeOrder) : draftApplied;
  const discountPaise = inOrder ? (saved && !saved.problem ? saved.discountPaise : 0) : draftT.discount;
  const discountNotApplied = inOrder ? saved?.problem ?? null : draftWhy;
  const noDiscountWhy = actor.role !== 'cashier' ? t('Only a cashier may give a discount.')
    : (inOrder ? activeOrder.lines.length : cart.length) === 0 ? t('Add items first.')
    : inOrder && activeOrder.kind !== 'order' ? t('This bill cannot take a discount.')
    : menu.settings.discountMaxBp === 0 ? t('Discounts are off. A manager can turn them on in Settings.') : undefined;

  const guard = async (f: () => Promise<void> | void) => {
    try { await f(); setMessage(''); } catch (e) { setMessage(e instanceof Error ? e.message : t('Not allowed.')); }
  };

  const lines: ShownLine[] = inOrder
    ? activeOrder.lines.map((l) => ({
      key: l.lineId ?? l.itemId, name: l.name, qty: l.qty, netPaise: l.netPaise,
      more: () => void guard(async () => { await setLineQty({ device, actor, settings: menu.settings, saleId: activeOrder.id, lineId: l.lineId!, qty: l.qty + 1 }); }),
      less: () => void guard(async () => {
        const s = await setLineQty({ device, actor, settings: menu.settings, saleId: activeOrder.id, lineId: l.lineId!, qty: l.qty - 1 });
        await dropIfEmpty(s);
      }),
    }))
    : draftT.lines.map((l) => ({
      key: l.itemId, name: l.name, qty: l.qty, netPaise: l.net,
      more: () => void guard(() => { setCart(setQty(cart, l.itemId, l.qty + 1, menu.settings)); }),
      less: () => void guard(() => { setCart(setQty(cart, l.itemId, l.qty - 1, menu.settings)); }),
    }));

  /** An order whose last line was removed is cancelled, so no 0-item order is left open. */
  const dropIfEmpty = async (s: { id: string; lines: unknown[] }) => {
    if (s.lines.length > 0) return;
    await voidOrder({ device, actor, saleId: s.id, reason: 'All items removed' });
    setOrderId(null);
  };

  const add = (entry: MenuEntry) => guard(async () => {
    if (inOrder) { await addToOrder({ device, actor, settings: menu.settings, saleId: activeOrder.id, entry }); return; }
    if (mode === 'map') {
      // A restaurant table's order is a running order from its first item.
      if (!tableId) throw new Error(t('Choose a table first.'));
      const sale = await openOrder({ device, actor, settings: menu.settings, menuVersion: menu.menuVersion, tableId, cart: addItem([], entry, 1, menu.settings) });
      setOrderId(sale.id);
      return;
    }
    setCart(addItem(cart, entry, 1, menu.settings));
  });

  /** Parks the draft as an open order on the default table, so the counter can start the next customer. */
  const holdDraft = async (): Promise<boolean> => {
    if (cart.length === 0) return true;
    await openOrder({ device, actor, settings: menu.settings, menuVersion: menu.menuVersion, cart, discount: draftApplied });
    setCart([]); setDraftDiscount(null);
    return true;
  };
  // Leaving Sell (another tab, sign-out, manager tools) unmounts it and would lose the draft: hold it instead, as the
  // signed-in person, so it waits under Held orders. A ref, because the cleanup runs after the last render's closure.
  const leaving = useRef({ cart, device, actor, menu, discount: draftApplied });
  leaving.current = { cart, device, actor, menu, discount: draftApplied };
  useEffect(() => () => {
    const { cart: left, device: d, actor: a, menu: m, discount } = leaving.current;
    if (left.length === 0) return;
    void openOrder({ device: d, actor: a, settings: m.settings, menuVersion: m.menuVersion, cart: left, discount })
      .catch((e) => console.error('could not hold the draft on leaving Sell', e));
  }, []);

  const hold = () => guard(async () => { await holdDraft(); setOrderId(null); setHeldOpen(false); });
  const resume = (id: string) => guard(async () => { await holdDraft(); setOrderId(id); setHeldOpen(false); });
  /** Freezes what is on screen as a draft bill (nothing is saved; no receipt number is used). */
  const showBill = () => {
    if (discountRule) { // lines with their tax on the discounted net, as the receipt will show them
      setBill(discountedBill(inOrder ? activeOrder.lines : cart, menu.settings, discountRule));
      return;
    }
    setBill({
      lines: inOrder
        ? activeOrder.lines.map((l) => ({ name: l.name, qty: l.qty, unitPaise: l.unitPaise, netPaise: l.netPaise, gstRateBp: l.gstRateBp, taxPaise: l.taxPaise }))
        : draftT.lines.map((l) => ({ name: l.name, qty: l.qty, unitPaise: l.unitPaise, netPaise: l.net, gstRateBp: l.gstRateBp, taxPaise: l.tax })),
      totals: { subtotalPaise: subtotal, taxPaise: tax, roundOffPaise: roundOff, totalPaise: total },
      discount: null,
    });
  };
  const applyDiscount = async (d: BillDiscount | null) => {
    if (inOrder) await setOrderDiscount({ device, actor, settings: menu.settings, saleId: activeOrder.id, discount: d });
    else setDraftDiscount(d);
    setDiscounting(false);
  };
  const pickTable = (id: string) => guard(async () => {
    const s = states.find((x) => x.table.id === id);
    setTableId(id);
    setOrderId(s?.orders[0]?.id ?? null);
    setMapOpen(false);
  });
  const clear = () => guard(async () => {
    if (inOrder) {
      let last = activeOrder;
      for (const l of activeOrder.lines) last = await setLineQty({ device, actor, settings: menu.settings, saleId: activeOrder.id, lineId: l.lineId!, qty: 0 });
      await dropIfEmpty(last);
    } else { setCart([]); setDraftDiscount(null); }
  });

  const confirmVoid = async () => {
    if (!activeOrder || voiding === null) return;
    try {
      await voidOrder({ device, actor, saleId: activeOrder.id, reason: voiding });
      setOrderId(null); setVoiding(null); setMessage(t('Order voided.'));
    } catch (e) { setMessage(e instanceof Error ? e.message : t('Not allowed.')); }
  };

  const finish = async (tenders: Tender[], discount: BillDiscount | null) => {
    const sale = inOrder
      ? await payOrder({ device, actor, saleId: activeOrder.id, tenders, discount, settings: menu.settings })
      : await createSale({ device, actor, cart, settings: menu.settings, menuVersion: menu.menuVersion, tenders, discount });
    setCart([]); setDraftDiscount(null); setOrderId(null); setPaying(null); setQ('');
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
    // Scroll only the item list; scrollIntoView would also move the search bar and filters.
    const group = document.getElementById(`cat-${id}`);
    const list = group?.closest('.items');
    if (group && list) list.scrollTo?.({ top: group.offsetTop, behavior: 'smooth' }); // .items is position: relative, so offsetTop is measured from it (and ignores the body zoom)
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
          <small>{e.available ? <><b className="pr">₹{rs(e.pricePaise)}</b>{x?.code && <> <span className="code" data-testid={`code-${e.name}`}>{x.code}</span></>}</> : t('Sold out')}</small>
        </span>
      </button>
    );
  };

  const hint = byCode
    ? exactEntry ? t('Add {name}', { name: exactEntry.name }) : exact.length === 1 ? t('{name} is sold out', { name: exact[0]!.name }) : visible.length === 1 ? t('{name} is {code}', { name: visible[0]!.name, code: String(menu.extras[visible[0]!.itemId]?.code ?? '') }) : visible.length ? t('{n} items start with {q}', { n: visible.length, q }) : t('No such code')
    : '';

  if (done) return <Receipt sale={done} device={device} onClose={() => setDone(null)} />;
  if (bill) return <DraftBill lines={bill.lines} totals={bill.totals} discount={bill.discount} device={device} staffName={actor.name} onClose={() => setBill(null)} />;

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
                  <b>{table.code}</b> {orders.length ? `₹${rs(orders.reduce((s, o) => s + orderDue(o), 0))}` : t('Free')}
                </button>
              ))}
            </div>
            <button data-testid="all-tables" onClick={() => setMapOpen(true)}>⊞ All tables</button>
          </div>
        )}
        <div className="srow" data-testid="held-strip">
          {mode !== 'map' && (
            <button data-testid="held-btn" className={`chipbtn ${heldOrders.length ? 'busy' : ''}`} aria-label={t('{n} held orders', { n: heldOrders.length })} title={heldOrders.length ? t('{n} held orders', { n: heldOrders.length }) : t('Held orders')} onClick={() => setHeldOpen(true)}>{defaultTable?.code ?? '…'}</button>
          )}
          <input ref={searchRef} className="search" data-testid="search" value={q} onChange={(e) => setQ(e.target.value.replace(/^\s+/, ''))} onKeyDown={(e) => { if (e.key === 'Enter') quickAdd(); }}
            placeholder={t('Item, code, or category item (e.g. tea, 0102, bev chai)')} aria-label={t('Search item or code')} inputMode="search" autoComplete="off" />
          <button className="primary" data-testid="add-code" disabled={!exactEntry} onClick={quickAdd} aria-label={t('Add')} title={t('Add')}>+</button>
        </div>
        {hint && <div className="muted hint" data-testid="code-hint">{hint}</div>}
        <div className="browse">
          <nav className="side" data-testid="filter-row" aria-label={t('Menu filters')}>
            {dietMarks.length > 0 && (
              <>
                <button className={`sechead ${openSec === 'types' ? 'open' : ''}`} data-testid="types-toggle" aria-expanded={openSec === 'types'} onClick={() => setOpenSec('types')}>{t('Type')} <span>{openSec === 'types' ? '▾' : '▸'}</span></button>
                {openSec === 'types' && (
                  <div className="seclist">
                    {dietMarks.map((d) => <button key={d} data-testid={`filter-${d}`} className={diet === d ? 'active' : ''} aria-pressed={diet === d} onClick={() => setDiet(diet === d ? '' : d)}>{d === 'non_veg' ? t('Non-veg') : t(d[0]!.toUpperCase() + d.slice(1))}</button>)}
                  </div>
                )}
              </>
            )}
            <>
                <button className={`sechead ${openSec === 'cats' ? 'open' : ''}`} data-testid="cats-toggle" aria-expanded={openSec === 'cats'} onClick={() => setOpenSec('cats')}>{t('Category')} <span>{openSec === 'cats' ? '▾' : '▸'}</span></button>
                {openSec === 'cats' && (
                  <div className="seclist">
                    {menu.categories.map((c) => <button key={c.id} className={category === c.id ? 'active' : ''} onClick={() => gotoCategory(c.id)}>{c.name}</button>)}
                  </div>
                )}
            </>
            {menu.tags.length > 0 && (
              <>
                <button className={`sechead ${openSec === 'tags' ? 'open' : ''}`} data-testid="tags-toggle" aria-expanded={openSec === 'tags'} onClick={() => setOpenSec('tags')}>{t('Tags')} <span>{openSec === 'tags' ? '▾' : '▸'}</span></button>
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
                <div className="divider"><span>{t('Popular')}</span></div>
                <div className="grid pop">{popularEntries.map((e) => tile(e, 'pop-'))}</div>
              </div>
            )}
            {visible.length === 0 && <p className="muted">{q ? t('No match.') : t('Nothing to sell here yet.')}</p>}
            {groups.map(({ cat, items }) => (
              <div key={cat.id} id={`cat-${cat.id}`} className="catgroup" data-testid={`group-${cat.name}`}>
                <div className="divider"><span>{cat.name}{cat.code && ` (${cat.code})`}</span></div>
                <div className="grid">{items.map((e) => tile(e))}</div>
              </div>
            ))}
            {loose.length > 0 && <div className="catgroup"><div className="divider"><span>{t('Other')} ({loose.length})</span></div><div className="grid">{loose.map((e) => tile(e))}</div></div>}
          </div>
        </div>
      </section>
      <aside className="cart">
        {(inOrder || (mode === 'map' && tableId)) && <h2>{inOrder ? `${t('Order')} · ${states.find((s) => s.table.id === activeOrder.tableId)?.table.code ?? ''}` : mode === 'map' && tableId ? `${t('Table')} ${states.find((s) => s.table.id === tableId)?.table.code ?? ''}` : ''}</h2>}
        <ul data-testid="cart-lines">
          {lines.length === 0 && <li className="muted">{mode === 'map' && !tableId ? t('Choose a table') : t('Tap an item to start')}</li>}
          {lines.map((l) => (
            <li key={l.key}>
              <span className="name">{l.name}</span>
              <span className="qty">
                <button aria-label={`${t('less')} ${l.name}`} onClick={l.less}>−</button>
                <b data-testid={`qty-${l.name}`}>{l.qty}</b>
                <button aria-label={`${t('more')} ${l.name}`} onClick={l.more}>+</button>
              </span>
              <span className="amt">₹{rs(l.netPaise)}</span>
            </li>
          ))}
        </ul>
        {message && <p className="error" role="alert" data-testid="sell-message">{message}</p>}
        <dl className="sums">
          <dt>{t('Subtotal')}</dt><dd data-testid="subtotal">₹{rs(subtotal)}</dd>
          {discountRule && discountPaise > 0 && (<><dt data-testid="discount-label">Discount ({discountRule.reason})</dt><dd data-testid="discount-amount">−₹{rs(discountPaise)}</dd></>)}
          {tax > 0 && (<><dt>GST</dt><dd data-testid="tax">₹{rs(tax)}</dd></>)}
          {roundOff !== 0 && (<><dt>{t('Round off')}</dt><dd data-testid="round-off">{roundOff < 0 ? '−' : '+'}₹{rs(Math.abs(roundOff))}</dd></>)}
          <dt className="total">{t('Total')}</dt><dd className="total" data-testid="total">₹{rs(total)}</dd>
        </dl>
        {discountNotApplied && <p className="warn" data-testid="discount-not-applied">{t('Discount not applied')}: {discountNotApplied}</p>}
        {otherDevice && <p className="warn" data-testid="other-device">{t("Opened on another device. Paid here, it goes on this counter's receipt and drawer.")}</p>}
        {actor.role === 'cashier' && (
          <div className="payrow">
            <button data-testid="pay-cash" className="primary" disabled={lines.length === 0} onClick={() => setPaying('cash')}>{t('Cash')} ₹{rs(total)}</button>
            <button data-testid="pay-upi" className="primary" disabled={lines.length === 0} onClick={() => setPaying('upi')}>UPI ₹{rs(total)}</button>
          </div>
        )}
        <div className="actions">
          {/* Plain text buttons at the left, icon buttons at the right: every one is always there (disabled, with why). */}
          <button data-testid="clear" disabled={lines.length === 0} onClick={() => void clear()}>{t('Clear')}</button>
          {mayVoid && <button data-testid="void-order" disabled={voiding !== null} title={t('Void this order')} onClick={() => setVoiding('')}>{t('Void')}</button>}
          <span className="spacer" />
          <button data-testid="save-order" className="icon-btn" aria-label={t('Save order')}
            title={inOrder ? t('This order is already saved.') : mode === 'map' ? t('A table order is saved as you add items.') : t('Save order')}
            disabled={inOrder || mode !== 'default' || cart.length === 0} onClick={() => void guard(async () => { await holdDraft(); setMessage(t('Order saved.')); })}>
            <svg {...svgProps}><path d="M5 3h11l3 3v15H5z" /><path d="M8 3v6h7V3" /><rect x="8" y="14" width="8" height="7" /></svg>
          </button>
          <button data-testid="discount-btn" className={`icon-btn ${discountRule ? 'active' : ''}`} aria-label={t('Discount')} title={noDiscountWhy ?? (discountRule ? t('Change or remove the discount') : t('Discount'))}
            disabled={!!noDiscountWhy} onClick={() => setDiscounting(true)}>
            <svg {...svgProps}><path d="M19 5L5 19" /><circle cx="7" cy="7" r="2" /><circle cx="17" cy="17" r="2" /></svg>
          </button>
          <button data-testid="print-bill" className="icon-btn" aria-label={t('Print bill')} title={t('Print bill')} disabled={lines.length === 0} onClick={showBill}>
            <svg {...svgProps}><path d="M6 9V3h12v6" /><rect x="3" y="9" width="18" height="9" rx="2" /><rect x="7" y="14" width="10" height="7" /></svg>
          </button>
        </div>
        {mayVoid && voiding !== null && (
          <div className="row" data-testid="void-form">
            <input data-testid="void-reason" value={voiding} maxLength={200} placeholder={t('Reason (required)')} onChange={(e) => setVoiding(e.target.value)} />
            <button data-testid="void-go" className="primary" disabled={!voiding.trim()} onClick={() => void confirmVoid()}>{t('Void')}</button>
            <button data-testid="void-cancel" onClick={() => setVoiding(null)}>{t('Cancel')}</button>
          </div>
        )}
      </aside>
      {mapOpen && (
        <div className="overlay" role="dialog" aria-label={t('All tables')}>
          <div className="dialog wide">
            <div className="row"><h2>{t('All tables')}</h2><span className="spacer" /><button data-testid="map-close" onClick={() => setMapOpen(false)}>{t('Close')}</button></div>
            <div className="map" data-testid="table-map">
              {states.map(({ table, orders }) => (
                <button key={table.id} data-testid={`map-${table.code}`} className={`tbl ${stateOf(orders)} ${table.id === shownTableId ? 'cur' : ''}`} onClick={() => void pickTable(table.id)}>
                  {table.code}<small>{orders.length ? `${t('Busy')} · ₹${rs(orders.reduce((s, o) => s + orderDue(o), 0))}` : t('Free')}</small>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
      {heldOpen && (
        <div className="overlay" role="dialog" aria-label={t('Held orders')}>
          <div className="dialog">
            <div className="row"><h2>{t('Held orders')}</h2><span className="spacer" /><button data-testid="held-close" onClick={() => setHeldOpen(false)}>{t('Close')}</button></div>
            <button data-testid="hold" className="primary" disabled={cart.length === 0 && !inOrder} onClick={() => void hold()}>{t('Hold current & start new')}</button>
            {heldOrders.length === 0 && <p className="muted">{t('No held orders.')}</p>}
            {heldOrders.map((o) => (
              <button key={o.id} data-testid="held-order" className="tbl busy" onClick={() => void resume(o.id)}>
                {o.lines.map((l) => `${l.qty} × ${l.name}`).join(', ')} · ₹{rs(orderDue(o))}
              </button>
            ))}
          </div>
        </div>
      )}
      {paying && (
        <PayDialog key={paying} initialMode={paying} lines={inOrder ? activeOrder.lines : cart} total={paise(grossTotal)} initialDiscount={discountRule}
          discountable={!inOrder || activeOrder.kind === 'order'} onCancel={() => setPaying(null)} onConfirm={finish} />
      )}
      {discounting && (
        <DiscountDialog lines={inOrder ? activeOrder.lines : cart} settings={menu.settings} current={discountRule}
          onApply={applyDiscount} onCancel={() => setDiscounting(false)} />
      )}
    </div>
  );
}
