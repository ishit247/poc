import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { parseGstBp } from '@pos/shared';
import { shrinkImage } from '@pos/shared/browser';
import { api } from './api.ts';
import { Modal } from './Modal.tsx';
import { Thumb, pickPicture, savePicture } from './ItemPicture.tsx';
import {
  MAX_OPS, addCat, addRow, buildApply, catIssues, deleteRows, editCat, editRow, fromMenu, importCsv, isNew, menuToCsv, moveRows, pasteCells, problemKeys,
  record, redo, removeCat, rowIssues, setGst, setHsn, shownRows, startHistory, undo, type CsvCol, type CsvImport, type DRow, type DTag, type Diet, type Draft,
  type Field, type History, type MenuPayload,
} from './menuDraft.ts';

// The manager's menu editor (docs/manager-menu-editor-plan.md). Online only: the grid edits a local draft of the live menu,
// and Save sends the whole difference to POST /menu/apply, which applies all of it or none. Pictures are chosen in the grid
// and uploaded right after the menu is saved, so a new item has an id to attach them to.

const DIETS: { v: Diet | ''; t: string }[] = [{ v: '', t: '—' }, { v: 'veg', t: 'Veg' }, { v: 'egg', t: 'Egg' }, { v: 'non_veg', t: 'Non-veg' }];
const FAIL_TEXT: Record<string, string> = {
  'code in use': 'That code is already used. To swap two codes, save in two steps.',
  'no free code': 'No free code is left here.',
  'tag name in use': 'That tag name is already used.',
  'category has items': 'Move or delete the items in this category first.',
  'not found': 'This changed on another device. Reload and make the change again.',
  'category not found': 'This category changed on another device. Reload and try again.',
  'tag not found': 'This tag changed on another device. Reload and try again.',
};

const COL_TEXT: Record<CsvCol, string> = {
  id: 'id', category: 'category', name: 'name', code: 'quick code', diet: 'diet', hsn: 'HSN', gst: 'GST %', price_counter: 'counter price',
  price_zomato: 'Zomato price', price_swiggy: 'Swiggy price', tags: 'tags', description: 'description',
};
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const download = (name: string, text: string) => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};
const pickCsvFile = (onFile: (f: File) => void) => {
  const i = document.createElement('input');
  i.type = 'file';
  i.accept = '.csv,text/csv';
  i.onchange = () => { const f = i.files?.[0]; if (f) onFile(f); };
  i.click();
};

function useOnline() {
  const [on, setOn] = useState(navigator.onLine);
  useEffect(() => {
    const up = () => setOn(true), down = () => setOn(false);
    window.addEventListener('online', up); window.addEventListener('offline', down);
    return () => { window.removeEventListener('online', up); window.removeEventListener('offline', down); };
  }, []);
  return on;
}

const focusCell = (col: string, row: number) => {
  const el = document.querySelector<HTMLInputElement>(`[data-cell="${col}:${row}"]`);
  el?.focus(); el?.select();
};

/** A text cell that commits on blur or Enter (so one edit is one undo step), moves with the arrow keys, takes a pasted block. */
function Cell({ value, onCommit, col, row, bad, ro, className, label, inputMode, onBlock }: {
  value: string; onCommit: (v: string) => void; col: string; row: number; bad?: string; ro: boolean; className?: string; label: string;
  inputMode?: 'decimal' | 'numeric'; onBlock?: (text: string) => void;
}) {
  return (
    <input
      key={value} defaultValue={value} className={`${className ?? ''}${bad ? ' bad' : ''}`} data-col={col} data-cell={`${col}:${row}`}
      disabled={ro} aria-label={label} aria-invalid={!!bad} title={bad} inputMode={inputMode} autoComplete="off"
      onBlur={(e) => { if (e.target.value !== value) onCommit(e.target.value); }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') { e.currentTarget.value = value; e.currentTarget.blur(); }
        else if (e.key === 'Enter' || e.key === 'ArrowDown') { e.preventDefault(); focusCell(col, row + 1); if (!document.querySelector(`[data-cell="${col}:${row + 1}"]`)) e.currentTarget.blur(); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); focusCell(col, row - 1); }
      }}
      onPaste={(e) => {
        const t = e.clipboardData.getData('text');
        if (onBlock && /[\t\n]/.test(t.replace(/\n$/, ''))) { e.preventDefault(); onBlock(t); }
      }}
    />
  );
}

