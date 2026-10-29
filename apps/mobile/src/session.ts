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
