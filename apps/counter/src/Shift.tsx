import { useEffect, useState } from 'react';
import { formatRupees, paise, parseRupees, renderShiftSlip, type ShiftSlipView } from '@pos/shared';
import { db, type DeviceInfo, type LocalShift } from './db.ts';
import type { Actor } from './sale.ts';
import { closeShift, managerCloseShift, openShift, slipFor } from './shift.ts';
import { ManagerLogin } from './manager/index.ts';

const money = (text: string, what: string): number => {
  try { return parseRupees(text); } catch { throw new RangeError(`Enter ${what} as rupees, like 500 or 500.50.`); }
};

/**
 * Open the drawer with a float, or close it with a blind count: the expected figure is never on this
 * screen. After closing, the slip shows what the drawer should have held; it is the cashier's copy.
 */
export function Shift({ device, actor, shift, onSync }: { device: DeviceInfo; actor: Actor; shift: LocalShift | undefined; onSync: () => Promise<void> }) {
  const [cash, setCash] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [slip, setSlip] = useState<ShiftSlipView | null>(null);
  // Closing another cashier's drawer: null = not started; '' = manager signing in; otherwise their token (memory only).
  const [mgr, setMgr] = useState<string | null>(null);
  // The latest drawer a manager closed for someone on this tablet, so the next cashier is not left wondering why it vanished.
  const [forced, setForced] = useState<LocalShift | null>(null);
  useEffect(() => {
    void db.shifts.toArray().then((all) => setForced(all.filter((s) => s.closedByManager).sort((a, b) => (b.closedAt ?? '').localeCompare(a.closedAt ?? ''))[0] ?? null));
  }, [shift]);

  const run = async (go: () => Promise<void>) => {
    setError('');
    setBusy(true);
    try { await go(); } catch (e) { setError(e instanceof Error ? e.message : 'Something went wrong.'); } finally { setBusy(false); }
  };

  if (slip) {
    return (
      <main className="center">
        <p className="no-print">Shift closed. Keep this slip with the cash.</p>
        <div className="receipt print-area" data-testid="shift-slip"><pre data-testid="shift-slip-text">{renderShiftSlip(slip).join('\n')}</pre></div>
        <div className="no-print">
          <button data-testid="print" onClick={() => window.print()}>Print</button>{' '}
          <button data-testid="slip-done" className="primary" onClick={() => setSlip(null)}>Done</button>
        </div>
      </main>
    );
  }

  if (!shift) {
    return (
      <main className="center">
        <h2>Open shift</h2>
        {forced?.closedByManager && (
          <p data-testid="forced-notice" className="warn">
            A manager closed {forced.userName}'s drawer at {new Date(forced.closedAt!).toLocaleTimeString()}: they counted ₹{formatRupees(paise(forced.countedCashPaise!))}, expected ₹{formatRupees(paise(forced.closedByManager.expectedCashPaise))}.
          </p>
        )}
        <p>Count the cash in the drawer and enter it as the opening float.</p>
        <input data-testid="opening-cash" inputMode="decimal" value={cash} onChange={(e) => setCash(e.target.value)} placeholder="Opening cash ₹" />
        <button data-testid="open-shift" className="primary" disabled={busy || !cash.trim()}
          onClick={() => run(async () => { await openShift({ actor, openingCashPaise: money(cash, 'the opening cash') }); setCash(''); void onSync(); })}>Open shift</button>
        {error && <p className="error" role="alert">{error}</p>}
      </main>
    );
  }

  if (shift.userId !== actor.id) {
    if (mgr === '') return <ManagerLogin onToken={setMgr} onCancel={() => setMgr(null)} />;
    return (
      <main className="center">
        <h2>Shift open</h2>
        <p data-testid="shift-other">The shift is open under <b>{shift.userName}</b> since {new Date(shift.openedAt).toLocaleTimeString()}. They need to close it before you can take payment.</p>
        {mgr === null ? (
          <p><button data-testid="mgr-close-other" onClick={() => { setError(''); setMgr(''); }}>{shift.userName} is not here? A manager can close it</button></p>
        ) : (
          <>
            <p>Manager: count all the cash in the drawer, including the float, and enter it. The server works out the difference.</p>
            <input data-testid="mgr-close-cash" inputMode="decimal" value={cash} onChange={(e) => setCash(e.target.value)} placeholder="Counted cash ₹" />
            <button data-testid="mgr-close-go" className="primary" disabled={busy || !cash.trim()}
              onClick={() => run(async () => {
                const counted = money(cash, 'the counted cash');
                await onSync(); // send everything first: the server's expected figure is only right once it has every sale
                await managerCloseShift({ device, token: mgr, shiftId: shift.id, countedCashPaise: counted });
                setCash('');
                setMgr(null);
                await onSync().catch(() => {}); // brings the server's figures (and a closure by someone else, on a 409)
              })}>{busy ? 'Closing…' : 'Close drawer'}</button>{' '}
            <button onClick={() => { setMgr(null); setCash(''); setError(''); }}>Cancel</button>
          </>
        )}
        {error && <p className="error" role="alert">{error}</p>}
      </main>
    );
  }

  return (
    <main className="center">
      <h2>Close shift</h2>
      <p data-testid="shift-info">Open since {new Date(shift.openedAt).toLocaleTimeString()} · opening float ₹{formatRupees(paise(shift.openingCashPaise))}</p>
      <p>Count all the cash in the drawer, including the float, and enter it. The expected amount is shown on the slip afterwards.</p>
      <input data-testid="counted-cash" inputMode="decimal" value={cash} onChange={(e) => setCash(e.target.value)} placeholder="Counted cash ₹" />
      <button data-testid="close-shift" className="primary" disabled={busy || !cash.trim()}
        onClick={() => run(async () => {
          const view = await closeShift({ device, actor, countedCashPaise: money(cash, 'the counted cash') });
          setCash('');
          await onSync().catch(() => {}); // forced sync: send the shift now if we can; the slip says if anything is still waiting
          // Worked out again after the sync: a payment refused in it (step 7d) moves from sales to its own line.
          const closed = await db.shifts.get(shift.id);
          setSlip(closed ? await slipFor(closed, device) : view);
        })}>Close shift</button>
      {error && <p className="error" role="alert">{error}</p>}
    </main>
  );
}
