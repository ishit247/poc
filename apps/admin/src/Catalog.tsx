import { useCallback, useEffect, useState } from 'react';
import { DESCRIPTION_MAX, api, catalogImageUrl, gstLabel, parseGstBp, parsePaise, rupees, shrinkImage, uploadCatalogImage, type TemplateFull, type TemplateRow } from './api.ts';

export const SUGGESTION_NOTE = 'Rates and prices in a template are suggestions. The caterer’s accountant owns them, and the manager can change every one after seeding.';

export function Catalog({ isOwner, templateId }: { isOwner: boolean; templateId: string }) {
  return templateId ? <TemplateView id={templateId} isOwner={isOwner} /> : <TemplateList isOwner={isOwner} />;
}

function TemplateList({ isOwner }: { isOwner: boolean }) {
  const [rows, setRows] = useState<TemplateRow[] | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    const r = await api<TemplateRow[]>('/platform/catalog-templates');
    if (r.status === 200) setRows(r.body); else setError('Could not load the templates.');
  }, []);
  useEffect(() => { void load(); }, [load]);

  return (
    <>
      <h1>Catalog templates</h1>
      <p className="muted">{SUGGESTION_NOTE} Seeding copies a template into a tenant once; later changes to the template do not reach tenants already seeded.</p>
      {error && <p className="error" role="alert">{error}</p>}
      {!rows ? <p>Loading…</p> : rows.length === 0 ? <p className="muted">No templates yet.</p> : (
        <table data-testid="template-table">
          <thead><tr><th>Name</th><th>Categories</th><th>Items</th></tr></thead>
          <tbody>
            {rows.map((t) => (
              <tr key={t.id}><td><a href={`#/catalog/${t.id}`}>{t.name}</a></td><td>{t.categories}</td><td>{t.items}</td></tr>
            ))}
          </tbody>
        </table>
      )}
      {isOwner && <NewTemplate onCreated={(id) => { window.location.hash = `#/catalog/${id}`; }} />}
    </>
  );
}

