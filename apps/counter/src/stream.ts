/**
 * Listens to a payload-free server-sent stream and calls `onChange` on each `changed` event, and once whenever the
 * stream (re)connects (anything may have changed while it was down). Reads with fetch because EventSource cannot send
 * an Authorization header. Reconnects after a pause; `onLive` says whether the stream is up, so a screen can fall back
 * to polling while it is not. Returns a function that stops everything.
 */
export function watchStream(path: string, authorization: string, onChange: () => void, onLive: (live: boolean) => void = () => {}): () => void {
  const ac = new AbortController();
  let stopped = false;
  void (async () => {
    while (!stopped) {
      try {
        const r = await fetch(`/api${path}`, { headers: { authorization }, signal: ac.signal });
        if (!r.ok || !r.body) throw new Error(String(r.status));
        onLive(true);
        onChange();
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
