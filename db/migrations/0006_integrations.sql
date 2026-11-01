-- Aggregator adapters (PLAN 11, phase 9). Per-outlet platform credentials, the platform's item ids, and a
-- record of every inbound webhook. No partner access exists yet: what a platform actually sends is unverified,
-- so the raw payload of everything received is kept.

-- One row per outlet per platform. `external_store_id` is how the platform names this outlet in its webhook; it is
-- globally unique per channel because it is the only thing that tells us which tenant an inbound call belongs to.
CREATE TABLE outlet_integration (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenant(id),
  outlet_id         uuid NOT NULL,
  channel           text NOT NULL CHECK (channel IN ('zomato', 'swiggy')),
  external_store_id text NOT NULL CHECK (length(external_store_id) BETWEEN 1 AND 64),
  -- Shared secret for the webhook signature. Stored as given (HMAC needs the key); encrypt at rest in phase 11.
  webhook_secret    text NOT NULL CHECK (length(webhook_secret) >= 16),
  -- Who the sale is booked to and which counter receives the order: a sale needs both (sale.created_by / device_id).
  service_user_id   uuid NOT NULL,
  device_id         uuid NOT NULL,
  enabled           boolean NOT NULL DEFAULT true,
  last_event_at     timestamptz,                 -- monitoring: an enabled outlet that goes quiet is a warning sign
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, outlet_id, channel),
  UNIQUE (channel, external_store_id),
  FOREIGN KEY (tenant_id, outlet_id)       REFERENCES outlet(tenant_id, id),
  FOREIGN KEY (tenant_id, service_user_id) REFERENCES app_user(tenant_id, id),
  FOREIGN KEY (tenant_id, device_id)       REFERENCES device(tenant_id, id)
);
SELECT app.enable_tenant_rls('outlet_integration');
REVOKE DELETE, TRUNCATE ON outlet_integration FROM pos_app;
-- Finding the tenant behind a webhook is a cross-tenant read, so it gets the same stamped, SELECT-only window as
-- the expiry and outbox jobs. The caller filters by (channel, external_store_id); the window shows only enabled rows.
CREATE POLICY webhook_lookup ON outlet_integration FOR SELECT
  USING (current_setting('app.job', true) = 'webhook' AND enabled);

-- The platform's id for one of our items, per outlet (a platform's menu is per store).
CREATE TABLE item_channel_map (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenant(id),
  outlet_id        uuid NOT NULL,
  channel          text NOT NULL CHECK (channel IN ('zomato', 'swiggy')),
  external_item_id text NOT NULL CHECK (length(external_item_id) BETWEEN 1 AND 64),
  item_id          uuid NOT NULL,
  UNIQUE (outlet_id, channel, external_item_id),
  FOREIGN KEY (tenant_id, outlet_id) REFERENCES outlet(tenant_id, id),
  FOREIGN KEY (tenant_id, item_id)   REFERENCES item(tenant_id, id)
);
SELECT app.enable_tenant_rls('item_channel_map');

-- Every webhook that reached a known outlet, whatever came of it. Append-only: this is the evidence when an
-- order "never arrived", and the sample we will need when real payloads differ from what we assumed.
CREATE TABLE inbound_event (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  outlet_id     uuid NOT NULL,
  channel       text NOT NULL CHECK (channel IN ('zomato', 'swiggy')),
  result        text NOT NULL CHECK (result IN ('created', 'duplicate', 'rejected')),
  detail        text CHECK (length(detail) <= 300),         -- why it was rejected
  raw_payload   text NOT NULL,
  received_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, outlet_id) REFERENCES outlet(tenant_id, id)
);
CREATE INDEX inbound_event_ix ON inbound_event (outlet_id, received_at DESC);
SELECT app.enable_tenant_rls('inbound_event');
REVOKE UPDATE, DELETE, TRUNCATE ON inbound_event FROM pos_app;
