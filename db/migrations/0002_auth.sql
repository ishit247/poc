-- Sessions (manager web login) and one-time device enrolment codes.
-- Secrets are never stored: only SHA-256 of a 256-bit random value.

CREATE TABLE session (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenant(id),
  user_id    uuid NOT NULL,
  token_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  FOREIGN KEY (tenant_id, user_id) REFERENCES app_user(tenant_id, id)
);
SELECT app.enable_tenant_rls('session');

CREATE TABLE enrolment_code (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenant(id),
  outlet_id  uuid NOT NULL,
  counter_id uuid NOT NULL,
  code_hash  text NOT NULL,
  label      text CHECK (label IS NULL OR length(label) BETWEEN 1 AND 60), -- copied to the device on redemption
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  FOREIGN KEY (tenant_id, outlet_id)  REFERENCES outlet(tenant_id, id),
  FOREIGN KEY (tenant_id, counter_id) REFERENCES counter(tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES app_user(tenant_id, id)
);
SELECT app.enable_tenant_rls('enrolment_code');
