import { useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent, type MouseEvent } from 'react';
import { api, catalogImageUrl, parseGstBp, parsePaise, shrinkImage, uploadCatalogImage, type TemplateFull } from './api.ts';
import {
  CSV_TEMPLATE, DESC_MAX, IMPORT_FLAG, baseName, blankDraft, fromFileList, groupRows, isBlank, isImageFile, issues, pickCsv, readDropped,
  resolvePictures, rowHasIssues, rowsFromCsv, toCsv, uid, type BundleFile, type Draft, type DraftCat, type ParsedRow,
} from './catalogIO.ts';
import { Confirm, Modal } from './Modal.tsx';
import { toast } from './toast.tsx';

interface Doc { name: string; cats: DraftCat[] }
interface Loose { id: string; name: string; blob: Blob; url: string }
const FIELDS = ['name', 'hsn', 'gst', 'price', 'desc'] as const;
type Field = (typeof FIELDS)[number];
const blankDoc = (): Doc => ({ name: '', cats: [{ id: uid(), name: '', items: [blankDraft()] }] });
const download = (name: string, text: string) => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
};
const toDoc = (t: TemplateFull): Doc => ({
  name: t.name,
  cats: t.categories.map((c) => ({
    id: uid(), name: c.name,
    items: c.items.map((i) => ({ id: uid(), name: i.name, hsn: i.hsnCode ?? '', gst: String(i.gstRateBp / 100), price: (i.pricePaise / 100).toFixed(2), desc: i.description ?? '', sha: i.imageSha256, blob: null, preview: null })),
  })),
});
/** Shrinks a picture file for upload; a picture the browser cannot read or cannot make small enough is reported, not fatal. */
async function prepare(files: BundleFile[], progress?: (done: number, total: number) => void) {
  const ok = new Map<BundleFile, { blob: Blob; url: string }>(), failed: { name: string; why: string }[] = [];
  let n = 0;
  for (const f of files) {
    try { const blob = await shrinkImage(f.file); ok.set(f, { blob, url: URL.createObjectURL(blob) }); }
    catch (e) { failed.push({ name: baseName(f.path), why: e instanceof Error ? e.message : 'Could not read it.' }); }
    progress?.(++n, files.length);
  }
  return { ok, failed };
}

