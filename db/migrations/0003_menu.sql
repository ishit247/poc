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

CREATE TABLE category (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenant(id),
  name       text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  sort_order int NOT NULL DEFAULT 0,
  version    bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (tenant_id, id)
);
SELECT app.make_versioned('category');

CREATE TABLE item (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  category_id uuid NOT NULL,
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  sort_order  int NOT NULL DEFAULT 0,
  version     bigint NOT NULL DEFAULT 0,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, category_id) REFERENCES category(tenant_id, id)
);
SELECT app.make_versioned('item');

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

-- Per-outlet availability (the cashier "stock toggle"). Absent row = available.
CREATE TABLE outlet_item (
  tenant_id  uuid NOT NULL REFERENCES tenant(id),
  outlet_id  uuid NOT NULL,
  item_id    uuid NOT NULL,
  available  boolean NOT NULL,
  version    bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  PRIMARY KEY (outlet_id, item_id),
  FOREIGN KEY (tenant_id, outlet_id) REFERENCES outlet(tenant_id, id),
  FOREIGN KEY (tenant_id, item_id)   REFERENCES item(tenant_id, id)
);
SELECT app.make_versioned('outlet_item');

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