export function MenuEditor({ token, onDirty }: { token: string; onDirty?: (dirty: boolean) => void }) {
  const online = useOnline();
  const [server, setServer] = useState<MenuPayload | null>(null);
  const [hist, setHist] = useState<History>(() => startHistory({ cats: [], rows: [], tags: [] }));
  const [pics, setPics] = useState<Map<string, Blob | null>>(new Map());
  const [catKey, setCatKey] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [onlyBad, setOnlyBad] = useState(false);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [bulkGst, setBulkGst] = useState('');
  const [bulkHsn, setBulkHsn] = useState('');
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<'delete' | 'discard' | null>(null);
  const [csv, setCsv] = useState<'menu' | (CsvImport & { file: string }) | null>(null); // the CSV dialog, then an import's preview
  const [failed, setFailed] = useState<Map<string, string>>(new Map());
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false); // the menu changed on another device: only Reload helps
  const focusAfter = useRef<string | null>(null);

  const cur = hist.present;
  const base = useMemo(() => (server ? fromMenu(server) : null), [server]);
  const change = useMemo(() => (server && base ? buildApply(base, cur, server.prices) : null), [server, base, cur]);
  const problems = useMemo(() => problemKeys(cur), [cur]);
  const dirty = !!change || pics.size > 0;
  const ro = !online || saving;

  const load = useCallback(async () => {
    setError(''); setConflict(false);
    try {
      const r = await api('/menu', token);
      if (r.status !== 200) return setError('Your session has ended. Sign in again.');
      const m = r.body as MenuPayload;
      setServer(m); setHist(startHistory(fromMenu(m))); setPics(new Map()); setSel(new Set()); setFailed(new Map());
    } catch { setError('Could not reach the server.'); }
  }, [token]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (catKey && !cur.cats.some((c) => c.key === catKey)) setCatKey(null); }, [cur, catKey]); // its category is gone
  useEffect(() => { onDirty?.(dirty); }, [dirty, onDirty]);
  useEffect(() => () => onDirty?.(false), [onDirty]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  // Ctrl+Z / Ctrl+Y outside a text box walk the edits (inside one, the browser undoes the typing).
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (!(e.ctrlKey || e.metaKey) || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
      if (e.key === 'z' && !e.shiftKey) { e.preventDefault(); setHist(undo); }
      else if (e.key === 'y' || (e.key === 'z' && e.shiftKey)) { e.preventDefault(); setHist(redo); }
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, []);
  useEffect(() => {
    const k = focusAfter.current;
    if (k) { focusAfter.current = null; document.querySelector<HTMLInputElement>(`[data-rowkey="${k}"] [data-col="name"], [data-catname="${k}"]`)?.focus(); }
  });

  const change$ = (f: (d: Draft) => Draft) => setHist((h) => record(h, f(h.present)));
  const rows = useMemo(() => shownRows(cur, { categoryKey: catKey, search, onlyProblems: onlyBad }), [cur, catKey, search, onlyBad]);
  const shownKeys = useMemo(() => rows.map((r) => r.key), [rows]);
  const counts = useMemo(() => {
    const n = new Map<string, { items: number; bad: boolean }>();
    for (const c of cur.cats) n.set(c.key, { items: 0, bad: problems.has(c.key) });
    for (const r of cur.rows) { const e = n.get(r.categoryKey); if (e) { e.items++; if (problems.has(r.key)) e.bad = true; } }
    return n;
  }, [cur, problems]);
  const cat = catKey ? cur.cats.find((c) => c.key === catKey) : undefined;
  const selected = [...sel].filter((k) => cur.rows.some((r) => r.key === k));
  const addTarget = cat?.key ?? null;

  const saveBlocked = !online ? 'Needs a connection.'
    : problems.size ? `Fix ${problems.size} ${problems.size === 1 ? 'problem' : 'problems'} first (turn on "Only problems").`
    : !dirty ? 'No changes to save.'
    : change && change.ops > MAX_OPS ? `Too many changes at once (${change.ops}; the most is ${MAX_OPS}). Save in smaller parts.`
    : saving ? 'Saving…' : '';

  const failWith = (status: number, body: { error?: string; op?: { list: string; index: number } }) => {
    const text = FAIL_TEXT[body.error ?? ''] ?? (status === 401 || status === 403 ? 'Your session has ended. Sign in again.' : 'Could not save. Nothing was changed.');
    const key = body.op && change ? change.origin.get(`${body.op.list}:${body.op.index}`) : undefined;
    if (key) { setFailed(new Map([[key, text]])); setCatKey(null); setSearch(''); setOnlyBad(false); } // so the marked row is on screen
    setConflict(/^(category |tag )?not found$/.test(body.error ?? ''));
    setError(`Nothing was saved. ${text}`);
  };

  const save = async () => {
    if (!server || saveBlocked) return;
    setSaving(true); setError(''); setFailed(new Map());
    try {
      let refs: Record<string, string> = {};
      if (change) {
        const r = await api('/menu/apply', token, { method: 'POST', body: JSON.stringify(change.body) });
        if (r.status !== 200) return failWith(r.status, r.body as { error?: string; op?: { list: string; index: number } });
        refs = (r.body as { refs: Record<string, string> }).refs;
      }
      const live = new Set(cur.rows.map((r) => r.key));
      const left = new Map<string, Blob | null>();
      const why = new Map<string, string>();
      for (const [key, blob] of pics) {
        if (!live.has(key)) continue;
        const id = refs[key] ?? key;
        const e = await savePicture(token, id, blob);
        if (e) { left.set(id, blob); why.set(id, e); }
      }
      const g = await api('/menu', token);
      if (g.status !== 200) return setError('Saved, but the menu could not be reloaded. Reload the tab.');
      const m = g.body as MenuPayload;
      setServer(m); setHist(startHistory(fromMenu(m))); setPics(left); setSel(new Set()); setFailed(why);
      setCatKey((k) => (k ? refs[k] ?? k : k)); setOpenKey(null); // a category made in this change now has its real id
      if (left.size) setError(`Menu saved. ${left.size} ${left.size === 1 ? 'picture' : 'pictures'} did not save: pick them again and Save.`);
    } catch { setError('Could not reach the server. Reload to see what was saved.'); } finally { setSaving(false); }
  };

  const choosePicture = (key: string) => pickPicture((f) => {
    void shrinkImage(f).then((blob) => setPics((p) => new Map(p).set(key, blob)), (e: unknown) => setError(e instanceof Error ? e.message : 'Could not use that picture.'));
  });
  const removePicture = (key: string) => setPics((p) => {
    const n = new Map(p);
    if (isNew(key)) n.delete(key); else n.set(key, null);
    return n;
  });

  const readCsv = () => pickCsvFile((f) => {
    f.text().then((text) => setCsv({ ...importCsv(cur, text), file: f.name }), () => setError('Could not read that file.'));
  });
  const loadImport = (r: CsvImport) => {
    change$(() => r.draft); // one undo step
    setCatKey(null); setSearch(''); setOnlyBad(r.bad > 0); setSel(new Set()); setCsv(null);
  };

  const addItem = () => {
    if (!addTarget) return;
    const d = addRow(cur, addTarget);
    focusAfter.current = d.rows[d.rows.length - 1]!.key; // its name cell takes focus once it renders
    change$(() => d);
  };

  if (!server) {
    return (
      <main className="me" data-testid="mgr-menu">
        {error ? <div className="m-alert bad" role="alert"><span>⚠</span><div className="grow">{error}</div><button onClick={() => void load()}>Try again</button></div>
          : <p className="muted">Loading…</p>}
      </main>
    );
  }

  const open = openKey ? cur.rows.find((r) => r.key === openKey) : undefined;
  const pendingFor = (r: DRow) => pics.get(r.key);
  const hasPicture = (r: DRow) => (pendingFor(r) === undefined ? !!r.sha : pendingFor(r) !== null);
  const rowCats = cur.cats;

  return (
    <main className="me" data-testid="mgr-menu">
      {!online && <div className="m-alert info" role="status"><span>⚠</span><div className="grow">The menu needs a connection. You can look, not change, until it is back.</div></div>}
      {error && <div className="m-alert bad" role="alert"><span>⚠</span><div className="grow">{error}</div>{conflict && <button onClick={() => void load()}>Reload</button>}</div>}

      <div className="me-bar">
        <span title={saveBlocked}>
          <button className="primary" data-testid="me-save" disabled={!!saveBlocked} onClick={() => void save()}>{saving ? 'Saving…' : 'Save'}</button>
        </span>
        <button data-testid="me-discard" disabled={!dirty || ro} title={!dirty ? 'No changes to discard.' : ''} onClick={() => setConfirm('discard')}>Discard</button>
        <button aria-label="Undo" title={hist.past.length ? 'Undo' : 'Nothing to undo.'} disabled={!hist.past.length || ro} onClick={() => setHist(undo)}>↶</button>
        <button aria-label="Redo" title={hist.future.length ? 'Redo' : 'Nothing to redo.'} disabled={!hist.future.length || ro} onClick={() => setHist(redo)}>↷</button>
        <span className="me-status" aria-live="polite">
          {saving ? 'Saving…' : dirty ? `${change?.ops ?? 0} ${change?.ops === 1 ? 'change' : 'changes'}${pics.size ? `, ${pics.size} ${pics.size === 1 ? 'picture' : 'pictures'}` : ''}` : 'Saved'}
          {problems.size > 0 && <b className="bad"> · {problems.size} to fix</b>}
        </span>
        <input type="search" className="me-search" placeholder="Search name or code" aria-label="Search items" value={search} onChange={(e) => setSearch(e.target.value)} />
        <button className={onlyBad ? 'active' : ''} aria-pressed={onlyBad} onClick={() => setOnlyBad(!onlyBad)}>Only problems</button>
        <span title={ro ? 'Needs a connection.' : !addTarget ? 'Choose a category on the left first.' : ''}>
          <button data-testid="me-add-item" disabled={ro || !addTarget} onClick={addItem}>+ Item</button>
        </span>
        <button data-testid="me-csv" title="Export the menu to a spreadsheet, or load one back" onClick={() => setCsv('menu')}>CSV</button>
      </div>

      <div className="me-bulk" data-testid="me-bulk">
        <b>{selected.length ? `${selected.length} selected` : 'None selected'}</b>
        <label>GST % <input value={bulkGst} onChange={(e) => setBulkGst(e.target.value)} inputMode="decimal" className="w-sm" /></label>
        <button disabled={ro || !selected.length || parseGstBp(bulkGst) === null} title={!selected.length ? 'Tick items first.' : parseGstBp(bulkGst) === null ? 'Type a GST % from 0 to 40.' : ''}
          onClick={() => { change$((d) => setGst(d, selected, bulkGst.trim())); setBulkGst(''); }}>Set GST</button>
        <label>HSN <input value={bulkHsn} onChange={(e) => setBulkHsn(e.target.value)} inputMode="numeric" className="w-sm" /></label>
        <button disabled={ro || !selected.length || !/^[0-9]{4,8}$/.test(bulkHsn.trim())} title={!selected.length ? 'Tick items first.' : 'Type a 4 to 8 digit HSN/SAC.'}
          onClick={() => { change$((d) => setHsn(d, selected, bulkHsn.trim())); setBulkHsn(''); }}>Set HSN</button>
        <select aria-label="Move selected to" disabled={ro || !selected.length} value="" title={!selected.length ? 'Tick items first.' : ''}
          onChange={(e) => { if (e.target.value) change$((d) => moveRows(d, selected, e.target.value)); }}>
          <option value="">Move to…</option>
          {rowCats.map((c) => <option key={c.key} value={c.key}>{c.name || '(new category)'}</option>)}
        </select>
        <button className="danger" data-testid="me-delete" disabled={ro || !selected.length} title={!selected.length ? 'Tick items first.' : ''} onClick={() => setConfirm('delete')}>Delete</button>
      </div>

      <div className="me-body">
        <nav className="me-rail" aria-label="Categories">
          <button className={catKey === null ? 'active' : ''} onClick={() => setCatKey(null)}>All items <span className="n">{cur.rows.length}</span></button>
          {cur.cats.map((c) => {
            const n = counts.get(c.key);
            return (
              <button key={c.key} className={catKey === c.key ? 'active' : ''} data-testid={`me-cat-${c.name}`} onClick={() => setCatKey(c.key)}>
                <span className="nm">{c.name || '(new category)'}</span>
                {(n?.bad || failed.has(c.key)) && <span className="dot" aria-label="needs attention" />}
                <span className="n">{n?.items ?? 0}</span>
              </button>
            );
          })}
          <button data-testid="me-add-cat" disabled={ro} onClick={() => { const r = addCat(cur); change$(() => r.draft); setCatKey(r.key); focusAfter.current = r.key; }}>+ Category</button>
        </nav>

        <section className="me-main">
          {cat && (
            <div className="me-cathead">
              <input
                key={cat.name} defaultValue={cat.name} data-catname={cat.key} aria-label="Category name" disabled={ro}
                className={catIssues(cat, cur).name ? 'bad' : ''} title={catIssues(cat, cur).name}
                onBlur={(e) => { if (e.target.value !== cat.name) change$((d) => editCat(d, cat.key, { name: e.target.value })); }}
              />
              <label>Code <input key={cat.code} defaultValue={cat.code} aria-label="Category code" disabled={ro} inputMode="numeric" className={`w-sm${catIssues(cat, cur).code ? ' bad' : ''}`} title={catIssues(cat, cur).code}
                onBlur={(e) => { if (e.target.value !== cat.code) change$((d) => editCat(d, cat.key, { code: e.target.value })); }} /></label>
              <span title={counts.get(cat.key)?.items ? 'Move or delete its items first.' : ''}>
                <button className="danger" data-testid="me-del-cat" disabled={ro || !!counts.get(cat.key)?.items} onClick={() => { change$((d) => removeCat(d, cat.key)); setCatKey(null); }}>Delete category</button>
              </span>
              {failed.get(cat.key) && <span className="me-note">{failed.get(cat.key)}</span>}
            </div>
          )}

          <div className="me-grid" role="grid" aria-label="Items">
            <div className="me-row head" role="row">
              <label className="me-chk"><input type="checkbox" aria-label="Select all shown" disabled={!rows.length || ro}
                checked={rows.length > 0 && rows.every((r) => sel.has(r.key))}
                onChange={(e) => setSel(e.target.checked ? new Set(shownKeys) : new Set())} /></label>
              <span /><span>Name</span><span>Code</span><span className="num">Counter ₹</span><span className="num c-zom">Zomato ₹</span><span className="num c-swg">Swiggy ₹</span>
              <span className="num">GST %</span><span className="c-hsn">HSN</span><span className="c-diet">Diet</span><span />
            </div>
            {rows.map((r, n) => {
              const bad = rowIssues(r, cur);
              const block = (col: Field) => (text: string) => change$((d) => pasteCells(d, shownKeys, n, ['name', 'code', 'counter', 'zomato', 'swiggy', 'gst', 'hsn', 'diet', 'desc'].indexOf(col), text, r.categoryKey));
              const cell = (col: Field, label: string, className?: string, inputMode?: 'decimal' | 'numeric') => (
                <Cell value={r[col as 'name']} col={col} row={n} bad={bad[col]} ro={ro} label={`${label}, ${r.name || 'new item'}`} className={className} inputMode={inputMode}
                  onCommit={(v) => change$((d) => editRow(d, r.key, { [col]: v.trim() }))} onBlock={block(col)} />
              );
              return (
                <div key={r.key} className={`me-row${problems.has(r.key) || failed.has(r.key) ? ' has-bad' : ''}`} role="row" data-rowkey={r.key}>
                  <label className="me-chk"><input type="checkbox" aria-label={`Select ${r.name || 'new item'}`} disabled={ro} checked={sel.has(r.key)}
                    onChange={(e) => setSel((s) => { const x = new Set(s); if (e.target.checked) x.add(r.key); else x.delete(r.key); return x; })} /></label>
                  <button className="me-pic" aria-label={`Change picture, ${r.name || 'new item'}`} disabled={ro} onClick={() => choosePicture(r.key)}>
                    <Thumb token={token} sha={r.sha} pending={pendingFor(r)} />
                  </button>
                  {cell('name', 'Name', 'c-name')}
                  {cell('code', 'Code', 'c-code', 'numeric')}
                  {cell('counter', 'Counter price', 'num', 'decimal')}
                  <span className="c-zom">{cell('zomato', 'Zomato price', 'num', 'decimal')}</span>
                  <span className="c-swg">{cell('swiggy', 'Swiggy price', 'num', 'decimal')}</span>
                  {cell('gst', 'GST %', 'num', 'decimal')}
                  <span className="c-hsn">{cell('hsn', 'HSN', undefined, 'numeric')}</span>
                  <select className="c-diet" aria-label={`Diet, ${r.name || 'new item'}`} disabled={ro} value={r.diet} onChange={(e) => change$((d) => editRow(d, r.key, { diet: e.target.value as Diet | '' }))}>
                    {DIETS.map((o) => <option key={o.v} value={o.v}>{o.t}</option>)}
                  </select>
                  <button className="me-more" aria-label={`More details, ${r.name || 'new item'}`} onClick={() => setOpenKey(r.key)}>⋯</button>
                  {failed.get(r.key) && <div className="me-note">{failed.get(r.key)}</div>}
                </div>
              );
            })}
            {!rows.length && <p className="muted me-empty">{onlyBad ? 'No problems.' : search ? 'No item matches.' : cur.cats.length ? 'No items here yet. Use + Item.' : 'No categories yet. Use + Category.'}</p>}
          </div>
        </section>
      </div>

      {open && (
        <Modal title={open.name || 'New item'} onClose={() => setOpenKey(null)}>
          <Details r={open} token={token} tags={cur.tags} cats={cur.cats} pending={pendingFor(open)} hasPicture={hasPicture(open)} ro={ro} d={cur}
            edit={(patch) => change$((d) => editRow(d, open.key, patch))} choose={() => choosePicture(open.key)} remove={() => removePicture(open.key)} />
          <div className="actions"><button className="primary" onClick={() => setOpenKey(null)}>Done</button></div>
        </Modal>
      )}
      {confirm === 'delete' && (
        <Modal title={`Delete ${selected.length} ${selected.length === 1 ? 'item' : 'items'}?`} onClose={() => setConfirm(null)}>
          <p>Past sales keep the item&apos;s name. The items go from every tablet when you Save.</p>
          <div className="actions"><button onClick={() => setConfirm(null)}>Keep</button>
            <button className="danger" data-testid="me-confirm-delete" onClick={() => { change$((d) => deleteRows(d, selected)); setSel(new Set()); setConfirm(null); }}>Delete</button></div>
        </Modal>
      )}
      {csv === 'menu' && base && (
        <Modal title="Menu as a spreadsheet" onClose={() => setCsv(null)}>
          <p>Export, change the file in Excel or Google Sheets, then import it. Import only fills the grid: check it, then Save.
            It never deletes items, and pictures are not in the file.</p>
          <div className="me-csv-choices">
            <button data-testid="me-export" onClick={() => { download(`menu-${new Date().toISOString().slice(0, 10)}.csv`, menuToCsv(base)); setCsv(null); }}>
              Export the saved menu{dirty ? ' (without your unsaved changes)' : ''}
            </button>
            <span title={ro ? 'Needs a connection.' : ''}>
              <button data-testid="me-import" disabled={ro} onClick={readCsv}>Import a CSV file…</button>
            </span>
          </div>
          <div className="actions"><button onClick={() => setCsv(null)}>Close</button></div>
        </Modal>
      )}
      {csv && csv !== 'menu' && (
        <Modal title={`Import ${csv.file}`} onClose={() => setCsv(null)}>
          <ImportPreview r={csv} />
          <div className="actions">
            <button onClick={() => setCsv(null)}>Cancel</button>
            <span title={csv.problems.length ? 'Fix the file and import it again.' : csv.draft === cur ? 'Nothing in the file differs from the menu.' : ''}>
              <button className="primary" data-testid="me-import-load" disabled={!!csv.problems.length || csv.draft === cur || ro} onClick={() => loadImport(csv)}>Load into the grid</button>
            </span>
          </div>
        </Modal>
      )}
      {confirm === 'discard' && (
        <Modal title="Discard your changes?" onClose={() => setConfirm(null)}>
          <p>Everything you changed since the last Save is lost.</p>
          <div className="actions"><button onClick={() => setConfirm(null)}>Keep editing</button>
            <button className="danger" data-testid="me-confirm-discard" onClick={() => { setConfirm(null); void load(); }}>Discard</button></div>
        </Modal>
      )}
    </main>
  );
}

