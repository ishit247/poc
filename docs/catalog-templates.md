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
- Admin-console screens. This change is API and database only.
- Description field on items. The tenant `item` table has none, so the catalog has none.

## Data model

All four tables are operator-only: `pos_app` (the tenant API role) is REVOKEd every right, `app_platform` holds
explicit grants. They have no `tenant_id` and no RLS, because no tenant may see them.

- `catalog_template(id, name, created_at, deleted_at)`
- `catalog_category(id, template_id, name, sort_order)`
- `catalog_item(id, template_id, category_id, name, hsn_code, gst_rate_bp, price_paise, sort_order)`

`hsn_code` uses the same check as `item.hsn_code` (4 to 8 digits; SAC codes are 6). `gst_rate_bp` uses the same
check as `item_price.gst_rate_bp` (0 to 4000 basis points). `price_paise` is the suggested counter price.

## API (platform scope)

| Route | Who | Purpose |
|---|---|---|
| `GET /platform/catalog-templates` | any console user | List templates with item counts. |
| `GET /platform/catalog-templates/:id` | any console user | One template with categories and items. |
| `POST /platform/catalog-templates` | owner | Create a template with its categories and items in one body. |
| `DELETE /platform/catalog-templates/:id` | owner | Soft-delete a template. Already-seeded tenants are unaffected. |
| `POST /platform/tenants/:id/seed-catalog` | owner | Copy a template into the tenant. Body `{ templateId }`. 409 if the tenant already has a menu. |

Every write is recorded in `platform_audit` (`catalog.create`, `catalog.delete`, `catalog.seed`) and the seed also
writes a tenant `audit` row.
