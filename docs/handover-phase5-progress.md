<meta charset="utf-8">

# Phase 5 progress: receipt layout, browser print, reprint trail

Read `CLAUDE.md`, `docs/handover-phase4-progress.md`, then this file. Baseline on a fresh
database: API 94, shared 39, DB 14, counter 20. Phase 5 mutants: 26/26 caught
(ids starting `receipt-`, `reprint-`, `tablet-waiter`, `tablet-reprint`, `tablet-recent`).

Hardware given: ATPOS H58BT, 58 mm, USB and Bluetooth, tear bar (no cutter).
Sample: `docs/Sample-Receipt.jpg` (a dine-in restaurant bill; it set the content, not the width).

## Done

- **Layout** (`packages/shared/src/receipt-text.ts`): pure `renderReceipt()` for 32 columns.
  Header (name, address, GSTIN, "Tax Invoice" or "Bill of Supply", "*** RE-PRINT ***"), bill number,
  date and time in the outlet's timezone, staff, numbered lines (name wraps, `qty x rate` and amount),
  Sub Total, **CGST and SGST per rate** (each half the rate; the odd paisa goes to CGST so they always
  sum to the tax), round-off, TOTAL, total qty, amount in words (Indian grouping), payments and
  change, FSSAI, footer. Long names and unbroken words wrap, never get cut. A golden test pins it.
- **Outlet fields** `address`, `fssai_no` (0003, seeded for every outlet except A2, so a receipt with
  neither is covered). `PUT /outlets/:id/receipt-info` (manager, own outlets, audited). Both are in pull.
- **Tablet:** `Receipt.tsx` shows the exact printed text and a Print button (browser print dialog,
  `@page` 58 mm, 48 mm printable, 9.4 px Courier New). `receipt.ts` maps a local sale to the layout using
  the pulled outlet, so it prints offline. Orders tab: cashier sees "Recent receipts" with Reprint.
- **Reprint trail:** event `print.reprinted` (who, when). The tablet queues it BEFORE opening the print
  dialog; the server (`applyReprint`) accepts only a paid sale of that device by a known user, and writes
  audit `sale.reprinted`. A retry does not add a second entry.

## Decisions taken (user said "go" to these)

English only (Q6). GST-disabled outlets print "Bill of Supply" with no tax lines or GSTIN. CGST gets
the odd paisa. Table#, Pax and Dine In from the sample are not printed (counter orders have none).

## Not done / unverified (say so)

- **Nothing printed on the real H58BT.** Font size, margins, the logo's look in black and white, and
  whether 32 characters really fit are guesses from the printer's spec. Adjust `styles.css` first.
- **No real-browser check** of the receipt screen, print preview or the reprint flow (and still none for
  push from phase 4). The user asked to delay it; do both together at tablet size.
- Direct USB (WebUSB) or Bluetooth printing, ESC/POS and cash-drawer are not built; browser print only.
  The text layout is plain ASCII-safe except item names, so an ESC/POS path can reuse `renderReceipt`.
  Non-ASCII item names (e.g. Hindi) would need a code page or bitmap printing there.
- The receipt time is the time the order was rung up, not the time of payment (payment time is not
  stored on the tablet). The date part can differ from the bill's business date after midnight.
- No manager UI for address/FSSAI (API only), nor a report of reprints.
- `sed` used once in an earlier step (phase 4 test fix); no other deviations from CLAUDE.md.
