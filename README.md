# Cafeteria POS

Hosted, multi-tenant, offline-capable POS for school cafeterias. Design and phase
order: [PLAN.md](PLAN.md). Working agreements: [CLAUDE.md](CLAUDE.md).

## Layout

| Path | What |
|---|---|
| `apps/api` | Fastify + zod API |
| `apps/counter` | Vite + React counter app (shell only until phase 3) |
| `packages/shared` | Money helpers (integer paise), shared types |
| `db/init` | Dev-only role bootstrap (`pos_owner`, `pos_app`) |
| `db/migrations` | `0001…` SQL, applied by `scripts/migrate.mjs` |
| `db/test` | Tenant-isolation tests against real Postgres |

## Run

```
pnpm install
pnpm run up:fresh      # destroys the dev DB volume, migrates from 0001, reseeds
pnpm test              # shared + api + db isolation tests (needs the DB up)
pnpm run typecheck
```

Use `pnpm run up:fresh`, not `pnpm up` (which means `pnpm update`).
Dev API: `pnpm --filter @pos/api dev` (port 3000); counter: `pnpm --filter @pos/counter dev` (5173, proxies `/api`).

Seed logins (dev only): `a1@example.test`, `a2@example.test` (tenant A, one outlet each),
`b1@example.test` (tenant B); password `dev-password-123`. Tenant ids are in `scripts/seed.ts`.

## Rules that must not drift

- **Tenant isolation.** The API connects as `pos_app` (`NOBYPASSRLS`); every table has
  `FORCE ROW LEVEL SECURITY`; the only tenant-scoped handle is `withTenant()`
  (`apps/api/src/db.ts`). New tenant tables call `app.enable_tenant_rls()` and must have
  seed rows for both tenants, or `db/test/rls.test.mjs` fails.
- **Permission is not scope.** Every route declares `config.scope`; every non-public route
  also declares `config.permission`. `onRoute` rejects routes without them. An id-taking
  route must also check *whose* record it is, inside the query.
- **Reference data that devices pull** (menu, prices, availability) is created with
  `app.make_versioned()`: RLS, a trigger that assigns `version` from a per-tenant locked
  counter (so versions commit in order and a pull cursor cannot skip a row), and no
  `DELETE` for the app role (soft delete = tombstone). The pull reads all tables in one
  statement so they share a snapshot. Never add a plain sequence for this.
- **GRANT never withholds; REVOKE does.** `audit` is insert/select only (tested).
- **Audit writes use a SAVEPOINT** (`apps/api/src/audit.ts`).
- **Money is integer paise**, never floats (`packages/shared/src/money.ts`).
- **Secrets are stored hashed** (sessions, device credentials, enrolment codes); passwords
  use scrypt. Credentials embed the tenant id so lookup stays inside RLS.
- **Dev phase:** no real tenant yet, so fix a migration where it was written and reseed
  with `up:fresh`. Ask before editing a migration once anything real depends on it.
- **Every guard gets a mutation check:** remove it, confirm a test fails.

## Not production

Dev passwords in `db/init/01-roles.sql` and the seed password are for local use only.
Set `TRUST_PROXY=1` only behind a proxy you control.
