# Phase 8: reports (PLAN 14)

Built. One manager-only route, `GET /reports/:kind?from&to[&outletId][&by][&format=csv]`
([apps/api/src/routes/reports.ts](../apps/api/src/routes/reports.ts)), with the queries in
[apps/api/src/reports.ts](../apps/api/src/reports.ts) and a Reports tab in the manager tools
([apps/counter/src/manager/Reports.tsx](../apps/counter/src/manager/Reports.tsx)). No schema change, so no migration.

## What it does

- Kinds: `sales` (by day, outlet, counter, person, channel), `items` (by item, category), `hourly`, `voids`
  (voids and refunds with reasons), `variance` (cash, by cashier), `unavailable` (sold while unavailable), `online`
  (received, delivered, rejected, cancelled, expired), `settlement` (statement lines that did not match), `sync`
  (per tablet: last heard from, waiting to send, app version, events turned away, late arrivals).
- Scope: scope rule `outlet`, permission `manager`. No `outletId` means every outlet assigned to the caller (the
  consolidated view); a named outlet that is not theirs is a 404.
- Dates are business dates (shift reports use the shift's opening day, online reports the day received, in the
  outlet's timezone). Range is inclusive, at most 366 days. A range that reaches today at any chosen outlet comes back
  `provisional: true` and the screen says so.
- Sales figures count `paid` sales only, the same rule as day close. Item rows are before tax (`line_total`), so they
  do not include bill round-off.
- CSV: money as rupees written by integer arithmetic, a UTF-8 BOM, a Total row, and any text cell that starts with
  `= + - @` is prefixed with `'` (void reasons are typed by people).

## Decisions I made (say if you want them otherwise)

- One generic route rather than nine, so the screen and the CSV cannot disagree.
- The settlement report lists only lines the platform said and we did not match. "Delivered but not in the
  statement" depends on which statement is read, so it stays on the statement's own screen.
- Online sales are attributed to the counter that keyed them and the person who keyed them.
- No refund route exists yet, so the refund half of the voids report is empty until one does.
- Reads are not audited. PLAN 14 asks for audit on platform-admin access to raw sales; that is phase 11.

## Verified

- Fresh start (`pnpm run up:fresh`), then `pnpm -r run test`: shared 41, tablet 25, API 137 (5 new, in
  `apps/api/test/zz-reports.test.ts`; the name makes it run last because it adds an outlet to tenant A).
  The new tests check every report against hand-worked figures on real Postgres, both range ends and the days
  either side, another manager and another tenant never seeing the outlet (all nine kinds), a cashier and a device
  being refused, and the CSV.
- Mutation checks: 31 mutants (ids `rep-*` in `scripts/mutation-checks.mjs`). 30 caught first time; the survivor
  (`rep-variance-open-shifts`: the test data had no open shift) was fixed by adding one, and is now caught.
- Real browser (Edge, production build, vite preview, API on :3000, fresh database, 1024x768 then 768x1024):
  34/34. Signed in as a manager on an enrolled tablet; opened every report; sales by channel; today flagged
  provisional and January not; CSV downloaded with the right name; an inverted range shows an error; no sideways
  scroll; no page errors. The script is in the session scratchpad, not the repo.
- Database tests (RLS, 8/8) passed in `pnpm test` on the same code. The older mutants were not re-run (only `rep-*`).

## Not covered

- The consolidated view with more than one outlet in the browser: the seed gives each manager one outlet, so the
  "All my outlets" selector never shows. The API test covers it.
- Large data: nothing here has been measured against months of real sales, and I did not check which indexes the
  queries use. Worth an `EXPLAIN` before a tenant has a year of sales.
- Printing a report; only CSV.
