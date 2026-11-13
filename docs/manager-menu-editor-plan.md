<meta charset="utf-8">

# Manager menu editor — plan

Status: **steps 1–3 done (2026-11-14); next is step 4** (`menuDraft.ts`, STANDARD). Source: `docs/handover-catalog-images.md`, "Not done" item 1.
Model: steps marked HIGH touch an authorisation-scoped write route; the rest are STANDARD (CLAUDE.md model table).

## Decisions (made with the user, 2026-11-13)

1. **Online-only**, like Reports, Settlements and Tablets. Offline, the tab says it needs a connection. Tablets receive
   changes on the next pull. No new events, no outbox, no ingest change.
2. **Admin-like editing, not one-field-at-a-time.** The manager gets the same efficient surface as the admin catalog
   editor: category sidebar, spreadsheet grid with keyboard navigation and paste, search, "only rows with problems",
   multi-select with bulk GST / HSN / move / delete, undo and redo, picture thumbnail with change/remove.
3. **`shrinkImage` moves to `packages/shared`** and both admin and counter import it (one rule, one place).

4. **Manager edits all three channel prices** (counter, Zomato, Swiggy) — decided 2026-11-13.
5. **Export and re-import** (CSV) so the manager can edit in a spreadsheet and bring it back — decided 2026-11-13.
   Step 7 is in scope, not optional.

Not in scope: offline editing; template import/seed (platform concern); outlet menu modes and per-outlet listing;
Hindi names; picture import from a folder (pictures are set per item in the screen; export does not carry them).

## What exists

- API: `apps/api/src/routes/menu.ts` — `GET /menu`, categories, items, tags, `PUT /items/:id/tags`, item image
  `PUT/DELETE`, channel prices `PUT/DELETE /items/:id/prices/:channel`, `GET /item-images/:sha256`. All
  `scope: tenant, permission: manager`, audited, tombstoned deletes. Tests: `apps/api/test/menu.test.ts`, `tags.test.ts`.
- Admin grid to mirror: `apps/admin/src/CatalogEditor.tsx` (486 lines) and `catalogIO.ts` (draft type, per-row `issues()`,
  CSV). It edits a **template** as one document and saves it whole. The live menu is different: rows already exist,
  have ids, per-channel prices, a quick code, diet and tags.
- Counter: `apps/counter/src/manager/ManagerTools.tsx` has four tabs; each screen takes the manager `token` and calls
  `manager/api.ts`.

## Design

### Saving: one transaction, not N calls (HIGH)

The grid edits a local draft; **Save** sends one diff. Doing it as many per-item calls could stop halfway (CLAUDE.md:
"a multi-step change cannot stop halfway"), leaving a half-edited menu live on every tablet. So add one route:

`POST /menu/apply` (`scope: tenant, permission: manager`) with body
`{ categories: {create[], update[], delete[]}, items: {create[], update[], delete[]}, prices: {set[], delete[]} }`,
validated by the **same zod schemas** already in `menu.ts` (extract them; do not copy). One `withTenant` transaction;
all-or-nothing; one audit row per entity as today (savepoint rule for audit writes). Returns the fresh `/menu` payload so the
screen reloads from truth. A client id in the body (`tmp-…`) lets an item reference a category created in the same diff;
the response maps tmp ids to real ones. Reuse the existing per-entity SQL by pulling it into functions that the single
routes and `apply` both call (one rule, one place) — do not duplicate the INSERT/UPDATE text.

Limits: cap the diff (e.g. 500 ops) and a body limit; report the first failing op by index so the grid can mark the row.
Conflicts: a row whose id was deleted by someone else returns 409 with the op index; the screen offers Reload.

**As built (step 2, 2026-11-14)** — `apps/api/src/routes/menu.ts`, `applyChange`:

```
POST /menu/apply
{ tags?:       { create?: [{ ref, name, sortOrder? }] },
  categories?: { create?: [{ ref, name, code?, sortOrder? }], update?: [{ id, ...fields }], delete?: [id] },
  items?:      { create?: [{ ref, categoryId: id|ref, name, code?, hsnCode?, description?, diet?, sortOrder?, tagIds?: (id|ref)[] }],
                 update?: [{ id, categoryId?: id|ref, ...fields, tagIds?: (id|ref)[] }], delete?: [id] },
  prices?:     { set?: [{ itemId: id|ref, channel, pricePaise, gstRateBp }], delete?: [{ itemId, channel }] } }
→ 200 { categories, items, prices, tags, refs: { "tmp-…": uuid } }      (the fresh /menu payload)
→ 400 { error: 'invalid request' | 'nothing to apply' | 'too many changes' }
→ 400 { error: 'unknown ref' | 'duplicate ref', op: { list, index } }
→ 409 { error: 'not found' | 'category not found' | 'tag not found' | 'category has items' | 'code in use' | 'no free code' | 'tag name in use', op: { list, index } }
```

