# Phase 11: platform admin console — design and progress

Decided with the user in the session of 2026-11-01. Update the **Progress** table as each step lands.
PLAN.md refs: sections 5 (roles), 14 (reports), 15 (audit), 18 (operations), 19 (phase 11).

## Design

- **Separate app** `apps/admin` (own host, e.g. `admin.<domain>`), same API process, shared `packages/shared`.
- **Separate identity.** `platform_admin` table, password + mandatory TOTP, short sessions, own lockout. Tenant
  `app_user` rows are never used for the console.
- **Separate DB role** `app_platform` (no default privileges). It sees tenants, outlets and devices (read), and
  may create/rename/suspend tenants. It has no right on sales, users, sessions or the tenant audit. Walls are
  REVOKE/GRANT plus policies `TO app_platform`, and are tested by enumerating every table.
- **Roles:** `owner` (everything) and `support` (health and usage; no create, suspend, impersonate).
- **Impersonation is the only way into tenant data:** reason required, time-limited, read-only by default,
  visible to the tenant's managers in their own audit trail, and logged on the platform side in the same transaction
  (SAVEPOINT audit). No raw-sales browser.
- **Billing deferred** (open question 8). Build a usage meter and a suspend flag only. A suspended tenant cannot
  sign in or sync; counters keep selling offline.
- **Audit:** `platform_audit`, append-only; every console action and every failed login.

## Configuration

| Variable | Meaning |
|---|---|
| `PLATFORM_DATABASE_URL` | connection for `app_platform` (default dev URL in `apps/api/src/db.ts`) |
| `PLATFORM_HOST` | if set, `/platform/*` is served only on this Host (else 404). Unset in dev/tests. |

## Progress

| # | Step | State |
|---|---|---|
| 1 | Migration `0007_platform.sql`, `app_platform` role, grants/policies, DB tests, 7 mutants | done, committed |
| 2 | Platform auth (password + TOTP, lockout, replay refusal, sessions), tenant create/rename/suspend/reactivate, first-manager creation, platform audit, suspension enforced on tenant login and auth | done, uncommitted (see notes) |
| 3 | Health and usage views (device last-seen, unsynced, sync rejects, outbox backlog, webhook quiet, app-version skew; counts per month) | done, uncommitted |
| 4 | Impersonation (reason, 30-minute expiry, read-only only, tenant-visible audit) | done, uncommitted |
| 5 | `apps/admin` UI, checked in a real browser at tablet size | done (see notes); impersonation, audit viewer and usage screens not yet in the UI |
| 6 | Mutation checks per gate; fold phase 9 gaps (integration/mapping admin, encrypt webhook secrets); runbook, backups/restore drill, rate limits | **partly done 2026-11-10**, see "Step 6 notes". Done: sealed secrets, backup and restore drill, runbook, rate limits reviewed, CSP header, device revoke screen. Owed: integration/mapping admin (needs partner access, Q1), off-site copies and PITR (Q4), a full mutation run |

## Notes per step

### Step 2 (done)
Built: `apps/api/src/routes/platform.ts`, `security/totp.ts`, `platformAudit.ts`, console branch in `auth.ts`
(`Authorization: Platform <sessionId>.<secret>`), `withPlatform` in `db.ts`, platform columns for lockout and
TOTP replay in `0007_platform.sql`, suspension checks (bearer, device, login) on the tenant side, seed operators
`owner@platform.test` / `support@platform.test` (dev password, fixed dev TOTP secret in `scripts/seed.ts`).

Routes (all under `/platform/`, enforced at registration by `onRoute`): `login` (public, 10/min), `logout`, `me`,
`tenants` (list, get, create, rename), `tenants/:id/suspend|reactivate` (reason required), `tenants/:id/managers`,
`audit`. Create/rename/suspend/reactivate/manager are owner-only; the rest any operator.

