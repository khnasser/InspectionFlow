import { UserManager, WebStorageStateStore } from 'oidc-client-ts';
import { api, session, SessionUser } from './api';

/** Sign-in configuration published by the API (`GET /v1/auth/config`). */
export interface AuthConfig {
  mode: 'dev' | 'oidc';
  issuer?: string;
  webClientId?: string;
  scope?: string;
}

let manager: UserManager | null = null;
let config: AuthConfig | null = null;

export async function authConfig(): Promise<AuthConfig> {
  config ??= await api.get<AuthConfig>('/v1/auth/config');
  if (config.mode === 'oidc' && !manager) {
    manager = new UserManager({
      authority: config.issuer!,
      client_id: config.webClientId!,
      redirect_uri: `${window.location.origin}/auth/callback`,
      post_logout_redirect_uri: window.location.origin,
      response_type: 'code', // authorization code + PKCE (S256), no client secret in the browser
      scope: config.scope ?? 'openid profile email',
      automaticSilentRenew: true, // refresh token before expiry
      userStore: new WebStorageStateStore({ store: window.sessionStorage }),
    });
    manager.events.addUserLoaded((u) => {
      if (session.user) session.set(u.access_token, session.user);
    });
    manager.events.addSilentRenewError(() => signOut());
  }
  return config;
}

/** Redirect to Keycloak; `uaepass` skips the Keycloak page and goes straight to UAE PASS. */
export async function signIn(idp?: 'uaepass') {
  await authConfig();
  await manager!.signinRedirect(idp ? { extraQueryParams: { kc_idp_hint: idp } } : undefined);
}

/** Complete the redirect: exchange the code, then ask the API who this is (roles live in InspectionFlow). */
export async function completeSignIn(): Promise<void> {
  await authConfig();
  const u = await manager!.signinRedirectCallback();
  session.set(u.access_token, { userId: '', tenantId: '', roles: [] });
  const me = await api.get<SessionUser>('/v1/me');
  session.set(u.access_token, me);
  window.history.replaceState({}, '', '/tasks');
}

export async function signOut() {
  session.clear();
  if (manager) await manager.signoutRedirect().catch(() => window.location.assign('/'));
  else window.location.assign('/');
}
