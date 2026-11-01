-- One-time manager invite (docs/phase11-platform-admin.md step 5).
--
-- The platform operator creates a manager WITHOUT knowing their password: the manager row gets a password hash nobody
-- holds, and this table holds a hashed single-use secret. The operator hands the manager a link; the manager opens
-- it and chooses their own password. Same shape as enrolment_code: claimed by one atomic UPDATE, stored hashed,
-- expiring, and addressed by `<tenantId>.<id>.<secret>` so the public redeem route can find the tenant.

CREATE TABLE manager_invite (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenant(id),
  user_id    uuid NOT NULL,
  token_hash text NOT NULL,
  admin_id   uuid NOT NULL,  -- platform_admin.id; no FK, the tenant side cannot see that table
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '7 days'),
  FOREIGN KEY (tenant_id, user_id) REFERENCES app_user(tenant_id, id)
);
SELECT app.enable_tenant_rls('manager_invite');

-- Invites are never deleted (the row is the record that a link was issued and when it was used).
REVOKE DELETE, TRUNCATE ON manager_invite FROM pos_app;
REVOKE ALL ON manager_invite FROM PUBLIC;
