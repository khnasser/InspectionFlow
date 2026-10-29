-- ============================================================================
-- 002 - MVP support objects
--   * per-tenant counters for human-readable numbers (logs, payment advices)
--   * login role used by the API (member of inspectionflow_app, no BYPASSRLS)
--   * dev-only user lookup used before a tenant context exists
--   * grants for objects created after 001
-- Run migrations as a superuser or a BYPASSRLS owner role.
-- ============================================================================

CREATE TABLE tenant_counters (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name      text NOT NULL,
  value     bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, name)
);
ALTER TABLE tenant_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_counters FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant_counters
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());

-- Next value of a named per-tenant counter (runs under the caller's RLS context)
CREATE OR REPLACE FUNCTION next_counter(p_name text) RETURNS bigint
LANGUAGE sql VOLATILE AS $$
  INSERT INTO tenant_counters (tenant_id, name, value)
  VALUES (current_tenant_id(), p_name, 1)
  ON CONFLICT (tenant_id, name) DO UPDATE SET value = tenant_counters.value + 1
  RETURNING value
$$;

-- Development sign-in: resolve a user by tenant code + email before any tenant
-- context exists. SECURITY DEFINER so it can read across tenants; returns only
-- the minimum needed to mint a token. Not used when AUTH_MODE=oidc.
CREATE OR REPLACE FUNCTION auth_lookup_user(p_tenant_code text, p_email text)
RETURNS TABLE (user_id uuid, tenant_id uuid, display_name text, roles text[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT u.id, u.tenant_id, u.display_name,
         COALESCE(array_agg(r.code ORDER BY r.code) FILTER (WHERE r.code IS NOT NULL), '{}')
  FROM users u
  JOIN tenants t ON t.id = u.tenant_id
  LEFT JOIN user_roles ur ON ur.tenant_id = u.tenant_id AND ur.user_id = u.id
  LEFT JOIN roles r ON r.tenant_id = ur.tenant_id AND r.id = ur.role_id
  WHERE t.code = p_tenant_code AND u.email = p_email AND u.is_active AND t.is_active
  GROUP BY u.id, u.tenant_id, u.display_name
$$;
REVOKE ALL ON FUNCTION auth_lookup_user(text, text) FROM PUBLIC;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO inspectionflow_app;
REVOKE UPDATE, DELETE ON audit_logs FROM inspectionflow_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO inspectionflow_app;

-- Login role for the API process. Change the password outside development.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'inspectionflow_api') THEN
    CREATE ROLE inspectionflow_api LOGIN PASSWORD 'inspectionflow_api' NOBYPASSRLS IN ROLE inspectionflow_app;
  END IF;
END $$;

-- Audit partitions are append-only too (UPDATE/DELETE revoked on each partition)
DO $$
DECLARE p text;
BEGIN
  FOR p IN SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
           JOIN pg_class parent ON parent.oid = i.inhparent WHERE parent.relname = 'audit_logs'
  LOOP
    EXECUTE format('REVOKE UPDATE, DELETE ON %I FROM inspectionflow_app', p);
  END LOOP;
END $$;

-- Total order for the audit hash chain (timestamps can tie within a millisecond)
CREATE SEQUENCE audit_log_seq;
ALTER TABLE audit_logs ADD COLUMN seq bigint NOT NULL DEFAULT nextval('audit_log_seq');
CREATE INDEX ix_audit_seq ON audit_logs (tenant_id, seq);
GRANT USAGE ON SEQUENCE audit_log_seq TO inspectionflow_app;
