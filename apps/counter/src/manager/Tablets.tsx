import { useCallback, useEffect, useState } from 'react';
import { api, type Me } from './api.ts';
import { Modal } from './Modal.tsx';
import { deviceRejected, unsentCount } from '../sync.ts';

/** A tablet of the manager's outlets, as `GET /devices` returns it. */
interface Tablet {
  id: string; label: string | null; outletId: string; counterCode: string;
  enrolledAt: string; lastSeenAt: string | null; revokedAt: string | null; appVersion: string | null;
}

const QUICK_REASONS = ['Lost', 'Stolen', 'Replaced', 'Not used any more'];

function ago(iso: string | null): string {
  if (!iso) return 'never';
  const min = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  if (min < 48 * 60) return `${Math.round(min / 60)} h ago`;
  return `${Math.round(min / 1440)} days ago`;
}
const day = (iso: string) => new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });

/**
 * The tablets enrolled at the manager's outlets, and revoking one that is lost, stolen or retired. The server checks
 * the tablet is at one of the manager's outlets and records who revoked it and why. A revoked tablet's credential is
 * refused at once; sales it made before the revocation are still accepted if it ever syncs (ingest.ts).
 */
export function Tablets({ token, thisDeviceId }: { token: string; thisDeviceId?: string }) {
  const [list, setList] = useState<Tablet[] | null>(null);
  const [outlets, setOutlets] = useState<Me['outlets']>([]);
  const [error, setError] = useState('');
  const [showRevoked, setShowRevoked] = useState(false);

  const load = useCallback(async () => {
    setError('');
    try {
      const [d, me] = await Promise.all([api('/devices', token), api('/me', token)]);
      if (d.status !== 200 || me.status !== 200) return setError('Your session has ended. Sign in again.');
      setList(d.body as Tablet[]);
      setOutlets((me.body as Me).outlets);
    } catch { setError('Could not reach the server.'); }
  }, [token]);
  useEffect(() => { void load(); }, [load]);

  const outletName = (id: string) => outlets.find((o) => o.id === id)?.name ?? '';
  const many = outlets.length > 1;
  const active = (list ?? []).filter((t) => !t.revokedAt);
  const revoked = (list ?? []).filter((t) => t.revokedAt);

  return (
    <main className="mgr" data-testid="mgr-tablets">
      {error && <div className="m-alert bad" role="alert"><span>⚠</span><div className="grow">{error}</div></div>}
      <section className="m-card">
        <header><h2>Tablets</h2>{list && <span className="m-pill ok">{active.length} working</span>}</header>
        {!list && !error && <div className="m-row"><span className="muted">Loading…</span></div>}
        {list && active.length === 0 && <div className="m-row"><span className="muted">No working tablets at your outlets.</span></div>}
        {active.map((t) => (
          <TabletRow key={t.id} t={t} outlet={many ? outletName(t.outletId) : ''} self={t.id === thisDeviceId} token={token} onRevoked={load} />
        ))}
      </section>
      {revoked.length > 0 && (
        <section className="m-card">
          <header>
            <h2>Revoked</h2><span className="m-pill">{revoked.length}</span><span className="spacer" />
            <button className="sm" data-testid="mgr-show-revoked" aria-expanded={showRevoked} onClick={() => setShowRevoked(!showRevoked)}>{showRevoked ? 'Hide' : 'Show'}</button>
          </header>
          {showRevoked && revoked.map((t) => (
            <div className="m-row" key={t.id} data-testid="mgr-tablet-revoked" data-device-id={t.id}>
              <div className="main"><b>{t.label ?? 'Tablet'} · {t.counterCode}{many ? ` · ${outletName(t.outletId)}` : ''}</b><span>Revoked {day(t.revokedAt!)} · enrolled {day(t.enrolledAt)}</span></div>
              <span className="m-pill bad">Revoked</span>
            </div>
          ))}
        </section>
      )}
    </main>
  );
}

const LABEL_MAX = 60; // deviceLabel in apps/api/src/routes/auth.ts