export function CatalogEditor({ id, isOwner, onDirty, go }: { id: string; isOwner: boolean; onDirty: (d: boolean) => void; go: (hash: string) => (e: MouseEvent) => void }) {
  const ro = !isOwner;
  const [doc, setDoc] = useState<Doc | null>(null);
  const saved = useRef<Doc | null>(null);
  const [missing, setMissing] = useState(false);
  const [undo, setUndo] = useState<Doc[]>([]);
  const [redo, setRedo] = useState<Doc[]>([]);
  const [sel, setSel] = useState('all');
  const [q, setQ] = useState('');
  const [onlyIssues, setOnlyIssues] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [loose, setLoose] = useState<Loose[]>([]);
  const [importing, setImporting] = useState<BundleFile[] | null | 'open'>(null);
  const [asking, setAsking] = useState<'discard' | 'delcat' | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [nameErr, setNameErr] = useState(false);
  const [over, setOver] = useState(false);
  const [bulkGst, setBulkGst] = useState('');
  const [bulkHsn, setBulkHsn] = useState('');
  const docRef = useRef<Doc | null>(null);
  const pre = useRef<Doc | null>(null);
  const focusNext = useRef<{ rid: string; f: Field } | null>(null);
  docRef.current = doc;

  // ---- load ----
  useEffect(() => {
    if (id === 'new') {
      const d = blankDoc();
      saved.current = d; setDoc(d); setSel(d.cats[0]!.id);
      let flag = false;
      try { flag = sessionStorage.getItem(IMPORT_FLAG) === '1'; sessionStorage.removeItem(IMPORT_FLAG); } catch { /* ignore */ }
      if (flag) setImporting('open');
      return;
    }
    void api<TemplateFull>(`/platform/catalog-templates/${id}`).then((r) => {
      if (r.status !== 200) return setMissing(true);
      const d = toDoc(r.body);
      saved.current = d; setDoc(d); setSel(d.cats[0]?.id ?? 'all');
    });
  }, [id]);
  const dirty = !!doc && doc !== saved.current;
  useEffect(() => { onDirty(dirty); }, [dirty, onDirty]);
  useEffect(() => () => onDirty(false), [onDirty]);
  useEffect(() => {
    if (!focusNext.current) return;
    const { rid, f } = focusNext.current; focusNext.current = null;
    const el = document.querySelector<HTMLInputElement>(`[data-rid="${rid}"][data-f="${f}"]`);
    el?.focus(); el?.select();
  });

  // ---- editing helpers (immutable updates, so history is just a stack of earlier documents) ----
  const change = useCallback((fn: (d: Doc) => Doc) => {
    const cur = docRef.current; if (!cur) return;
    setUndo((u) => [...u.slice(-59), cur]); setRedo([]); setDoc(fn(cur));
  }, []);
  const typing = (fn: (d: Doc) => Doc) => setDoc((d) => (d ? fn(d) : d));
  const onFocus = () => { pre.current = docRef.current; };
  const onBlur = () => { const p = pre.current; pre.current = null; if (p && p !== docRef.current) { setUndo((u) => [...u.slice(-59), p]); setRedo([]); } };
  const doUndo = () => { if (!undo.length || !doc) return; setRedo((r) => [...r, doc]); setDoc(undo[undo.length - 1]!); setUndo((u) => u.slice(0, -1)); };
  const doRedo = () => { if (!redo.length || !doc) return; setUndo((u) => [...u, doc]); setDoc(redo[redo.length - 1]!); setRedo((r) => r.slice(0, -1)); };
  const mapItem = (d: Doc, rid: string, fn: (i: Draft) => Draft): Doc => ({ ...d, cats: d.cats.map((c) => ({ ...c, items: c.items.map((i) => (i.id === rid ? fn(i) : i)) })) });
  const mapPicked = (d: Doc, fn: (i: Draft) => Draft): Doc => ({ ...d, cats: d.cats.map((c) => ({ ...c, items: c.items.map((i) => (picked.has(i.id) ? fn(i) : i)) })) });

  useEffect(() => {
    const key = (e: globalThis.KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) { e.preventDefault(); doUndo(); }
      else if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); doRedo(); }
      else if (k === 's') { e.preventDefault(); void save(); }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  });

  const cats = doc?.cats ?? [];
  const cat = cats.find((c) => c.id === sel);
  const all = useMemo(() => cats.flatMap((c) => c.items.filter((i) => !isBlank(i)).map((i) => [c, i] as const)), [doc]); // eslint-disable-line react-hooks/exhaustive-deps
  const bad = all.filter(([, i]) => rowHasIssues(i)).length;
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return cats.filter((c) => sel === 'all' || c.id === sel).flatMap((c) => c.items.map((i) => [c, i] as const))
      .filter(([, i]) => (!needle || `${i.name} ${i.hsn} ${i.desc}`.toLowerCase().includes(needle)) && (!onlyIssues || rowHasIssues(i)));
  }, [doc, sel, q, onlyIssues]); // eslint-disable-line react-hooks/exhaustive-deps

  const addRow = (afterId: string | null, then?: Field) => {
    const c = sel === 'all' ? (afterId ? cats.find((k) => k.items.some((i) => i.id === afterId)) : undefined) : cat;
    if (!c) return;
    const it = blankDraft();
    change((d) => ({ ...d, cats: d.cats.map((k) => k !== c && k.id !== c.id ? k : { ...k, items: (() => { const at = afterId ? k.items.findIndex((i) => i.id === afterId) + 1 : k.items.length; return [...k.items.slice(0, at), it, ...k.items.slice(at)]; })() }) }));
    focusNext.current = { rid: it.id, f: then ?? 'name' };
  };
  const addCategory = () => { const c: DraftCat = { id: uid(), name: '', items: [blankDraft()] }; change((d) => ({ ...d, cats: [...d.cats, c] })); setSel(c.id); setPicked(new Set()); };
  const moveCat = (dir: -1 | 1) => change((d) => { const i = d.cats.findIndex((c) => c.id === sel), j = i + dir; const next = [...d.cats]; [next[i], next[j]] = [next[j]!, next[i]!]; return { ...d, cats: next }; });
  const deleteCat = () => { change((d) => { const left = d.cats.filter((c) => c.id !== sel); return { ...d, cats: left.length ? left : [{ id: uid(), name: '', items: [blankDraft()] }] }; }); setSel('all'); };

  // ---- pictures ----
  const setPicture = async (rid: string, file: File | undefined) => {
    if (!file || !isImageFile(file)) return;
    try {
      const blob = await shrinkImage(file);
      change((d) => mapItem(d, rid, (i) => ({ ...i, blob, preview: URL.createObjectURL(blob), sha: null })));
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not use that picture.'); }
  };
  const pickPicture = (rid: string) => { const i = document.createElement('input'); i.type = 'file'; i.accept = 'image/*'; i.onchange = () => void setPicture(rid, i.files?.[0]); i.click(); };
  /** Pictures dropped on the grid or chosen with "Add images": matched to items by file name; the rest wait in a tray. */
  const addPictures = async (files: BundleFile[]) => {
    const pics = files.filter((f) => isImageFile(f.file));
    if (!pics.length) { toast('No pictures in that drop'); return; }
    const targets = all.map(([, i]) => i);
    const stubs: ParsedRow[] = targets.map((i) => ({ category: '', name: i.name, hsn: '', gst: '', price: '', desc: '', image: '' }));
    const res = resolvePictures(stubs, pics);
    setBusy(`Preparing ${pics.length} picture${pics.length === 1 ? '' : 's'}…`);
    const { ok, failed } = await prepare(pics, (d, t) => setBusy(`Preparing pictures ${d}/${t}…`));
    setBusy('');
    const byId = new Map<string, { blob: Blob; url: string }>();
    res.byRow.forEach((f, n) => { const p = ok.get(f); if (p) byId.set(targets[n]!.id, p); });
    if (byId.size) change((d) => ({ ...d, cats: d.cats.map((c) => ({ ...c, items: c.items.map((i) => { const p = byId.get(i.id); return p ? { ...i, blob: p.blob, preview: p.url, sha: null } : i; }) })) }));
    setLoose((l) => [...l, ...res.unused.flatMap((f) => { const p = ok.get(f); return p ? [{ id: uid(), name: baseName(f.path), blob: p.blob, url: p.url }] : []; })]);
    if (failed.length) setError(`${failed.length} picture${failed.length === 1 ? '' : 's'} skipped: ${failed.slice(0, 3).map((f) => `${f.name} (${f.why})`).join('; ')}`);
    toast(`${byId.size} picture${byId.size === 1 ? '' : 's'} matched${res.unused.length ? `, ${res.unused.length} need assigning` : ''}`);
  };
  const assignLoose = (l: Loose, rid: string) => {
    change((d) => mapItem(d, rid, (i) => ({ ...i, blob: l.blob, preview: l.url, sha: null })));
    setLoose((x) => x.filter((y) => y.id !== l.id));
  };

  // ---- grid events ----
  const cellKey = (e: KeyboardEvent<HTMLInputElement>, rid: string, f: Field) => {
    const ids = rows.map(([, i]) => i.id), k = ids.indexOf(rid);
    const go2 = (to: string) => { focusNext.current = { rid: to, f }; setDoc((d) => d && { ...d }); };
    if (e.key === 'Enter') { e.preventDefault(); if (k < ids.length - 1) go2(ids[k + 1]!); else if (sel !== 'all') addRow(rid, f); }
    if (e.key === 'ArrowDown' && k < ids.length - 1) { e.preventDefault(); go2(ids[k + 1]!); }
    if (e.key === 'ArrowUp' && k > 0) { e.preventDefault(); go2(ids[k - 1]!); }
  };
  const paste = (e: ClipboardEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement;
    if (!(t instanceof HTMLInputElement) || !t.dataset.rid || ro) return;
    const text = e.clipboardData.getData('text');
    if (!/[\t\n]/.test(text.trim())) return;
    e.preventDefault();
    const lines = text.replace(/\r/g, '').split('\n').filter((l) => l.length);
    const start = FIELDS.indexOf(t.dataset.f as Field);
    change((d) => {
      const c = d.cats.find((k) => k.items.some((i) => i.id === t.dataset.rid))!;
      const at = c.items.findIndex((i) => i.id === t.dataset.rid);
      const items = [...c.items];
      lines.forEach((ln, li) => {
        const base = items[at + li] ?? (items[at + li] = blankDraft());
        const next = { ...base };
        ln.split('\t').forEach((v, ci) => { const f = FIELDS[start + ci]; if (f) next[f] = v.trim(); });
        items[at + li] = next;
      });
      return { ...d, cats: d.cats.map((k) => (k.id === c.id ? { ...k, items } : k)) };
    });
    toast(`Pasted ${lines.length} row${lines.length === 1 ? '' : 's'}`);
  };
  const onDrop = async (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault(); setOver(false);
    if (ro) return;
    const thumb = (e.target as HTMLElement).closest<HTMLElement>('[data-thumb]');
    if (thumb && e.dataTransfer.files.length) { void setPicture(thumb.dataset.thumb!, e.dataTransfer.files[0]); return; }
    const files = await readDropped(e.dataTransfer);
    if (pickCsv(files).csv) setImporting(files); else void addPictures(files);
  };

  // ---- bulk ----
  const ids = [...picked];
  const bulkDelete = () => { change((d) => ({ ...d, cats: d.cats.map((c) => ({ ...c, items: c.items.filter((i) => !picked.has(i.id)) })) })); toast(`${ids.length} item${ids.length === 1 ? '' : 's'} deleted. Ctrl+Z to undo`); setPicked(new Set()); };
  const bulkDup = () => { change((d) => ({ ...d, cats: d.cats.map((c) => ({ ...c, items: c.items.flatMap((i) => (picked.has(i.id) ? [i, { ...i, id: uid(), name: `${i.name} (copy)` }] : [i])) })) })); setPicked(new Set()); };
  const bulkMove = (to: string) => {
    const moving = cats.flatMap((c) => c.items.filter((i) => picked.has(i.id)));
    change((d) => ({ ...d, cats: d.cats.map((c) => ({ ...c, items: c.id === to ? [...c.items, ...moving] : c.items.filter((i) => !picked.has(i.id)) })) }));
    setPicked(new Set());
  };

  // ---- save ----
  async function save() {
    const d = docRef.current;
    if (!d || ro || busy) return;
    setError('');
    if (!d.name.trim()) { setNameErr(true); document.getElementById('tpl-name')?.focus(); toast('Give the template a name'); return; }
    const withItems = d.cats.map((c) => ({ ...c, items: c.items.filter((i) => !isBlank(i)) })).filter((c) => c.items.length);
    if (!withItems.length) { setError('Add at least one item before saving.'); return; }
    const unnamed = withItems.find((c) => !c.name.trim());
    if (unnamed) { setSel(unnamed.id); setError('Every category needs a name.'); return; }
    const n = withItems.flatMap((c) => c.items).filter(rowHasIssues).length;
    if (n) { setOnlyIssues(true); setSel('all'); toast(`Fix ${n} issue${n === 1 ? '' : 's'} before saving`); return; }
    // pictures first, by content; the template then refers to them by hash
    const need = withItems.flatMap((c) => c.items).filter((i) => i.blob && !i.sha);
    const shas = new Map<string, string>();
    try {
      for (const [k, i] of need.entries()) { setBusy(`Uploading pictures ${k + 1}/${need.length}…`); shas.set(i.id, await uploadCatalogImage(i.blob!)); }
    } catch (e) { setBusy(''); setError(e instanceof Error ? e.message : 'Could not upload a picture.'); return; }
    setBusy('Saving…');
    const body = { name: d.name.trim(), categories: withItems.map((c) => ({ name: c.name.trim(), items: c.items.map((i) => {
      const sha = i.sha ?? shas.get(i.id);
      return { name: i.name.trim(), ...(i.hsn.trim() ? { hsnCode: i.hsn.trim() } : {}), ...(i.desc.trim() ? { description: i.desc.trim() } : {}), ...(sha ? { imageSha256: sha } : {}), gstRateBp: parseGstBp(i.gst)!, pricePaise: parsePaise(i.price)! };
    }) })) };
    const r = await api<TemplateFull>(id === 'new' ? '/platform/catalog-templates' : `/platform/catalog-templates/${id}`, { method: id === 'new' ? 'POST' : 'PUT', body });
    setBusy('');
    if (r.status === 200 || r.status === 201) { toast('Template saved'); onDirty(false); window.location.hash = `#/catalog/${r.body.id}`; return; }
    setError(r.status === 409 ? 'Another template already has that name.' : r.status === 403 ? 'Only an owner can do this.' : r.status === 404 ? 'This template was changed or deleted elsewhere. Go back to the list and open it again.'
      : r.status === 400 ? 'The server refused the template. Check the names, HSN codes, rates, prices and the number of distinct pictures.' : 'Could not save the template.');
  }

  if (missing) return <><p>Template not found.</p><p><a href="#/catalog" onClick={go('#/catalog')}>← Catalog</a></p></>;
  if (!doc) return <p>Loading…</p>;
  const leave = () => { window.location.hash = '#/catalog'; };
  const allPicked = rows.length > 0 && rows.every(([, i]) => picked.has(i.id));
  const setNameValue = (v: string) => { setNameErr(false); typing((d) => ({ ...d, name: v })); };

  return (
    <>
      <div className="crumbs"><a href="#/catalog" onClick={go('#/catalog')}>Catalog</a><span>›</span><b>{doc.name || 'New template'}</b></div>
      <div className="edbar">
        <input id="tpl-name" data-testid="tpl-name" className={`tname-in${nameErr ? ' err' : ''}`} value={doc.name} onChange={(e) => setNameValue(e.target.value)} onFocus={onFocus} onBlur={onBlur}
          placeholder="Template name, e.g. School cafeteria, North Indian" aria-label="Template name" disabled={ro} />
        <span className={`pill ${dirty ? 'warn' : 'ok'}`} data-testid="dirty"><i />{dirty ? 'Unsaved changes' : 'All changes saved'}</span>
        <button className={`pill ${bad ? 'bad' : 'ok'}`} data-testid="issues" style={{ cursor: 'pointer', border: '1px solid' }} aria-pressed={onlyIssues} title="Show only rows with issues" onClick={() => setOnlyIssues(!onlyIssues)}><i />{bad ? `${bad} issue${bad === 1 ? '' : 's'}` : 'No issues'}</button>
        <span className="sp" />
        {!ro && <button className="btn sm" data-testid="undo" disabled={!undo.length} title="Undo (Ctrl+Z)" onClick={doUndo}>↶ Undo</button>}
        {!ro && <button className="btn sm" disabled={!redo.length} title="Redo (Ctrl+Y)" aria-label="Redo" onClick={doRedo}>↷</button>}
        {!ro && <button className="btn sm" data-testid="import" onClick={() => setImporting('open')}>⬆ Import folder</button>}
        <button className="btn sm" data-testid="export" title="Downloads the data as CSV (pictures are not included)" onClick={() => { download(`${(doc.name || 'template').replace(/\W+/g, '-').toLowerCase()}.csv`, toCsv(doc.cats)); toast('CSV downloaded'); }}>⬇ Export CSV</button>
        {!ro && <button className="btn" data-testid="discard" onClick={() => (dirty ? setAsking('discard') : leave())}>{id === 'new' ? 'Cancel' : 'Discard'}</button>}
        {!ro && <button className="btn primary" data-testid="save" disabled={!!busy} onClick={() => void save()}>{busy || 'Save template'}</button>}
      </div>
      {error && <div className="alert bad" role="alert"><span>⚠</span><div className="grow">{error}</div><button className="btn sm ghost" onClick={() => setError('')}>Dismiss</button></div>}
      {loose.length > 0 && (
        <div className="alert warn" data-testid="loose"><span>⚠</span>
          <div className="grow"><b>{loose.length} picture{loose.length === 1 ? '' : 's'} didn’t match an item name.</b> Assign each one, or discard it.
            <div className="tray">
              {loose.map((l) => (
                <div className="tcard" key={l.id}><img src={l.url} alt="" />
                  <div style={{ minWidth: 0, flex: 1 }}><div className="tsub" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={l.name}>{l.name}</div>
                    <select aria-label={`Assign ${l.name} to`} value="" onChange={(e) => e.target.value && assignLoose(l, e.target.value)}>
                      <option value="">Assign to item…</option>
                      {all.map(([c, i]) => <option key={i.id} value={i.id}>{i.name} · {c.name || '?'}</option>)}
                    </select></div>
                  <button className="btn sm ghost" aria-label="Discard picture" onClick={() => setLoose((x) => x.filter((y) => y.id !== l.id))}>✕</button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
      <div className="ed">
        <aside className="cats" aria-label="Categories">
          <button className="catb" data-testid="cat-all" aria-current={sel === 'all'} onClick={() => { setSel('all'); setPicked(new Set()); }}>All items <span className="pill">{all.length}</span></button>
          {cats.map((c) => (
            <button key={c.id} className="catb" data-testid={`cat-${c.name}`} aria-current={sel === c.id} onClick={() => { setSel(c.id); setPicked(new Set()); }}>
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.name || 'Untitled category'}</span>
              {c.items.some(rowHasIssues) && <span className="pill bad" style={{ padding: '0 7px' }}>!</span>}
              <span className="pill">{c.items.filter((i) => !isBlank(i)).length}</span>
            </button>
          ))}
          {!ro && <button className="btn sm" data-testid="add-category" style={{ marginTop: 6 }} onClick={addCategory}>＋ Add category</button>}
        </aside>
        <section className="card" aria-label="Items">
          {sel !== 'all' && cat && (
            <div className="cathead">
              <input data-testid="cat-name" value={cat.name} placeholder="Category name" aria-label="Category name" disabled={ro} style={{ maxWidth: 320, fontWeight: 700 }}
                onFocus={onFocus} onBlur={onBlur} onChange={(e) => typing((d) => ({ ...d, cats: d.cats.map((c) => (c.id === sel ? { ...c, name: e.target.value } : c)) }))} />
              {!ro && <><span className="sp" />
                <button className="btn sm ghost" title="Move up" aria-label="Move category up" disabled={cats[0]?.id === sel} onClick={() => moveCat(-1)}>↑</button>
                <button className="btn sm ghost" title="Move down" aria-label="Move category down" disabled={cats[cats.length - 1]?.id === sel} onClick={() => moveCat(1)}>↓</button>
                <button className="btn sm danger" data-testid="delete-category" onClick={() => setAsking('delcat')}>Delete category</button></>}
            </div>
          )}
          <div className="gtool">
            <input type="search" data-testid="item-search" placeholder="Search items, HSN, description…" aria-label="Search items" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 300 }} />
            <span className="sp" />
            {!ro && <button className="btn sm" data-testid="add-images" onClick={() => { const i = document.createElement('input'); i.type = 'file'; i.accept = 'image/*'; i.multiple = true; i.onchange = () => void addPictures(fromFileList(i.files ?? [])); i.click(); }}>🖼 Add images…</button>}
            {!ro && <button className="btn sm primary" data-testid="add-item" disabled={sel === 'all'} title={sel === 'all' ? 'Pick a category first' : undefined} onClick={() => addRow(null)}>＋ Add item</button>}
          </div>
          {picked.size > 0 && !ro && (
            <div className="bulk" data-testid="bulk"><b>{picked.size} selected</b>
              <span className="bgrp">GST % <input data-testid="bulk-gst" value={bulkGst} onChange={(e) => setBulkGst(e.target.value)} placeholder="e.g. 12" style={{ width: 70 }} />
                <button className="btn sm" disabled={parseGstBp(bulkGst) === null} onClick={() => { change((d) => mapPicked(d, (i) => ({ ...i, gst: bulkGst.trim() }))); toast(`GST set on ${picked.size} items`); }}>Apply</button></span>
              <span className="bgrp">HSN/SAC <input data-testid="bulk-hsn" value={bulkHsn} onChange={(e) => setBulkHsn(e.target.value)} placeholder="e.g. 2106" style={{ width: 110 }} />
                <button className="btn sm" disabled={!/^[0-9]{4,8}$/.test(bulkHsn.trim())} onClick={() => { change((d) => mapPicked(d, (i) => ({ ...i, hsn: bulkHsn.trim() }))); toast(`HSN/SAC set on ${picked.size} items`); }}>Apply</button></span>
              <span className="bgrp">Move to <select aria-label="Move to category" value="" onChange={(e) => e.target.value && bulkMove(e.target.value)}><option value="">Choose…</option>{cats.map((c) => <option key={c.id} value={c.id}>{c.name || 'Untitled'}</option>)}</select></span>
              <span className="sp" /><button className="btn sm" onClick={bulkDup}>Duplicate</button><button className="btn sm danger" data-testid="bulk-delete" onClick={bulkDelete}>Delete</button><button className="btn sm ghost" onClick={() => setPicked(new Set())}>Clear</button>
            </div>
          )}
          <div className={`gridbox${over ? ' over' : ''}`} data-testid="grid" onPaste={paste}
            onDragOver={(e) => { if (!ro && [...e.dataTransfer.types].includes('Files')) { e.preventDefault(); setOver(true); } }}
            onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(false); }} onDrop={(e) => void onDrop(e)}>
            <div className="gh"><span><input type="checkbox" aria-label="Select all" checked={allPicked} disabled={ro} onChange={(e) => setPicked(e.target.checked ? new Set(rows.map(([, i]) => i.id)) : new Set())} /></span><span /><span>Item</span><span>HSN/SAC</span><span>GST %</span><span>Price ₹</span><span>{sel === 'all' ? 'Category' : 'Description'}</span><span /></div>
            {rows.length === 0 && <div className="empty">{q || onlyIssues ? 'No items match.' : 'No items in this category yet.'} {!ro && sel !== 'all' && !q && !onlyIssues && <button className="btn sm primary" onClick={() => addRow(null)}>＋ Add the first item</button>}</div>}
            {rows.map(([c, i]) => {
              const e = isBlank(i) ? {} : issues(i);
              const cell = (f: Field, ph: string, mode?: 'numeric' | 'decimal') => (
                <input className={`c${e[f] ? ' bad' : ''}`} data-rid={i.id} data-f={f} data-testid={`${f}-${i.id}`} value={i[f]} placeholder={ph} inputMode={mode} disabled={ro}
                  title={e[f]} aria-invalid={e[f] ? true : undefined} maxLength={f === 'desc' ? DESC_MAX + 20 : 120}
                  onFocus={onFocus} onBlur={onBlur} onChange={(ev) => typing((d) => mapItem(d, i.id, (r) => ({ ...r, [f]: ev.target.value })))} onKeyDown={(ev) => cellKey(ev, i.id, f)} />
              );
              return (
                <div className={`gr${picked.has(i.id) ? ' sel' : ''}`} key={i.id} data-row={i.id}>
                  <span><input type="checkbox" aria-label="Select row" checked={picked.has(i.id)} disabled={ro} onChange={(ev) => setPicked((p) => { const n = new Set(p); if (ev.target.checked) n.add(i.id); else n.delete(i.id); return n; })} /></span>
                  <button className="thumbbtn" data-thumb={i.id} data-testid={`thumb-${i.id}`} aria-label={i.sha || i.blob ? 'Change picture' : 'Add picture'} disabled={ro} onClick={() => pickPicture(i.id)}><Thumb row={i} /></button>
                  {cell('name', 'Item name')}{cell('hsn', '4–8 digits', 'numeric')}{cell('gst', '5', 'decimal')}{cell('price', '45 or 45.50', 'decimal')}
                  {sel === 'all'
                    ? <select className="c" aria-label="Category" value={c.id} disabled={ro} onChange={(ev) => { const to = ev.target.value; change((d) => ({ ...d, cats: d.cats.map((k) => (k.id === to ? { ...k, items: [...k.items, i] } : { ...k, items: k.items.filter((x) => x.id !== i.id) })) })); }}>{cats.map((k) => <option key={k.id} value={k.id}>{k.name || 'Untitled'}</option>)}</select>
                    : cell('desc', 'Description (optional)')}
                  <span style={{ display: 'flex', gap: 2 }}>{!ro && <>
                    <button className="btn sm ghost" title="Duplicate" aria-label="Duplicate row" onClick={() => change((d) => ({ ...d, cats: d.cats.map((k) => ({ ...k, items: k.items.flatMap((x) => (x.id === i.id ? [x, { ...x, id: uid(), name: `${x.name} (copy)` }] : [x])) })) }))}>⧉</button>
                    <button className="btn sm ghost" title="Delete" aria-label="Delete row" data-testid={`del-${i.id}`} onClick={() => { change((d) => ({ ...d, cats: d.cats.map((k) => ({ ...k, items: k.items.filter((x) => x.id !== i.id) })) })); toast('Row deleted. Ctrl+Z to undo'); }}>✕</button></>}</span>
                </div>
              );
            })}
          </div>
          <div className="gfoot"><span className="hint">Prices exclude GST. <b>Tips:</b> Enter adds a row · Tab moves across · paste rows copied from Excel or Sheets · drop a folder (a CSV and pictures) or pictures onto the grid.</span></div>
        </section>
      </div>
      {importing && (
        <ImportDialog initial={importing === 'open' ? [] : importing} onClose={() => setImporting(null)}
          onApply={(newCats, mode, strays) => {
            change((d) => {
              if (mode === 'replace') return { ...d, cats: newCats };
              const merged = d.cats.map((c) => ({ ...c, items: c.items.filter((i) => !isBlank(i)) }));
              for (const nc of newCats) { const ex = merged.find((c) => c.name.trim().toLowerCase() === nc.name.toLowerCase()); if (ex) ex.items = [...ex.items, ...nc.items]; else merged.push(nc); }
              return { ...d, cats: merged.filter((c) => c.items.length || c.name.trim()) };
            });
            setSel('all'); setPicked(new Set());
            if (strays.length) setLoose((l) => [...l, ...strays]);
            setImporting(null);
          }} />
      )}
      {asking === 'discard' && <Confirm title="Discard your changes?" message="Everything you changed in this template since the last save is lost." label="Discard" danger onClose={() => setAsking(null)} onYes={leave} />}
      {asking === 'delcat' && cat && <Confirm title={`Delete “${cat.name || 'Untitled category'}”?`} message={`${cat.items.filter((i) => !isBlank(i)).length} items in it will be removed. You can undo this.`} label="Delete category" danger onClose={() => setAsking(null)} onYes={deleteCat} />}
    </>
  );
}

