// How ingest says "no" or "not yet" from deep inside a handler. See ingest.ts for what the tablet does with each.

/** Will never be accepted as sent: recorded in the ledger with this reason. */
export class Reject extends Error { constructor(readonly reason: string) { super(reason); } }

/** Rejected without a ledger row: the answer may change once the server (or the device) is upgraded. */
export class RejectUnrecorded extends Reject {}

/** Cannot be judged yet (what it refers to has not arrived): no ledger row; the tablet retries. */
export class Defer extends Error { constructor(readonly reason = 'sale_not_yet_received') { super(reason); } }
