-- Menu (reference data) with a per-tenant monotonic version for pull. PLAN.md 7.4, 8.

-- One counter row per tenant. Incrementing it takes a row lock that is held to
-- commit, so two writers in one tenant are serialised and versions COMMIT in
-- order: a device that has pulled up to version N can never later miss a
-- committed row with a version below N. (A plain sequence cannot promise this.)
CREATE TABLE tenant_version (
  tenant_id uuid PRIMARY KEY REFERENCES tenant(id),
  v         bigint NOT NULL
);
SELECT app.enable_tenant_rls('tenant_version');
-- The app role must not be able to rewind or skip the counter: only the
-- SECURITY DEFINER function below writes it. REVOKE is what withholds.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON tenant_version FROM pos_app;

CREATE FUNCTION app.next_version(t uuid) RETURNS bigint
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS
$$
  INSERT INTO tenant_version (tenant_id, v) VALUES (t, 1)
  ON CONFLICT (tenant_id) DO UPDATE SET v = tenant_version.v + 1
  RETURNING v
$$;
REVOKE EXECUTE ON FUNCTION app.next_version(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.next_version(uuid) TO pos_app;

-- Clients never choose a version or a timestamp: the trigger always overwrites.
CREATE FUNCTION app.stamp_version() RETURNS trigger
LANGUAGE plpgsql AS
$$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.tenant_id <> OLD.tenant_id THEN
    RAISE EXCEPTION 'tenant_id is immutable';
  END IF;
  NEW.version := app.next_version(NEW.tenant_id);
  NEW.updated_at := now();
  RETURN NEW;
END
$$;

-- Adds the version trigger and withholds DELETE (soft delete only, so every
-- removal is a tombstone the devices can pull). For tables that already have RLS.
CREATE FUNCTION app.add_versioning(tbl regclass) RETURNS void
LANGUAGE plpgsql AS
$$
BEGIN
  EXECUTE format(
    'CREATE TRIGGER stamp_version BEFORE INSERT OR UPDATE ON %s FOR EACH ROW EXECUTE FUNCTION app.stamp_version()', tbl);
  EXECUTE format('REVOKE DELETE, TRUNCATE ON %s FROM pos_app', tbl);
END
$$;
REVOKE EXECUTE ON FUNCTION app.add_versioning(regclass) FROM PUBLIC;

-- New table: RLS plus versioning.
CREATE FUNCTION app.make_versioned(tbl regclass) RETURNS void
LANGUAGE plpgsql AS
$$
BEGIN
  PERFORM app.enable_tenant_rls(tbl);
  PERFORM app.add_versioning(tbl);
END
$$;
REVOKE EXECUTE ON FUNCTION app.make_versioned(regclass) FROM PUBLIC;

-- Users reach devices by pull (offline PIN sign-in). Columns are in 0001; RLS already applied.
-- Hard delete is withheld on both: a user is deactivated, a membership is tombstoned.
SELECT app.add_versioning('app_user');
SELECT app.add_versioning('user_outlet');

CREATE TABLE category (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenant(id),
  name       text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  -- Quick code (PLAN D16): text, so "01" keeps its zero. Left NULL on insert, a trigger gives the next free one.
  code       text NOT NULL CHECK (code ~ '^[0-9]{2}$'),
  sort_order int NOT NULL DEFAULT 0,
  version    bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (tenant_id, id)
);
SELECT app.make_versioned('category');
-- A category code is unique among a tenant's live categories; an item code among the live items of one category.
-- Together the two give each live item a unique four-digit code (the width is fixed at 2 + 2 in v1).
CREATE UNIQUE INDEX category_code_live_uq ON category (tenant_id, code) WHERE deleted_at IS NULL;

-- Next free two-digit code. The lock serialises two writers asking for "the next one" in the same scope, so they
-- cannot both pick it; a code typed by a person is still protected by the unique index.
CREATE FUNCTION app.assign_category_code() RETURNS trigger
LANGUAGE plpgsql AS
$$
BEGIN
  IF NEW.code IS NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('category-code:' || NEW.tenant_id::text, 0));
    SELECT lpad(g::text, 2, '0') INTO NEW.code FROM generate_series(1, 99) g
     WHERE NOT EXISTS (SELECT 1 FROM category c WHERE c.tenant_id = NEW.tenant_id AND c.deleted_at IS NULL AND c.code = lpad(g::text, 2, '0'))
     ORDER BY g LIMIT 1;
    IF NEW.code IS NULL THEN RAISE EXCEPTION 'no free category code: all 99 are in use'; END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER assign_category_code BEFORE INSERT ON category FOR EACH ROW EXECUTE FUNCTION app.assign_category_code();

