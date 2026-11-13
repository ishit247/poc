<meta charset="utf-8">

# Handover: catalog templates, item descriptions and pictures (object store)

Read `CLAUDE.md` (working agreements are policy: schema is fixed in its original migration, `up:fresh` is the
verification, Edit tool not sed, filtered command output, ask before the listed exceptions), then
`docs/catalog-templates.md` (decisions C1-C9 and P1-P9, data model, API, the Garage section), then this file.
Logins and how to start the stack are in `docs/test-accounts.md`.

Landed in commit `43a4f78` on `main`. Everything below is in that commit.

## Done

- **Platform console** (`apps/admin/src/Catalog.tsx`, `TenantDetail.tsx`, `api.ts`): "Catalog templates" page (list with
  category and item counts, view with HSN/SAC, GST %, price, description and thumbnail; create and delete for the owner
  only; support sees it read-only). On a tenant's page, an owner-only "Seed menu from template" with a confirm step; the 409
  "tenant already has a menu" is shown as a clear message; the accountant-owns-the-rates note is on screen.
  Units: prices are tax-exclusive paise shown as rupees, GST is shown as a percent and sent as basis points, HSN is 4-8 digits.
- **Descriptions**: plain text, 300 characters, on `catalog_item` and `item`, delivered in pull.
- **Pictures**: bytes live in Garage (S3-compatible, container), Postgres keeps an index only. The browser shrinks every
  upload to a 320 px WebP of at most 64 KB; the API checks the real bytes, the 64 KB cap and 500 pictures per tenant.
  Pull carries only the hash. A tablet fetches each hash it lacks once (three at a time, in the background), verifies it,
  keeps it in IndexedDB (`itemImages`), and works offline. Seeding copies each distinct picture once, inside the store.
- **Manager API** (no screen yet): `PATCH /items/:id` (description), `PUT` and `DELETE /items/:id/image`,
  `GET /item-images/:sha256`; tablets use `GET /device/item-images/:sha256`.
- **Counter tiles** (`apps/counter/src/Sell.tsx`, `itemImages.ts`): picture plus a two-line description.
- **Tests**: `apps/api/test/item-images.test.ts` (descriptions, hash-only pull, serving and tenant wall, size and type
  rules, sharing and cleanup of objects, the picture cap, template pictures and seeding, an upload-versus-release race),
  `apps/api/test/platform-catalog.test.ts`, and `db/test/platform.test.mjs` (the console role's exact grants include
  `catalog_image`).

## How it was verified

- Real Postgres and real Garage; the whole workspace suite and the DB tests passed after `pnpm run up:fresh`.
- Mutations proven caught: disabling object cleanup fails the cleanup test; disabling the picture lock fails the race test.
- Browser (Edge via `playwright-core`, 1024x768): console upload (a non-picture is refused; a 1200 px PNG became a 320 px
  WebP of 748 bytes), two items sharing one picture give one hash, the view shows thumbnails and descriptions, seeding works;
  on the counter the Samosa tile shows picture and description, other tiles stay text, one fetch per picture, a second sync
  fetches nothing, and after going offline and reloading the picture still shows.
- **That browser script is not in the repo** (it lived in a session scratch folder). Re-create it if you need it.
- **Not verified**: WebP encoding in a browser other than Edge/Chromium (the console reports "too detailed" if the canvas
  cannot make WebP); real tablets or printers; load with thousands of items (see "Scale" below).

## Gotchas (each cost time once)

- **Lock order.** Every versioned write holds the tenant's version lock until commit. Any route that touches pictures must
  call `lockItemImages(c, tenantId)` FIRST, before its first write to a versioned table, or two requests deadlock. The race
  test in `item-images.test.ts` exists for this.
- **YAML numbers.** In `docker-compose.yml` the S3 secret is quoted on purpose: an all-digit value is a number to YAML and
  silently becomes `1`.
- **Git Bash rewrites `/garage`** to a Windows path. Use `MSYS_NO_PATHCONV=1 docker compose exec garage /garage ...`, or run
  it from `scripts/garage-init.mjs` (plain Node, no rewrite).
- **The dev tenants accumulate items across test runs**, so a test that reads one pull page and expects its item will start
  failing as data grows. Follow `hasMore` (see `pullItem` in `item-images.test.ts`), or run `pnpm run up:fresh` first.
- **Console sign-in codes are one per 30 seconds per operator.** Two scripted sign-ins in the same step fail with a timeout.
- **Secrets are dev values**: `deploy/garage.toml` (RPC secret, admin token) and the S3 key pair in `docker-compose.yml` and
  `scripts/garage-init.mjs`. Replace all before real use.
- **Backups** are now the Postgres dump plus the `garage-meta` and `garage-data` volumes, together. `up:fresh` destroys all.

## Not done (candidates for the next task, in the order I would take them)

1. ~~**Manager menu editor screen**~~ **Done 2026-11-14**: Manager tools → Menu in the counter app (online-only grid,
   three channel prices, pictures via `shrinkImage` now in `packages/shared`, CSV export/import, one transactional
   `POST /menu/apply`). See [manager-menu-editor-plan.md](manager-menu-editor-plan.md).
2. **Edit an existing template.** Templates are create-and-delete only (no edit route). Decide whether operators need edit,
   or "clone then change".
3. **Sweep orphan objects.** A missed removal after commit leaves an object with no index row (space only). A small job that
   lists the bucket and deletes objects with no row, older than a day, closes it.
4. **Put the browser check in the repo** (a short playwright script under `scripts/`, run on demand, not a big suite).
5. **Other browsers**: confirm canvas WebP in Safari/Firefox, or add a JPEG fallback in `shrinkImage`.

## Scale (a hypothetical, not a plan)

A 50K-item supermarket is a different product shape: the counter renders one button per item, `loadMenu` reads every
synced row into memory, there is no search or barcode lookup, and stock is only a toggle (PLAN.md). Pictures would need
on-demand fetching and a higher cap. If it becomes real, give it its own phase in `PLAN.md`; do not stretch this design.
