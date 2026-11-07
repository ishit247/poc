# Catalog templates (operator-level shared menus)

Status: decided 2026-11-03, implemented in `db/migrations/0011_catalog.sql` and the `/platform/catalog-templates` routes.

## What it is

The platform operator keeps reusable menu templates (for example "School cafeteria, North Indian"). When a new
tenant is created the operator seeds its menu from a template. The tenant's manager then edits the menu like any
other menu. Nothing links the tenant back to the template afterwards.

## Decisions

| # | Decision | Why |
|---|---|---|
| C1 | **Copy on seed, not live inheritance.** Seeding writes ordinary `category`, `item` and `item_price` rows into the tenant. | Tenant tables are FORCE RLS and versioned for device pull. Live inheritance would put operator rows into every tenant's pull and RLS path, and would need a second conflict system for "operator changed it, manager also changed it". |
| C2 | **The catalog carries HSN/SAC code and GST rate** per item. Seeding copies both into the tenant's `item.hsn_code` and `item_price.gst_rate_bp`. | Chosen by the operator. The manager can override both afterwards through the normal menu admin. |
| C3 | **Prices are tax-exclusive**, as everywhere else (PLAN.md, resolved question 10). There is no inclusive/exclusive flag on a catalog item. | A flag would let a template and a tenant disagree about what a price means. |
| C4 | **One GST rate per catalog item.** Seeding creates the `counter` channel price only, with that rate. Aggregator prices (Zomato, Swiggy) differ per channel and outlet, so the manager sets them. | Keeps the template simple; a template should not decide what a caterer charges on an aggregator. |
| C5 | **CGST/SGST versus IGST is not stored.** It is decided at invoice time. A counter sale is intra-state, so the one rate splits into CGST and SGST. | The catalog needs only the combined rate. |
| C6 | **Seeding never switches GST on.** `outlet.gst_enabled` (needs a GSTIN) still decides whether any tax is charged. | A rate copied from a template cannot cause wrong billing for a tenant with no GSTIN. |
| C7 | **Template rates and prices are suggestions.** The caterer's accountant owns them. | Responsibility for tax stays with the caterer. |
| C8 | **Seeding is refused when the tenant already has a menu** (any live category or item). | Seeding twice would duplicate everything. |
| C9 | Each seeded `item` stores `source_catalog_item_id` (provenance only, no foreign key, no behaviour). | Cheap now; lets a later "suggested updates" feature find which items came from a template without a data migration. |

## Out of scope for now

- Pushing a later template change to tenants that were already seeded. If wanted: an opt-in "suggested updates"
  list the manager reviews, offering only fields they have not touched. Nothing is overwritten.
- Composed templates (base plus add-ons). Templates are flat.
- A manager menu-editor screen. Managers can set an item's description and picture through the API
  (`PATCH /items/:id`, `PUT/DELETE /items/:id/image`), but no counter-app screen calls them yet.

## Descriptions and pictures

Decided 2026-11-03. Both are optional, per item, on the catalog item and on the tenant `item`.