- A ref is `tmp-` + 1–40 of `[A-Za-z0-9_-]`. `list` is e.g. `items.update`; `index` is the position in that array.
- Ops run in this fixed order: tags.create, categories.create, categories.update, items.delete, items.create, items.update,
  prices.delete, prices.set, categories.delete. So a category emptied in the same change can be deleted, and a deleted
  item's code is free for a new one.
- `tagIds` replaces the item's whole tag set (as `PUT /items/:id/tags`). An emptied price on a live item that has no
  price on that channel is fine (it is already in the state asked for).
- Cap: 500 ops in total, body 1 MB. Another tenant's ids are "not found" (RLS), never an error that reveals them.
- Known limit: two live items cannot **swap** codes in one change (the unique index is not deferrable). The second op
  gets `code in use`. The screen should say so and suggest saving the swap in two steps.

Pictures stay immediate and outside the diff: content-addressed, one `PUT /items/:id/image` per item as soon as the
manager picks it (needs the item to exist, so a new row's picture uploads after Save, right after `apply` returns the real
id). A picture that fails after Save reports per row; it never undoes the saved menu.

Tags: `PUT /items/:id/tags` stays per item (small, already atomic). Include tag edits in `apply` only if the grid grows a
tag column in the first cut (default: tags and diet are editable in a row drawer, saved with the row via `apply`).

### Screen

New tab **Menu** in `ManagerTools.tsx` (`data-testid="mgr-tab-menu"`), file `apps/counter/src/manager/MenuEditor.tsx`.
Layout follows the admin editor, tablet-first: categories as a left rail (a horizontal strip at tablet width if the rail
costs too much), grid in the centre, actions at the very top (memory: no wasted top space, primary action first).
Columns: name, quick code, counter price, Zomato price, Swiggy price, GST %, HSN, diet, tags, picture. A channel price
left empty means the item is not sold on that channel (the row's price is deleted on save). GST is held per price row in
the database (`item_price.gst_rate_bp`); the grid has one GST % per item and applies it to all of that item's channel
prices, so the three can never disagree on screen (check the seed and API tests: if a real case needs different rates per
channel, move GST to the row drawer). Targets at least 44px; no hover-only controls; no horizontal scroll (at narrow width
HSN, description, diet, tags and the two aggregator prices move into a row drawer).

- Pure data code (draft type, `issues()`, diff builder, bulk ops) goes in `apps/counter/src/manager/menuDraft.ts` with unit
  tests, free of React, like `catalogIO.ts`. Row checks mirror the API's (name, 2-digit code, HSN 4–8 digits, GST 0–40,
  price) and name the mirror in a comment. Reuse by moving the shared parts (`parsePaise`, `parseGstBp`, `DESC_MAX`) to
  `packages/shared` rather than importing admin code into the counter.
- Disabled-with-reason: Save is disabled with a title when there are problems or nothing changed; never removed.
- Delete: category with items is refused by the server (409) — the screen disables Delete and says why. Item delete asks
  for confirmation and notes that past sales keep the item's name.
- Leaving with unsaved changes asks first. Offline: a banner, grid read-only.
- Sold-out toggle stays on the till (`PUT /outlets/:outletId/items/:itemId`); not duplicated here.

## Steps

