import * as AuthSession from 'expo-auth-session';
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { SyncClient, SyncTransport } from '@inspectionflow/sync-client';
import { uuidv7 } from '@inspectionflow/engine';
import { SqliteStore } from './storage';

export interface Session {
  baseUrl: string;
  token: string;
  user: { userId: string; tenantId: string; roles: string[]; name?: string };
  /** Present for OIDC sessions (Keycloak / UAE PASS). */
  oidc?: { issuer: string; clientId: string; refreshToken?: string; expiresAt: number };
}

export interface AuthConfig {
  mode: 'dev' | 'oidc';
  issuer?: string;
  mobileClientId?: string;
  scope?: string;
}

export async function fetchAuthConfig(baseUrl: string): Promise<AuthConfig> {
  const res = await fetch(`${baseUrl}/v1/auth/config`);
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

async function whoAmI(baseUrl: string, token: string): Promise<Session['user']> {
  const res = await fetch(`${baseUrl}/v1/me`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
}

/**
 * OIDC sign-in: Authorization Code + PKCE (S256) in the system browser.
 * `idp: 'uaepass'` sends the user straight to UAE PASS via Keycloak's kc_idp_hint.
 * Roles come from InspectionFlow (`/v1/me`), never from the token.
 */
export async function oidcLogin(baseUrl: string, cfg: AuthConfig, idp?: 'uaepass'): Promise<Session> {
  const discovery = await AuthSession.fetchDiscoveryAsync(cfg.issuer!);
  const redirectUri = AuthSession.makeRedirectUri({ scheme: 'inspectionflow', path: 'auth' });
  const request = new AuthSession.AuthRequest({
    clientId: cfg.mobileClientId!,
    redirectUri,
    scopes: (cfg.scope ?? 'openid profile email').split(' ').concat('offline_access'),
    usePKCE: true,
    extraParams: idp ? { kc_idp_hint: idp } : {},
  });
  const result = await request.promptAsync(discovery);
  if (result.type !== 'success') throw new Error(result.type === 'error' ? String(result.error?.message) : 'cancelled');
  const tokens = await AuthSession.exchangeCodeAsync(
    { clientId: cfg.mobileClientId!, code: result.params.code, redirectUri, extraParams: { code_verifier: request.codeVerifier! } },
    discovery,
  );
  const user = await whoAmI(baseUrl, tokens.accessToken);
  return {
    baseUrl,
    token: tokens.accessToken,
    user,
    oidc: {
      issuer: cfg.issuer!,
      clientId: cfg.mobileClientId!,
      refreshToken: tokens.refreshToken,
      expiresAt: Date.now() + (tokens.expiresIn ?? 300) * 1000,
    },
  };
}

/** Refresh the access token when it is within 60 s of expiry. Mutates and persists the session. */
export async function ensureFreshToken(s: Session): Promise<void> {
  if (!s.oidc || Date.now() < s.oidc.expiresAt - 60_000) return;
  if (!s.oidc.refreshToken) throw new Error('401 session expired');
  const discovery = await AuthSession.fetchDiscoveryAsync(s.oidc.issuer);
  const t = await AuthSession.refreshAsync({ clientId: s.oidc.clientId, refreshToken: s.oidc.refreshToken }, discovery);
  s.token = t.accessToken;
  s.oidc.refreshToken = t.refreshToken ?? s.oidc.refreshToken;
  s.oidc.expiresAt = Date.now() + (t.expiresIn ?? 300) * 1000;
  await saveSession(s);
}

const SESSION_KEY = 'if.session';
const DEVICE_KEY = 'if.device';

export async function loadSession(): Promise<Session | null> {
  const raw = await SecureStore.getItemAsync(SESSION_KEY);
  return raw ? JSON.parse(raw) : null;
}

export async function saveSession(s: Session | null) {
  if (s) await SecureStore.setItemAsync(SESSION_KEY, JSON.stringify(s));
  else await SecureStore.deleteItemAsync(SESSION_KEY);
}

export async function deviceId(): Promise<string> {
  let id = await SecureStore.getItemAsync(DEVICE_KEY);
  if (!id) {
    id = uuidv7();
    await SecureStore.setItemAsync(DEVICE_KEY, id);
  }
  return id;
}

/** Development sign-in. Production: OIDC Authorization Code + PKCE against Keycloak / UAE PASS. */
export async function devLogin(baseUrl: string, tenantCode: string, email: string): Promise<Session> {
  const res = await fetch(`${baseUrl}/v1/dev/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tenantCode, email }),
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  const body = await res.json();
  return { baseUrl, token: body.accessToken, user: body.user };
}

function transport(s: Session): SyncTransport {
  const call = async (method: string, path: string, body?: unknown) => {
    await ensureFreshToken(s);
    const res = await fetch(`${s.baseUrl}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${res.status}`);
    return res.json();
  };
  return {
    push: (batch) => call('POST', '/v1/sync/push', batch),
    pull: () => call('GET', '/v1/sync/pull'),
    bundle: () => call('GET', '/v1/config/bundle'),
  };
}

let store: SqliteStore | null = null;

export async function syncClient(s: Session): Promise<SyncClient> {
  store ??= await SqliteStore.open();
  return new SyncClient(store, transport(s), await deviceId(), Platform.OS === 'ios' ? 'IOS' : 'ANDROID', (text) =>
    Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, text),
  );
}

export async function wipeLocalData() {
  store ??= await SqliteStore.open();
  await store.wipe();
  await saveSession(null);
}