function Thumb({ row }: { row: Draft }) {
  const [url, setUrl] = useState<string | null>(row.preview);
  useEffect(() => {
    let live = true;
    if (row.preview) setUrl(row.preview);
    else if (row.sha) { setUrl(null); void catalogImageUrl(row.sha).then((u) => { if (live) setUrl(u); }); }
    else setUrl(null);
    return () => { live = false; };
  }, [row.preview, row.sha]);
  return url ? <img src={url} alt="" /> : <>＋</>;
}

// ---------------------------------------------------------------------------------------------------------------
// Import: drop a folder (catalog.csv with an optional `image` column, plus the pictures) or choose it. Nothing changes
// in the template until the preview has been read and Import is pressed.
function ImportDialog({ initial, onClose, onApply }: {
  initial: BundleFile[]; onClose: () => void; onApply: (cats: DraftCat[], mode: 'append' | 'replace', strays: Loose[]) => void;
}) {
  const [files, setFiles] = useState<BundleFile[]>(initial);
  const [reading, setReading] = useState(false);
  const [rows, setRows] = useState<ParsedRow[] | null>(null);
  const [csvName, setCsvName] = useState('');
  const [extraCsv, setExtraCsv] = useState(0);
  const [mode, setMode] = useState<'append' | 'replace'>('append');
  const [progress, setProgress] = useState('');
  const [over, setOver] = useState(false);
  const [problem, setProblem] = useState('');

  useEffect(() => {
    if (!files.length) return;
    let live = true;
    (async () => {
      setReading(true); setProblem('');
      const { csv, extra } = pickCsv(files);
      if (!csv) { if (live) { setRows(null); setProblem('No .csv file found in what you dropped. The folder needs a catalog.csv next to (or above) the pictures.'); setReading(false); } return; }
      const parsed = rowsFromCsv(await csv.file.text());
      if (!live) return;
      setCsvName(csv.path); setExtraCsv(extra); setReading(false);
      if (!parsed.length) { setRows(null); setProblem('That CSV has no rows.'); return; }
      setRows(parsed);
    })();
    return () => { live = false; };
  }, [files]);

  const res = useMemo(() => (rows ? resolvePictures(rows, files) : null), [rows, files]);
  const drafts = useMemo(() => (rows ? groupRows(rows).flatMap((c) => c.items) : []), [rows]);
  const nIssues = useMemo(() => (rows ? rows.filter((r) => rowHasIssues({ ...blankDraft(), name: r.name, hsn: r.hsn, gst: r.gst, price: r.price, desc: r.desc })).length : 0), [rows]);
  const cats = useMemo(() => new Set((rows ?? []).map((r) => r.category.toLowerCase())).size, [rows]);
  const take = async (list: BundleFile[]) => { setFiles(list); };
  const choose = (kind: 'folder' | 'files') => {
    const i = document.createElement('input'); i.type = 'file'; i.multiple = true;
    if (kind === 'folder') (i as HTMLInputElement & { webkitdirectory: boolean }).webkitdirectory = true; else i.accept = '.csv,text/csv,image/*';
    i.onchange = () => void take(fromFileList(i.files ?? []));
    i.click();
  };

  const run = async () => {
    if (!rows || !res) return;
    setProgress('Preparing pictures…');
    const wanted = [...new Set([...res.byRow.values(), ...res.unused])];
    const { ok, failed } = await prepare(wanted, (d, t) => setProgress(`Preparing pictures ${d}/${t}…`));
    const pics = rows.map((_, n) => { const f = res.byRow.get(n); const p = f && ok.get(f); return p ? { ...blankDraft(), blob: p.blob, preview: p.url } : null; });
    const strays = res.unused.flatMap((f) => { const p = ok.get(f); return p ? [{ id: uid(), name: baseName(f.path), blob: p.blob, url: p.url }] : []; });
    onApply(groupRows(rows, pics), mode, strays);
    toast(`${rows.length} items imported${failed.length ? `, ${failed.length} picture${failed.length === 1 ? '' : 's'} skipped` : ''}`);
  };

  const withPic = res ? res.byRow.size : 0;
  return (
    <Modal title="Import a folder" onClose={onClose}>
      <div className="muted">Drop the folder that holds your <code>catalog.csv</code> and the pictures. The CSV’s <code>image</code> column names each item’s picture file; with no image column, pictures are matched to items by file name. Prices are rupees excluding GST.</div>
      {!rows && (
        <div className={`drop${over ? ' over' : ''}`} data-testid="import-drop"
          onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
          onDrop={(e) => { e.preventDefault(); setOver(false); void readDropped(e.dataTransfer).then(take); }}>
          <b>{reading ? 'Reading…' : 'Drop a folder here'}</b>
          <span className="muted">or</span>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
            <button className="btn sm primary" data-testid="choose-folder" onClick={() => choose('folder')}>Choose folder…</button>
            <button className="btn sm" data-testid="choose-files" onClick={() => choose('files')}>Choose files…</button>
            <button className="btn sm ghost" onClick={() => download('catalog.csv', CSV_TEMPLATE)}>Download CSV template</button>
          </div>
        </div>
      )}
      {problem && <div className="alert bad" role="alert"><span>⚠</span><div className="grow">{problem}</div></div>}
      {rows && res && (
        <div data-testid="import-preview" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div className="alert ok"><span>✓</span><div className="grow"><b>{rows.length} item{rows.length === 1 ? '' : 's'} in {cats} categor{cats === 1 ? 'y' : 'ies'}</b> from <code>{csvName}</code>.{extraCsv > 0 && <> {extraCsv} other CSV file{extraCsv === 1 ? ' was' : 's were'} ignored.</>}</div></div>
          <ul className="reqs" style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 4 }}>
            <li><b>{withPic}</b> of {rows.length} items have a picture{drafts.length - withPic > 0 && <>; {rows.length - withPic} don’t</>}.</li>
            {res.missing.length > 0 && <li className="error"><b>{res.missing.length}</b> picture name{res.missing.length === 1 ? ' is' : 's are'} in the CSV but not in the folder: {res.missing.slice(0, 4).map((m) => m.ref).join(', ')}{res.missing.length > 4 ? '…' : ''}</li>}
            {res.unused.length > 0 && <li><b>{res.unused.length}</b> picture{res.unused.length === 1 ? '' : 's'} not used by any item (they’ll wait in a tray to assign): {res.unused.slice(0, 4).map((f) => baseName(f.path)).join(', ')}{res.unused.length > 4 ? '…' : ''}</li>}
            {nIssues > 0 && <li className="error"><b>{nIssues}</b> row{nIssues === 1 ? ' has' : 's have'} problems. They’re still imported, marked in red, so you can fix them in the grid.</li>}
          </ul>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}><input type="radio" name="mode" checked={mode === 'append'} onChange={() => setMode('append')} style={{ width: 'auto', minHeight: 0 }} /> Add to this template</label>
            <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}><input type="radio" name="mode" checked={mode === 'replace'} onChange={() => setMode('replace')} style={{ width: 'auto', minHeight: 0 }} /> Replace everything</label>
          </div>
          {progress && <div><div className="hint">{progress}</div><div className="progress"><i style={{ width: '60%' }} /></div></div>}
        </div>
      )}
      <div className="acts">
        <button className="btn" onClick={onClose}>Cancel</button>
        {rows && <button className="btn" onClick={() => { setRows(null); setFiles([]); setProgress(''); }}>Choose another</button>}
        <button className="btn primary" data-testid="import-go" disabled={!rows || !!progress} onClick={() => void run()}>Import</button>
      </div>
    </Modal>
  );
}
