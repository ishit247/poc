-- Trading: business day, shift, sale, lines, payments. PLAN.md sections 8 and 9.
-- Rows arrive from devices by sync push (phase 4); the ids are client-generated UUIDs.

-- Manager-set trading rules, one row per tenant, delivered to tablets by pull. Defaults here must
-- match DEFAULT_SETTINGS in packages/shared/src/settings.ts. A tenant with no row uses the defaults.
CREATE TABLE tenant_setting (
  tenant_id     uuid PRIMARY KEY REFERENCES tenant(id),
  max_line_qty  int  NOT NULL DEFAULT 99 CHECK (max_line_qty BETWEEN 1 AND 999),
  gst_rounding  text NOT NULL DEFAULT 'half_up' CHECK (gst_rounding IN ('half_up', 'up', 'down')),
  bill_round_to int  NOT NULL DEFAULT 0 CHECK (bill_round_to IN (0, 10, 50, 100)),
  offline_days  int  NOT NULL DEFAULT 7 CHECK (offline_days BETWEEN 1 AND 60),
  version       bigint NOT NULL DEFAULT 0,
  updated_at    timestamptz NOT NULL DEFAULT now()
);
SELECT app.make_versioned('tenant_setting');

-- The tenant's logo: one row per tenant, bytes in Postgres (small, and it backs up with everything else).
-- PNG, JPEG or WebP only, never SVG (scripts). Removal is a tombstone with the bytes cleared, so tablets
-- learn of it through pull; the bytes themselves are fetched from /branding/logo, not carried in pull.
CREATE TABLE tenant_logo (
  tenant_id    uuid PRIMARY KEY REFERENCES tenant(id),
  content_type text CHECK (content_type IN ('image/png', 'image/jpeg', 'image/webp')),
  bytes        bytea CHECK (length(bytes) BETWEEN 1 AND 262144),
  sha256       text CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  version      bigint NOT NULL DEFAULT 0,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz,
  -- Live: all three present. Tombstone: all three cleared.
  CHECK ((deleted_at IS NULL AND content_type IS NOT NULL AND bytes IS NOT NULL AND sha256 IS NOT NULL)
      OR (deleted_at IS NOT NULL AND content_type IS NULL AND bytes IS NULL AND sha256 IS NULL))
);
SELECT app.make_versioned('tenant_logo');

CREATE TABLE business_day (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  outlet_id uuid NOT NULL,
  date      date NOT NULL,
  closed_at timestamptz,
  closed_by uuid,
  UNIQUE (tenant_id, id),
  UNIQUE (outlet_id, date),
  FOREIGN KEY (tenant_id, outlet_id) REFERENCES outlet(tenant_id, id),
  FOREIGN KEY (tenant_id, closed_by) REFERENCES app_user(tenant_id, id)
);
SELECT app.enable_tenant_rls('business_day');
REVOKE DELETE, TRUNCATE ON business_day FROM pos_app;

CREATE TABLE shift (
  id                  uuid PRIMARY KEY,
  tenant_id           uuid NOT NULL REFERENCES tenant(id),
  outlet_id           uuid NOT NULL,
  device_id           uuid NOT NULL,
  user_id             uuid NOT NULL,
  opened_at           timestamptz NOT NULL,
  closed_at           timestamptz,
  opening_cash_paise  bigint NOT NULL CHECK (opening_cash_paise >= 0),
  counted_cash_paise  bigint CHECK (counted_cash_paise >= 0),
  expected_cash_paise bigint,
  variance_paise      bigint,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, outlet_id) REFERENCES outlet(tenant_id, id),
  FOREIGN KEY (tenant_id, device_id) REFERENCES device(tenant_id, id),
  FOREIGN KEY (tenant_id, user_id)   REFERENCES app_user(tenant_id, id)
);
SELECT app.enable_tenant_rls('shift');
REVOKE DELETE, TRUNCATE ON shift FROM pos_app;

