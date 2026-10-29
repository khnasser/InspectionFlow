-- ============================================================================
-- 003 - OIDC identity linking (Keycloak, UAE PASS brokered through Keycloak)
-- The API trusts Keycloak tokens for authentication; authorisation (roles)
-- stays in InspectionFlow (user_roles), so a tenant administers its own roles.
-- ============================================================================

CREATE UNIQUE INDEX IF NOT EXISTS uq_users_idp_subject ON users (tenant_id, idp_subject) WHERE idp_subject IS NOT NULL;

-- Resolve a verified token to an InspectionFlow user.
--   p_tenant  : tenant id or tenant code from the token's tenant claim
--   p_subject : token "sub" (Keycloak user id)
--   p_email   : token "email" (used once, to link a pre-provisioned user)
-- Links idp_subject on first sign-in when the email matches an active user
-- that has no link yet. Returns no row when there is no matching account.
CREATE OR REPLACE FUNCTION auth_resolve_oidc(p_tenant text, p_subject text, p_email text)
RETURNS TABLE (user_id uuid, tenant_id uuid, display_name text, roles text[], linked boolean)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_tenant uuid;
  v_user   uuid;
  v_linked boolean := false;
BEGIN
  SELECT t.id INTO v_tenant FROM tenants t
   WHERE t.is_active AND (t.id::text = p_tenant OR t.code = p_tenant);
  IF v_tenant IS NULL THEN RETURN; END IF;

  SELECT u.id INTO v_user FROM users u
   WHERE u.tenant_id = v_tenant AND u.idp_subject = p_subject AND u.is_active;

  IF v_user IS NULL AND p_email IS NOT NULL THEN
    UPDATE users u SET idp_subject = p_subject
     WHERE u.tenant_id = v_tenant AND u.email = p_email::citext AND u.is_active AND u.idp_subject IS NULL
     RETURNING u.id INTO v_user;
    v_linked := v_user IS NOT NULL;
  END IF;
  IF v_user IS NULL THEN RETURN; END IF;

  UPDATE users SET last_login_at = now() WHERE id = v_user;

  RETURN QUERY
  SELECT u.id, u.tenant_id, u.display_name,
         COALESCE(array_agg(r.code ORDER BY r.code) FILTER (WHERE r.code IS NOT NULL), '{}'),
         v_linked
    FROM users u
    LEFT JOIN user_roles ur ON ur.tenant_id = u.tenant_id AND ur.user_id = u.id
    LEFT JOIN roles r ON r.tenant_id = ur.tenant_id AND r.id = ur.role_id
   WHERE u.id = v_user
   GROUP BY u.id, u.tenant_id, u.display_name;
END $$;
REVOKE ALL ON FUNCTION auth_resolve_oidc(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_resolve_oidc(text, text, text) TO inspectionflow_app;
GRANT EXECUTE ON FUNCTION auth_lookup_user(text, text) TO inspectionflow_app;
