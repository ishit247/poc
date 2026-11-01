import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildApp } from '../src/app.js';
import { pool, subdomainOf, tenantForHost, withTenant } from '../src/db.js';
import { A_ID as A, B_ID as B, HOST_A, HOST_B, hostFor } from './hosts.js';
import { solidPng } from '../../../scripts/png.ts';

const PW = 'dev-password-123';
test.after(() => pool.end());

type App = ReturnType<typeof buildApp>;
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
const login = (app: App, host: string | undefined, email: string, password = PW) =>
  app.inject({ method: 'POST', url: '/login', headers: host ? { host } : {}, payload: { email, password } });
async function token(app: App, tenantId: string, email: string) {
  const r = await login(app, hostFor(tenantId), email);
  assert.equal(r.statusCode, 200);
  return r.json().token as string;
}
const put = (app: App, t: string, body: Buffer | string, type = 'image/png') =>
  app.inject({ method: 'PUT', url: '/settings/logo', headers: { ...bearer(t), 'content-type': type }, payload: body });
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

test('host parsing: only <label>.<base domain> names a tenant', () => {
  assert.equal(subdomainOf('tenant-a.localhost'), 'tenant-a');
  assert.equal(subdomainOf('TENANT-A.localhost:5173'), 'tenant-a');
  for (const bad of [undefined, '', 'localhost', 'localhost:3000', 'a.b.localhost', 'tenant-a.example.com', '-a.localhost', 'a_b.localhost', 'tenant-a.localhost.evil.com', '127.0.0.1:3000',
                     'tenant-a0123456789', 'tenant-a.evilhost', 'tenant-a.local'])
    assert.equal(subdomainOf(bad), null, String(bad));
});

test('host to tenant: seeded subdomains resolve, strangers do not', async () => {
  assert.equal(await tenantForHost(HOST_A), A);
  assert.equal(await tenantForHost(`${HOST_B}:4173`), B);
  assert.equal(await tenantForHost('nobody.localhost'), null);
  assert.equal(await tenantForHost('localhost'), null);
});

test('login: the tenant comes from the email, whatever address the request used', async () => {
  const app = buildApp();
  const sessionOf = async (host: string | undefined, email: string) => {
    const r = await login(app, host, email);
    assert.equal(r.statusCode, 200, `${email} on ${host}`);
    return r.json().token as string;
  };
  // The same manager signs in on their own address, another tenant's address, an unknown one, and the bare domain.
  for (const host of [HOST_A, HOST_B, 'nobody.localhost', undefined]) assert.match(await sessionOf(host, 'a1@example.test'), new RegExp(`^${A}\\.`));
  assert.match(await sessionOf(HOST_A, 'b1@example.test'), new RegExp(`^${B}\\.`), 'B\'s manager on A\'s address is still B\'s');
  // Unknown email and wrong password are the same refusal.
  const unknown = await login(app, HOST_A, 'nobody@example.test');
  assert.equal(unknown.statusCode, 401);
  assert.equal(unknown.body, (await login(app, HOST_A, 'a1@example.test', 'wrong-password-xx')).body);
  // A body tenantId cannot redirect the login to another tenant (unknown keys are refused).
  const sneaky = await app.inject({ method: 'POST', url: '/login', headers: { host: HOST_B }, payload: { tenantId: B, email: 'a1@example.test', password: PW } });
  assert.equal(sneaky.statusCode, 400);
});

test('a session works on any address; it only ever reaches its own tenant', async () => {
  const app = buildApp();
  const a1 = await token(app, A, 'a1@example.test');
  for (const host of [HOST_A, HOST_B, undefined])
    assert.equal((await app.inject({ method: 'GET', url: '/settings', headers: { ...bearer(a1), ...(host ? { host } : {}) } })).statusCode, 200);
  assert.ok(a1.startsWith(`${A}.`), 'the session is A\'s whatever address it was used on');
});

