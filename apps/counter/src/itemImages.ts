// Item pictures. Pull carries only each item's picture hash; the bytes come from /api/device/item-images/:sha256 once per
// distinct hash, are checked against it, and are kept in IndexedDB so tiles work offline. A few at a time, so a first sync
// of a large menu never floods the network or blocks the pull; whatever fails is simply tried again on the next pull.
import { useEffect, useState } from 'react';
import { db } from './db.ts';

const CONCURRENCY = 3;
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');

const urls = new Map<string, string>();
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((f) => f());
let running: Promise<void> | null = null;

export function syncItemImages(credential: string): Promise<void> {
  running ??= run(credential).finally(() => { running = null; });
  return running;
}

async function run(credential: string): Promise<void> {
  const items = await db.entities.where('type').equals('item').toArray();
  const wanted = new Set(items.map((r) => r.data.imageSha256 as string | null).filter((s): s is string => !!s));
  const have = new Set((await db.itemImages.toCollection().primaryKeys()) as string[]);

  const stale = [...have].filter((s) => !wanted.has(s));
  if (stale.length) {
    await db.itemImages.bulkDelete(stale);
    for (const s of stale) { const u = urls.get(s); if (u) { URL.revokeObjectURL(u); urls.delete(s); } }
    changed();
  }

  const missing = [...wanted].filter((s) => !have.has(s));
  let next = 0;
  const worker = async () => {
    while (next < missing.length) {
      const sha = missing[next++]!;
      try {
        const r = await fetch(`/api/device/item-images/${sha}`, { headers: { authorization: `Device ${credential}` } });
        if (!r.ok) continue;
        const bytes = await r.arrayBuffer();
        // Never store what does not match what pull promised.
        if (hex(await crypto.subtle.digest('SHA-256', bytes)) !== sha) continue;
        await db.itemImages.put({ sha, type: r.headers.get('content-type') ?? 'image/webp', bytes });
        changed();
      } catch { /* offline or interrupted: the next pull retries */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, missing.length) }, worker));
}

/** An object URL for a cached picture, or null while it is not on the tablet yet. */
export function useItemImageUrl(sha: string | null | undefined): string | null {
  const [url, setUrl] = useState<string | null>(sha ? urls.get(sha) ?? null : null);
  useEffect(() => {
    if (!sha) { setUrl(null); return; }
    let live = true;
    const load = async () => {
      let u = urls.get(sha);
      if (!u) {
        const row = await db.itemImages.get(sha);
        if (!row) { if (live) setUrl(null); return; }
        u = urls.get(sha) ?? URL.createObjectURL(new Blob([row.bytes], { type: row.type }));
        urls.set(sha, u);
      }
      if (live) setUrl(u);
    };
    void load();
    listeners.add(load);
    return () => { live = false; listeners.delete(load); };
  }, [sha]);
  return url;
}
