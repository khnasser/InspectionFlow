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
    /** Run the background jobs (reports, notifications, outbox) in this process. */
    worker: boolean;
    workerIntervalMs: number;
    /** Public base URL printed in the QR code, e.g. https://verify.inspectionflow.ae */
    verifyBaseUrl: string;
  };
  /** Delivery of queued notifications (email, SMS, in-app). */
  notifications: {
    /** smtp in production; capture keeps messages in memory (development, tests). */
    emailDriver: 'smtp' | 'capture';
    smtpUrl: string;
    emailFrom: string;
    /** infobip (common UAE aggregator), none (SMS switched off), capture (tests). */
    smsDriver: 'infobip' | 'none' | 'capture';
    infobipBaseUrl: string;
    infobipApiKey: string;
    smsSender: string;
    maxAttempts: number;
  };
  /** Outbox relay to tenant webhooks. */
  webhooks: {
    /** Allow webhook URLs on private / loopback addresses (development and tests only). */
    allowPrivateTargets: boolean;
    maxAttempts: number;
    timeoutMs: number;
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
  const emailDriver = (env.EMAIL_DRIVER ?? 'capture') === 'smtp' ? 'smtp' : 'capture';
  const smsDriver = (['infobip', 'none', 'capture'] as const).find((d) => d === (env.SMS_DRIVER ?? 'capture')) ?? 'capture';
  if (env.NODE_ENV === 'production' && (emailDriver === 'capture' || smsDriver === 'capture')) {
    throw new Error('EMAIL_DRIVER=smtp and SMS_DRIVER=infobip|none are required in production');
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
      worker: (env.BACKGROUND_JOBS ?? env.REPORT_WORKER ?? 'on') !== 'off',
      workerIntervalMs: Number(env.JOBS_INTERVAL_MS ?? env.REPORT_WORKER_INTERVAL_MS ?? 5000),
      verifyBaseUrl: env.VERIFY_BASE_URL ?? env.PUBLIC_BASE_URL ?? 'http://localhost:3000',
    },
    notifications: {
      emailDriver,
      smtpUrl: env.SMTP_URL ?? 'smtp://localhost:1025',
      emailFrom: env.EMAIL_FROM ?? 'InspectionFlow <no-reply@inspectionflow.local>',
      smsDriver,
      infobipBaseUrl: env.INFOBIP_BASE_URL ?? '',
      infobipApiKey: env.INFOBIP_API_KEY ?? '',
      smsSender: env.SMS_SENDER ?? 'InspectFlow',
      maxAttempts: Number(env.NOTIFICATION_MAX_ATTEMPTS ?? 5),
    },
    webhooks: {
      allowPrivateTargets: env.WEBHOOK_ALLOW_PRIVATE === 'true',
      maxAttempts: Number(env.WEBHOOK_MAX_ATTEMPTS ?? 8),
      timeoutMs: Number(env.WEBHOOK_TIMEOUT_MS ?? 10000),
    },
  };
}

export const APP_CONFIG = Symbol('APP_CONFIG');
