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