function TemplateView({ id, isOwner }: { id: string; isOwner: boolean }) {
  const [tpl, setTpl] = useState<TemplateFull | null | undefined>(undefined);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    void api<TemplateFull>(`/platform/catalog-templates/${id}`).then((r) => setTpl(r.status === 200 ? r.body : null));
  }, [id]);

  const remove = async () => {
    const r = await api(`/platform/catalog-templates/${id}`, { method: 'DELETE' });
    if (r.status === 200) window.location.hash = '#/catalog';
    else setError(r.status === 403 ? 'Only an owner can do this.' : 'Could not delete the template.');
  };

  if (tpl === undefined) return <p>Loading…</p>;
  if (tpl === null) return <><p>Template not found.</p><p><a href="#/catalog">← All templates</a></p></>;
  return (
    <>
      <p><a href="#/catalog" data-testid="back-templates">← All templates</a></p>
      <h1 data-testid="template-title">{tpl.name}</h1>
      <p className="muted">Prices are tax-exclusive. {SUGGESTION_NOTE}</p>
      {error && <p className="error" role="alert">{error}</p>}
      {tpl.categories.map((k) => (
        <section className="card" key={k.id} aria-label={k.name}>
          <h2>{k.name}</h2>
          <table>
            <thead><tr><th /><th>Item</th><th>HSN/SAC</th><th>GST</th><th>Price (excl. GST)</th></tr></thead>
            <tbody>
              {k.items.map((i) => (
                <tr key={i.id}>
                  <td className="thumbcell"><Picture sha={i.imageSha256} /></td>
                  <td>{i.name}{i.description && <div className="muted" data-testid={`desc-${i.name}`}>{i.description}</div>}</td>
                  <td>{i.hsnCode ?? '—'}</td><td>{gstLabel(i.gstRateBp)}</td><td>{rupees(i.pricePaise)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
      {isOwner && (
        <section className="card" aria-label="Delete template">
          <h2>Delete</h2>
          <p className="muted">Tenants already seeded from this template keep their menus.</p>
          {confirming ? (
            <div className="row">
              <button data-testid="template-delete-confirm" className="primary" onClick={remove}>Yes, delete “{tpl.name}”</button>
              <button onClick={() => setConfirming(false)}>Cancel</button>
            </div>
          ) : <button data-testid="template-delete" onClick={() => setConfirming(true)}>Delete template</button>}
        </section>
      )}
    </>
  );
}

/** A template picture, fetched once per hash and shown small. Lazy: a long template does not load every picture at once. */
function Picture({ sha }: { sha: string | null }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setUrl(null);
    if (sha) void catalogImageUrl(sha).then((u) => { if (live) setUrl(u); });
    return () => { live = false; };
  }, [sha]);
  return url ? <img className="thumb" src={url} alt="" loading="lazy" decoding="async" width={56} height={56} data-testid="template-picture" /> : null;
}

interface DraftItem { name: string; hsn: string; gst: string; price: string; description: string; image: string | null }
interface DraftCategory { name: string; items: DraftItem[] }
const blankItem = (): DraftItem => ({ name: '', hsn: '', gst: '5', price: '', description: '', image: null });
const blankCategory = (): DraftCategory => ({ name: '', items: [blankItem()] });

function NewTemplate({ onCreated }: { onCreated: (id: string) => void }) {
  const [name, setName] = useState('');
  const [cats, setCats] = useState<DraftCategory[]>([blankCategory()]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const setCat = (ci: number, f: (c: DraftCategory) => DraftCategory) => setCats((p) => p.map((c, i) => (i === ci ? f(c) : c)));
  const setItem = (ci: number, ii: number, patch: Partial<DraftItem>) =>
    setCat(ci, (c) => ({ ...c, items: c.items.map((it, i) => (i === ii ? { ...it, ...patch } : it)) }));

  const pick = async (ci: number, ii: number, file: File | undefined) => {
    if (!file) return;
    setError('');
    try { setItem(ci, ii, { image: await uploadCatalogImage(await shrinkImage(file)) }); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not use that picture.'); }
  };

  const create = async () => {
    setError('');
    const out = [];
    for (const c of cats) {
      const items = [];
      for (const it of c.items) {
        const label = `“${it.name.trim() || 'unnamed item'}”`;
        const pricePaise = parsePaise(it.price);
        const gstRateBp = parseGstBp(it.gst);
        if (!it.name.trim()) return setError(`Every item needs a name (category “${c.name}”).`);
        if (it.hsn && !/^[0-9]{4,8}$/.test(it.hsn)) return setError(`${label}: HSN/SAC must be 4 to 8 digits.`);
        if (gstRateBp === null) return setError(`${label}: GST must be between 0 and 40 percent, with at most two decimals.`);
        if (pricePaise === null) return setError(`${label}: price must be in rupees (up to 10,00,000) with at most two decimals, for example 45 or 45.50.`);
        items.push({ name: it.name.trim(), ...(it.hsn ? { hsnCode: it.hsn } : {}), ...(it.description.trim() ? { description: it.description.trim() } : {}),
          ...(it.image ? { imageSha256: it.image } : {}), gstRateBp, pricePaise });
      }
      if (!c.name.trim()) return setError('Every category needs a name.');
      out.push({ name: c.name.trim(), items });
    }
    setBusy(true);
    const r = await api<TemplateFull>('/platform/catalog-templates', { body: { name: name.trim(), categories: out } });
    setBusy(false);
    if (r.status === 201) onCreated(r.body.id);
    else setError(r.status === 409 ? 'A template with that name already exists.' : r.status === 403 ? 'Only an owner can do this.' : r.status === 400 ? 'The template was refused. Check the names, HSN codes, rates and prices.' : 'Could not create the template.');
  };

  return (
    <section className="card" aria-label="New template">
      <h2>New template</h2>
      <div className="row">
        <input data-testid="tpl-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Template name, e.g. School cafeteria, North Indian" />
      </div>
      {cats.map((c, ci) => (
        <div className="card" key={ci}>
          <div className="row">
            <input data-testid={`cat-name-${ci}`} value={c.name} onChange={(e) => setCat(ci, (x) => ({ ...x, name: e.target.value }))} placeholder="Category name" />
            {cats.length > 1 && <button onClick={() => setCats((p) => p.filter((_, i) => i !== ci))}>Remove category</button>}
          </div>
          {c.items.map((it, ii) => (
            <div className="row" key={ii}>
              <input data-testid={`item-name-${ci}-${ii}`} value={it.name} onChange={(e) => setItem(ci, ii, { name: e.target.value })} placeholder="Item name" />
              <input data-testid={`item-hsn-${ci}-${ii}`} value={it.hsn} onChange={(e) => setItem(ci, ii, { hsn: e.target.value.trim() })} placeholder="HSN/SAC (4–8 digits)" inputMode="numeric" style={{ maxWidth: 190 }} />
              <input data-testid={`item-gst-${ci}-${ii}`} value={it.gst} onChange={(e) => setItem(ci, ii, { gst: e.target.value })} placeholder="GST %" inputMode="decimal" aria-label="GST percent" style={{ maxWidth: 90 }} />
              <input data-testid={`item-price-${ci}-${ii}`} value={it.price} onChange={(e) => setItem(ci, ii, { price: e.target.value })} placeholder="Price ₹ excl. GST" inputMode="decimal" aria-label="Price in rupees, excluding GST" style={{ maxWidth: 160 }} />
              {c.items.length > 1 && <button aria-label="Remove item" onClick={() => setCat(ci, (x) => ({ ...x, items: x.items.filter((_, i) => i !== ii) }))}>✕</button>}
              <input data-testid={`item-desc-${ci}-${ii}`} value={it.description} maxLength={DESCRIPTION_MAX} onChange={(e) => setItem(ci, ii, { description: e.target.value })}
                placeholder="Description (optional, shown on the counter tile)" aria-label="Description" style={{ maxWidth: 'none', flex: '1 1 320px' }} />
              <span className="picpick">
                <Picture sha={it.image} />
                <label className="filebtn">{it.image ? 'Change picture' : 'Add picture'}
                  <input data-testid={`item-pic-${ci}-${ii}`} type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden
                    onChange={(e) => { void pick(ci, ii, e.target.files?.[0]); e.target.value = ''; }} />
                </label>
                {it.image && <button aria-label="Remove picture" onClick={() => setItem(ci, ii, { image: null })}>✕</button>}
              </span>
            </div>
          ))}
          <button data-testid={`add-item-${ci}`} onClick={() => setCat(ci, (x) => ({ ...x, items: [...x.items, blankItem()] }))}>Add item</button>
        </div>
      ))}
      <div className="row">
        <button data-testid="add-category" onClick={() => setCats((p) => [...p, blankCategory()])}>Add category</button>
        <button data-testid="tpl-create" className="primary" disabled={busy || !name.trim()} onClick={create}>Create template</button>
      </div>
      {error && <p className="error" role="alert" data-testid="tpl-error">{error}</p>}
      <p className="muted">Prices are in rupees, tax-exclusive. GST is a percent (for example 5 or 2.5). {SUGGESTION_NOTE}</p>
    </section>
  );
}