test('an enrolment code carries its tenant, so any address enrols it', async () => {
  const app = buildApp();
  const a1 = await token(app, A, 'a1@example.test');
  const place = (await withTenant(A, (c) => c.query(`SELECT o.id AS o, c.id AS c FROM outlet o JOIN counter c ON c.outlet_id = o.id ORDER BY o.name, c.code LIMIT 1`))).rows[0];
  const code = (await app.inject({ method: 'POST', url: '/enrolment-codes', headers: bearer(a1), payload: { outletId: place.o, counterId: place.c } })).json().code as string;
  const r = await app.inject({ method: 'POST', url: '/enrol', headers: { host: HOST_B }, payload: { code } });
  assert.equal(r.statusCode, 200);
  assert.ok((r.json().credential as string).startsWith(`${A}.`), 'the device belongs to the code\'s tenant, not the address\'s');
});

test('device logo: by credential on the bare domain, own tenant only', async () => {
  const app = buildApp();
  const a1 = await token(app, A, 'a1@example.test');
  const place = (await withTenant(A, (c) => c.query(`SELECT o.id AS o, c.id AS c FROM outlet o JOIN counter c ON c.outlet_id = o.id ORDER BY o.name, c.code LIMIT 1`))).rows[0];
  const code = (await app.inject({ method: 'POST', url: '/enrolment-codes', headers: bearer(a1), payload: { outletId: place.o, counterId: place.c } })).json().code as string;
  const cred = (await app.inject({ method: 'POST', url: '/enrol', payload: { code } })).json().credential as string;
  assert.equal((await app.inject({ method: 'GET', url: '/device/logo' })).statusCode, 401);
  assert.equal((await app.inject({ method: 'GET', url: '/device/logo', headers: bearer(a1) })).statusCode, 403, 'a manager session is not a device');
  const img = await app.inject({ method: 'GET', url: '/device/logo', headers: { authorization: `Device ${cred}`, host: HOST_B } });
  assert.equal(img.statusCode, 200);
  const a = (await app.inject({ method: 'GET', url: '/branding', headers: { host: HOST_A } })).json();
  assert.equal(sha(img.rawPayload), a.logo.sha256, 'A\'s logo, even requested on B\'s address');
});

test('login lookup policy: a stamped email shows one manager row, read-only', async () => {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.login_email', 'A1@Example.Test', true)");
    const rows = (await c.query('SELECT tenant_id, email, role FROM app_user')).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].tenant_id, A);
    await c.query('SAVEPOINT w');
    assert.equal((await c.query("UPDATE app_user SET name = 'hijacked'")).rowCount, 0, 'the stamp cannot update');
    assert.equal((await c.query("UPDATE tenant SET name = 'x'")).rowCount, 0, 'nor touch tenant');
    await c.query('ROLLBACK TO w');
    // A cashier's row is never shown by an email stamp, nor is any other tenant's data.
    assert.equal((await c.query('SELECT 1 FROM outlet')).rowCount, 0);
    await c.query('ROLLBACK');
    await c.query('BEGIN');
    assert.equal((await c.query('SELECT 1 FROM app_user')).rowCount, 0, 'no stamp, no rows');
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    c.release();
  }
});

test('manager emails are unique across tenants', async () => {
  await assert.rejects(
    withTenant(B, (c) => c.query(
      "INSERT INTO app_user (tenant_id, name, pin_verifier, role, email, password_hash) SELECT $1, 'dup', 'x', 'manager', 'A1@example.test', password_hash FROM app_user WHERE email = 'b1@example.test'", [B])),
    /app_user_email_uq/);
});

test('tenant row policy: a host stamp shows one tenant row and can change nothing', async () => {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.host_subdomain', 'tenant-a', true)");
    assert.deepEqual((await c.query('SELECT id FROM tenant')).rows.map((r) => r.id), [A]);
    await c.query('SAVEPOINT w1');
    await assert.rejects(c.query("UPDATE tenant SET name = 'hijacked'"), /row-level security/, 'the lookup stamp must not allow writes');
    await c.query('ROLLBACK TO w1');
    await assert.rejects(c.query("INSERT INTO tenant (id, name, subdomain) VALUES (gen_random_uuid(), 'x', 'evil')"), /row-level security/);
    await c.query('ROLLBACK');
    await c.query('BEGIN');
    assert.equal((await c.query('SELECT 1 FROM tenant')).rowCount, 0, 'no stamp, no rows');
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    c.release();
  }
});

