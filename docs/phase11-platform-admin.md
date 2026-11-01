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
| 2 | Platform auth (password + TOTP, lockout, replay refusal, sessions), tenant create/rename/suspend/reactivate, first-manager creation, platform audit, suspension enforced on tenant login and auth | see notes below |
| 3 | Health and usage views (device last-seen, unsynced, sync rejects, outbox backlog, webhook quiet, app-version skew; counts per month) | not started |
| 4 | Impersonation (reason, expiry, read-only, tenant-visible audit) | not started |
| 5 | `apps/admin` UI, checked in a real browser at tablet size | not started |
| 6 | Mutation checks per gate; fold phase 9 gaps (integration/mapping admin, encrypt webhook secrets); runbook, backups/restore drill, rate limits | not started |

## Notes per step

### Step 2
See the section appended below when finished.

## Open items carried

- Q4 hosting (needed for IP allowlist/VPN in front of the console, TLS, backups).
- Whether support staff exist besides the owner (the `support` role is built either way).
- Outlet/counter onboarding by the platform (step 2 does tenants and the first manager only).
- Device enrolment redemption for a suspended tenant is not yet blocked (login, bearer and device auth are).
