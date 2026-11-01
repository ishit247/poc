// Online orders are online-only (PLAN 10.7). The server session lives in memory and is gone on reload; nothing
// here touches the outbox or the local database. A signed-in cashier asks the server for a session with the
// same PIN they just used offline.

export interface OnlineOrder {
  id: string; saleId: string; outletId: string; channel: 'zomato' | 'swiggy'; externalOrderId: string;
  status: 'received' | 'accepted' | 'preparing' | 'ready' | 'handed_over' | 'rejected' | 'cancelled' | 'expired';
  acceptBy: string | null; prepMinutes: number | null; customerLabel: string | null; deliveryNote: string | null;
  reason: string | null; priceOverridden: boolean; receivedAt: string; totalPaise: number | string;
}

export type SignIn = { ok: true; token: string } | { ok: false; message: string };

export async function signInOnline(credential: string, userId: string, pin: string): Promise<SignIn> {
  try {
    const r = await fetch('/api/device/pin-signin', {
      method: 'POST', headers: { authorization: `Device ${credential}`, 'content-type': 'application/json' }, body: JSON.stringify({ userId, pin }),
    });
    if (r.status === 200) return { ok: true, token: (await r.json()).token as string };
    if (r.status === 429) return { ok: false, message: 'Too many tries. Wait a minute.' };
    return { ok: false, message: 'Wrong PIN, or this account is locked.' };
  } catch {
    return { ok: false, message: 'Needs internet.' };
  }
}

export interface Result<T> { status: number; body: T }

export async function call<T>(token: string, path: string, init: { method?: string; body?: unknown } = {}): Promise<Result<T>> {
  const r = await fetch(`/api${path}`, {
    method: init.method ?? 'GET',
    headers: { authorization: `Bearer ${token}`, ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as T };
}

/**
 * Listens for "the queue changed" and calls `onChange`. Reads the stream with fetch because EventSource cannot send
 * the session header. Reconnects after a pause; `onLive` says whether the stream is up, so the screen can fall back
 * to polling while it is not. Returns a function that stops everything.
 */
export function watchQueue(token: string, onChange: () => void, onLive: (live: boolean) => void): () => void {
  const ac = new AbortController();
  let stopped = false;
  void (async () => {
    while (!stopped) {
      try {
        const r = await fetch('/api/online-orders/stream', { headers: { authorization: `Bearer ${token}` }, signal: ac.signal });
        if (!r.ok || !r.body) throw new Error(String(r.status));
        onLive(true);
        onChange(); // anything that changed while the stream was down
        const reader = r.body.getReader();
        const dec = new TextDecoder();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (dec.decode(value).includes('event: changed')) onChange();
        }
      } catch { /* fall through to the pause */ }
      if (stopped) return;
      onLive(false);
      await new Promise((res) => setTimeout(res, 5000));
    }
  })();
  return () => { stopped = true; ac.abort(); };
}

/** "2:05" until the deadline, or "overdue". */
export function countdown(acceptBy: string | null, now: number): string {
  if (!acceptBy) return '';
  const s = Math.floor((new Date(acceptBy).getTime() - now) / 1000);
  if (s <= 0) return 'overdue';
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

let ctx: AudioContext | undefined;
/** A short two-tone chime. Browsers only allow sound after a tap, so this stays silent until the cashier has touched the screen. */
export function chime(): void {
  try {
    ctx ??= new AudioContext();
    if (ctx.state !== 'running') return;
    [880, 1175].forEach((f, i) => {
      const o = ctx!.createOscillator();
      const g = ctx!.createGain();
      o.frequency.value = f; g.gain.value = 0.15;
      o.connect(g); g.connect(ctx!.destination);
      o.start(ctx!.currentTime + i * 0.18); o.stop(ctx!.currentTime + i * 0.18 + 0.15);
    });
  } catch { /* no audio is not an error */ }
}
export function unlockSound(): void {
  try { ctx ??= new AudioContext(); void ctx.resume(); } catch { /* ignore */ }
}
