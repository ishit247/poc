<meta charset="utf-8">

# Phase 3 progress: step 1 done, steps 2-4 remain

Read `CLAUDE.md`, then `docs/handover-phase3.md` (state, decisions, gotchas), then this file.
Everything below is committed. Baseline on a fresh database (`pnpm run up:fresh`):
API 61, shared 19, DB 14 (`node --test db/test/*.test.mjs`). 38/38 mutants caught
(`node scripts/mutation-checks.mjs`, about 30 minutes; do not kill it mid-run, it
leaves a guard removed in the source).

## Done (step 1, server groundwork)

- `app_user` and `user_outlet` are versioned in 0001/0003 (membership has `deleted_at`
  tombstones). Lockout counters live in `login_lockout` (0002), so a failed PIN never
  bumps a user's version. Sessions have `device_id`; a PIN session dies with its device.
- `POST /device/pin-signin` (device credential; cashier and waiter only; 5 failures,
  5-minute lock, 423 with `lockedUntil`), `POST /users/:id/unlock` (manager, own
  outlets). Pull now carries this outlet's cashiers and waiters with `pinVerifier`;
  removal and deactivation are tombstones with empty data. Managers never reach tablets.
- `0004_trading.sql`: `business_day`, `shift`, `sale`, `sale_line`, `payment`, with
  DB-enforced invariants 3, 4 and 5 (payments sum to total, paid sales immutable,
  receipt unique per device per day). `sync_event` is deliberately left to phase 4.
- Order routes (`apps/api/src/routes/orders.ts`) use the single `ORDER_SCOPE`
  predicate and scope `own-orders`; a test enumerates every such route.
- `app_version` is read from the `x-app-version` header on every device request.

## Remaining in phase 3

2. **Shared logic** in `packages/shared`: cart (uses `resolveMenu` and `exclusiveLine`),
   payment validation (cash, UPI, split; change on cash only), receipt numbering
   `<counter>-<yyyymmdd>-<n>` assigned at payment, event schemas for `sale.created` and
   `payment.taken` with a schema version, and the offline PIN verifier with local
   lockout (injected clock). Offline verifier: scrypt in the browser via
   `@noble/hashes`, same verifier format as the server (`scrypt$N$r$p$salt$hash`).
3. **Counter app** (`apps/counter`, currently a shell): PWA and service worker,
   persistent-storage request, Dexie local DB (menu snapshot, users, cursor, outbox,
   receipt counter, open orders), PIN pad, sell, pay, sync bar. The sale, its outbox
   entry and the receipt counter are written in ONE IndexedDB transaction. Pull works;
   push stays stubbed (phase 4).
4. **Verification**: real-browser check at 1024x768 (Playwright), including offline and
   online toggling and killing the tab mid-sale; mutation-check each new guard;
   report offline storage and printing as unverified on hardware.

Decided this session (do not re-ask): Q9 days offline = 7, as a per-tenant setting
stored now and enforced in phase 4; tablets assumed Android Chrome or Windows
Chrome/Edge; manager web-UI token storage is deferred until an admin UI exists.

## Gotchas added

- API tests need a fresh database after other test files have run (older tests such
  as the counters one depend on seed data); the new staff and order tests are rerunnable.
- The `login` and PIN lockout state is per user and kind (`password` or `pin`).
- In the DB trading tests, `SET CONSTRAINTS ALL IMMEDIATE` stays in force for the rest
  of the transaction; switch back to `DEFERRED` before inserting a paid sale.
