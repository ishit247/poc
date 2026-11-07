import { useCallback, useEffect, useState, type MouseEvent } from 'react';
import { api, type TemplateFull, type TemplateRow } from './api.ts';
import { CatalogEditor } from './CatalogEditor.tsx';
import { Confirm } from './Modal.tsx';
import { toast } from './toast.tsx';
import { IMPORT_FLAG, toCsv, uid, type DraftCat } from './catalogIO.ts';

export const SUGGESTION_NOTE = 'Rates and prices in a template are suggestions. The caterer’s accountant owns them, and the manager can change every one after seeding.';

type Go = (hash: string) => (e: MouseEvent) => void;

export function Catalog({ isOwner, templateId, onDirty, go }: { isOwner: boolean; templateId: string; onDirty: (d: boolean) => void; go: Go }) {
  return templateId ? <CatalogEditor id={templateId} isOwner={isOwner} onDirty={onDirty} go={go} /> : <TemplateList isOwner={isOwner} />;
}

const toDraft = (t: TemplateFull): DraftCat[] => t.categories.map((c) => ({
  id: uid(), name: c.name,
  items: c.items.map((i) => ({ id: uid(), name: i.name, hsn: i.hsnCode ?? '', gst: String(i.gstRateBp / 100), price: (i.pricePaise / 100).toFixed(2), desc: i.description ?? '', sha: i.imageSha256, blob: null, preview: null })),
}));

function TemplateList({ isOwner }: { isOwner: boolean }) {
  const [rows, setRows] = useState<TemplateRow[] | null>(null);
  const [error, setError] = useState('');
  const [deleting, setDeleting] = useState<TemplateRow | null>(null);
  const load = useCallback(async () => {
    const r = await api<TemplateRow[]>('/platform/catalog-templates');
    if (r.status === 200) setRows(r.body); else setError('Could not load the templates.');
  }, []);
  useEffect(() => { void load(); }, [load]);

  const open = (id: string) => { window.location.hash = `#/catalog/${id}`; };
  const full = async (id: string) => {
    const r = await api<TemplateFull>(`/platform/catalog-templates/${id}`);
    if (r.status !== 200) { setError('Could not load that template.'); return null; }
    return r.body;
  };
  const duplicate = async (t: TemplateRow) => {
    const src = await full(t.id);
    if (!src) return;
    const names = new Set((rows ?? []).map((x) => x.name.toLowerCase()));
    let name = `${t.name} (copy)`;
    for (let n = 2; names.has(name.toLowerCase()); n++) name = `${t.name} (copy ${n})`;
    const r = await api<TemplateFull>('/platform/catalog-templates', { body: { name, categories: src.categories.map((c) => ({ name: c.name, items: c.items.map((i) => ({ name: i.name, ...(i.hsnCode ? { hsnCode: i.hsnCode } : {}), ...(i.description ? { description: i.description } : {}), ...(i.imageSha256 ? { imageSha256: i.imageSha256 } : {}), gstRateBp: i.gstRateBp, pricePaise: i.pricePaise })) })) } });
    if (r.status === 201) { toast('Template duplicated'); void load(); } else setError(r.status === 403 ? 'Only an owner can do this.' : 'Could not duplicate the template.');
  };
  const exportCsv = async (t: TemplateRow) => {
    const src = await full(t.id);
    if (!src) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([toCsv(toDraft(src))], { type: 'text/csv' }));
    a.download = `${t.name.replace(/\W+/g, '-').toLowerCase()}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast('CSV downloaded');
  };
  const remove = async (t: TemplateRow) => {
    const r = await api(`/platform/catalog-templates/${t.id}`, { method: 'DELETE' });
    if (r.status === 200) { toast('Template deleted'); void load(); } else setError(r.status === 403 ? 'Only an owner can do this.' : 'Could not delete the template.');
  };
  const importNew = () => { try { sessionStorage.setItem(IMPORT_FLAG, '1'); } catch { /* the editor just opens without the dialog */ } window.location.hash = '#/catalog/new'; };

  return (
    <>
      <div className="pagehead">
        <div><h1>Catalog</h1><div className="muted">Menu templates you seed into new tenants. {SUGGESTION_NOTE}</div></div>
        <span className="sp" />
        {isOwner && <button className="btn" data-testid="template-import" onClick={importNew}>⬆ Import folder</button>}
        {isOwner && <button className="btn primary" data-testid="template-new" onClick={() => open('new')}>＋ New template</button>}
      </div>
      {error && <div className="alert bad" role="alert"><span>⚠</span><div className="grow">{error}</div></div>}
      <section className="card">
        {!rows ? <div className="body">Loading…</div> : rows.length === 0 ? (
          <div className="empty">No templates yet. {isOwner ? 'Create one, or import a folder with a CSV and pictures.' : ''}</div>
        ) : (
          <table data-testid="template-table">
            <thead><tr><th>Template</th><th className="num">Categories</th><th className="num">Items</th><th /></tr></thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.id} className="clickable" tabIndex={0} onClick={() => open(t.id)} onKeyDown={(e) => { if (e.key === 'Enter') open(t.id); }}>
                  <td className="tname"><a href={`#/catalog/${t.id}`} onClick={(e) => e.stopPropagation()} style={{ color: 'inherit', textDecoration: 'none' }}>{t.name}</a></td>
                  <td className="num">{t.categories}</td><td className="num">{t.items}</td>
                  <td className="num" style={{ whiteSpace: 'nowrap' }} onClick={(e) => e.stopPropagation()}>
                    <button className="btn sm primary" data-testid={`edit-${t.name}`} onClick={() => open(t.id)}>{isOwner ? 'Edit' : 'Open'}</button>{' '}
                    {isOwner && <button className="btn sm" onClick={() => void duplicate(t)}>Duplicate</button>}{' '}
                    <button className="btn sm" onClick={() => void exportCsv(t)}>Export</button>{' '}
                    {isOwner && <button className="btn sm danger" data-testid={`delete-${t.name}`} onClick={() => setDeleting(t)}>Delete</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      {deleting && <Confirm title={`Delete “${deleting.name}”?`} message="Tenants already seeded from this template keep their menus." label="Delete template" danger onClose={() => setDeleting(null)} onYes={() => void remove(deleting)} />}
    </>
  );
}
