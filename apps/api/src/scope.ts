// Every route must declare whose records it may touch (scope) and who may call
// it (permission). A permission answers "what"; the scope rule answers "whose".
// onRoute (app.ts) rejects any non-public route registered without both, and
// the auth hook (auth.ts) enforces the permission before the handler runs.
export type ScopeRule =
  | 'public' // no tenant data (health, login, enrolment entry)
  | 'tenant' // any record of the caller's tenant
  | 'outlet' // records of an outlet the caller is assigned to
  | 'shift-owner' // cashier: only records of the shift they own
  | 'own-orders' // orders: waiter = their own open orders; cashier = open orders at their outlets plus their own shift's; manager = their outlets
  | 'platform'; // super-admin console, outside tenant scope

export type Role = 'manager' | 'cashier' | 'waiter';

export type Permission =
  | 'manager' // manager only
  | 'till' // takes payment: cashier or manager
  | 'staff' // takes orders: waiter, cashier or manager
  | 'device' // enrolled device credential
  | 'platform-owner' // console: owner only
  | 'platform-any'; // console: owner or support

export interface PlatformAdmin {
  adminId: string;
  role: 'owner' | 'support';
  sessionId: string;
}

export type Principal =
  // `support` is set only for a platform operator's impersonation: a read-only manager view (no real user behind it,
  // userId is the nil uuid, outletIds is every outlet of the tenant). auth.ts refuses every method but GET/HEAD for it.
  | { kind: 'user'; tenantId: string; userId: string; role: Role; outletIds: string[]; sessionId: string; deviceId: string | null; support?: { impersonationId: string } }
  // revokedAt is set only on a route that opted in with allowRevokedDevice (the push endpoint).
  | { kind: 'device'; tenantId: string; deviceId: string; outletId: string; counterId: string; revokedAt: Date | null };

declare module 'fastify' {
  interface FastifyContextConfig {
    scope?: ScopeRule;
    permission?: Permission;
    /** A revoked tablet may still deliver what it did before revocation (PLAN 7.6). Only the push endpoint sets this. */
    allowRevokedDevice?: boolean;
  }
  interface FastifyRequest {
    principal?: Principal;
    /** The signed-in console operator, set only on scope 'platform' routes. Never a tenant principal. */
    admin?: PlatformAdmin;
    /** The tenant named by the request's Host (<subdomain>.<base domain>), or null for a bare/unknown host. */
    hostTenantId?: string | null;
  }
}
