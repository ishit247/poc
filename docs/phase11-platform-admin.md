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
| 5 | `apps/admin` UI, checked in a real browser at tablet size | not started |
| 6 | Mutation checks per gate; fold phase 9 gaps (integration/mapping admin, encrypt webhook secrets); runbook, backups/restore drill, rate limits | not started |

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

## Open items carried

- Q4 hosting (needed for IP allowlist/VPN in front of the console, TLS, backups).
- Whether support staff exist besides the owner (the `support` role is built either way).
- Outlet/counter onboarding by the platform (step 2 does tenants and the first manager only).