Choices worth knowing:
- Sessions are 2 hours absolute, no sliding extension.
- A used TOTP step is refused (`totp_last_step`), so a captured code cannot be replayed. Five failures lock 15 min.
- Suspension is a 403 `tenant suspended` on tenant routes; at login it is said only after the password was proved.
- The first manager is written on the tenant path (`withTenant`) with a tenant-audit row, then the platform audit row
  in a second transaction. If the second fails the manager exists and the audit insert is only logged (SAVEPOINT
  helper). Accepted: the two roles cannot share a transaction.
- Tests that sign in repeatedly reset `totp_last_step` through the console role (only 3 codes are valid per 30 s).

Verified (real Postgres, no browser, no UI yet): after `up:fresh`, API 159/159 (12 new in `platform.test.ts`),
DB 28/28. Mutants `plat-*` in `scripts/mutation-checks.mjs`: 19 for this step, all caught (two needed their
patterns fixed for CRLF files first). The API suite fails on a database dirtied by earlier runs; always `up:fresh` first.

Process note: a commit made while the mutation run was in progress captured one mutated line in
`routes/platform.ts` (`'x.noop'` instead of `'platform.manager.create'`). The working tree is correct; commit it.
Do not commit while `mutation-checks.mjs` is running.

### Step 3 (done)
Built: `db/migrations/0008_platform_metrics.sql` (schema `platform`; `tenant_health(ids, stale_hours, quiet_hours)`
and `tenant_usage(ids, since)`), `apps/api/src/platformHealth.ts` (warning rules), `GET /platform/health` and
`GET /platform/usage` in `routes/platform.ts` (owner and support).

Design:
- The console role still has no right on sales, sync events, the outbox or integrations. The two functions are
  SECURITY DEFINER (owner pos_owner), take a list of tenant ids, stamp each tenant in turn so FORCE RLS applies
  inside, return aggregates only, and clear the stamp on exit. EXECUTE is revoked from PUBLIC and granted to
  `app_platform` alone. A test pins the exact output column list, so adding a column that could carry text is a
  deliberate act.
- Warnings (`device-stale`, `device-unsynced`, `sync-rejected`, `outbox-failed`, `outbox-backlog`,
  `integration-quiet`, `webhook-rejected`, `version-skew`) are derived server-side. Windows (`staleHours`,
  `quietHours`, 0 to 720) are the caller's.
- Usage is counts per month (paid and refunded sales, online orders, active devices and outlets), no money: billing
  is undecided (Q8).

Verified (real Postgres, no browser): after `up:fresh`, API 165/165, DB 29/29. 11 mutants `plat-health-*`,
`plat-usage-*`, `plat-warning-severity`: 10 caught first time; the survivor (`plat-health-executable-by-all`: the
PUBLIC revoke was masked by `pos_app` lacking schema access) is now caught by a privilege check asked from the
console connection.

Not covered: nothing measured against large data (the functions scan per tenant; check `EXPLAIN` before a tenant has
a year of sales); no alert delivery, the console only shows warnings; the lifetime of "rejected" events is not
trimmed, so `sync-rejected` counts the last 24 h only.

### Step 4 (done)
Decided with the user on 2026-11-02: a support session is **read-only only** (there is no write mode, not even an
opt-in) and lasts **30 minutes**, not extendable.

