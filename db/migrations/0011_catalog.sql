-- Operator-level catalog templates (docs/catalog-templates.md).
--
-- A template is copied into a tenant once, when the operator seeds it; afterwards the tenant's menu is ordinary
-- tenant rows and nothing links back. These tables belong to no tenant (no tenant_id, no RLS), so the wall is the
-- grants: pos_app is REVOKEd everything, and app_platform holds only what is written below.

CREATE TABLE catalog_template (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE UNIQUE INDEX catalog_template_name_uq ON catalog_template (lower(name)) WHERE deleted_at IS NULL;

CREATE TABLE catalog_category (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id uuid NOT NULL REFERENCES catalog_template(id),
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  sort_order  int NOT NULL DEFAULT 0,
  UNIQUE (template_id, id)
);

-- Same checks as item.hsn_code and item_price.gst_rate_bp. Price is tax-exclusive integer paise; one GST rate per
-- item, copied to every channel row when seeded. All three are suggestions: the tenant's manager can override them.
CREATE TABLE catalog_item (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id uuid NOT NULL,
  category_id uuid NOT NULL,
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  hsn_code    text CHECK (hsn_code ~ '^[0-9]{4,8}$'),
  gst_rate_bp int NOT NULL DEFAULT 0 CHECK (gst_rate_bp BETWEEN 0 AND 4000),
  price_paise bigint NOT NULL CHECK (price_paise BETWEEN 0 AND 100000000),
  sort_order  int NOT NULL DEFAULT 0,
  FOREIGN KEY (template_id, category_id) REFERENCES catalog_category(template_id, id)
);

-- Provenance only: which catalog item a tenant item was seeded from. No foreign key, no behaviour; the tenant side
-- cannot see the catalog, and deleting a template must not touch tenant menus.
ALTER TABLE item ADD COLUMN source_catalog_item_id uuid;

-- Default privileges gave pos_app all four rights. REVOKE is what withholds.
REVOKE ALL ON catalog_template, catalog_category, catalog_item FROM pos_app;
REVOKE ALL ON catalog_template, catalog_category, catalog_item FROM PUBLIC;

-- Templates are soft-deleted (UPDATE); categories and items are write-once.
GRANT SELECT, INSERT, UPDATE ON catalog_template TO app_platform;
GRANT SELECT, INSERT ON catalog_category, catalog_item TO app_platform;