CREATE TABLE sale (
  id              uuid PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenant(id),
  outlet_id       uuid NOT NULL,
  business_day_id uuid,                 -- assigned at ingest
  business_date   date NOT NULL,        -- the device's local business date; part of receipt uniqueness
  shift_id        uuid,
  device_id       uuid NOT NULL,
  created_by      uuid NOT NULL,        -- the waiter/cashier who took the order
  channel         text NOT NULL DEFAULT 'counter' CHECK (channel IN ('counter', 'zomato', 'swiggy')),
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'paid', 'refunded', 'void')),
  receipt_no      text,
  receipt_seq     int CHECK (receipt_seq > 0),
  device_seq      bigint,
  menu_version    bigint NOT NULL,
  subtotal_paise  bigint NOT NULL CHECK (subtotal_paise >= 0),
  tax_paise       bigint NOT NULL CHECK (tax_paise >= 0),
  round_off_paise bigint NOT NULL DEFAULT 0,   -- signed bill round-off (tenant_setting.bill_round_to)
  total_paise     bigint NOT NULL CHECK (total_paise > 0),
  created_at_device timestamptz NOT NULL,
  received_at     timestamptz NOT NULL DEFAULT now(),
  void_reason     text,
  flags           text[] NOT NULL DEFAULT '{}',
  UNIQUE (tenant_id, id),
  CHECK (total_paise = subtotal_paise + tax_paise + round_off_paise),
  -- The receipt number is assigned at payment (PLAN 9), so only paid/refunded sales carry one.
  CHECK ((status IN ('paid', 'refunded')) = (receipt_no IS NOT NULL AND receipt_seq IS NOT NULL)
         OR status = 'void'),
  CHECK (status <> 'void' OR void_reason IS NOT NULL),
  FOREIGN KEY (tenant_id, outlet_id)       REFERENCES outlet(tenant_id, id),
  FOREIGN KEY (tenant_id, business_day_id) REFERENCES business_day(tenant_id, id),
  FOREIGN KEY (tenant_id, shift_id)        REFERENCES shift(tenant_id, id),
  FOREIGN KEY (tenant_id, device_id)       REFERENCES device(tenant_id, id),
  FOREIGN KEY (tenant_id, created_by)      REFERENCES app_user(tenant_id, id)
);
-- Invariant 5: a receipt number is unique per device per business day.
CREATE UNIQUE INDEX sale_receipt_uq ON sale (device_id, business_date, receipt_seq) WHERE receipt_seq IS NOT NULL;
CREATE INDEX sale_creator_open_ix ON sale (created_by) WHERE status = 'open';
SELECT app.enable_tenant_rls('sale');
-- Paid sales are never deleted (invariant 4); they are voided or refunded.
REVOKE DELETE, TRUNCATE ON sale FROM pos_app;

CREATE TABLE sale_line (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenant(id),
  sale_id          uuid NOT NULL,
  item_id          uuid NOT NULL,
  name_snapshot    text NOT NULL,
  unit_price_paise bigint NOT NULL CHECK (unit_price_paise >= 0),
  gst_rate_bp      int NOT NULL CHECK (gst_rate_bp BETWEEN 0 AND 10000),
  qty              int NOT NULL CHECK (qty > 0),
  line_total_paise bigint NOT NULL CHECK (line_total_paise >= 0),
  tax_paise        bigint NOT NULL CHECK (tax_paise >= 0),
  FOREIGN KEY (tenant_id, sale_id) REFERENCES sale(tenant_id, id),
  FOREIGN KEY (tenant_id, item_id) REFERENCES item(tenant_id, id)
);
SELECT app.enable_tenant_rls('sale_line');
-- Lines are facts: written once with the sale. REVOKE withholds (default privileges grant all four).
REVOKE UPDATE, DELETE, TRUNCATE ON sale_line FROM pos_app;

CREATE TABLE payment (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenant(id),
  sale_id        uuid NOT NULL,
  method         text NOT NULL CHECK (method IN ('cash', 'upi', 'aggregator')),
  amount_paise   bigint NOT NULL CHECK (amount_paise > 0),
  tendered_paise bigint CHECK (tendered_paise >= 0),
  change_paise   bigint NOT NULL DEFAULT 0 CHECK (change_paise >= 0),
  upi_ref        text,
  -- Change exists only for cash, and tendered = amount + change.
  CHECK (method = 'cash' OR change_paise = 0),
  CHECK (tendered_paise IS NULL OR tendered_paise = amount_paise + change_paise),
  FOREIGN KEY (tenant_id, sale_id) REFERENCES sale(tenant_id, id)
);
SELECT app.enable_tenant_rls('payment');
REVOKE UPDATE, DELETE, TRUNCATE ON payment FROM pos_app;

