<meta charset="utf-8">

# Build notes: decisions taken while building, open gaps, gotchas

This file replaces the per-phase handover and progress notes for phases 1 to 9 and the catalog-pictures work
(`handover-phase3*.md`, `handover-phase4..8-progress.md`, `phase7-plan.md`, `phase9-notes.md`,
`handover-catalog-images.md`; all in git history before 2026-11-14). Test counts and "not yet committed" states from
those notes are left out on purpose: the current state is PLAN.md section 0, and the history is in git.

What belongs here: a decision made during a build that the design in PLAN.md does not state, a known gap that is
still open, and a trap that cost time once. Active phases keep their own file (phase 11, phase 12) until done.

## Decisions taken during the build (do not re-ask)

**Tenancy and sign-in**
- D12 as revised: the login email picks the tenant, not the address. Manager emails are globally unique
  (`app_user_email_uq`); `tenantForLogin()` (`apps/api/src/db.ts`) sees one active manager row through a read-only
  policy. A subdomain is optional and only brands the unauthenticated sign-in screen (`GET /branding`). A person who
  manages two caterers needs two emails.
- Tablets sign in staff by PIN, offline. Opening an online-only screen (Online queue, Manager tools) asks for the PIN
  again and gets a server session from `/device/pin-signin`, held in memory only.
- Managers never reach tablets in pull; pull carries this outlet's cashiers and waiters with their PIN verifiers.
- Lockout counters live in `login_lockout`, per user and kind (`password`, `pin`), so a failed PIN never bumps a
  user's version.

**Settings (per tenant, `tenant_setting`)**
- `maxLineQty` (default 99), `gstRounding` (half_up | up | down), `billRoundTo` (0/10/50/100 paise, never rounds a bill
  to zero), `offlineDays` (Q9 = 7, 1 to 60). Total = subtotal + tax + round-off; `line_total_paise` is the pre-GST net.