test('branding: public by address, own tenant only, served as an inert image', async () => {
  const app = buildApp();
  const a = (await app.inject({ method: 'GET', url: '/branding', headers: { host: HOST_A } })).json();
  const b = (await app.inject({ method: 'GET', url: '/branding', headers: { host: HOST_B } })).json();
  assert.equal(a.name, 'Tenant A Caterers');
  assert.equal(b.name, 'Tenant B School');
  assert.notEqual(a.logo.sha256, b.logo.sha256);
  assert.equal((await app.inject({ method: 'GET', url: '/branding', headers: { host: 'nobody.localhost' } })).statusCode, 404);
  assert.equal((await app.inject({ method: 'GET', url: '/branding/logo' })).statusCode, 404);

  const img = await app.inject({ method: 'GET', url: '/branding/logo', headers: { host: HOST_A } });
  assert.equal(img.statusCode, 200);
  assert.equal(img.headers['content-type'], 'image/png');
  assert.equal(img.headers['x-content-type-options'], 'nosniff');
  assert.match(String(img.headers['content-security-policy']), /default-src 'none'/);
  assert.equal(sha(img.rawPayload), a.logo.sha256);
  const again = await app.inject({ method: 'GET', url: '/branding/logo', headers: { host: HOST_A, 'if-none-match': img.headers.etag as string } });
  assert.equal(again.statusCode, 304);
});

test('logo upload: manager only, real PNG/JPEG/WebP only, size capped', async () => {
  const app = buildApp();
  const a1 = await token(app, A, 'a1@example.test');
  const before = (await app.inject({ method: 'GET', url: '/branding', headers: { host: HOST_A } })).json().logo.sha256 as string;
  try {
    const png = solidPng(10, 20, 30);
    // refused: no credentials, a signed-in cashier, wrong/absent type, type that lies, svg, junk, empty, oversize
    assert.equal((await app.inject({ method: 'PUT', url: '/settings/logo', headers: { 'content-type': 'image/png' }, payload: png })).statusCode, 401);
    const cashierId = (await withTenant(A, (c) => c.query("SELECT id FROM app_user WHERE name = 'School 1 Canteen cashier'"))).rows[0].id;
    const cred = await (async () => {
      const place = (await withTenant(A, (c) => c.query(`SELECT o.id AS o, c.id AS c FROM outlet o JOIN counter c ON c.outlet_id = o.id ORDER BY o.name, c.code LIMIT 1`))).rows[0];
      const code = (await app.inject({ method: 'POST', url: '/enrolment-codes', headers: bearer(a1), payload: { outletId: place.o, counterId: place.c } })).json().code;
      return (await app.inject({ method: 'POST', url: '/enrol', headers: { host: HOST_A }, payload: { code } })).json().credential as string;
    })();
    const staff = (await app.inject({ method: 'POST', url: '/device/pin-signin', headers: { authorization: `Device ${cred}` }, payload: { userId: cashierId, pin: '482913' } })).json().token as string;
    assert.equal((await put(app, staff, png)).statusCode, 403);

    assert.equal((await put(app, a1, png, 'image/jpeg')).statusCode, 400, 'declared type must match the bytes');
    assert.equal((await put(app, a1, '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', 'image/svg+xml')).statusCode, 415);
    assert.equal((await put(app, a1, '<script>alert(1)</script>', 'image/png')).statusCode, 400, 'bytes decide, not the header');
    assert.equal((await put(app, a1, Buffer.alloc(0))).statusCode, 400);
    assert.equal((await put(app, a1, Buffer.concat([png, Buffer.alloc(300 * 1024)]))).statusCode, 413);
    assert.equal(((await app.inject({ method: 'GET', url: '/branding', headers: { host: HOST_A } })).json().logo.sha256), before, 'refused uploads change nothing');

    const next = solidPng(200, 100, 50, 64);
    const ok = await put(app, a1, next);
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.json().sha256, sha(next));
    assert.equal((await app.inject({ method: 'GET', url: '/branding', headers: { host: HOST_A } })).json().logo.sha256, sha(next));
    // B is untouched.
    assert.notEqual((await app.inject({ method: 'GET', url: '/branding', headers: { host: HOST_B } })).json().logo.sha256, sha(next));
    const audited = await withTenant(A, (c) => c.query("SELECT detail FROM audit WHERE action = 'logo.set' ORDER BY at DESC LIMIT 1"));
    assert.equal(audited.rows[0].detail.sha256, sha(next));
    assert.equal(audited.rows[0].detail.bytes, next.length);
    // The seeded logo is replaced for the rest of this database's life; `pnpm run up:fresh` restores it.
  } finally {
    await app.close();
  }
});

