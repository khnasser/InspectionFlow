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
  /** Evidence and report storage: S3 (or S3-compatible) in production, local disk in development. */
  storage: {
    driver: 'local' | 's3';
    localDir: string;
    bucket: string;
    region: string;
    endpoint?: string;
    forcePathStyle: boolean;
    /** HMAC key for local-driver upload/download URLs. */
    signingSecret: string;
    maxUploadBytes: number;
  };
  /** PDF rendering: Gotenberg (Chromium) service in production; local Playwright for development and tests. */
  reports: {
    renderer: 'gotenberg' | 'playwright';
    gotenbergUrl: string;
    /** Run the background report worker in this process. */
    worker: boolean;
    workerIntervalMs: number;
    /** Public base URL printed in the QR code, e.g. https://verify.inspectionflow.ae */
    verifyBaseUrl: string;
  };
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
  if (env.NODE_ENV === 'production' && (env.STORAGE_DRIVER ?? 'local') !== 's3') {
    throw new Error('STORAGE_DRIVER=s3 is required in production');
  }
  return {
    port: Number(env.PORT ?? 3000),
    databaseUrl:
      env.DATABASE_URL ?? 'postgres://inspectionflow_api:inspectionflow_api@localhost:5432/inspectionflow',
    authMode,
    devJwtSecret: env.JWT_DEV_SECRET ?? 'dev-only-secret-change-me-at-least-32-chars',
    oidcIssuer: env.OIDC_ISSUER?.replace(/\/$/, ''),
    oidcAudience: env.OIDC_AUDIENCE,
    oidcJwksUrl: env.OIDC_JWKS_URL || undefined,
    tenantClaim: env.TENANT_CLAIM ?? 'tenant',
    oidcWebClientId: env.OIDC_WEB_CLIENT_ID ?? 'inspectionflow-web',
    oidcMobileClientId: env.OIDC_MOBILE_CLIENT_ID ?? 'inspectionflow-mobile',
    paymentWebhookSecret: env.PAYMENT_WEBHOOK_SECRET ?? 'dev-webhook-secret',
    publicBaseUrl: env.PUBLIC_BASE_URL ?? 'http://localhost:3000',
    storage: {
      driver: (env.STORAGE_DRIVER ?? 'local') === 's3' ? 's3' : 'local',
      localDir: env.STORAGE_LOCAL_DIR ?? './var/storage',
      bucket: env.S3_BUCKET ?? 'inspectionflow-evidence',
      region: env.S3_REGION ?? 'me-central-1',
      endpoint: env.S3_ENDPOINT || undefined,
      forcePathStyle: env.S3_FORCE_PATH_STYLE === 'true',
      signingSecret: env.STORAGE_SIGNING_SECRET ?? env.JWT_DEV_SECRET ?? 'dev-only-storage-signing-secret-32ch',
      maxUploadBytes: Number(env.MAX_UPLOAD_BYTES ?? 25 * 1024 * 1024),
    },
    reports: {
      renderer: (env.REPORT_RENDERER ?? 'playwright') === 'gotenberg' ? 'gotenberg' : 'playwright',
      gotenbergUrl: env.GOTENBERG_URL ?? 'http://localhost:3001',
      worker: (env.REPORT_WORKER ?? 'on') !== 'off',
      workerIntervalMs: Number(env.REPORT_WORKER_INTERVAL_MS ?? 5000),
      verifyBaseUrl: env.VERIFY_BASE_URL ?? env.PUBLIC_BASE_URL ?? 'http://localhost:3000',
    },
  };
}

export const APP_CONFIG = Symbol('APP_CONFIG');
