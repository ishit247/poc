<meta charset="utf-8">

# Phase 4 progress: push and ingest (server and tablet), not yet committed

Read `CLAUDE.md`, `docs/handover-phase3-progress.md`, then this file. Baseline on a fresh
database (`pnpm run up:fresh`): API 91, shared 33, DB 14, counter 17. Phase 4 mutants: 40/40
caught (`node scripts/mutation-checks.mjs <ids starting ingest-, push-, tablet->`, ~25 min).

## Done

- **Ledger:** `sync_event` in `0004_trading.sql` (edited in place, seeded for both tenants).
  Key `(tenant_id, id)`; unique `(device_id, seq)`; append-only for the app role (REVOKE).
  Holds applied and rejected events with their payload. A deferred event leaves no row.
- **`POST /sync/push`** (`apps/api/src/routes/sync.ts`, logic in `apps/api/src/ingest.ts`): batch
  of up to 100, replayed in device `seq` order, one transaction per event, serialised per device
  by an advisory lock. Result per event: `applied | duplicate | rejected(reason) | deferred`.
  Tenant, outlet, device and counter come from the credential, never the body.
- **Rejected for good** (ledgered, answer is sticky): lines that do not add up, unknown user or
  item, non-counter channel, payments not equal to total, wrong receipt number, paying a paid or
  void sale, another device's sale, database constraint (e.g. duplicate receipt number),
  event after the device's revocation.
- **Rejected but not ledgered** (may change after an upgrade): unknown event type, unsupported
  schema version, reused `seq`.
- **Accepted and flagged** (`sale.flags`): `over_qty_cap`, `settings_differ` (tax or round-off
  differs from the tenant's CURRENT settings), `sold_unavailable`, `clock_ahead` (> 5 min),
  `late_arrival` (business day already closed).
- **Revoked devices:** only the push route (`allowRevokedDevice`) lets them in; events created
  (device clock) before `revoked_at` are applied and audited as `sync.from_revoked_device`.
- **Tablet:** `push()` in `apps/counter/src/sync.ts`. An outbox row is deleted only on
  applied/duplicate; rejected rows are parked (`rejected` field, kept, not resent) and shown in a
  banner; deferred rows are retried. `App.tsx` pushes before each pull (online event, 60 s timer, Sync button).
- `sale.business_date` is set from `payment.taken` at payment.

## Decision to confirm

The handover said the server must "enforce the cap and recompute totals". I enforce internal
consistency (hard reject) but treat the cap and the tenant's rounding settings as FLAGS, not
rejections: a manager lowering the cap while a tablet is offline must not throw away a sale
that was already handed over (PLAN 7.6). Say if you want hard rejection instead.

## Not done / unverified

- No real-browser run of push yet (CLAUDE.md asks for one at tablet size: offline sales, go
  online, banner, kill the tab mid-push). The tablet logic is tested with fake-indexeddb and
  against the real API, not in a browser.
- N-1 schema upgrade path: only version 1 exists, so there is nothing to upgrade yet.
- Receipt-number gap detection (1..k per device per day) is not implemented; the data to
  check it is in `sale` (device, business_date, receipt_seq). Belongs with day close (phase 6).
- Offline-days lockout (`offlineDays`, Q9) is stored but not enforced on the tablet.
- No manager view of parked/rejected events or flagged sales (reports, phase 8).
- Events `sale.voided`, `shift.*`, `print.reprinted` do not exist yet.
- `sed` was used once to fix a test string; trivial, noted per CLAUDE.md.