CREATE TABLE item (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  category_id uuid NOT NULL,
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  -- Quick code within the category (PLAN D16); see category.code.
  code        text NOT NULL CHECK (code ~ '^[0-9]{2}$'),
  -- Provision for GST invoicing (Q3): HSN/SAC code, 4 to 8 digits. Optional until the receipt format is known.
  hsn_code    text CHECK (hsn_code ~ '^[0-9]{4,8}$'),
  -- Plain text shown on the counter tile. Travels in pull (small).
  description text CHECK (length(description) BETWEEN 1 AND 300),
  -- Which picture, by content hash. The bytes live in item_image and are NOT in pull: a tablet fetches a hash it
  -- does not hold yet, once, and keeps it. No foreign key: item_image rows are immutable and cleaned up in code.
  image_sha256 text CHECK (image_sha256 ~ '^[0-9a-f]{64}$'),
  sort_order  int NOT NULL DEFAULT 0,
  version     bigint NOT NULL DEFAULT 0,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, category_id) REFERENCES category(tenant_id, id)
);
SELECT app.make_versioned('item');
CREATE UNIQUE INDEX item_code_live_uq ON item (category_id, code) WHERE deleted_at IS NULL;

-- On insert, or when an item moves to another category: keep the code if it is free there, else take the next free one.
-- (A moved item's full code changes in any case, because the category part does; the manager screen warns first.)
CREATE FUNCTION app.assign_item_code() RETURNS trigger
LANGUAGE plpgsql AS
$$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.category_id <> OLD.category_id AND NEW.code = OLD.code
     AND EXISTS (SELECT 1 FROM item i WHERE i.category_id = NEW.category_id AND i.deleted_at IS NULL AND i.code = NEW.code AND i.id <> NEW.id) THEN
    NEW.code := NULL;
  END IF;
  IF NEW.code IS NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('item-code:' || NEW.category_id::text, 0));
    SELECT lpad(g::text, 2, '0') INTO NEW.code FROM generate_series(1, 99) g
     WHERE NOT EXISTS (SELECT 1 FROM item i WHERE i.category_id = NEW.category_id AND i.deleted_at IS NULL AND i.id <> NEW.id AND i.code = lpad(g::text, 2, '0'))
     ORDER BY g LIMIT 1;
    IF NEW.code IS NULL THEN RAISE EXCEPTION 'no free item code: all 99 in this category are in use'; END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER assign_item_code BEFORE INSERT OR UPDATE OF category_id ON item FOR EACH ROW EXECUTE FUNCTION app.assign_item_code();

-- Item pictures, content-addressed: one row per distinct image per tenant, however many items use it. This table is the
-- INDEX only; the bytes live in the S3-compatible object store (Garage) under t/<tenant_id>/<sha256>. The browser
-- shrinks the picture before upload (about 320 px WebP, 15 to 30 KB); the API caps one at 64 KB and a tenant at 500.
-- Not versioned: a row never changes, and pull learns of a new picture through the item's own version. A picture
-- nothing references any more has its row deleted in the transaction that stopped referencing it, and its object
-- removed right after (a missed removal leaves an orphan object, never a dangling reference).
CREATE TABLE item_image (
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  sha256       text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  content_type text NOT NULL CHECK (content_type IN ('image/png', 'image/jpeg', 'image/webp')),
  byte_size    int NOT NULL CHECK (byte_size BETWEEN 1 AND 65536),
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, sha256)
);
SELECT app.enable_tenant_rls('item_image');
REVOKE UPDATE, TRUNCATE ON item_image FROM pos_app;

