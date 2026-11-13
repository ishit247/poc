import { useEffect, useState } from 'react';

// Pictures in the menu editor. A saved picture is fetched once per hash with the manager's session (the route needs it) and
// kept as an object URL; a picture chosen but not yet saved is shown from the blob itself.
const cache = new Map<string, string>();

function useSavedUrl(token: string, sha: string | null): string | null {
  const [url, setUrl] = useState<string | null>(sha ? cache.get(sha) ?? null : null);
  useEffect(() => {
    if (!sha) return setUrl(null);
    const hit = cache.get(sha);
    if (hit) return setUrl(hit);
    setUrl(null);
    let live = true;
    void fetch(`/api/item-images/${sha}`, { headers: { authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.blob() : null))
      .then((b) => { if (!b) return; const u = URL.createObjectURL(b); cache.set(sha, u); if (live) setUrl(u); })
      .catch(() => { /* offline: the placeholder stays */ });
    return () => { live = false; };
  }, [token, sha]);
  return url;
}

function usePendingUrl(blob: Blob | null | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!blob) return setUrl(null);
    const u = URL.createObjectURL(blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [blob]);
  return url;
}

/** `pending` is the picture chosen in this session: a Blob (set), null (removed), undefined (untouched). */
export function Thumb({ token, sha, pending, size = 40 }: { token: string; sha: string | null; pending: Blob | null | undefined; size?: number }) {
  const saved = useSavedUrl(token, pending === undefined ? sha : null);
  const chosen = usePendingUrl(pending);
  const src = pending === undefined ? saved : chosen;
  return src
    ? <img className="me-thumb" src={src} width={size} height={size} alt="" />
    : <span className="me-thumb none" style={{ width: size, height: size }} aria-hidden="true">＋</span>;
}

export const pickPicture = (onFile: (f: File) => void) => {
  const i = document.createElement('input');
  i.type = 'file';
  i.accept = 'image/*';
  i.onchange = () => { const f = i.files?.[0]; if (f) onFile(f); };
  i.click();
};

/** Stores one item's picture (or removes it). Returns an error line, or '' when it worked. */
export async function savePicture(token: string, itemId: string, blob: Blob | null): Promise<string> {
  try {
    const r = await fetch(`/api/items/${itemId}/image`, blob
      ? { method: 'PUT', headers: { authorization: `Bearer ${token}`, 'content-type': blob.type }, body: blob }
      : { method: 'DELETE', headers: { authorization: `Bearer ${token}` } });
    if (r.ok) return '';
    const why = (await r.json().catch(() => ({}))) as { error?: string };
    return why.error === 'picture limit reached' ? 'Picture limit reached. Remove one first.' : r.status === 404 ? 'Item no longer exists.' : 'Could not save the picture.';
  } catch { return 'Could not reach the server.'; }
}
