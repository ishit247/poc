<meta charset="utf-8">

# Handover: start of phase 3 (offline counter sale)

Written at the end of phase 2. Read `CLAUDE.md` (working agreements) and `PLAN.md`
sections 0, 7, 9, 10 and 19 first; this file is the state of the build, not a
replacement for them.

## State

Local git repo, 8 commits, latest `72e6a3d`. Nothing is pushed anywhere (no remote).
Phases 1 and 2 are done at the API level. There is **no real UI yet**: `apps/counter`
is a Vite + React shell that only calls `/api/health`.

| Suite | Count | Run |
|---|---|---|
| API (real Postgres, serial) | 50 | `cd apps/api && pnpm run test` |
| shared | 19 | `cd packages/shared && node --import tsx --test test/*.test.ts` |
| DB isolation | 8 | `node --test db/test/rls.test.mjs` |

Start: Docker Desktop must be running (`D:\Docker\Docker Desktop.exe`), then
`pnpm run up:fresh` (destroys the dev volume, migrates from 0001, reseeds, ~30 s).
Never run bare `pnpm up`.

## What exists

- **Tenancy:** non-owner `NOBYPASSRLS` role `pos_app`; `FORCE ROW LEVEL SECURITY` on
  every table; the only tenant handle is `withTenant()` (`apps/api/src/db.ts`).
  New tenant tables use `app.enable_tenant_rls()` or `app.make_versioned()` and need
  seed rows for **both** tenants or the generic RLS test fails.
- **Auth:** manager web login (scrypt, lockout, hashed sessions); device enrolment
  with single-use codes; revocable hashed device credentials. Credentials embed the
  tenant id so lookup stays inside RLS. Roles: manager, cashier, waiter.
  Permissions: `manager`, `till` (cashier+manager = takes payment), `staff`
  (anyone who takes orders), `device`. Every route declares `config.scope`; every
  non-public route also `config.permission` (`onRoute` enforces it).
- **Catalogue and pull:** category, item (+`hsn_code`), item_price (counter, zomato,
  swiggy), outlet_item (`available`, `listed` nullable), outlet_price (per channel),
  counter menu rules. `GET /sync/pull?cursor=` returns changes plus tombstones, paged,
  one SQL statement (one snapshot), scoped to the device's outlet and counter.
- **Versions:** per-tenant locked counter (`app.next_version`), so versions commit
  in order and a cursor cannot skip a row. The app role cannot write the counter or
  hard-delete versioned rows. Never use a plain sequence for this.
- **Menu resolution:** `resolveMenu()` in `packages/shared/src/menu.ts` is the one
  implementation (counter override > outlet override > catalogue; a counter can only
  narrow its outlet; GST rate is the item's, 0 if the outlet is not GST-enabled).
- **Money:** integer paise, `packages/shared/src/money.ts`. Pricing is
  **tax-exclusive**; `exclusiveLine()` rounds GST once per line.
- **PIN policy:** `pinProblem()` in `packages/shared/src/pin.ts` (6-8 digits, no
  repeats, runs or short repeating blocks). PIN verifiers are scrypt hashes
  (`hashPassword`), cashier/waiter rows have no email.
- **Seed:** tenants A and B. Logins (dev only): `a1@example.test`, `a2@example.test`,
  `b1@example.test`, password `dev-password-123`. Dev staff PIN `482913`. A1 and B1
  are GST-enabled with fake GSTINs, A2 is not.

## Decisions made this far (do not re-ask)

Tenant = caterer with many outlets; multiple counters per outlet; cash + UPI only;
per-counter-per-day receipt numbers; user hosts the server; Zomato/Swiggy needed;
online-first with offline mode. Waiter takes orders, cashier takes payment (a cashier
can do both); waiters sign in by PIN on the shared counter tablet, a separate
handheld is optional and not built. "Cashier-specific" menus mean **per outlet**
(menu and prices), plus optional counter narrowing; aggregator prices differ per
outlet; menus are not date-specific. GST: provision only (GSTIN + enable flag on the
outlet, HSN on the item); receipt specifics deferred by the user.

## Still open (ask only when the phase needs it)

Q1 aggregator contact (before phase 9), Q2 size, Q3 GST receipt specifics (before the
receipt is designed, phase 5), Q4 hosting (before phase 11), Q5 reports/read-only
views, Q6 receipt language (before phase 5), Q7 tablets/printers (hardware is
unchosen; offline storage and printing stay "unverified on hardware"), Q8 billing,
Q9 days offline before locking (default 7), Q11 accountant role.

## Phase 3 scope (PLAN section 19)

PWA shell, local DB, cart, cash/UPI/split, local receipt numbering, local outbox,
offline PIN. Not sync push (that is phase 4) and not printing (phase 5).

Things phase 3 must also do, because earlier work deferred them:
1. **PIN sign-in endpoint and offline verifier sync.** Pull does not yet carry users.
   Add `version`/tombstones to `app_user` and `user_outlet` **in their original
   migrations** (dev-phase rule) and replace the delete-and-reinsert of `user_outlet`
   in `routes/admin.ts`. Add server-side lockout for PIN failures and a way for a
   manager to unlock. Rate-limit locally and on the server.
2. **Order/sale tables** (PLAN section 8) with RLS, seeded for both tenants. Add the
   scope rule "a waiter touches only their own open orders" and a test that
   enumerates it.
3. `app_version` on devices is read by the device list but nothing sets it yet.
4. Decide token storage for the manager web UI (cookie vs storage); there is no admin
   UI yet.
5. The counter app needs a real-browser check at tablet size (CLAUDE.md), including
   offline/online toggling.

## Gotchas learned

- TypeScript 7 does not auto-include `@types/node`: each package sets
  `"types": ["node"]`.
- API tests share one database and mutate outlet state, so they run serially
  (`--test-concurrency=1`). Tests restore state in `finally`.
- **A failing test can leave state behind** (one mutation run deactivated the seeded
  manager and invalidated every later result). For mutation checks, run
  `node scripts/up-fresh.mjs` before each mutation; the harness is in the history of
  this session (copy source, replace one string, run, restore).
- `outlet_item.listed` is nullable on purpose: NULL means "no opinion", so a stock
  toggle never lists an item. Do not default it to true.
- Git warns LF will be replaced by CRLF; harmless. No remote is configured; do not add one.
- `pnpm` build scripts: `esbuild: false` in `pnpm-workspace.yaml`.
- Install tooling on D:, not C: (pnpm store is already `D:\.pnpm-store`).

## Verification expected

Real Postgres, a mutation check for every guard, and a plain statement of what was and
was not verified. Offline storage and printing need hardware; report them as
unverified until then. Use a real browser at tablet size for UI.
