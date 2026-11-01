# Test accounts for manual testing

**Dev only.** Every value below comes from `scripts/seed.ts` and is public in the repository. None of it may exist in a
real environment. If the seed changes, change this file in the same commit.

## Bring the environment up and down

```
pnpm run env:up            # docker compose: Postgres, migrate, API, counter; seeds if the DB is empty
pnpm run env:down          # stops everything; data is kept
pnpm run env:down -- --volumes   # also destroys the database
pnpm run up:fresh          # destroy the database, migrate from 0001, reseed, bring everything up
```

Everything runs from the one [docker-compose.yml](../docker-compose.yml) (`docker compose up -d --build --wait` is what
`env:up` wraps). Open the app at <http://localhost:8080>; the API is reachable only through it, under `/api`.
Logs: `docker compose logs -f api`. Postgres is also published on `localhost:55432` for the host-side tests.
Use `pnpm run ...`, never bare `pnpm up` (that is `pnpm update`).

## Tenants

| Tenant | Subdomain | Id | Outlets (each has counters C1, C2) |
|---|---|---|---|
| Tenant A Caterers | `tenant-a` | `00000000-0000-4000-8000-00000000000a` | School 1 Canteen, School 2 Canteen |
| Tenant B School | `tenant-b` | `00000000-0000-4000-8000-00000000000b` | Main Canteen |

Tenant B rounds totals to the rupee; A uses the defaults, so a leak between them shows.
The subdomain is cosmetic: `http://tenant-a.localhost:5173` picks A's name and logo on unauthenticated screens.

## Tenant staff

Shared password for every web login: `dev-password-123`. Shared staff PIN: `482913`.

| Account | Role | Sign-in | Outlet access |
|---|---|---|---|
| `a1@example.test` | manager | email + password | A: School 1 Canteen only |
| `a2@example.test` | manager | email + password | A: School 2 Canteen only |
| `b1@example.test` | manager | email + password | B: Main Canteen only |
| "School 1 Canteen cashier" / "waiter" | cashier / waiter | PIN `482913`, on an enrolled tablet | A: School 1 |
| "School 2 Canteen cashier" / "waiter" | cashier / waiter | PIN `482913`, on an enrolled tablet | A: School 2 |
| "Main Canteen cashier" / "waiter" | cashier / waiter | PIN `482913`, on an enrolled tablet | B: Main |

Managers see only their own outlet, so signing in as `a1` and looking for School 2 data is a valid isolation check.

### Enrolling a tablet (needed for PIN sign-in)

The seeded devices have no known secret, so enrol a fresh one: sign in as a manager, create an enrolment code
(`POST /enrolment-codes`, valid 15 minutes, one use), and redeem it at the counter app's enrolment screen
(`POST /enrol`). A suspended tenant's code is refused with `tenant suspended` and is not consumed.

## Platform console operators

Sign-in needs email + password + a current authenticator code. Both share the password `dev-password-123` and the
authenticator secret `JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP` (add it to any authenticator app as a time-based key, 30 s steps).

| Account | Role |
|---|---|
| `owner@platform.test` | owner (can create/suspend tenants, start support access) |
| `support@platform.test` | support (read-only; cannot suspend) |

Current code without an app (run from the repository root):

```
node --import tsx -e "import {totpCode,totpStep} from './apps/api/src/security/totp.ts'; console.log(totpCode('JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', totpStep(Date.now())))"
```

## Useful manual checks

- Suspend a tenant from the console: its managers' logins, existing sessions, devices and enrolment codes are refused with
  `tenant suspended`; reactivate restores them.
- Support access is read-only for 30 minutes and writes an audit row visible to the tenant's managers.
- Create a throwaway tenant from the console rather than editing A or B, so the seed stays a stable baseline.
