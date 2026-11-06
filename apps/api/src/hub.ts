// In-process fan-out keyed by topic: an outlet id for "this outlet's online queue changed", `orders:<outlet id>` for
// "an open order at this outlet changed" (routes/sync.ts). Payload-free on purpose: a subscriber refetches
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

/** Topic for "an open order at this outlet may have changed"; the tablet then pulls `/sync/orders`. */
export const ordersTopic = (outletId: string) => `orders:${outletId}`;

export function publish(outletId: string): void {
  for (const fn of byOutlet.get(outletId) ?? []) fn();
}
