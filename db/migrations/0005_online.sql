-- Online orders (PLAN 11, phase 7). Each order is a `sale` on the platform's channel plus an `online_order`
-- row that carries the lifecycle. The sale stays `open` until handover, then becomes `paid` with one
-- `aggregator` payment (the platform pays the school later, so these are gross sales).

CREATE TABLE online_order (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenant(id),
  outlet_id         uuid NOT NULL,
  sale_id           uuid NOT NULL,
  -- Where the order came from. `manual` = a cashier keyed it from the platform's own app. Real adapters (phase 9)
  -- add 'zomato' / 'swiggy' sources; the platform it is FOR is always `channel`.
  provider          text NOT NULL CHECK (provider IN ('manual', 'zomato', 'swiggy')),
  channel           text NOT NULL CHECK (channel IN ('zomato', 'swiggy')),
  external_order_id text NOT NULL CHECK (length(external_order_id) BETWEEN 1 AND 64),
  status            text NOT NULL DEFAULT 'received'
                    CHECK (status IN ('received', 'accepted', 'preparing', 'ready', 'handed_over', 'rejected', 'cancelled', 'expired')),
  accept_by         timestamptz,
  prep_minutes      int CHECK (prep_minutes BETWEEN 1 AND 240),
  customer_label    text CHECK (length(customer_label) <= 120),   -- "Block B, Room 214": the minimum, no roster
  delivery_note     text CHECK (length(delivery_note) <= 300),
  reason            text,                                         -- why it was rejected or cancelled
  price_overridden  boolean NOT NULL DEFAULT false,               -- a cashier changed a line price to match the platform
  raw_payload       jsonb,
  received_at       timestamptz NOT NULL DEFAULT now(),
  status_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, sale_id),
  -- Invariant 7. Per platform, not per source: two platforms keyed by hand may reuse the same number.
  UNIQUE (tenant_id, channel, external_order_id),
  CHECK (status NOT IN ('rejected', 'cancelled') OR reason IS NOT NULL),
  FOREIGN KEY (tenant_id, outlet_id) REFERENCES outlet(tenant_id, id),
  FOREIGN KEY (tenant_id, sale_id)   REFERENCES sale(tenant_id, id)
);
CREATE INDEX online_order_queue_ix ON online_order (outlet_id, status) WHERE status IN ('received', 'accepted', 'preparing', 'ready');
SELECT app.enable_tenant_rls('online_order');
-- An order is a record of what happened on the platform: it is closed, never deleted.
REVOKE DELETE, TRUNCATE ON online_order FROM pos_app;

-- One way through: terminal states are final, and nothing goes backwards. The API enforces the same table,
-- but this is the floor if a route or a job ever gets it wrong.
CREATE FUNCTION app.online_order_guard() RETURNS trigger
LANGUAGE plpgsql AS
$$
BEGIN
  IF (NEW.tenant_id, NEW.outlet_id, NEW.sale_id, NEW.provider, NEW.channel, NEW.external_order_id)
     IS DISTINCT FROM (OLD.tenant_id, OLD.outlet_id, OLD.sale_id, OLD.provider, OLD.channel, OLD.external_order_id) THEN
    RAISE EXCEPTION 'online order identity is immutable';
  END IF;
  IF NEW.status = OLD.status THEN RETURN NEW; END IF;
  IF NOT (
       (OLD.status = 'received'  AND NEW.status IN ('accepted', 'rejected', 'cancelled', 'expired'))
    OR (OLD.status = 'accepted'  AND NEW.status IN ('preparing', 'ready', 'cancelled'))
    OR (OLD.status = 'preparing' AND NEW.status IN ('ready', 'cancelled'))
    OR (OLD.status = 'ready'     AND NEW.status IN ('handed_over', 'cancelled'))) THEN
    RAISE EXCEPTION 'online order cannot go from % to %', OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER online_order_guard BEFORE UPDATE ON online_order FOR EACH ROW EXECUTE FUNCTION app.online_order_guard();

-- The expiry job has to find overdue orders across every tenant, which row security hides (FORCE applies to the
-- owner too, so a SECURITY DEFINER function would see nothing). Same shape as the tenant lookup by host: a
-- transaction-local stamp (app.job) opens a SELECT-only window onto exactly the rows the job acts on. Writes
-- still need the tenant stamp, so the job moves each order inside its own tenant's transaction.
CREATE POLICY expiry_scan ON online_order FOR SELECT
  USING (current_setting('app.job', true) = 'expire_online' AND status = 'received' AND accept_by IS NOT NULL AND accept_by < now());