| # | Decision | Why |
|---|---|---|
| P1 | **Description** is plain text, 1 to 300 characters, and travels in pull with the item. | Small, and the counter tile needs it offline. |
| P2 | **Picture bytes never travel in pull, and are not in Postgres.** `item.image_sha256` is only a hash. The bytes live in an S3-compatible object store (Garage, in a container); Postgres keeps only an index (`item_image` per tenant, `catalog_image` for the operator: hash, type, size). | A menu of hundreds or thousands of items would otherwise bloat every pull, every backup and the database's memory. Bytes in a store scale and cache independently of the database. |
| P3 | **Content-addressed.** The same picture used by many items is one index row and one object per tenant. A tablet fetches a hash it does not hold, once, from `GET /device/item-images/:sha256`, checks the bytes against the hash, and keeps it in IndexedDB (`itemImages`). | No duplicates, no re-download, and the address can be cached forever (`immutable`). |
| P8 | **The store is addressed only as an S3 endpoint** (`S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`; path-style). Only `apps/api/src/objects.ts` knows it. Keys: `t/<tenant_id>/<sha256>` (a tenant's pictures), `c/<sha256>` (operator templates). Tablets never talk to the store: the API checks the tenant's index row, then returns the object. | Garage can be replaced by any S3-compatible service by changing those five values. Tenant isolation stays in Postgres (RLS on the index), not in bucket policy. |
| P9 | **Write order.** Upload: object first, then the index row, so a row never points at a missing object. Release: row deleted in the transaction, object removed after commit; a missed removal leaves an orphan object (wasted space), never a broken item. Seeding copies `c/<sha>` to `t/<tenant>/<sha>` inside the store (the bytes do not pass through the API). A tenant-wide advisory lock, taken before any versioned write, orders storing against releasing the same picture. | Failure in the middle can waste space but cannot lose a picture an item still uses. |
| P4 | **The browser shrinks before upload**: longest edge 320 px, WebP, at most 64 KB. The server needs no image library; it checks the real bytes (PNG, JPEG or WebP, never SVG), the 64 KB cap, and at most 500 distinct pictures per tenant. | Keeps storage, bandwidth and tablet memory small without a new dependency. |
| P5 | **Fetched three at a time, in the background**, after a pull completes; a failure is retried on the next pull. Pictures no longer referenced are removed from the tablet. | A first sync of a large menu never blocks selling or floods the network. |
| P6 | **A picture nothing points at is deleted** (index row in the transaction that dropped the last reference, object right after commit): replace, remove, or item delete. | No blobs accumulating. |
| P7 | **Seeding copies each distinct picture once** into the tenant's prefix and index, and the item's hash. Nothing links back afterwards. | Same copy-on-seed rule as C1. |

## Data model

All four tables are operator-only: `pos_app` (the tenant API role) is REVOKEd every right, `app_platform` holds
explicit grants. They have no `tenant_id` and no RLS, because no tenant may see them.

- `catalog_template(id, name, created_at, deleted_at)`
- `catalog_category(id, template_id, name, sort_order)`
- `catalog_item(id, template_id, category_id, name, hsn_code, description, image_sha256, gst_rate_bp, price_paise, sort_order)`
- `catalog_image(sha256, content_type, byte_size, created_at)`: index only, write-once; `catalog_item.image_sha256`
  references it. The bytes are the object `c/<sha256>` in the object store.
- `item_image(tenant_id, sha256, content_type, byte_size, created_at)` (0003): the tenant's index, RLS-pinned; the bytes
  are the object `t/<tenant_id>/<sha256>`.

### Object store (Garage)

`docker compose` runs `garage` (one node, S3 API on 3900 inside the network, published as `localhost:53900` for host-side
tests and the seed). `scripts/garage-init.mjs` (called by `pnpm run env:up`) assigns the node's layout, creates the
`pos-images` bucket and imports the dev key; it is safe to run again. `deploy/garage.toml` and the key pair in
`docker-compose.yml` are DEV values, public in the repository: replace them before real use. Garage's data lives in the
`garage-meta` and `garage-data` volumes, so a backup is now the Postgres dump **and** those volumes, taken together.
`up:fresh` destroys all of them. Orphan objects (from a missed removal) are not swept yet; they cost space only.

`hsn_code` uses the same check as `item.hsn_code` (4 to 8 digits; SAC codes are 6). `gst_rate_bp` uses the same
check as `item_price.gst_rate_bp` (0 to 4000 basis points). `price_paise` is the suggested counter price.

## API (platform scope)

| Route | Who | Purpose |
|---|---|---|
| `GET /platform/catalog-templates` | any console user | List templates with item counts. |
| `GET /platform/catalog-templates/:id` | any console user | One template with categories and items. |
| `POST /platform/catalog-templates` | owner | Create a template with its categories and items in one body. |
| `PUT /platform/catalog-templates/:id` | owner | Save an edited template (same body as POST). The platform role has no DELETE on template rows, so an edit retires the current version (soft delete) and writes the new content as a fresh template in one transaction; the reply carries the **new id**. 404 for a retired or unknown id, 409 if the name is taken by another live template. |
| `DELETE /platform/catalog-templates/:id` | owner | Soft-delete a template. Already-seeded tenants are unaffected. |
| `PUT /platform/catalog-images` | owner | Upload one picture (raw body, `image/png`, `image/jpeg` or `image/webp`, at most 64 KB). Returns `{ sha256 }`; a template item refers to that hash. |
| `GET /platform/catalog-images/:sha256` | any console user | The picture's bytes. |
| `POST /platform/tenants/:id/seed-catalog` | owner | Copy a template into the tenant. Body `{ templateId }`. 409 if the tenant already has a menu. |

Every write is recorded in `platform_audit` (`catalog.create`, `catalog.update`, `catalog.delete`, `catalog.seed`) and the seed also
writes a tenant `audit` row.

## Editing and bulk import (console, Catalog)

The Catalog screen edits a template in a grid (inline cells, paste from a spreadsheet, bulk GST/HSN, undo) and saves it with
`PUT`. **Import folder** takes a folder holding `catalog.csv` and the pictures, dropped on the dialog or the grid, or chosen with
a picker:

```
category,item,hsn,gst,price,description,image
Snacks,Samosa,21069099,5,12,Crisp pastry,images/samosa.jpg
```

- Columns are found by header name, in any order; without a header they are read in the order above. Prices are rupees excluding
  GST; GST is a percent.
- The `image` column names the picture file (a bare name or a path ending in it). A row with no `image` value is matched to a
  picture by item name (case, dashes and extension ignored). A picture serves one row; pictures nothing uses wait in a tray.
- The preview reports items and categories, pictures found and missing, unused pictures and rows with problems before anything
  changes. Rows with problems are still imported and marked in the grid; Save is blocked until they are fixed.
- Pictures are shrunk in the browser (320 px, WebP, under 64 KB) and uploaded, by content hash, when the template is saved.
- Export CSV writes the data only; the `image` column is left empty.
