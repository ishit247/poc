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

export interface TemplateRow { id: string; name: string; createdAt: string; categories: number; items: number }
export interface TemplateItem { id: string; name: string; hsnCode: string | null; description: string | null; imageSha256: string | null; gstRateBp: number; pricePaise: number }
export interface TemplateFull { id: string; name: string; categories: { id: string; name: string; items: TemplateItem[] }[] }

// Money and rates: the API speaks tax-exclusive paise and GST basis points; the screens speak rupees and percent.
export const rupees = (paise: number) => `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const gstLabel = (bp: number) => `${bp / 100}%`;
/** "45" or "45.50" to paise (at most 10,00,000 rupees, the API's ceiling), or null. Parsed from the text so no float rounding is involved. */
export const parsePaise = (s: string) => {
  const m = /^(\d{1,7})(?:\.(\d{1,2}))?$/.exec(s.trim());
  const paise = m ? Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0')) : NaN;
  return paise >= 0 && paise <= 100_000_000 ? paise : null;
};
/** "5" or "2.5" percent to basis points (0 to 4000), or null. */
export const parseGstBp = (s: string) => {
  const m = /^(\d{1,2})(?:\.(\d{1,2}))?$/.exec(s.trim());
  const bp = m ? Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0')) : NaN;
  return bp >= 0 && bp <= 4000 ? bp : null;
};

// Where the invited manager opens their link: the counter app. Editable on screen, remembered in this browser.
const BASE_KEY = 'console-counter-url';
export const counterUrl = () => localStorage.getItem(BASE_KEY) ?? import.meta.env.VITE_COUNTER_URL ?? 'http://localhost:8080';
export const setCounterUrl = (u: string) => localStorage.setItem(BASE_KEY, u);
export const inviteLink = (token: string) => `${counterUrl().replace(/\/+$/, '')}/#invite=${token}`;

// Item pictures. The browser shrinks every picture before upload (so the server needs no image library and a menu of
// hundreds of items stays small): longest edge 320 px, WebP, under 64 KB. They are stored by content hash and fetched
// with the console's credential, so they are shown through object URLs, which are kept per hash for the session.
export const IMAGE_EDGE = 320;
export const IMAGE_MAX_BYTES = 64 * 1024;
export const DESCRIPTION_MAX = 300;

export async function shrinkImage(file: File): Promise<Blob> {
  const bmp = await createImageBitmap(file).catch(() => null);
  if (!bmp) throw new Error('That file is not a picture this browser can read.');
  // Centre-crop to a square, then shrink: every picture is the same shape, so tiles line up whatever the photo was.
  const side = Math.min(bmp.width, bmp.height);
  const edge = Math.max(1, Math.min(IMAGE_EDGE, side));
  const canvas = document.createElement('canvas');
  canvas.width = edge;
  canvas.height = edge;
  canvas.getContext('2d')!.drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, edge, edge);
  bmp.close();
  for (const q of [0.82, 0.7, 0.55, 0.4]) {
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/webp', q));
    if (blob && blob.type === 'image/webp' && blob.size <= IMAGE_MAX_BYTES) return blob;
  }
  throw new Error('That picture is too detailed to shrink under 64 KB. Try a simpler one.');
}

const picUrls = new Map<string, string>();
export function rememberPicture(sha: string, blob: Blob) { picUrls.set(sha, URL.createObjectURL(blob)); }

/** Uploads a shrunk picture; the hash it returns is what a template item refers to. */
export async function uploadCatalogImage(blob: Blob): Promise<string> {
  const r = await fetch('/api/platform/catalog-images', { method: 'PUT', headers: { authorization: `Platform ${getToken()}`, 'content-type': blob.type }, body: blob });
  if (r.status === 401 && getToken()) onExpired();
  if (!r.ok) throw new Error(r.status === 403 ? 'Only an owner can do this.' : 'Could not upload the picture.');
  const { sha256 } = (await r.json()) as { sha256: string };
  rememberPicture(sha256, blob);
  return sha256;
}

export async function catalogImageUrl(sha: string): Promise<string | null> {
  const have = picUrls.get(sha);
  if (have) return have;
  const r = await fetch(`/api/platform/catalog-images/${sha}`, { headers: { authorization: `Platform ${getToken()}` } });
  if (!r.ok) return null;
  const url = URL.createObjectURL(await r.blob());
  picUrls.set(sha, url);
  return url;
}