-- Every move, who made it. Append-only.
CREATE TABLE online_order_event (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenant(id),
  online_order_id uuid NOT NULL,
  from_status     text,
  to_status       text NOT NULL,
  actor_id        uuid,                       -- the cashier or manager; NULL for the system (expiry)
  device_id       uuid,
  detail          jsonb,
  at              timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, online_order_id) REFERENCES online_order(tenant_id, id),
  FOREIGN KEY (tenant_id, actor_id)        REFERENCES app_user(tenant_id, id),
  FOREIGN KEY (tenant_id, device_id)       REFERENCES device(tenant_id, id)
);
CREATE INDEX online_order_event_ix ON online_order_event (online_order_id, at);
SELECT app.enable_tenant_rls('online_order_event');
REVOKE UPDATE, DELETE, TRUNCATE ON online_order_event FROM pos_app;

-- Messages to a platform, retried with backoff so a provider outage never blocks the kitchen. For the `manual`
-- provider there is nothing to call; its rows are marked done at once. Phase 9 adds the adapters that send.
CREATE TABLE integration_outbox (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenant(id),
  outlet_id       uuid NOT NULL,
  online_order_id uuid NOT NULL,
  provider        text NOT NULL,
  action          text NOT NULL CHECK (action IN ('accept', 'reject', 'ready', 'handed_over', 'cancel')),
  payload         jsonb NOT NULL DEFAULT '{}',
  -- One message per order per action: a retried request cannot queue it twice.
  dedupe_key      text NOT NULL,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'failed')),
  attempts        int NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  done_at         timestamptz,
  UNIQUE (tenant_id, dedupe_key),
  CHECK ((status = 'done') = (done_at IS NOT NULL)),
  FOREIGN KEY (tenant_id, outlet_id)       REFERENCES outlet(tenant_id, id),
  FOREIGN KEY (tenant_id, online_order_id) REFERENCES online_order(tenant_id, id)
);
CREATE INDEX integration_outbox_due_ix ON integration_outbox (next_attempt_at) WHERE status = 'pending';
SELECT app.enable_tenant_rls('integration_outbox');
REVOKE DELETE, TRUNCATE ON integration_outbox FROM pos_app;

-- A platform's payout statement, uploaded by a manager. Matching never edits a sale; it only reports.
CREATE TABLE settlement_import (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  outlet_id     uuid NOT NULL,
  channel       text NOT NULL CHECK (channel IN ('zomato', 'swiggy')),
  filename      text NOT NULL CHECK (length(filename) <= 200),
  period_from   date NOT NULL,
  period_to     date NOT NULL,
  uploaded_by   uuid NOT NULL,
  uploaded_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (period_to >= period_from),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, outlet_id)   REFERENCES outlet(tenant_id, id),
  FOREIGN KEY (tenant_id, uploaded_by) REFERENCES app_user(tenant_id, id)
);
SELECT app.enable_tenant_rls('settlement_import');
REVOKE UPDATE, DELETE, TRUNCATE ON settlement_import FROM pos_app;

CREATE TABLE settlement_line (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenant(id),
  import_id         uuid NOT NULL,
  external_order_id text NOT NULL,
  gross_paise       bigint NOT NULL CHECK (gross_paise >= 0),    -- what the platform says the order was worth
  payout_paise      bigint NOT NULL,                             -- what it pays the school (after commission)
  online_order_id   uuid,                                        -- our order, when the id is known
  -- matched: same id, same amount. amount_mismatch: same id, different gross. unknown_order: we have no such order.
  result            text NOT NULL CHECK (result IN ('matched', 'amount_mismatch', 'unknown_order')),
  CHECK ((result = 'unknown_order') = (online_order_id IS NULL)),
  UNIQUE (import_id, external_order_id),
  FOREIGN KEY (tenant_id, import_id)       REFERENCES settlement_import(tenant_id, id),
  FOREIGN KEY (tenant_id, online_order_id) REFERENCES online_order(tenant_id, id)
);
SELECT app.enable_tenant_rls('settlement_line');
REVOKE UPDATE, DELETE, TRUNCATE ON settlement_line FROM pos_app;
