// The tenant's logo. Pull says which logo is current (a hash); the bytes come from /api/branding/logo
// once, are checked against that hash, and are kept in IndexedDB so the header and receipt work offline.
import { useEffect, useState } from 'react';
import { liveQuery } from 'dexie';
import { db } from './db.ts';

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');

export async function syncLogo(): Promise<void> {
  const row = await db.entities.where('type').equals('tenant_logo').first();
  if (!row) {
    await db.logo.clear(); // removed by the manager (a tombstone deleted the row)
    return;
  }
  const sha = String(row.data.sha256);
  if (await db.logo.get(sha)) return;
  const r = await fetch('/api/branding/logo');
  if (!r.ok) return;
  const bytes = await r.arrayBuffer();
  // Never store what does not match what pull promised: a stale or swapped response is ignored.
  if (hex(await crypto.subtle.digest('SHA-256', bytes)) !== sha) return;
  await db.transaction('rw', db.logo, async () => {
    await db.logo.clear();
    await db.logo.put({ sha, type: String(row.data.contentType), bytes });
  });
}

/** An object URL for the cached logo, or null. Revoked when it changes or the component goes away. */
export function useLogoUrl(): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let current: string | null = null;
    const sub = liveQuery(() => db.logo.toCollection().first()).subscribe({
      next: (row) => {
        if (current) URL.revokeObjectURL(current);
        current = row ? URL.createObjectURL(new Blob([row.bytes], { type: row.type })) : null;
        setUrl(current);
      },
    });
    return () => {
      sub.unsubscribe();
      if (current) URL.revokeObjectURL(current);
    };
  }, []);
  return url;
}
