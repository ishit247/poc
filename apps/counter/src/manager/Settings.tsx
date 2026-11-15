import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DEFAULT_SETTINGS, parsePercentBp, LOGO_MAX_BYTES, LOGO_TYPES, QTY_CAP_MAX, REFUND_REASON_MAX, REFUND_REASONS_MAX, ROUND_OFF_STEPS, type TradingSettings } from '@pos/shared';
import { api, type Me } from './api.ts';

type Outlet = Me['outlets'][number];

// Mirrors apps/api/src/routes/outlets.ts (GSTIN, receiptInfoBody); the server is the judge, this only saves a round trip.
const GSTIN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const FSSAI = /^[0-9]{14}$/;
const ROUNDING = [['half_up', 'Nearest paisa'], ['up', 'Always up'], ['down', 'Always down']] as const;
const ROUND_OFF_LABEL: Record<number, string> = { 0: 'No round-off', 10: 'Nearest 10 paise', 50: 'Nearest 50 paise', 100: 'Nearest ₹1' };

/** Result line shared by the three cards: saved, or what to do next. */
function Note({ ok, error }: { ok: boolean; error: string }) {
  if (error) return <p className="error" role="alert" style={{ margin: 0 }}>{error}</p>;
  return ok ? <p className="muted" role="status" style={{ margin: 0 }}>Saved.</p> : null;
}

/**
 * Tenant settings, the logo, and each outlet's receipt details (address, FSSAI, GST). All of it is online-only and
 * audited by the API; tablets pick the changes up at their next sync.
 */
export function Settings({ token }: { token: string }) {
  const [outlets, setOutlets] = useState<Outlet[] | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    try {
      const me = await api('/me', token);
      if (me.status !== 200) return setError('Your session has ended. Sign in again.');
      setOutlets((me.body as Me).outlets);
    } catch { setError('Could not reach the server.'); }
  }, [token]);
  useEffect(() => { void load(); }, [load]);

  return (
    <main className="mgr" data-testid="mgr-settings">
      {error && <div className="m-alert bad" role="alert"><span>⚠</span><div className="grow">{error}</div></div>}
      <Trading token={token} />
      <Logo token={token} />
      {!outlets && !error && <section className="m-card"><div className="m-row"><span className="muted">Loading…</span></div></section>}
      {outlets?.map((o) => <OutletDetails key={o.id} o={o} token={token} many={outlets.length > 1} onSaved={load} />)}
    </main>
  );
}

// One reason per line; blank lines and repeats (any case) are dropped, so the list saves as the cashier will see it.
// The limits are the shared `reasonList` schema's (settings.ts), for refund and discount reasons alike.
function reasonLines(text: string): string[] {
  const seen = new Set<string>();
  return text.split('\n').map((x) => x.trim()).filter((x) => x && !seen.has(x.toLowerCase()) && seen.add(x.toLowerCase()));
}
const listOk = (xs: readonly string[]) => xs.length <= REFUND_REASONS_MAX && xs.every((x) => x.length <= REFUND_REASON_MAX);

