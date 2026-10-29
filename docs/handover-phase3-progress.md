<meta charset="utf-8">

# Phase 3 progress: steps 1-4 done

Read `CLAUDE.md`, then `docs/handover-phase3.md` (state, decisions, gotchas), then this file.
Everything below is committed. Baseline on a fresh database (`pnpm run up:fresh`):
API 64, shared 33, DB 14 (`node --test db/test/*.test.mjs`), counter 11. 38/38 mutants caught
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

## Done (step 2, shared logic, plus manager settings)

- `packages/shared`: `cart.ts`, `payment.ts`, `receipt.ts`, `events.ts` (schemaVersion 1),
  `pin-offline.ts` (noble scrypt, same verifier format as the server, local lockout with
  injected clock), `settings.ts`. Baseline now: shared 33, DB 14, API 64.
- **Manager settings** (per tenant, user's decision): `tenant_setting` in 0004 (versioned,
  one row per tenant, seeded for both: A defaults; B cap 20, GST round down, round bill to
  the rupee). Fields: `maxLineQty` (1-999, default 99), `gstRounding` (half_up|up|down),
  `billRoundTo` (0|10|50|100 paise, nearest, half up, never rounds a bill to zero),
  `offlineDays` (Q9, 1-60, default 7). `GET/PUT /settings` (manager, scope tenant);
  tablets receive it in pull as type `tenant_setting` (id = tenant id); no row = defaults.
- `sale.round_off_paise` (signed): total = subtotal + tax + round_off. `line_total_paise`
  is the pre-GST net. Cart `totals(cart, settings)` returns `roundOff`; payments must sum to
  the rounded total. The cap is not yet enforced server-side (phase 4 ingest must check
  `qty <= maxLineQty` and recompute totals with the tenant's settings).
- Mutation-checked: all new shared/route/pull/CHECK guards caught. Two `sale_guard`
  round-off mutants survive as equivalent (the CHECK ties round-off to total/tax/subtotal,
  which the guard already freezes). No manager UI for settings exists yet (API only).

## Done (steps 3 and 4, counter app and its verification)

- `apps/counter/src`: `db.ts` (Dexie: meta, entities, pinState, sales, outbox), `sync.ts`
  (enrol, pull; a page and its cursor commit in one transaction), `menu.ts` (resolveMenu over
  pulled rows), `sale.ts` (sale + outbox events + receipt counter in ONE transaction; cashier
  only takes payment; waiter sees own open orders), `auth.ts` (offline PIN; failure written
  BEFORE the slow check), UI (`App`, `PinScreen`, `Sell`, `PayDialog`, `Receipt`, `Orders`),
  `public/sw.js` (app-shell cache, production build only), `manifest.webmanifest`.
- `GET /device/whoami` now also returns `counterCode`, `outletName`, `timezone` (cached at enrolment).
- `payment.taken` carries `businessDate`: an order saved before midnight and paid after takes
  the receipt's date as its business date, so (device, date, seq) stays unique. The server's
  `sale_guard` already allows `business_date` to change on open->paid; phase 4 ingest must set it.
- Tests: counter 11 (`pnpm --dir apps/counter run test`, fake-indexeddb: forced mid-sale
  failure leaves nothing, payOrder atomicity, pull atomicity, scope, PIN order of writes).
  12 of 12 counter mutants caught (after adding two tests for gaps the first run found).
- Real browser (Edge via playwright-core, 1024x768, production build, vite preview): 34/34
  checks. Covers enrol, offline cold reload from the service worker, offline PIN and lockout
  (survives reload), waiter vs cashier, split and cash payment, cap and round-off from manager
  settings, receipts 1..N, killing the tab mid-payment 10 times (invariants held), back online.
  The script lives only in the session scratchpad; it is not in the repo.

## Unverified (say so; do not claim otherwise)

- Offline storage durability and `navigator.storage.persist()` outcome on real tablets
  (headless Edge only). Printing (phase 5). Android Chrome. The service worker was exercised
  only in the production build; no icons in the manifest, so "install" prompts may not appear.
- The Pay-button hiding and the settings UI are covered by the browser run only, not mutated.
- No manager UI for settings; no push (phase 4); the server does not yet enforce `maxLineQty`
  or recompute totals from tenant settings on ingest.

## Remaining

Phase 3 is complete apart from the above. Next is phase 4 (sync push and ingest): read
PLAN.md section 19. Phase 4 must also: accept `sale.created` and `payment.taken`, set
`sale.business_date` from `payment.taken`, enforce the cap and recompute totals, add `sync_event`.

Decided this session (do not re-ask): Q9 days offline = 7, as a per-tenant setting
stored now and enforced in phase 4; tablets assumed Android Chrome or Windows
Chrome/Edge; manager web-UI token storage is deferred until an admin UI exists.

## Gotchas added

- API tests need a fresh database after other test files have run (older tests such
  as the counters one depend on seed data); the new staff and order tests are rerunnable.
- The `login` and PIN lockout state is per user and kind (`password` or `pin`).
- In the DB trading tests, `SET CONSTRAINTS ALL IMMEDIATE` stays in force for the rest
  of the transaction; switch back to `DEFERRED` before inserting a paid sale.
