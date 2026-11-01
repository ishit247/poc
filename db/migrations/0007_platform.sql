-- Platform console (PLAN.md sections 5, 15, 18): the operator's identity, sessions and audit trail.
--
-- Two walls keep this apart from tenant data:
--   1. These tables are not tenant tables. pos_app (the tenant API's role) is REVOKEd every right on them.
--   2. The console connects as app_platform, a separate role that has no default privileges: it holds only the
--      grants written below, so a new table is invisible to it until someone grants it on purpose.
--      The tenant tables are FORCE RLS keyed on the tenant stamp, so without a stamp app_platform sees none of
--      their rows except through the explicit policies in this file.

CREATE TABLE platform_admin (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL,
  name          text NOT NULL,
  -- owner: everything. support: health and usage only; cannot suspend, create or impersonate.
  role          text NOT NULL CHECK (role IN ('owner', 'support')),
  password_hash text NOT NULL,
  -- Base32 TOTP secret. Required: a console login is always two-factor.
  totp_secret   text NOT NULL,
  active        boolean NOT NULL DEFAULT true,
  -- Highest TOTP time step already accepted. A code at or below it is refused, so a captured code cannot be replayed.
  totp_last_step bigint NOT NULL DEFAULT 0,
  failed_logins int NOT NULL DEFAULT 0,
  locked_until  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX platform_admin_email_uq ON platform_admin (lower(email));

-- Same shape as the tenant session table: only the SHA-256 of a 256-bit random token is stored.
CREATE TABLE platform_session (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id   uuid NOT NULL REFERENCES platform_admin(id),
  token_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);

-- Every console action. tenant_id is null for actions that name no tenant (a login).
CREATE TABLE platform_audit (
  id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at        timestamptz NOT NULL DEFAULT now(),
  admin_id  uuid REFERENCES platform_admin(id),
  action    text NOT NULL,
  tenant_id uuid REFERENCES tenant(id),
  entity    text NOT NULL,
  entity_id uuid,
  detail    jsonb NOT NULL DEFAULT '{}'
);

-- Default privileges granted pos_app all four rights on the tables above. REVOKE is what withholds.
REVOKE ALL ON platform_admin, platform_session, platform_audit FROM pos_app;
REVOKE ALL ON platform_admin, platform_session, platform_audit FROM PUBLIC;

-- The console role. Login is by password in dev; production sets its own.
GRANT USAGE ON SCHEMA public, app TO app_platform;
GRANT EXECUTE ON FUNCTION app.current_tenant_id() TO app_platform; -- the tenant row policy calls it
GRANT SELECT, INSERT, UPDATE ON platform_admin   TO app_platform;
GRANT SELECT, INSERT, UPDATE ON platform_session TO app_platform;
-- Append-only: no UPDATE, DELETE or TRUNCATE is ever granted (and none can leak in through a default).
GRANT SELECT, INSERT ON platform_audit TO app_platform;

-- Reference data the console needs, and nothing else. Reads only, except tenants (create, suspend, rename).
GRANT SELECT, INSERT, UPDATE ON tenant TO app_platform;
GRANT SELECT ON outlet, device TO app_platform;

-- Tenant rows are FORCE RLS. These policies are scoped TO app_platform, so they widen nothing for pos_app.
CREATE POLICY platform_console ON tenant TO app_platform USING (true) WITH CHECK (true);
CREATE POLICY platform_console ON outlet FOR SELECT TO app_platform USING (true);
CREATE POLICY platform_console ON device FOR SELECT TO app_platform USING (true);