**Ingest (phase 4)**
- Internal inconsistency is rejected for good (lines that do not add up, payments not equal to total, wrong receipt
  number, another device's sale, a database constraint). The quantity cap and the tenant's rounding settings are
  **flags, not rejections** (`over_qty_cap`, `settings_differ`): a manager changing them while a tablet is offline must
  not throw away a sale already handed over. Other flags: `sold_unavailable`, `clock_ahead` (> 5 min), `late_arrival`.
- Unknown event type, unsupported schema version and a reused `seq` are rejected but not ledgered (an upgrade may fix
  them). A deferred event leaves no ledger row.
- A revoked device may still push events created before `revoked_at`; they are audited `sync.from_revoked_device`.
- `payment.taken` carries `businessDate`: an order saved before midnight and paid after takes the receipt's date.

**Receipts (phase 5)**
- English only (Q6). 32 columns for the 58 mm ATPOS H58BT. GST-disabled outlets print "Bill of Supply" with no tax
  lines. CGST and SGST per rate, each half; the odd paisa goes to CGST. The layout is one pure function
  (`renderReceipt`, `packages/shared/src/receipt-text.ts`) so an ESC/POS path can reuse it.
- A reprint is queued as `print.reprinted` before the print dialog opens; the server audits `sale.reprinted` once.

**Shifts and day close (phase 6)**
- Expected cash = float + the cash part of each payment (`expectedCash`, `packages/shared/src/shift.ts`), shared by
  the tablet slip and the server. Money taken after the count is accepted and flagged `after_shift_close`.
- Day close blocks on an open shift, an open sale dated on or before the day, and a tablet reporting unsent events
  (`x-outbox-pending`); a manager may step over a named tablet (audited). Receipt gaps are shown and frozen, never
  blocking. Late adjustments are listed once, at the next close.

**Online orders (phase 7)**
- Online orders are online-only API calls, not outbox events. Each is a `sale` with `channel = zomato|swiggy` plus an
  `online_order` row; non-counter sales never carry a receipt number.
- The sale counts at `handed_over` (one `aggregator` payment); business date is the outlet's local date at handover;
  online sales belong to no shift. Rejected, cancelled or expired voids the sale.
- Jobs that scan across tenants (expiry, outbox, webhook lookup) use a stamped, SELECT-only policy (`app.job`), because
  a SECURITY DEFINER function cannot read across FORCEd row security.
- Settlement matching compares gross to the sale total only; a paid-but-not-delivered order is reported separately,
  not as a mismatch. An import never edits a sale.

**Reports (phase 8)**
- One route, `GET /reports/:kind`, for the screen and the CSV, so they cannot disagree. Paid sales only (the day-close
  rule). Online sales are attributed to the counter and person that keyed them. CSV cells starting `= + - @` get a `'`.

**Aggregator adapters (phase 9, scaffold)**
- Q1: outlets are listed on the platforms; onboarding is per outlet. The webhook payload and signature
  (hex HMAC-SHA256 of `<unix seconds>.<raw body>`, 5-minute window) are our own placeholders until partner docs
  arrive. Outbound senders throw "partner API not configured", so messages end `failed` and visible.
- Manager setup (2026-11-15): Platforms tab (`apps/counter/src/manager/Platforms.tsx`) over `routes/integrations.ts`.
  Per outlet and platform: map platform item ids to items (the "needs an item" list is built from the last 30 days of
  `online_order.unmapped_lines`), store id, webhook secret (sealed on save, never returned; left blank it is kept),
  receiving tablet and booked-to person (both must be at that outlet), on/off, and the last 20 inbound calls. No delete
  for an integration: turn it off. The store id is unique per platform across tenants, so a 409 can come from another
  tenant's row. Only items with a live price on the platform can be picked (the `createOrder` rule); a mapping whose item
  later loses its price is flagged. The counter's order card lists unmapped lines ("Not on this bill, check the
  platform app").

**Catalog pictures**
- Bytes live in Garage (S3-compatible); Postgres keeps an index. Uploads are shrunk in the browser to a 320 px WebP of
  at most 64 KB; the API checks the real bytes, the cap and 500 pictures per tenant. Pull carries only the hash.

## Open gaps (not in the phase tracker's one-line summary)

| Area | Gap |
|---|---|
| Tablet | `navigator.storage.persist()` is never called, and storage durability is unchecked on a real tablet |
| Tablet | The offline-days lockout (`offlineDays`) is stored but not enforced |
| Manager UI | Done 2026-11-15: manager Settings tab (`apps/counter/src/manager/Settings.tsx`) for selling rules, logo, and per-outlet address/FSSAI/GST. Checked in Edge at 1024 and 820 wide only (`browser-settings.mjs` 25/25); not on a real tablet or Safari/Firefox. Logo is uploaded as picked (PNG/JPEG/WebP, 256 KB), not resized. Added `GET /settings/logo` (manager's own tenant) and address/FSSAI/GST fields on `/me` |
| Printing | Nothing printed on the real H58BT; no WebUSB, Bluetooth, ESC/POS or drawer kick. Non-ASCII item names would need a code page or bitmap printing |
| Receipt | The printed time is when the order was rung up, not when it was paid |
| Day close | Late adjustments key on arrival time; closing days out of date order may list or miss some |
| Online | Online voids are not in the day's void count (they carry no business day) |
| Online | Only Samosa has a Zomato price in the seed and no item has a Swiggy price; other items return `422 unknown_item` |
| Reports | No refund route, so the refund half of the voids report is empty; no `EXPLAIN` on a year of data; multi-outlet view only API-tested |
| Phase 9 | No menu or stock push to platforms. The Platforms tab was checked only in Edge at 1024 and 820 wide; the "needs an item" list has no paging (capped at 100) and is not grouped by name |
| Pictures | No sweep for orphan objects in the bucket; WebP encoding checked only in Edge (Safari/Firefox may need a JPEG fallback in `shrinkImage`); the console picture browser check is not in the repo |
| Scale | A 50K-item catalogue is a different product (one button per item, the whole menu in memory, no barcode). Give it its own phase if it becomes real |

## Gotchas (each cost time once)

**Environment and tools**
- Never run bare `pnpm up` (it is `pnpm update`); use `pnpm run up:fresh`.
- TypeScript 7 does not auto-include `@types/node`; each package sets `"types": ["node"]`.
- `pnpm` build scripts: `esbuild: false` in `pnpm-workspace.yaml`. The pnpm store is `D:\.pnpm-store`.
- Git Bash rewrites `/garage` to a Windows path: use `MSYS_NO_PATHCONV=1 docker compose exec garage /garage ...` or
  `scripts/garage-init.mjs`.
- In `docker-compose.yml` the S3 secret is quoted: an all-digit value is a number to YAML and becomes `1`.
- Bash heredocs containing backticks broke once; use the Edit or Write tool for files. Files under `scripts/` and some
  migrations are CRLF, so mutant `from` patterns over several lines should be regexes.
- The machine is short of memory: run validation stages one after another.
- Console sign-in codes are one per 30 seconds per operator; two scripted sign-ins in one step time out.

**Tests and shared state**
- API tests share one database and run serially; a failing test can leave state behind (one mutation run once
  deactivated the seeded manager). Run `node scripts/validate.mjs fresh --yes` before the API suite and before each
  browser script.
- Test data grows across runs: a test that reads one pull page will start failing. Follow `hasMore`.
- A test that needs a signed-in cashier creates its own via `POST /users`; other suites change seeded PINs.
- Tests that add an outlet to tenant A are named `zz-*.test.ts` so they run last (an extra outlet breaks the outlet and
  scope suites).
- In the DB trading tests, `SET CONSTRAINTS ALL IMMEDIATE` lasts for the rest of the transaction; switch back to
  `DEFERRED` before inserting a paid sale.
- Do not edit source or commit while `scripts/mutation-checks.mjs` runs: it rewrites files and restores them after.
  Do not kill it mid-run. Afterwards, `git status` must show only your own changes.

**Schema and data**
- `outlet_item.listed` is nullable on purpose: NULL means "no opinion", so a stock toggle never lists an item.
- Lock order: every versioned write holds the tenant's version lock until commit. A route that touches pictures calls
  `lockItemImages(c, tenantId)` first, before any versioned write, or two requests deadlock.
- A backup dumped as `pos_owner` is refused because of FORCEd RLS; use the superuser or a BYPASSRLS read-only role.
  Backups are the Postgres dump plus the `garage-meta` and `garage-data` volumes, together (see `docs/runbook.md`).
- The Vite proxy forwards Host unchanged; do not set `changeOrigin`.