Built: `db/migrations/0009_impersonation.sql`, `requestMode` in `db.ts`, `Support` credential in `auth.ts`,
`POST /platform/tenants/:id/impersonate` and `.../impersonations/:iid/end` (owner only, reason 3 to 200 chars),
`GET /support-access` (a tenant's managers), `test/platform-impersonation.test.ts`.

Design:
- The grant is a row in the tenant-side `impersonation` table (FORCE RLS). `pos_app` can only read it; the console
  role has no right on it. The console starts and ends a grant through two SECURITY DEFINER functions, which also write
  the tenant's own audit row (`support.access.start` / `.end`); the platform audit row goes in the same transaction.
- The 30 minutes is fixed in the start function and pinned by a CHECK (`expires_at <= created_at + 30 min`); the caller
  chooses nothing. Expiry and early end are checked on every request.
- Credential: `Support <tenantId>.<id>.<secret>`, shown once. It acts as a manager who has every outlet of that tenant
  (nil-uuid user). Device-only routes refuse it.
- Read-only twice over: auth refuses any method but GET/HEAD, and every transaction of a support request is
  `SET TRANSACTION READ ONLY` (AsyncLocalStorage flag read by `withTenant`), so a GET route that wrote would fail with
  25006 instead of writing.

Not done: individual reads are not audited (only start/end, as the rest of the system does not audit reads);
a suspended tenant refuses support access like everyone else; no console UI yet (step 5); no per-operator cap on how
many grants may be open at once.

### Step 5 (done): operator UI and the end-to-end onboarding flow
Decided with the user on 2026-11-02: the manager receives access by a **one-time invite link** (no mail is sent; the
operator passes it on), the manager makes the **enrolment code on the blank tablet** (sign-in on the counter's enrolment
screen), and the **operator creates outlets and counters** in the console.

Built:
- `db/migrations/0010_manager_invite.sql` (`manager_invite`, FORCE RLS, lifetime CHECK 7 days, no DELETE for `pos_app`),
  `apps/api/src/invite.ts`, `POST /invite/redeem` (public, single atomic claim, suspended tenant not consumed).
- Console routes: `POST /platform/tenants/:id/outlets` (owner), `GET .../outlets` (outlets, counters, managers),
  `POST .../managers` now takes optional `outletIds` and an optional `password` (omitted = invite, 3 days),
  `POST .../managers/:uid/invite` (new link; refused once accepted). Outlet/counter/manager writes use the stamped tenant
  path, so the console DB role gained no write right on tenant data.
- `GET /me` also returns each outlet's counters.
- `apps/admin` (Vite + React, port 8081 in Docker, own origin): sign-in with authenticator code, tenant list with health
  warnings, tenant page (outlets, managers, invite panel, suspend/reactivate). Session token in sessionStorage.
- Counter app: `#invite=<token>` screen (manager sets own password), manager sign-in + code maker on the enrolment screen.

Verified: after `up:fresh`, `platform-onboarding.test.ts` (real Postgres) and a real-browser run (Edge, 1024x768, Docker
stack): 13/13 checks from operator creating a tenant to a tablet showing its counter. Mutants `onb-*` in
`scripts/mutation-checks.mjs`: 11/11 caught. After a final `up:fresh`: API 183/183, DB 17/17 (the "every table" isolation
test needed `manager_invite` rows in the seed, now added), shared 41/41, counter 25/25, typecheck clean in all packages.
The browser script is not in the repo.

Environment note: this machine is short of memory (WSL capped at 4 GB, ~2 GB free). Docker's engine died twice during
image builds and `tsc` ran out of memory when builds and tests overlapped; one `pnpm test` run, where the three
packages' suites run in parallel, also gave two API failures that did not reproduce on a fresh database. Run the stages
one after another and `up:fresh` before the API suite.

Not done: the console has no screens for impersonation, usage or the platform audit yet (API exists); a manager's outlets
cannot be changed after creation from the console; nothing is emailed or texted (the operator copies the link); the
invite lifetime (3 days) and the 7-day DB ceiling are fixed in code.

### Step 6 (partly done, 2026-11-10)

- **Sealed secrets.** `outlet_integration.webhook_secret` and `platform_admin.totp_secret` held plain text the server
  must read back (HMAC key, authenticator seed), so they cannot be hashed. Now `webhook_secret_sealed` and
  `totp_secret_sealed` (originals edited in 0006 and 0007): AES-256-GCM under `SECRETS_KEY`, stored as `v1:` +
  base64url(iv, tag, ciphertext), with the table, column and row id as authenticated data, so a value copied onto
  another row or tenant does not open. A database CHECK refuses anything not in the sealed shape. One place:
  `apps/api/src/security/crypto.ts` (`sealSecret`, `openSecret`, the two context functions, `sealWebhookSecret`, which
  keeps the 16-character minimum that was a DB check before). The API image (`NODE_ENV=production`) refuses to start
  without the key; tests and `pnpm dev` fall back to a public dev key, and docker-compose passes the same dev key. The
  seed makes the row ids itself so it can seal against them.
  Verified: DB 47/47 (1 new: plain text refused in both columns), API 250/250 (5 new in `test/secrets.test.ts`; the
  webhook and console sign-in suites now open seed values sealed inside Docker), tablet 62/62, typecheck clean.
  6 mutants `secret-*`, 6/6 caught (two re-run after their patterns were fixed; they did not match at first).
- **Backups.** `scripts/backup.mjs` (pg_dump, owners kept) and `scripts/restore-drill.ts` (restore beside `pos`,
  compare row counts, RLS flags and policies, owners, grants, tenant isolation as `pos_app`, and open every sealed
  secret). Passed on the dev stack in 3.9 s; fails with a wrong key (0/4), as it should. A dump as `pos_owner` is
  refused by Postgres because of FORCEd RLS, so backups need the superuser or a BYPASSRLS read-only role.
- **Rate limits** were already wider than the plan said: global 300/min per IP; 10/min on manager, console and invite
  sign-in and enrolment; 30/min per device on PIN sign-in. Left as they are; the runbook says when to raise the global
  one (a school's tablets share one IP).
- **Runbook:** `docs/runbook.md` (dev values to replace, backups, restore, incidents).
- **Device revoke screen (built the same day).** Manager tools gets a fourth tab, Tablets (`manager/Tablets.tsx`):
  the tablets of the manager's outlets from `GET /devices` (label, counter, outlet when there are several, last seen,
  enrolled, app version, "This tablet"), Revoke… with a required reason (quick picks Lost, Stolen, Replaced, Not used
  any more) and a Revoked section. `POST /devices/:id/revoke` takes an optional `reason` (1 to 200 characters, strict
  body) into the audit row; the screen always sends one. The tablet in your hand cannot revoke itself while
  `unsentCount()` (sync.ts) is above 0: on revocation it drops its credential (App.tsx `onDeviceRejected`), so unsent
  records could never be sent; once revoked it goes to the set-up screen at once. Another tablet, revoked while it holds
  offline sales, still delivers them: it pushes before it pulls, and push accepts a revoked tablet's events made before
  the revocation.
  Verified: API 250/250 (the revoke test now covers the reason: 400 on too long or an unknown field before anything
  changes, the reason in the audit row, no second audit row on a repeat), 1 mutant `revoke-reason-unchecked` caught.
  Browser: `node scripts/browser-tablets.mjs` 17/17 (two tablets, Edge, fresh seed): list and "This tablet", reason
  required, B revoked and listed under Revoked, audit reason, B's offline sale from before the revocation delivered and
  B reset, self-revoke refused with unsent records (push blocked) and allowed once sent, A reset. `browser-flow` 46/46
  and `browser-sell` 30/30 re-run. Not a mutant: the self-revoke guard is UI only (a browser check covers it).
  **Rename** (added after): each working tablet's row has Rename beside Revoke…, through the existing
  `PATCH /devices/:id` (scope-checked, audited `device.label`, 1 to 60 characters trimmed); Save is disabled while the
  name is empty or unchanged. No API change. `browser-tablets.mjs` 22/22: rename opens with the current name, the list
  and the server follow, saved trimmed and audited once, both buttons on one row, no sideways scroll at 768x1024.

## Open items carried

- Q4 hosting (needed for IP allowlist/VPN in front of the console, TLS, backups).
- Whether support staff exist besides the owner (the `support` role is built either way).
- Outlet/counter onboarding by the platform (step 2 does tenants and the first manager only).