/** What an import would do, before it touches the grid. */
function ImportPreview({ r }: { r: CsvImport }) {
  if (r.problems.length) {
    return (
      <div className="me-import" data-testid="me-import-preview">
        <p><b className="bad">{plural(r.problems.length, 'problem')}</b>, so nothing was loaded. Fix the file and import it again.</p>
        <ul>{r.problems.slice(0, 8).map((p) => <li key={p}>{p}</li>)}</ul>
        {r.problems.length > 8 && <p className="muted">and {r.problems.length - 8} more.</p>}
      </div>
    );
  }
  const keep = r.absent.filter((c) => c !== 'id');
  return (
    <div className="me-import" data-testid="me-import-preview">
      <p className="me-import-sum">
        <b>{r.changed}</b> changed · <b>{r.added}</b> new · <b>{r.unchanged}</b> unchanged · <b className={r.bad ? 'bad' : ''}>{r.bad}</b> {r.bad === 1 ? 'problem' : 'problems'}
      </p>
      {(r.newCats > 0 || r.newTags > 0) && <p>Adds {[r.newCats && plural(r.newCats, 'category', 'categories'), r.newTags && plural(r.newTags, 'tag')].filter(Boolean).join(' and ')}.</p>}
      {keep.length > 0 && <p>Not in the file, so left as they are: {keep.map((c) => COL_TEXT[c]).join(', ')}.</p>}
      {r.ignored.length > 0 && <p className="muted">Columns not used: {r.ignored.join(', ')}.</p>}
      <p className="muted">An empty price cell stops selling the item on that channel. Items not in the file stay as they are.
        {r.bad > 0 && ' The rows with problems are marked in the grid; fix them there before you Save.'} Nothing is saved until you press Save.</p>
    </div>
  );
}