-- The sync ledger: one row per event the server has DECIDED (applied or rejected), keyed by the
-- client's event id so a retry finds its earlier answer. (tenant_id, id) rather than id alone: an id
-- another tenant used must not look like "already seen" through RLS. A deferred event (its sale has not
-- arrived yet) is not decided and leaves no row. The payload is kept so a rejected event is not lost
-- if the tablet is. The ledger is append-only: REVOKE withholds (default privileges grant all four).
CREATE TABLE sync_event (
  tenant_id         uuid NOT NULL REFERENCES tenant(id),
  id                uuid NOT NULL,
  device_id         uuid NOT NULL,
  seq               bigint NOT NULL CHECK (seq > 0),
  type              text NOT NULL,
  entity_id         uuid,                    -- the sale an event is about, when it names one
  schema_version    int,
  created_at_device timestamptz NOT NULL,
  received_at       timestamptz NOT NULL DEFAULT now(),
  outcome           text NOT NULL CHECK (outcome IN ('applied', 'rejected')),
  reason            text,
  payload           jsonb NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CHECK ((outcome = 'rejected') = (reason IS NOT NULL)),
  FOREIGN KEY (tenant_id, device_id) REFERENCES device(tenant_id, id)
);
-- A device numbers its events 1, 2, 3...; one number is one event.
CREATE UNIQUE INDEX sync_event_device_seq_uq ON sync_event (device_id, seq);
CREATE INDEX sync_event_entity_ix ON sync_event (device_id, entity_id) WHERE entity_id IS NOT NULL;
SELECT app.enable_tenant_rls('sync_event');
REVOKE UPDATE, DELETE, TRUNCATE ON sync_event FROM pos_app;

-- Invariant 4: once a sale leaves 'open' its money cannot change, and the only
-- moves are open->paid|void and paid->refunded|void.
CREATE FUNCTION app.sale_guard() RETURNS trigger
LANGUAGE plpgsql AS
$$
BEGIN
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.id <> OLD.id OR NEW.outlet_id <> OLD.outlet_id
     OR NEW.device_id <> OLD.device_id OR NEW.created_by <> OLD.created_by THEN
    RAISE EXCEPTION 'sale identity is immutable';
  END IF;
  IF OLD.status <> 'open' AND (NEW.subtotal_paise, NEW.tax_paise, NEW.round_off_paise, NEW.total_paise, NEW.receipt_no, NEW.receipt_seq, NEW.business_date)
       IS DISTINCT FROM (OLD.subtotal_paise, OLD.tax_paise, OLD.round_off_paise, OLD.total_paise, OLD.receipt_no, OLD.receipt_seq, OLD.business_date) THEN
    RAISE EXCEPTION 'a % sale cannot be edited', OLD.status;
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'open' AND NEW.status IN ('paid', 'void'))
    OR (OLD.status = 'paid' AND NEW.status IN ('refunded', 'void'))) THEN
    RAISE EXCEPTION 'sale cannot go from % to %', OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER sale_guard BEFORE UPDATE ON sale FOR EACH ROW EXECUTE FUNCTION app.sale_guard();

-- Invariant 3: a paid sale's payments sum to its total. A payment's amount is the part of the
-- total it covers; cash tendered above that is recorded as change (see the payment CHECKs).
-- Deferred to commit so the sale and its payments can be written in any order within one transaction.
CREATE FUNCTION app.assert_sale_payments(sid uuid) RETURNS void
LANGUAGE plpgsql AS
$$
DECLARE s record; paid bigint;
BEGIN
  SELECT id, status, total_paise INTO s FROM sale WHERE id = sid;
  IF s.id IS NULL OR s.status NOT IN ('paid', 'refunded') THEN RETURN; END IF;
  SELECT COALESCE(sum(amount_paise), 0) INTO paid FROM payment WHERE sale_id = s.id;
  IF paid <> s.total_paise THEN
    RAISE EXCEPTION 'sale % payments (%) do not equal its total (%)', s.id, paid, s.total_paise;
  END IF;
END
$$;
CREATE FUNCTION app.sale_payments_ck() RETURNS trigger LANGUAGE plpgsql AS
$$ BEGIN PERFORM app.assert_sale_payments(NEW.id); RETURN NULL; END $$;
CREATE FUNCTION app.payment_sale_ck() RETURNS trigger LANGUAGE plpgsql AS
$$ BEGIN PERFORM app.assert_sale_payments(NEW.sale_id); RETURN NULL; END $$;
CREATE CONSTRAINT TRIGGER sale_payments_ck AFTER INSERT OR UPDATE ON sale
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.sale_payments_ck();
CREATE CONSTRAINT TRIGGER payment_sale_ck AFTER INSERT ON payment
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.payment_sale_ck();
