-- Platform console health and usage (PLAN 14, 18): per-tenant COUNTS, never rows.
--
-- app_platform has no right on sales, sync events, the outbox or integrations (0007). These functions are how it
-- learns anything about them. Each runs as pos_owner (SECURITY DEFINER) and, for every tenant id it is given, stamps
-- that tenant for the rest of the call, so the same FORCE RLS that walls tenants from each other applies inside.
-- They return aggregates only: counts, timestamps, version labels. Nothing a customer or a cashier typed.

CREATE SCHEMA platform;
GRANT USAGE ON SCHEMA platform TO app_platform;

CREATE FUNCTION platform.tenant_health(ids uuid[], stale_hours int DEFAULT 24, quiet_hours int DEFAULT 24)
RETURNS TABLE (
  tenant_id uuid,
  outlets int,
  devices int,                  -- enrolled and not revoked
  devices_stale int,            -- not heard from within stale_hours (never-seen counts from enrolment)
  devices_unsynced int,         -- last reported a non-empty outbox
  device_outbox_events int,     -- events still on tablets at their last contact
  last_device_seen timestamptz,
  sync_applied_24h int,
  sync_rejected_24h int,
  last_sync_at timestamptz,
  online_outbox_pending int,    -- messages to Zomato/Swiggy not yet delivered
  online_outbox_failed int,
  online_outbox_oldest_pending timestamptz,
  integrations_enabled int,
  integrations_quiet int,       -- enabled, but no event within quiet_hours
  webhook_rejected_24h int,
  app_versions jsonb            -- {"1.4.0": 3, "unknown": 1}: version skew at a glance
) LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS
$$
#variable_conflict use_column
DECLARE
  t uuid;
BEGIN
  FOREACH t IN ARRAY ids LOOP
    PERFORM set_config('app.tenant_id', t::text, true);
    RETURN QUERY SELECT
      t,
      (SELECT count(*)::int FROM outlet o WHERE o.tenant_id = t),
      (SELECT count(*)::int FROM device d WHERE d.tenant_id = t AND d.revoked_at IS NULL),
      (SELECT count(*)::int FROM device d WHERE d.tenant_id = t AND d.revoked_at IS NULL
          AND COALESCE(d.last_seen_at, d.enrolled_at) < now() - make_interval(hours => stale_hours)),
      (SELECT count(*)::int FROM device d WHERE d.tenant_id = t AND d.revoked_at IS NULL AND d.outbox_pending > 0),
      (SELECT COALESCE(sum(d.outbox_pending), 0)::int FROM device d WHERE d.tenant_id = t AND d.revoked_at IS NULL),
      (SELECT max(d.last_seen_at) FROM device d WHERE d.tenant_id = t),
      (SELECT count(*)::int FROM sync_event e WHERE e.tenant_id = t AND e.outcome = 'applied' AND e.received_at > now() - interval '24 hours'),
      (SELECT count(*)::int FROM sync_event e WHERE e.tenant_id = t AND e.outcome = 'rejected' AND e.received_at > now() - interval '24 hours'),
      (SELECT max(e.received_at) FROM sync_event e WHERE e.tenant_id = t),
      (SELECT count(*)::int FROM integration_outbox q WHERE q.tenant_id = t AND q.status = 'pending'),
      (SELECT count(*)::int FROM integration_outbox q WHERE q.tenant_id = t AND q.status = 'failed'),
      (SELECT min(q.created_at) FROM integration_outbox q WHERE q.tenant_id = t AND q.status = 'pending'),
      (SELECT count(*)::int FROM outlet_integration i WHERE i.tenant_id = t AND i.enabled),
      (SELECT count(*)::int FROM outlet_integration i WHERE i.tenant_id = t AND i.enabled
          AND COALESCE(i.last_event_at, i.created_at) < now() - make_interval(hours => quiet_hours)),
      (SELECT count(*)::int FROM inbound_event v WHERE v.tenant_id = t AND v.result = 'rejected' AND v.received_at > now() - interval '24 hours'),
      (SELECT COALESCE(jsonb_object_agg(s.v, s.n), '{}'::jsonb)
         FROM (SELECT COALESCE(d.app_version, 'unknown') AS v, count(*)::int AS n
                 FROM device d WHERE d.tenant_id = t AND d.revoked_at IS NULL GROUP BY 1) s);
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true); -- leave the caller's connection unstamped
END
$$;

-- Months of activity per tenant, for the usage meter. Paid and refunded sales only; online orders are the subset
-- that arrived from an aggregator. No money: billing (open question 8) is undecided, counts are the safe unit.
CREATE FUNCTION platform.tenant_usage(ids uuid[], since date)
RETURNS TABLE (tenant_id uuid, month date, sales int, online_orders int, active_devices int, active_outlets int)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS
$$
#variable_conflict use_column
DECLARE
  t uuid;
BEGIN
  FOREACH t IN ARRAY ids LOOP
    PERFORM set_config('app.tenant_id', t::text, true);
    RETURN QUERY
      SELECT t, date_trunc('month', s.business_date)::date, count(*)::int, count(oo.id)::int,
             count(DISTINCT s.device_id)::int, count(DISTINCT s.outlet_id)::int
        FROM sale s LEFT JOIN online_order oo ON oo.tenant_id = s.tenant_id AND oo.sale_id = s.id
       WHERE s.tenant_id = t AND s.status IN ('paid', 'refunded') AND s.business_date >= date_trunc('month', since)::date
       GROUP BY 2 ORDER BY 2;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END
$$;

REVOKE EXECUTE ON FUNCTION platform.tenant_health(uuid[], int, int), platform.tenant_usage(uuid[], date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.tenant_health(uuid[], int, int), platform.tenant_usage(uuid[], date) TO app_platform;