-- Money is integer paise. gst_rate_bp: basis points (500 = 5%).
CREATE TABLE item_price (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  item_id     uuid NOT NULL,
  channel     text NOT NULL CHECK (channel IN ('counter', 'zomato', 'swiggy')),
  price_paise bigint NOT NULL CHECK (price_paise BETWEEN 0 AND 100000000),
  gst_rate_bp int NOT NULL DEFAULT 0 CHECK (gst_rate_bp BETWEEN 0 AND 4000),
  version     bigint NOT NULL DEFAULT 0,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz,
  FOREIGN KEY (tenant_id, item_id) REFERENCES item(tenant_id, id)
);
CREATE UNIQUE INDEX item_price_live_uq ON item_price (item_id, channel) WHERE deleted_at IS NULL;
SELECT app.make_versioned('item_price');

-- Per-outlet item row. `available` is the daily stock toggle (cashier or manager);
-- `listed` is the manager's menu choice for this outlet and is NULL ("no opinion") until
-- they make one: a stock toggle creates this row too and must not list an item in a
-- 'listed' outlet. Absent row / NULL: shown in mode 'all', not shown in mode 'listed'.
CREATE TABLE outlet_item (
  tenant_id  uuid NOT NULL REFERENCES tenant(id),
  outlet_id  uuid NOT NULL,
  item_id    uuid NOT NULL,
  available  boolean NOT NULL DEFAULT true,
  listed     boolean,
  version    bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  PRIMARY KEY (outlet_id, item_id),
  FOREIGN KEY (tenant_id, outlet_id) REFERENCES outlet(tenant_id, id),
  FOREIGN KEY (tenant_id, item_id)   REFERENCES item(tenant_id, id)
);
SELECT app.make_versioned('outlet_item');

-- Outlet-specific menu and pricing. Resolution order, most specific first:
--   counter override > outlet override > catalogue (item_price).
-- An outlet's mode filters first; a counter can only narrow what its outlet shows.
-- Outlet overrides are per channel, so aggregator prices can differ per outlet (Q10).
ALTER TABLE outlet
  ADD COLUMN menu_mode   text NOT NULL DEFAULT 'all' CHECK (menu_mode IN ('all', 'listed')),
  -- GST provision (Q3): a disabled outlet charges no GST whatever the item rate; enabling needs a GSTIN.
  ADD COLUMN gst_enabled boolean NOT NULL DEFAULT false,
  -- Tables (PLAN D14): 'default' = counter service, one pre-selected table and no table step; 'map' = the table map.
  ADD COLUMN table_mode  text NOT NULL DEFAULT 'default' CHECK (table_mode IN ('default', 'map')),
  -- Printed on the receipt header and footer (phase 5). Single line each is not required for the address.
  ADD COLUMN address     text CHECK (address IS NULL OR length(address) BETWEEN 1 AND 200),
  ADD COLUMN fssai_no    text CHECK (fssai_no IS NULL OR fssai_no ~ '^[0-9]{14}$'),
  ADD COLUMN version     bigint NOT NULL DEFAULT 0,
  ADD COLUMN updated_at  timestamptz NOT NULL DEFAULT now(),
  ADD CONSTRAINT outlet_gstin_format CHECK (gstin IS NULL OR gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'),
  ADD CONSTRAINT outlet_gst_needs_gstin CHECK (NOT gst_enabled OR gstin IS NOT NULL);
SELECT app.add_versioning('outlet'); -- RLS already applied in 0001
CREATE INDEX outlet_version_ix ON outlet (tenant_id, version);

-- A table is a named slot for one running order (PLAN D14). Occupancy is NOT stored: a table is busy when it has an open
-- sale. Versioned, so tablets pull the table list like the menu; soft delete only, so a removal is a tombstone.
CREATE TABLE dining_table (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenant(id),
  outlet_id  uuid NOT NULL,
  code       text NOT NULL CHECK (code ~ '^[A-Za-z0-9][A-Za-z0-9 -]{0,9}$'),   -- what the counter shows: "T1", "Patio 3"
  sort_order int NOT NULL DEFAULT 0,
  is_default boolean NOT NULL DEFAULT false,
  version    bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, outlet_id, id),   -- lets sale.table_id prove the table belongs to the sale's outlet
  FOREIGN KEY (tenant_id, outlet_id) REFERENCES outlet(tenant_id, id)
);
SELECT app.make_versioned('dining_table');
CREATE UNIQUE INDEX dining_table_code_live_uq ON dining_table (outlet_id, lower(code)) WHERE deleted_at IS NULL;
-- At most one default per outlet; the trigger below makes sure there is one.
CREATE UNIQUE INDEX dining_table_default_live_uq ON dining_table (outlet_id) WHERE is_default AND deleted_at IS NULL;
CREATE INDEX dining_table_version_ix ON dining_table (outlet_id, version);

