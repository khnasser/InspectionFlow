/** Thin API client. The token is kept in memory and sessionStorage (cleared with the tab). */

export interface SessionUser {
  userId: string;
  tenantId: string;
  roles: string[];
  name?: string;
}

const KEY = 'inspectionflow.session';
let token: string | null = null;
let user: SessionUser | null = null;

try {
  const saved = sessionStorage.getItem(KEY);
  if (saved) ({ token, user } = JSON.parse(saved));
} catch {
  /* storage unavailable: stay signed out */
}

export const session = {
  get user() {
    return user;
  },
  get token() {
    return token;
  },
  set(t: string, u: SessionUser) {
    token = t;
    user = u;
    try {
      sessionStorage.setItem(KEY, JSON.stringify({ token, user }));
    } catch {
      /* ignore */
    }
  },
  clear() {
    token = null;
    user = null;
    try {
      sessionStorage.removeItem(KEY);
    } catch {
      /* ignore */
    }
  },
  has(...roles: string[]) {
    return !!user && roles.some((r) => user!.roles.includes(r));
  },
};

export class ApiError extends Error {
  constructor(public status: number, message: string, public body?: unknown) {
    super(message);
  }
}

const BASE = (import.meta as any).env?.VITE_API_URL ?? '';

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401 && token) {
    session.clear();
    window.location.reload();
  }
  const text = await res.text();
  const data = text ? (res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text) : null;
  if (!res.ok) {
    const msg = typeof data === 'object' && data ? (data.message ?? JSON.stringify(data)) : String(data);
    throw new ApiError(res.status, Array.isArray(msg) ? msg.join(', ') : msg, data);
  }
  return data as T;
}

export const api = {
  get: <T = any>(path: string) => call<T>('GET', path),
  post: <T = any>(path: string, body?: unknown) => call<T>('POST', path, body ?? {}),
  /** Opens an authenticated HTML resource (report) in a new tab. */
  async openHtml(path: string) {
    const html = await call<string>('GET', path);
    const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
    window.open(url, '_blank', 'noopener');
  },
};