/** Names a tablet so a manager can tell two on one counter apart (PATCH /devices/:id, audited as device.label). */
function RenameTablet({ t, token, onRenamed }: { t: Tablet; token: string; onRenamed: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const clean = label.trim();
  const unchanged = clean === (t.label ?? '');
  const dismiss = () => { setOpen(false); setError(''); };
  const go = async () => {
    setBusy(true);
    setError('');
    try {
      const r = await api(`/devices/${t.id}`, token, { method: 'PATCH', body: JSON.stringify({ label: clean }) });
      if (r.status === 404) { dismiss(); await onRenamed(); return; } // revoked or moved meanwhile: the list is out of date
      if (r.status !== 200) { setError('Could not rename this tablet. Try again.'); return; }
      dismiss();
      await onRenamed();
    } catch { setError('Could not reach the server.'); } finally { setBusy(false); }
  };
  return (
    <>
      <button className="sm" data-testid="mgr-rename" onClick={() => { setLabel(t.label ?? ''); setOpen(true); }}>Rename</button>
      {open && (
        <Modal title="Rename tablet" onClose={dismiss}>
          <label className="m-field">Name
            <input data-testid="mgr-rename-label" autoFocus value={label} maxLength={LABEL_MAX} autoComplete="off" placeholder="e.g. Front counter, Waiter 2"
              onChange={(e) => { setLabel(e.target.value); setError(''); }}
              onKeyDown={(e) => { if (e.key === 'Enter' && clean && !unchanged && !busy) void go(); }} />
          </label>
          <p className="muted" style={{ margin: 0, fontSize: 14 }}>Counter {t.counterCode} · enrolled {day(t.enrolledAt)}. Receipts and sales are not affected.</p>
          {error && <p className="error" role="alert" style={{ margin: 0 }}>{error}</p>}
          <div className="m-dialog-actions">
            <button onClick={dismiss}>Cancel</button>
            <button data-testid="mgr-rename-go" className="primary" disabled={busy || !clean || unchanged}
              title={!clean ? 'Type a name' : unchanged ? 'Same name as now' : undefined} onClick={go}>{busy ? 'Saving…' : 'Save'}</button>
          </div>
        </Modal>
      )}
    </>
  );
}

function TabletRow({ t, outlet, self, token, onRevoked }: { t: Tablet; outlet: string; self: boolean; token: string; onRevoked: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // Revoking the tablet in your hand drops its credential (App.tsx, onDeviceRejected), so anything it has not sent
  // could never be sent. It may revoke itself only once everything is delivered.
  const [unsent, setUnsent] = useState(0);
  useEffect(() => { if (self && open) void unsentCount().then(setUnsent); }, [self, open]);
  const name = `${t.label ?? 'Tablet'} · ${t.counterCode}`;
  const dismiss = () => { setOpen(false); setReason(''); setError(''); };
  const go = async () => {
    setBusy(true);
    setError('');
    try {
      const r = await api(`/devices/${t.id}/revoke`, token, { method: 'POST', body: JSON.stringify({ reason: reason.trim() }) });
      // 404: already revoked from another tablet, or no longer at your outlets. Either way the list is out of date.
      if (r.status !== 200 && r.status !== 404) { setError('Could not revoke this tablet. Try again.'); return; }
      dismiss();
      if (self) return deviceRejected(); // back to the set-up screen now, not at the next sync
      await onRevoked();
    } catch { setError('Could not reach the server.'); } finally { setBusy(false); }
  };
  return (
    <div className="m-row" data-testid="mgr-tablet" data-device-id={t.id}>
      <div className="main">
        <b>{name}{outlet ? ` · ${outlet}` : ''}{self && <span className="m-pill" style={{ marginLeft: 8 }}>This tablet</span>}</b>
        <span>Last seen {ago(t.lastSeenAt)} · enrolled {day(t.enrolledAt)}{t.appVersion ? ` · app ${t.appVersion}` : ''}</span>
      </div>
      <div className="m-row-actions">
        <RenameTablet t={t} token={token} onRenamed={onRevoked} />
        <button className="sm danger" data-testid="mgr-revoke" onClick={() => setOpen(true)}>Revoke…</button>
      </div>
      {open && (
        <Modal title={self ? 'Revoke this tablet?' : `Revoke ${name}?`} onClose={dismiss}>
          <p className="muted" style={{ margin: 0 }}>
            It stops working at once and can only be used again after enrolling it with a new code. Sales it made before now
            still count if it ever reconnects. If a drawer is open on it, close it from Close the day.
          </p>
          {self && <p className="error" data-testid="mgr-revoke-self" style={{ margin: 0 }}>
            {unsent > 0 ? `You are using this tablet and it has ${unsent} record${unsent === 1 ? '' : 's'} not sent yet. Sync (⟳) first, or revoke it from another tablet.`
              : 'You are using this tablet. It will return to the set-up screen.'}
          </p>}
          <label className="m-field">Reason (required)
            <input data-testid="mgr-revoke-reason" autoFocus value={reason} maxLength={200} autoComplete="off" placeholder="e.g. lost, stolen, replaced"
              onChange={(e) => { setReason(e.target.value); setError(''); }}
              onKeyDown={(e) => { if (e.key === 'Enter' && reason.trim() && !busy) void go(); }} />
          </label>
          <div className="m-chips">
            {QUICK_REASONS.map((q) => <button key={q} className={`sm ${reason === q ? 'active' : ''}`} aria-pressed={reason === q} onClick={() => setReason(q)}>{q}</button>)}
          </div>
          <p className="muted" style={{ margin: 0, fontSize: 14 }}>This can’t be undone and is recorded against your name.</p>
          {error && <p className="error" role="alert" style={{ margin: 0 }}>{error}</p>}
          <div className="m-dialog-actions">
            <button onClick={dismiss}>Keep it</button>
            <button data-testid="mgr-revoke-go" className="danger solid" disabled={busy || !reason.trim() || (self && unsent > 0)}
              title={self && unsent > 0 ? 'Send this tablet’s records first' : !reason.trim() ? 'Give a reason' : undefined} onClick={go}>{busy ? 'Revoking…' : 'Revoke tablet'}</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
