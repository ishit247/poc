<meta charset="utf-8">

# Phase 6 progress (part 1): shifts and blind count, not yet committed

Read `CLAUDE.md`, `docs/handover-phase5-progress.md`, then this file. Baseline on a fresh database
(`pnpm run up:fresh`): API 99, shared 41, counter 23, root DB 8, typecheck clean.

## Done

- **Events** (`packages/shared/src/events.ts`): `shift.opened` (shift, cashier, float, time), `shift.closed`
  (shift, counted cash, time), and an optional `shiftId` on `payment.taken`. Schema version stays 1
  (old events still parse; a payment without a shift just has none).
- **Cash arithmetic** (`packages/shared/src/shift.ts`): `expectedCash` = float + cash part of each payment
  (UPI excluded, change already out of the amount); `renderShiftSlip` (32 columns, outlet timezone).
  The tablet slip and the server use the same function.
- **Server** (`apps/api/src/ingest.ts`): `applyShiftOpened` (cashier of this outlet only; one open shift
  per device), `applyShiftClosed` (server works out expected and variance from the payments it holds;
  second close refused), payments set `sale.shift_id`; a payment on a shift from another device is
  rejected (`wrong_device`); on a shift whose opening was refused, `shift_rejected`; a close before its
  open is deferred. Money taken after the count is accepted and flagged `after_shift_close`.
- **Schema** (`0004_trading.sql`, edited in place): partial unique index, one open shift per device;
  a closed shift carries counted, expected and variance, an open one none.
- **Tablet:** Dexie v2 `shifts` table; `shift.ts` (open, blind close, slip); `Shift.tsx`; a cashier with no
  open shift is sent to open one and cannot take payment (`drawerFor` in `sale.ts`, checked before the sale
  is saved or a receipt number spent); only the shift's owner can pay into it. Close = blind count, then a
  forced sync attempt, then the slip with variance and "N records not yet sent" if the outbox is not empty.
- `app.ts` now logs 5xx errors server-side (the client still sees only "internal error").

## Verification

Real Postgres for API and contract tests. Mutants caught (removed, tests failed, restored): second close
allowed; UPI counted as drawer cash; foreign-device shift accepted. Not run through `scripts/mutation-checks.mjs`
(no phase 6 ids added yet).

## Not done / unverified (say so)

- **No real-browser check** of the Shift screen, nor of phases 4 and 5 (still owed, do them together at tablet size).
- **Day close** (manager, online): block while shifts or sales are open or devices have unsynced events,
  per-counter variance, freeze totals, late-arrival adjustments surfaced next day. Not started.
- **Receipt-number gap check** (1..k per device per day) and the offline-days lockout: not started.
- **Abandoned open orders are not auto-voided at shift close** (PLAN 9): there is no `sale.voided` event yet.
  They stay open and can be paid in the next shift.
- A manager cannot yet see shifts, variances or `after_shift_close` flags in any screen or report.
- A shift left open on a tablet blocks another cashier on that tablet until its owner closes it; there is no
  manager force-close yet.
- Used a shell heredoc once to append tests to `apps/api/test/sync-push.test.ts` (Edit would have done).