test('logo reaches tablets by pull as a hash, and removal arrives as a tombstone', async () => {
  const app = buildApp();
  const a1 = await token(app, A, 'a1@example.test');
  const b1 = await token(app, B, 'b1@example.test');
  const enrol = async (t: string, host: string, tenant: string, name: string) => {
    const place = (await withTenant(tenant, (c) => c.query(`SELECT o.id AS o, c.id AS c FROM outlet o JOIN counter c ON c.outlet_id = o.id WHERE o.name = $1 ORDER BY c.code LIMIT 1`, [name]))).rows[0];
    const code = (await app.inject({ method: 'POST', url: '/enrolment-codes', headers: bearer(t), payload: { outletId: place.o, counterId: place.c } })).json().code;
    return (await app.inject({ method: 'POST', url: '/enrol', headers: { host }, payload: { code } })).json().credential as string;
  };
  const pullLogo = async (cred: string, from = 0) => {
    let cursor = from;
    const out: { id: string; deleted: boolean; data: any; version: number }[] = [];
    for (;;) {
      const j = (await app.inject({ method: 'GET', url: `/sync/pull?cursor=${cursor}`, headers: { authorization: `Device ${cred}` } })).json();
      out.push(...j.changes.filter((c: any) => c.type === 'tenant_logo'));
      cursor = j.cursor;
      if (!j.hasMore) return { rows: out, cursor };
    }
  };
  const credA = await enrol(a1, HOST_A, A, 'School 1 Canteen');
  const credB = await enrol(b1, HOST_B, B, 'Main Canteen');
  const first = await pullLogo(credA);
  assert.equal(first.rows.length, 1);
  assert.equal(first.rows[0]!.id, A);
  assert.equal(first.rows[0]!.data.contentType, 'image/png');
  assert.equal(Object.keys(first.rows[0]!.data).sort().join(), 'contentType,sha256', 'bytes are not carried in pull');
  const bRows = (await pullLogo(credB)).rows;
  assert.equal(bRows.length, 1);
  assert.equal(bRows[0]!.id, B);
  assert.notEqual(bRows[0]!.data.sha256, first.rows[0]!.data.sha256);

  assert.equal((await app.inject({ method: 'DELETE', url: '/settings/logo', headers: bearer(a1) })).statusCode, 200);
  const gone = await pullLogo(credA, first.cursor);
  assert.equal(gone.rows.length, 1);
  assert.equal(gone.rows[0]!.deleted, true);
  assert.deepEqual(gone.rows[0]!.data, {});
  assert.equal((await app.inject({ method: 'GET', url: '/branding/logo', headers: { host: HOST_A } })).statusCode, 404);
  assert.equal((await app.inject({ method: 'GET', url: '/branding', headers: { host: HOST_A } })).json().logo, null);
  assert.equal((await pullLogo(credB, 0)).rows.length, 1, 'B keeps its logo');
  // and it can be set again after removal
  const again = solidPng(1, 2, 3);
  assert.equal((await put(app, a1, again)).statusCode, 200);
  const back = await pullLogo(credA, gone.cursor);
  assert.equal(back.rows[0]!.deleted, false);
  assert.equal(back.rows[0]!.data.sha256, sha(again));
});