function Trading({ token }: { token: string }) {
  const [saved, setSaved] = useState<TradingSettings | null>(null);
  const [s, setS] = useState<TradingSettings>(DEFAULT_SETTINGS);
  const [qty, setQty] = useState(String(DEFAULT_SETTINGS.maxLineQty));
  const [days, setDays] = useState(String(DEFAULT_SETTINGS.offlineDays));
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');
  const [reasons, setReasons] = useState(DEFAULT_SETTINGS.refundReasons.join('\n'));
  const [cap, setCap] = useState(String(DEFAULT_SETTINGS.discountMaxBp / 100));
  const [dReasons, setDReasons] = useState(DEFAULT_SETTINGS.discountReasons.join('\n'));
  const adopt = (v: TradingSettings) => {
    setSaved(v); setS(v); setQty(String(v.maxLineQty)); setDays(String(v.offlineDays)); setReasons(v.refundReasons.join('\n'));
    setCap(String(v.discountMaxBp / 100)); setDReasons(v.discountReasons.join('\n'));
  };
  useEffect(() => {
    void api('/settings', token).then((r) => { if (r.status === 200) adopt(r.body as TradingSettings); else setError('Could not load the settings.'); })
      .catch(() => setError('Could not reach the server.'));
  }, [token]);

  const q = Number(qty), d = Number(days);
  const qtyOk = Number.isInteger(q) && q >= 1 && q <= QTY_CAP_MAX;
  const daysOk = Number.isInteger(d) && d >= 1 && d <= 60;
  const list = useMemo(() => reasonLines(reasons), [reasons]);
  const dList = useMemo(() => reasonLines(dReasons), [dReasons]);
  const reasonsOk = listOk(list);
  const dReasonsOk = listOk(dList);
  const capBp = parsePercentBp(cap);
  const next: TradingSettings = { ...s, maxLineQty: q, offlineDays: d, refundReasons: list, discountMaxBp: capBp ?? 0, discountReasons: dList };
  const changed = !!saved && JSON.stringify(next) !== JSON.stringify(saved);
  const reasonsWhy = `up to ${REFUND_REASONS_MAX}, each up to ${REFUND_REASON_MAX} letters`;
  const why = !qtyOk ? `Quantity limit: 1 to ${QTY_CAP_MAX}` : !daysOk ? 'Offline days: 1 to 60'
    : !reasonsOk ? `Refund reasons: ${reasonsWhy}` : capBp === null ? 'Largest discount: 0 to 100 (%)'
    : !dReasonsOk ? `Discount reasons: ${reasonsWhy}` : !changed ? 'Nothing changed' : undefined;

  const save = async () => {
    setBusy(true); setError(''); setDone(false);
    try {
      const r = await api('/settings', token, { method: 'PUT', body: JSON.stringify(next) });
      if (r.status !== 200) return setError('Could not save. Check the values and try again.');
      adopt(next); setDone(true);
    } catch { setError('Could not reach the server.'); } finally { setBusy(false); }
  };

  return (
    <section className="m-card" data-testid="set-trading">
      <header><h2>Selling rules</h2></header>
      <div className="m-form">
        <label className="m-field">Most of one item on a line
          <input data-testid="set-qty" inputMode="numeric" value={qty} onChange={(e) => { setQty(e.target.value.replace(/\D/g, '')); setDone(false); }} />
        </label>
        <label className="m-field">GST rounding
          <select data-testid="set-rounding" value={s.gstRounding} onChange={(e) => { setS({ ...s, gstRounding: e.target.value as TradingSettings['gstRounding'] }); setDone(false); }}>
            {ROUNDING.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
        <label className="m-field">Bill round-off
          <select data-testid="set-roundoff" value={s.billRoundTo} onChange={(e) => { setS({ ...s, billRoundTo: Number(e.target.value) as TradingSettings['billRoundTo'] }); setDone(false); }}>
            {ROUND_OFF_STEPS.map((v) => <option key={v} value={v}>{ROUND_OFF_LABEL[v]}</option>)}
          </select>
        </label>
        <label className="m-field">Days a tablet may stay offline
          <input data-testid="set-days" inputMode="numeric" value={days} onChange={(e) => { setDays(e.target.value.replace(/\D/g, '')); setDone(false); }} />
        </label>
        <label className="m-field">Refund reasons, one per line (cashiers pick one or type their own)
          <textarea data-testid="set-refund-reasons" rows={5} value={reasons} onChange={(e) => { setReasons(e.target.value); setDone(false); }} />
          {!reasonsOk && <span className="error" role="alert">Up to {REFUND_REASONS_MAX} reasons, each up to {REFUND_REASON_MAX} letters.</span>}
        </label>
        <label className="m-field">Largest bill discount a cashier may give, % (0 turns discounts off)
          <input data-testid="set-discount-cap" inputMode="decimal" value={cap} onChange={(e) => { setCap(e.target.value); setDone(false); }} />
          {capBp === null && <span className="error" role="alert">A percentage from 0 to 100, like 10 or 12.5.</span>}
        </label>
        <label className="m-field">Discount reasons, one per line (cashiers pick one or type their own)
          <textarea data-testid="set-discount-reasons" rows={4} value={dReasons} onChange={(e) => { setDReasons(e.target.value); setDone(false); }} />
          {!dReasonsOk && <span className="error" role="alert">Up to {REFUND_REASONS_MAX} reasons, each up to {REFUND_REASON_MAX} letters.</span>}
        </label>
        <p className="muted">Tablets use new rules after their next sync. Bills already rung up keep the rules they were made under.</p>
        <Note ok={done} error={error} />
        <div className="m-dialog-actions">
          <button data-testid="set-save" className="primary" disabled={busy || !!why} title={why} onClick={save}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
    </section>
  );
}

function Logo({ token }: { token: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const show = useCallback(async () => {
    try {
      const r = await fetch('/api/settings/logo', { headers: { authorization: `Bearer ${token}` } });
      const blob = r.status === 200 ? await r.blob() : null;
      setUrl((old) => { if (old) URL.revokeObjectURL(old); return blob ? URL.createObjectURL(blob) : null; });
    } catch { setError('Could not reach the server.'); } finally { setLoaded(true); }
  }, [token]);
  useEffect(() => { void show(); }, [show]);

  const pick = async (f: File | undefined) => {
    if (!f) return;
    setError('');
    if (!(LOGO_TYPES as readonly string[]).includes(f.type)) return setError('Use a PNG, JPEG or WebP picture.');
    if (f.size > LOGO_MAX_BYTES) return setError(`The picture is too big. The limit is ${LOGO_MAX_BYTES / 1024} KB.`);
    setBusy(true);
    try {
      const r = await fetch('/api/settings/logo', { method: 'PUT', headers: { authorization: `Bearer ${token}`, 'content-type': f.type }, body: f });
      if (r.status !== 200) return setError('That picture was not accepted. Try another PNG, JPEG or WebP.');
      await show();
    } catch { setError('Could not reach the server.'); } finally { setBusy(false); }
  };
  const remove = async () => {
    setBusy(true); setError('');
    try {
      const r = await api('/settings/logo', token, { method: 'DELETE' });
      if (r.status !== 200) return setError('Could not remove the logo. Try again.');
      await show();
    } catch { setError('Could not reach the server.'); } finally { setBusy(false); }
  };

  return (
    <section className="m-card" data-testid="set-logo">
      <header><h2>Logo</h2></header>
      <div className="m-row">
        <div className="main">
          <div className="m-logo">
            {url ? <img src={url} alt="Your logo" data-testid="set-logo-img" /> : <span className="muted">{loaded ? 'No logo yet.' : 'Loading…'}</span>}
          </div>
          <span style={{ display: 'block' }}>Shown on sign-in screens, the counter header and receipts. PNG, JPEG or WebP, up to {LOGO_MAX_BYTES / 1024} KB.</span>
          {error && <span className="error" role="alert" style={{ display: 'block' }}>{error}</span>}
        </div>
        <div className="m-row-actions">
          <button className="sm" data-testid="set-logo-pick" disabled={busy} onClick={() => fileRef.current?.click()}>{url ? 'Replace' : 'Upload'}</button>
          <input ref={fileRef} data-testid="set-logo-file" type="file" accept={LOGO_TYPES.join(',')} hidden
            onChange={(e) => { void pick(e.target.files?.[0]); e.target.value = ''; }} />
          {url && <button className="sm danger" data-testid="set-logo-remove" disabled={busy} onClick={remove}>Remove</button>}
        </div>
      </div>
    </section>
  );
}

function OutletDetails({ o, token, many, onSaved }: { o: Outlet; token: string; many: boolean; onSaved: () => Promise<void> }) {
  const [address, setAddress] = useState(o.address ?? '');
  const [fssai, setFssai] = useState(o.fssaiNo ?? '');
  const [gstOn, setGstOn] = useState(!!o.gstEnabled);
  const [gstin, setGstin] = useState(o.gstin ?? '');
  const [busy, setBusy] = useState<'info' | 'gst' | ''>('');
  const [done, setDone] = useState<'info' | 'gst' | ''>('');
  const [error, setError] = useState<{ info: string; gst: string }>({ info: '', gst: '' });

  const addr = address.trim(), fs = fssai.trim(), gs = gstin.trim().toUpperCase();
  const infoOk = (!fs || FSSAI.test(fs)) && addr.length <= 200 && !/[\u0000-\u001f\u007f]/.test(addr);
  const infoChanged = addr !== (o.address ?? '') || fs !== (o.fssaiNo ?? '');
  const gstOk = gstOn ? GSTIN.test(gs) : !gs || GSTIN.test(gs);
  const gstChanged = gstOn !== !!o.gstEnabled || (gs || null) !== (o.gstin ?? null);

  const put = async (what: 'info' | 'gst') => {
    setBusy(what); setDone(''); setError({ info: '', gst: '' });
    const [path, body] = what === 'info'
      ? ['receipt-info', { address: addr || null, fssaiNo: fs || null }]
      : ['gst', { enabled: gstOn, gstin: gs || null }];
    try {
      const r = await api(`/outlets/${o.id}/${path}`, token, { method: 'PUT', body: JSON.stringify(body) });
      if (r.status !== 200) return setError((e) => ({ ...e, [what]: 'Could not save. Check the values and try again.' }));
      await onSaved(); setDone(what);
    } catch { setError((e) => ({ ...e, [what]: 'Could not reach the server.' })); } finally { setBusy(''); }
  };

  return (
    <section className="m-card" data-testid="set-outlet" data-outlet-id={o.id}>
      <header><h2>{many ? `${o.name} · receipt` : 'Receipt details'}</h2></header>
      <div className="m-form">
        <label className="m-field">Address on the receipt
          <input data-testid="set-address" value={address} maxLength={200} autoComplete="off" onChange={(e) => { setAddress(e.target.value); setDone(''); }} />
        </label>
        <label className="m-field">FSSAI licence number (14 digits)
          <input data-testid="set-fssai" inputMode="numeric" value={fssai} maxLength={14} autoComplete="off" onChange={(e) => { setFssai(e.target.value.replace(/\D/g, '')); setDone(''); }} />
        </label>
        <Note ok={done === 'info'} error={error.info} />
        <div className="m-dialog-actions">
          <button data-testid="set-info-save" className="primary" disabled={busy !== '' || !infoOk || !infoChanged}
            title={!infoOk ? 'FSSAI is 14 digits' : !infoChanged ? 'Nothing changed' : undefined} onClick={() => put('info')}>{busy === 'info' ? 'Saving…' : 'Save details'}</button>
        </div>
      </div>
      <div className="m-form">
        <label className="m-field inline">
          <input data-testid="set-gst-on" type="checkbox" checked={gstOn} onChange={(e) => { setGstOn(e.target.checked); setDone(''); }} /> Charge GST at this outlet
        </label>
        <label className="m-field">GSTIN
          <input data-testid="set-gstin" value={gstin} maxLength={15} autoComplete="off" placeholder="15 characters" disabled={!gstOn && !gstin}
            onChange={(e) => { setGstin(e.target.value.toUpperCase()); setDone(''); }} />
        </label>
        <p className="muted">Switching GST off charges 0% on every item. Items keep their rates.</p>
        <Note ok={done === 'gst'} error={error.gst} />
        <div className="m-dialog-actions">
          <button data-testid="set-gst-save" className="primary" disabled={busy !== '' || !gstOk || !gstChanged}
            title={!gstOk ? 'Enter a valid GSTIN to charge GST' : !gstChanged ? 'Nothing changed' : undefined} onClick={() => put('gst')}>{busy === 'gst' ? 'Saving…' : 'Save GST'}</button>
        </div>
      </div>
    </section>
  );
}
