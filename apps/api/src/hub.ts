// In-process fan-out for "this outlet's online queue changed". Payload-free on purpose: a subscriber refetches
// through the normal, scope-checked routes, so the stream can never carry data its reader may not see.
// One API process serves a school; if that ever changes, this is the seam to put Postgres LISTEN/NOTIFY behind.
type Listener = () => void;
const byOutlet = new Map<string, Set<Listener>>();

export function subscribe(outletIds: string[], fn: Listener): () => void {
  for (const id of outletIds) {
    if (!byOutlet.has(id)) byOutlet.set(id, new Set());
    byOutlet.get(id)!.add(fn);
  }
  return () => { for (const id of outletIds) byOutlet.get(id)?.delete(fn); };
}

export function publish(outletId: string): void {
  for (const fn of byOutlet.get(outletId) ?? []) fn();
}