/** One item's details, including what the narrow grid hides: other channel prices, HSN, diet, description, tags, picture. */
function Details({ r, d, token, tags, cats, pending, hasPicture, ro, edit, choose, remove }: {
  r: DRow; d: Draft; token: string; tags: DTag[]; cats: Draft['cats']; pending: Blob | null | undefined; hasPicture: boolean; ro: boolean;
  edit: (patch: Partial<DRow>) => void; choose: () => void; remove: () => void;
}) {
  const bad = rowIssues(r, d);
  const f = (col: Field, label: string, inputMode?: 'decimal' | 'numeric') => (
    <label>{label}<Cell value={r[col as 'name']} col={`d-${col}`} row={0} bad={bad[col]} ro={ro} label={label} inputMode={inputMode} onCommit={(v) => edit({ [col]: v.trim() })} />
      {bad[col] && <small className="err">{bad[col]}</small>}</label>
  );
  return (
    <div className="me-details">
      <div className="me-pic-big">
        <Thumb token={token} sha={r.sha} pending={pending} size={96} />
        <div><button disabled={ro} onClick={choose}>{hasPicture ? 'Change picture' : 'Add picture'}</button>{' '}
          <button disabled={ro || !hasPicture} title={!hasPicture ? 'No picture.' : ''} onClick={remove}>Remove picture</button></div>
      </div>
      {f('name', 'Name')}
      <div className="two">{f('code', 'Quick code', 'numeric')}
        <label>Category<select disabled={ro} value={r.categoryKey} onChange={(e) => edit({ categoryKey: e.target.value })}>
          {cats.map((c) => <option key={c.key} value={c.key}>{c.name || '(new category)'}</option>)}</select></label></div>
      <div className="two three">{f('counter', 'Counter ₹', 'decimal')}{f('zomato', 'Zomato ₹', 'decimal')}{f('swiggy', 'Swiggy ₹', 'decimal')}</div>
      <p className="muted">An empty price means it is not sold on that channel.</p>
      <div className="two">{f('gst', 'GST %', 'decimal')}{f('hsn', 'HSN / SAC', 'numeric')}</div>
      <label>Diet<select disabled={ro} value={r.diet} onChange={(e) => edit({ diet: e.target.value as Diet | '' })}>{DIETS.map((o) => <option key={o.v} value={o.v}>{o.t}</option>)}</select></label>
      <label>Description
        <textarea key={r.desc} defaultValue={r.desc} rows={3} disabled={ro} aria-invalid={!!bad.desc} onBlur={(e) => { if (e.target.value !== r.desc) edit({ desc: e.target.value.trim() }); }} />
        {bad.desc && <small className="err">{bad.desc}</small>}
      </label>
      {tags.length > 0 && (
        <div className="me-tags" role="group" aria-label="Tags">
          {tags.map((t) => {
            const on = r.tagIds.includes(t.key);
            return <button key={t.key} className={on ? 'active' : ''} aria-pressed={on} disabled={ro} onClick={() => edit({ tagIds: on ? r.tagIds.filter((x) => x !== t.key) : [...r.tagIds, t.key] })}>{t.name}</button>;
          })}
        </div>
      )}
    </div>
  );
}