| # | Step | Model | Done when | State |
|---|------|-------|-----------|-------|
| 1 | Move `shrinkImage`, `parsePaise`, `parseGstBp`, `DESC_MAX` and the CSV reader/writer to `packages/shared`; admin imports them | STANDARD | admin + shared typecheck, shared tests, admin catalog tests pass | **Done** 2026-11-14: shared `money.ts`, `csv.ts`, `browser.ts` (`shrinkImage`); `DESC_MAX` is `ITEM_DESCRIPTION_MAX`. Admin typecheck clean, admin 9/9, shared 59/59 |
| 2 | Extract per-entity SQL and zod schemas in `menu.ts`; add `POST /menu/apply`; route-scope declaration | **HIGH** | API tests on real Postgres: all-or-nothing (one bad op rolls back all), cross-tenant ids rejected by RLS, non-manager 403, tmp-id mapping, audit rows, 409 on a deleted row | **Done** 2026-11-14: `apps/api/test/menu-apply.test.ts` (7 tests). Fresh-DB full API run 254/256; the 2 failures are the `7d` refused-receipt tests, failing since `refused.ts` changed 2026-11-10, not this work |
| 3 | Mutants in `scripts/mutation-checks.mjs` for `apply` (permission, tenant scope, rollback, category-in-use guard); run only these by id | HIGH | all caught | **Done** 2026-11-14: 7 `apply-*` mutants plus the 4 menu-route mutants touched by the refactor: 11/11 caught |
| 4 | `menuDraft.ts` + unit tests (diff builder, issues, bulk ops, undo stack) | STANDARD | tablet tests pass |
| 5 | `MenuEditor.tsx` grid, rail, search, bulk bar, undo/redo, save/discard, offline banner; Menu tab | STANDARD | typecheck; browser check at tablet size |
| 6 | Pictures: pick, shrink, upload after save, remove; thumbnail via `/item-images/:sha256` | STANDARD | browser check: set, change, remove; second tablet sees it after pull |
| 7 | CSV export and import of the live menu (design below) | STANDARD | unit tests on parse/match/diff; browser check: export, edit, import, preview, save |
| 8 | Docs and tracker (below) | STANDARD | tracker row updated |

Steps 1–3 can be one session (HIGH); 4–6 another. Start a fresh session between them.

### CSV export and import (step 7)

- **Export** downloads the whole live menu (all categories, not just the selected one). Columns:
  `id, category, name, code, diet, hsn, gst, price_counter, price_zomato, price_swiggy, tags, description`. `id` is the
  item id; prices are rupees excluding GST, as in the admin CSV; `tags` are names joined by `|`. Reuse the CSV
  reader/writer from admin `catalogIO.ts` after moving it to `packages/shared` (add to step 1); do not write a second one.
- **Import never saves by itself.** It loads the file into the grid as a draft, so the same row checks, undo and
  the same transactional **Save** (`apply`) are used. A preview strip says "N changed, M new, K unchanged, J problems".
- **Matching:** by `id` when present and live; otherwise by category name + item name (case-insensitive); otherwise a new
  item. A category name not found is created. An unknown tag name is created. Two rows with the same match key in the
  file are a problem on both rows, not a silent merge.
- **Items missing from the file are left alone** (never deleted by import). Deleting stays an explicit action in the grid,
  so a partial or filtered spreadsheet cannot wipe the menu.
- **Empty cell vs absent column:** an empty price cell removes that channel's price; a column missing from the file leaves
  that field untouched. The preview says which.
- Excel-safe: UTF-8 with BOM on export, quote any cell with a comma, quote or newline; the importer strips the BOM. A
  quick code like `07` must survive Excel: export it as text and the importer left-pads a single digit to two.
- Pictures are not in the CSV; imported rows keep their current picture, new rows have none.

## Verification

- Authorisation and tenant isolation (step 2): real Postgres, mutants, per CLAUDE.md "How much verification".
- Screen (steps 5–6): real browser at tablet size, Edge via a script under `scripts/` (like `browser-tables.mjs`), checking
  cashier and waiter see no Menu tab, manager edits price and the till shows it after pull, a failed save leaves nothing
  half-applied, offline banner. Then say plainly which checks ran.
- Seeds: the two tenants already have menus; no schema change is expected. If one is needed, edit the original migration
  and run `up:fresh` (no real tenant yet).

## Docs to update in the same change as the build

- `PLAN.md`: tracker row for this work (0.1) and 0.3 next steps; mark done only with evidence.
- `docs/handover-catalog-images.md`: strike "Not done" item 1, link here.
- `docs/catalog-templates.md`: one line that managers edit the live menu in Manager tools → Menu, and templates are
  still only suggestions.
- `README.md`: Manager tools list gets "Menu".
- `docs/runbook.md`: nothing expected (no new service or secret); confirm.
- This file: set each step's state when done.

## Open questions

None open.

Resolved 2026-11-13: manager edits Zomato and Swiggy prices; CSV export and import are in scope.
Resolved 2026-11-14:
- Deleting an item with open orders is allowed. Ingest (`ingest.ts`, `order-ingest.ts`) treats a tombstoned item as
  unavailable, and sale lines keep `name_snapshot`, so past and open orders keep their names.
- One GST % per item: the seed gives every channel price of an item the same rate, and nothing needs it to differ.
