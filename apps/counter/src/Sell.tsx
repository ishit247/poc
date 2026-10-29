import { useState } from 'react';
import { addItem, formatRupees, paise, setQty, totals, type Cart, type MenuEntry } from '@pos/shared';
import type { DeviceInfo, LocalSale } from './db.ts';
import type { MenuView } from './menu.ts';
import { createSale, type Actor } from './sale.ts';
import { PayDialog } from './PayDialog.tsx';
import { Receipt } from './Receipt.tsx';

const rs = (n: number) => formatRupees(paise(n));

export function Sell({ device, actor, menu }: { device: DeviceInfo; actor: Actor; menu: MenuView }) {
  const [cart, setCart] = useState<Cart>([]);
  const [category, setCategory] = useState<string>('all');
  const [message, setMessage] = useState('');
  const [paying, setPaying] = useState(false);
  const [done, setDone] = useState<LocalSale | null>(null);

  const t = totals(cart, menu.settings);
  const shown = menu.entries.filter((e) => category === 'all' || e.categoryId === category);
  const attempt = (f: () => Cart) => { try { setCart(f()); setMessage(''); } catch (e) { setMessage(e instanceof Error ? e.message : 'Not allowed.'); } };

  const save = async (tenders?: Parameters<typeof createSale>[0]['tenders']) => {
    const sale = await createSale({ device, actor, cart, settings: menu.settings, menuVersion: menu.menuVersion, tenders });
    setCart([]);
    setPaying(false);
    setDone(sale);
  };

  if (done) return <Receipt sale={done} device={device} onClose={() => setDone(null)} />;
  return (
    <div className="sell">
      <section className="menu">
        <div className="cats">
          <button className={category === 'all' ? 'active' : ''} onClick={() => setCategory('all')}>All</button>
          {menu.categories.map((c) => <button key={c.id} className={category === c.id ? 'active' : ''} onClick={() => setCategory(c.id)}>{c.name}</button>)}
        </div>
        <div className="grid">
          {shown.length === 0 && <p className="muted">Nothing to sell here yet.</p>}
          {shown.map((e: MenuEntry) => (
            <button key={e.itemId} data-testid={`item-${e.name}`} className="item" disabled={!e.available} onClick={() => attempt(() => addItem(cart, e, 1, menu.settings))}>
              <span>{e.name}</span>
              <small>{e.available ? `₹${rs(e.pricePaise)}` : 'Sold out'}</small>
            </button>
          ))}
        </div>
      </section>
      <aside className="cart">
        <h2>Order</h2>
        <ul data-testid="cart-lines">
          {t.lines.map((l) => (
            <li key={l.itemId}>
              <span className="name">{l.name}</span>
              <span className="qty">
                <button aria-label={`less ${l.name}`} onClick={() => attempt(() => setQty(cart, l.itemId, l.qty - 1, menu.settings))}>−</button>
                <b data-testid={`qty-${l.name}`}>{l.qty}</b>
                <button aria-label={`more ${l.name}`} onClick={() => attempt(() => setQty(cart, l.itemId, l.qty + 1, menu.settings))}>+</button>
              </span>
              <span className="amt">₹{rs(l.net)}</span>
            </li>
          ))}
        </ul>
        {message && <p className="error" role="alert">{message}</p>}
        <dl className="sums">
          <dt>Subtotal</dt><dd data-testid="subtotal">₹{rs(t.subtotal)}</dd>
          {t.tax > 0 && (<><dt>GST</dt><dd data-testid="tax">₹{rs(t.tax)}</dd></>)}
          {t.roundOff !== 0 && (<><dt>Round off</dt><dd data-testid="round-off">{t.roundOff < 0 ? '−' : '+'}₹{rs(Math.abs(t.roundOff))}</dd></>)}
          <dt className="total">Total</dt><dd className="total" data-testid="total">₹{rs(t.total)}</dd>
        </dl>
        <div className="actions">
          <button data-testid="clear" disabled={cart.length === 0} onClick={() => setCart([])}>Clear</button>
          <button data-testid="save-order" disabled={cart.length === 0} onClick={() => save()}>Save order</button>
          {actor.role === 'cashier' && <button data-testid="pay" className="primary" disabled={cart.length === 0} onClick={() => setPaying(true)}>Pay ₹{rs(t.total)}</button>}
        </div>
      </aside>
      {paying && <PayDialog total={paise(t.total)} onCancel={() => setPaying(false)} onConfirm={(tenders) => save(tenders)} />}
    </div>
  );
}