-- Every outlet has a default table from the moment it exists, so counter service never has to ask for one.
CREATE FUNCTION app.outlet_default_table() RETURNS trigger
LANGUAGE plpgsql AS
$$
BEGIN
  INSERT INTO dining_table (tenant_id, outlet_id, code, is_default) VALUES (NEW.tenant_id, NEW.id, 'T1', true);
  RETURN NEW;
END
$$;
CREATE TRIGGER outlet_default_table AFTER INSERT ON outlet FOR EACH ROW EXECUTE FUNCTION app.outlet_default_table();

-- The default table can be renamed but not removed, un-defaulted or moved to another outlet: that would leave an
-- outlet with no table for counter service. (Choosing a different default is a later feature.)
CREATE FUNCTION app.dining_table_guard() RETURNS trigger
LANGUAGE plpgsql AS
$$
BEGIN
  IF NEW.outlet_id <> OLD.outlet_id THEN RAISE EXCEPTION 'a table cannot move to another outlet'; END IF;
  IF OLD.is_default AND OLD.deleted_at IS NULL AND (NOT NEW.is_default OR NEW.deleted_at IS NOT NULL) THEN
    RAISE EXCEPTION 'the default table cannot be removed or un-defaulted';
  END IF;
  IF NOT OLD.is_default AND NEW.is_default THEN RAISE EXCEPTION 'the default table is set when the outlet is created'; END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER dining_table_guard BEFORE UPDATE ON dining_table FOR EACH ROW EXECUTE FUNCTION app.dining_table_guard();

CREATE TABLE outlet_price (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  outlet_id   uuid NOT NULL,
  item_id     uuid NOT NULL,
  channel     text NOT NULL CHECK (channel IN ('counter', 'zomato', 'swiggy')),
  price_paise bigint NOT NULL CHECK (price_paise BETWEEN 0 AND 100000000),
  version     bigint NOT NULL DEFAULT 0,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz,
  FOREIGN KEY (tenant_id, outlet_id) REFERENCES outlet(tenant_id, id),
  FOREIGN KEY (tenant_id, item_id)   REFERENCES item(tenant_id, id)
);
CREATE UNIQUE INDEX outlet_price_live_uq ON outlet_price (outlet_id, item_id, channel) WHERE deleted_at IS NULL;
SELECT app.make_versioned('outlet_price');
CREATE INDEX outlet_price_version_ix ON outlet_price (outlet_id, version);

-- Counter-specific menus. Default 'all': the counter shows the whole catalogue at
-- the counter price. 'listed': only items with a listed counter_item row show.
-- counter_item.price_paise overrides the 'counter' channel price at that counter
-- only; GST rate always stays with the item (item_price.gst_rate_bp).
ALTER TABLE counter
  ADD COLUMN menu_mode  text NOT NULL DEFAULT 'all' CHECK (menu_mode IN ('all', 'listed')),
  ADD COLUMN version    bigint NOT NULL DEFAULT 0,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
SELECT app.add_versioning('counter'); -- RLS already applied in 0001

CREATE TABLE counter_item (
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  counter_id  uuid NOT NULL,
  item_id     uuid NOT NULL,
  listed      boolean NOT NULL DEFAULT true,
  price_paise bigint CHECK (price_paise BETWEEN 0 AND 100000000),
  version     bigint NOT NULL DEFAULT 0,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz,
  PRIMARY KEY (counter_id, item_id),
  FOREIGN KEY (tenant_id, counter_id) REFERENCES counter(tenant_id, id),
  FOREIGN KEY (tenant_id, item_id)    REFERENCES item(tenant_id, id)
);
SELECT app.make_versioned('counter_item');
CREATE INDEX counter_item_version_ix ON counter_item (counter_id, version);
CREATE INDEX counter_version_ix ON counter (tenant_id, version);

CREATE INDEX category_version_ix    ON category    (tenant_id, version);
CREATE INDEX item_version_ix        ON item        (tenant_id, version);
CREATE INDEX item_price_version_ix  ON item_price  (tenant_id, version);
CREATE INDEX outlet_item_version_ix ON outlet_item (outlet_id, version);
