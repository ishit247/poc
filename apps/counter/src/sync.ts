// Pull: the server's changes since our cursor, applied page by page. A page and the new
// cursor are written in ONE transaction, so a crash can never leave a cursor that is
// ahead of the data (which would skip rows for good).
import { db, getMeta, type DeviceInfo } from './db.ts';
import { syncLogo } from './logo.ts';

interface Change { type: string; id: string; version: number; deleted: boolean; data: Record<string, any> }

export async function pull(device: DeviceInfo): Promise<number> {
  let cursor = (await getMeta('cursor')) ?? 0;
  let applied = 0;
  for (let page = 0; page < 200; page++) {
    const r = await fetch(`/api/sync/pull?cursor=${cursor}`, {
      headers: { authorization: `Device ${device.credential}`, 'x-app-version': __APP_VERSION__ },
    });
    if (!r.ok) throw new Error(`pull failed: ${r.status}`);
    const j = (await r.json()) as { cursor: number; hasMore: boolean; changes: Change[] };
    await db.transaction('rw', db.entities, db.meta, async () => {
      for (const c of j.changes) {
        if (c.deleted) await db.entities.delete([c.type, c.id]);
        else await db.entities.put({ type: c.type, id: c.id, data: c.data });
      }
      await db.meta.put({ key: 'cursor', value: j.cursor });
      await db.meta.put({ key: 'lastPull', value: new Date().toISOString() });
    });
    applied += j.changes.length;
    cursor = j.cursor;
    if (!j.hasMore) {
      await syncLogo().catch(() => {}); // the logo is cosmetic: never let it fail a pull
      return applied;
    }
  }
  throw new Error('pull did not terminate');
}

export interface PushSummary { sent: number; done: number; parked: number; deferred: number }
const BATCH = 50;

/**
 * Push: send the outbox in device order. An event leaves the outbox ONLY when the server says it is
 * applied or a duplicate; a lost response, a crash or a 500 therefore just means "send it again".
 * A rejected event is parked (kept, marked, not resent) and a deferred one is simply tried next time.
 */
export async function push(device: DeviceInfo): Promise<PushSummary> {
  const summary: PushSummary = { sent: 0, done: 0, parked: 0, deferred: 0 };
  const rows = (await db.outbox.orderBy('seq').toArray()).filter((r) => !r.rejected);
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const r = await fetch('/api/sync/push', {
      method: 'POST',
      headers: { authorization: `Device ${device.credential}`, 'content-type': 'application/json', 'x-app-version': __APP_VERSION__ },
      body: JSON.stringify({ events: batch.map((b) => ({ eventId: b.eventId, seq: b.seq, createdAt: b.createdAt, payload: b.payload })) }),
    });
    if (!r.ok) throw new Error(`push failed: ${r.status}`);
    const { results } = (await r.json()) as { results: { eventId: string; status: string; reason?: string }[] };
    const bySeq = new Map(batch.map((b) => [b.eventId, b.seq!]));
    await db.transaction('rw', db.outbox, db.meta, async () => {
      for (const res of results) {
        const seq = bySeq.get(res.eventId);
        if (seq === undefined) continue;
        if (res.status === 'applied' || res.status === 'duplicate') { await db.outbox.delete(seq); summary.done++; }
        else if (res.status === 'rejected') { await db.outbox.update(seq, { rejected: res.reason ?? 'rejected' }); summary.parked++; }
        else summary.deferred++;
      }
      await db.meta.put({ key: 'lastPush', value: new Date().toISOString() });
    });
    summary.sent += batch.length;
  }
  return summary;
}

export async function enrol(code: string): Promise<DeviceInfo> {
  const r = await fetch('/api/enrol', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: code.trim() }) });
  if (!r.ok) throw new Error('That code was not accepted. It may be used, expired or mistyped.');
  const { credential, deviceId } = (await r.json()) as { credential: string; deviceId: string };
  const who = await fetch('/api/device/whoami', { headers: { authorization: `Device ${credential}` } });
  if (!who.ok) throw new Error('Enrolled, but could not read this counter.');
  const w = await who.json();
  const device: DeviceInfo = { credential, deviceId, tenantId: credential.split('.')[0]!, outletId: w.outletId, counterId: w.counterId, counterCode: w.counterCode, outletName: w.outletName, timezone: w.timezone };
  await db.meta.put({ key: 'device', value: device });
  return device;
}
