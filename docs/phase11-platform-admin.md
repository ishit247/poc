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
| 3 | Health and usage views (device last-seen, unsynced, sync rejects, outbox backlog, webhook quiet, app-version skew; counts per month) | not started |
| 4 | Impersonation (reason, expiry, read-only, tenant-visible audit) | not started |
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

## Open items carried

- Q4 hosting (needed for IP allowlist/VPN in front of the console, TLS, backups).
- Whether support staff exist besides the owner (the `support` role is built either way).
- Outlet/counter onboarding by the platform (step 2 does tenants and the first manager only).
- Device enrolment redemption for a suspended tenant is not yet blocked (login, bearer and device auth are).
