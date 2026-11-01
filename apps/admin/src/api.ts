// Console API client. The session token (2 hours, absolute) lives in sessionStorage: it survives a reload but not a
// closed tab. A 401 anywhere means the session ended, and the app returns to the sign-in screen.
const KEY = 'console-token';

export const getToken = () => sessionStorage.getItem(KEY) ?? '';
export const setToken = (t: string) => (t ? sessionStorage.setItem(KEY, t) : sessionStorage.removeItem(KEY));

export interface Result<T = any> { status: number; body: T }

let onExpired: () => void = () => {};
export const setExpiredHandler = (f: () => void) => { onExpired = f; };

export async function api<T = any>(path: string, init: { method?: string; body?: object } = {}): Promise<Result<T>> {
  const r = await fetch(`/api${path}`, {
    method: init.method ?? (init.body ? 'POST' : 'GET'),
    headers: { ...(getToken() ? { authorization: `Platform ${getToken()}` } : {}), ...(init.body ? { 'content-type': 'application/json' } : {}) },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const body = await r.json().catch(() => ({}));
  if (r.status === 401 && getToken() && !path.startsWith('/platform/login')) onExpired();
  return { status: r.status, body };
}

export interface Admin { id: string; name: string; email: string; role: 'owner' | 'support' }
export interface Tenant { id: string; name: string; subdomain: string | null; createdAt: string; suspendedAt: string | null; outlets: number; devices: number }
export interface Warning { code: string; severity: 'warn' | 'alert'; message: string }
export interface Health { id: string; warnings: Warning[] }
export interface Outlet { id: string; name: string; timezone: string; counters: { id: string; code: string }[] }
export interface Manager { id: string; name: string; email: string; active: boolean; invited: boolean; acceptedInvite: boolean; invitePending: boolean; outletIds: string[] }

// Where the invited manager opens their link: the counter app. Editable on screen, remembered in this browser.
const BASE_KEY = 'console-counter-url';
export const counterUrl = () => localStorage.getItem(BASE_KEY) ?? import.meta.env.VITE_COUNTER_URL ?? 'http://localhost:8080';
export const setCounterUrl = (u: string) => localStorage.setItem(BASE_KEY, u);
export const inviteLink = (token: string) => `${counterUrl().replace(/\/+$/, '')}/#invite=${token}`;
