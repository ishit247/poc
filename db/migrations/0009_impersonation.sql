-- Support impersonation (PLAN 5, 15; docs/phase11-platform-admin.md step 4).
--
-- The only way a platform operator sees tenant data. Always READ-ONLY and always 30 minutes at most:
--   * the limit is fixed here (the function sets expires_at, a CHECK refuses anything longer), not chosen by the caller;
--   * read-only is enforced by the API (GET/HEAD only) and again by the database (the request's transactions are
--     READ ONLY), see apps/api/src/db.ts.
--
-- The grant lives on the tenant side, in a FORCE RLS table, so the tenant API can check it and a tenant's managers
-- can read it. The console role has no right on the table: it starts and ends a grant only through the two
-- SECURITY DEFINER functions below, which also write the tenant's own audit row in the same transaction.

CREATE TABLE impersonation (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenant(id),
  admin_id   uuid NOT NULL,   -- platform_admin.id; no FK, the tenant side cannot see that table
  admin_name text NOT NULL,   -- shown to the tenant's managers
  reason     text NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 200),
  token_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  ended_at   timestamptz,
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '30 minutes')
);
SELECT app.enable_tenant_rls('impersonation');

-- Default privileges granted pos_app all four rights. The tenant API only ever reads this table.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON impersonation FROM pos_app;
REVOKE ALL ON impersonation FROM PUBLIC;

CREATE FUNCTION platform.start_impersonation(p_tenant uuid, p_admin uuid, p_admin_name text, p_reason text, p_token_hash text)
RETURNS TABLE (id uuid, expires_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS
$$
DECLARE
  new_id uuid;
  exp timestamptz := now() + interval '30 minutes';
BEGIN
  PERFORM set_config('app.tenant_id', p_tenant::text, true);
  INSERT INTO impersonation (tenant_id, admin_id, admin_name, reason, token_hash, created_at, expires_at)
  VALUES (p_tenant, p_admin, p_admin_name, p_reason, p_token_hash, now(), exp) RETURNING impersonation.id INTO new_id;
  INSERT INTO audit (tenant_id, actor_kind, actor_id, action, entity, entity_id, detail)
  VALUES (p_tenant, 'system', NULL, 'support.access.start', 'impersonation', new_id,
          jsonb_build_object('operator', p_admin_name, 'reason', p_reason, 'readOnly', true, 'expiresAt', exp));
  PERFORM set_config('app.tenant_id', '', true);
  RETURN QUERY SELECT new_id, exp;
END
$$;

-- Ends a grant early. Returns false if it does not exist for that tenant or is already over.
CREATE FUNCTION platform.end_impersonation(p_tenant uuid, p_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS
$$
DECLARE
  n int;
BEGIN
  PERFORM set_config('app.tenant_id', p_tenant::text, true);
  UPDATE impersonation SET ended_at = now() WHERE impersonation.id = p_id AND tenant_id = p_tenant AND ended_at IS NULL AND expires_at > now();
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n = 1 THEN
    INSERT INTO audit (tenant_id, actor_kind, actor_id, action, entity, entity_id, detail)
    VALUES (p_tenant, 'system', NULL, 'support.access.end', 'impersonation', p_id, '{}');
  END IF;
  PERFORM set_config('app.tenant_id', '', true);
  RETURN n = 1;
END
$$;

REVOKE EXECUTE ON FUNCTION platform.start_impersonation(uuid, uuid, text, text, text), platform.end_impersonation(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.start_impersonation(uuid, uuid, text, text, text), platform.end_impersonation(uuid, uuid) TO app_platform;
