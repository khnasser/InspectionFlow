/** Runtime configuration, read once from environment variables. */
export interface AppConfig {
  port: number;
  databaseUrl: string;
  authMode: 'dev' | 'oidc';
  devJwtSecret: string;
  oidcIssuer?: string;
  oidcAudience?: string;
  oidcJwksUrl?: string;
  /** OIDC token claim carrying the tenant code or id (Keycloak user-attribute mapper). */
  tenantClaim: string;
  /** Public OIDC client ids the web and mobile apps use (authorization code + PKCE). */
  oidcWebClientId: string;
  oidcMobileClientId: string;
  paymentWebhookSecret: string;
  publicBaseUrl: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const authMode = (env.AUTH_MODE ?? 'dev') as AppConfig['authMode'];
  if (authMode !== 'dev' && authMode !== 'oidc') {
    throw new Error(`AUTH_MODE must be dev or oidc, got ${authMode}`);
  }
  if (authMode === 'oidc' && !env.OIDC_ISSUER) {
    throw new Error('OIDC_ISSUER is required when AUTH_MODE=oidc');
  }
  if (env.NODE_ENV === 'production' && authMode === 'dev') {
    throw new Error('AUTH_MODE=dev is not allowed in production');
  }
  return {
    port: Number(env.PORT ?? 3000),
    databaseUrl:
      env.DATABASE_URL ?? 'postgres://inspectionflow_api:inspectionflow_api@localhost:5432/inspectionflow',
    authMode,
    devJwtSecret: env.JWT_DEV_SECRET ?? 'dev-only-secret-change-me-at-least-32-chars',
    oidcIssuer: env.OIDC_ISSUER,
    oidcAudience: env.OIDC_AUDIENCE,
    oidcJwksUrl: env.OIDC_JWKS_URL,
    tenantClaim: env.TENANT_CLAIM ?? 'tenant',
    oidcWebClientId: env.OIDC_WEB_CLIENT_ID ?? 'inspectionflow-web',
    oidcMobileClientId: env.OIDC_MOBILE_CLIENT_ID ?? 'inspectionflow-mobile',
    paymentWebhookSecret: env.PAYMENT_WEBHOOK_SECRET ?? 'dev-webhook-secret',
    publicBaseUrl: env.PUBLIC_BASE_URL ?? 'http://localhost:3000',
  };
}

export const APP_CONFIG = Symbol('APP_CONFIG');
