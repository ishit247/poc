-- Tenancy, access and audit. See PLAN.md sections 4, 5, 8.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE SCHEMA app;
GRANT USAGE ON SCHEMA app, public TO pos_app;

-- The tenant stamp. Set per transaction with set_config('app.tenant_id', $1, true)
-- so it dies with the transaction and cannot leak through the pool.
CREATE FUNCTION app.current_tenant_id() RETURNS uuid
LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;
GRANT EXECUTE ON FUNCTION app.current_tenant_id() TO pos_app;

-- Default privileges: the app role gets full DML on every table the owner
-- creates from here on. Tables that must be narrower REVOKE explicitly (audit).
ALTER DEFAULT PRIVILEGES FOR ROLE pos_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO pos_app;

CREATE TABLE tenant (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  -- Optional branded address: <subdomain>.<base domain>. It only decides which name and logo a sign-in screen shows;
  -- it never decides who someone is signed in as (the login does, D12). Assigned by the operator, never by a manager
  -- (names can be squatted). NULL means the tenant uses the bare domain.
  subdomain  text UNIQUE
             CHECK (subdomain ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'
                    AND subdomain NOT IN ('www', 'api', 'app', 'admin', 'mail', 'static', 'assets')),
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Set by the platform console. A suspended tenant cannot sign in or sync; counters keep selling offline.
  suspended_at timestamptz
);

CREATE TABLE outlet (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  name      text NOT NULL,
  timezone  text NOT NULL DEFAULT 'Asia/Kolkata',
  gstin     text,
  upi_vpa   text,
  UNIQUE (tenant_id, id)
);

CREATE TABLE counter (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenant(id),
  outlet_id      uuid NOT NULL,
  code           text NOT NULL,
  printer_config jsonb NOT NULL DEFAULT '{}',
  UNIQUE (tenant_id, id),
  UNIQUE (outlet_id, code),
  FOREIGN KEY (tenant_id, outlet_id) REFERENCES outlet(tenant_id, id)
);

CREATE TABLE device (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenant(id),
  outlet_id       uuid NOT NULL,
  counter_id      uuid NOT NULL,
  credential_hash text NOT NULL,
  label           text CHECK (label IS NULL OR length(label) BETWEEN 1 AND 60),
  enrolled_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz,
  -- Events still in the tablet's outbox at its last contact (x-outbox-pending); null = never reported.
  -- Day close shows it so a manager knows what the server cannot see.
  outbox_pending  int CHECK (outbox_pending >= 0),
  revoked_at      timestamptz,
  app_version     text,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, outlet_id)  REFERENCES outlet(tenant_id, id),
  FOREIGN KEY (tenant_id, counter_id) REFERENCES counter(tenant_id, id)
);

CREATE TABLE app_user (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  name          text NOT NULL,
  pin_verifier  text NOT NULL,
  role          text NOT NULL CHECK (role IN ('waiter', 'cashier', 'manager')),
  active        boolean NOT NULL DEFAULT true,
  -- Web login is for managers only; cashiers and waiters sign in with a PIN on a device.
  email         text,
  password_hash text,
  -- Versioned (trigger added in 0003) so a PIN change or deactivation reaches devices by pull.
  -- Lockout counters are NOT here: a failed attempt must not look like a change to every device.
  version       bigint NOT NULL DEFAULT 0,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  CHECK (role <> 'manager' OR (email IS NOT NULL AND password_hash IS NOT NULL))
);
-- Global, not per tenant: the email is how a manager's login finds their tenant (D12), so one email belongs to
-- exactly one tenant. A person who manages two caterers uses two addresses.
CREATE UNIQUE INDEX app_user_email_uq ON app_user (lower(email));

CREATE TABLE user_outlet (
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  user_id   uuid NOT NULL,
  outlet_id uuid NOT NULL,
  -- Membership is versioned with tombstones (trigger in 0003): removing someone from an
  -- outlet is a row the outlet's devices can pull, not a vanished row.
  version    bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  PRIMARY KEY (user_id, outlet_id),
  FOREIGN KEY (tenant_id, user_id)   REFERENCES app_user(tenant_id, id),
  FOREIGN KEY (tenant_id, outlet_id) REFERENCES outlet(tenant_id, id)
);

CREATE TABLE audit (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id  uuid NOT NULL REFERENCES tenant(id),
  at         timestamptz NOT NULL DEFAULT now(),
  actor_kind text NOT NULL,
  actor_id   uuid,
  action     text NOT NULL,
  entity     text NOT NULL,
  entity_id  uuid,
  detail     jsonb NOT NULL DEFAULT '{}'
);
-- Append-only for the app role. Default privileges granted all four rights,
-- so a narrow GRANT would restrict nothing: REVOKE is what withholds.
REVOKE UPDATE, DELETE, TRUNCATE ON audit FROM pos_app;

-- Row-level security. FORCE so even the owner is subject to it. Every later
-- tenant table calls this; it is a migration helper, not callable by the app.
CREATE FUNCTION app.enable_tenant_rls(tbl regclass) RETURNS void
LANGUAGE plpgsql AS
$$
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', tbl);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', tbl);
  EXECUTE format(
    'CREATE POLICY tenant_isolation ON %s USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id())',
    tbl);
END
$$;
REVOKE EXECUTE ON FUNCTION app.enable_tenant_rls(regclass) FROM PUBLIC;

SELECT app.enable_tenant_rls('outlet');
SELECT app.enable_tenant_rls('counter');
SELECT app.enable_tenant_rls('device');
SELECT app.enable_tenant_rls('app_user');
SELECT app.enable_tenant_rls('user_outlet');
SELECT app.enable_tenant_rls('audit');

ALTER TABLE tenant ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant FORCE ROW LEVEL SECURITY;
-- A request arrives on <subdomain>.<base domain> before we know the tenant. The API stamps the
-- subdomain (app.host_subdomain, per transaction) and may then SEE that one row, and only see it:
-- WITH CHECK keeps writes tied to the tenant stamp, so the lookup stamp can never modify anything.
CREATE POLICY tenant_isolation ON tenant
  USING (id = app.current_tenant_id() OR subdomain = nullif(current_setting('app.host_subdomain', true), ''))
  WITH CHECK (id = app.current_tenant_id());

-- Manager login arrives with an email and no tenant. The API stamps the email (app.login_email, per transaction)
-- and may then SEE that one active manager row, read-only, to learn which tenant to continue in. Permissive
-- policies are OR-ed with app_user's tenant policy; there is no write side, so the stamp can modify nothing.
CREATE POLICY app_user_login_lookup ON app_user FOR SELECT
  USING (role = 'manager' AND active AND lower(email) = nullif(lower(current_setting('app.login_email', true)), ''));
