// Every route must declare whose records it may touch (scope) and who may call
// it (permission). A permission answers "what"; the scope rule answers "whose".
// onRoute (app.ts) rejects any non-public route registered without both, and
// the auth hook (auth.ts) enforces the permission before the handler runs.
export type ScopeRule =
  | 'public' // no tenant data (health, login, enrolment entry)
  | 'tenant' // any record of the caller's tenant
  | 'outlet' // records of an outlet the caller is assigned to
  | 'shift-owner' // cashier: only records of the shift they own
  | 'platform'; // super-admin console, outside tenant scope

export type Role = 'manager' | 'cashier' | 'waiter';

export type Permission =
  | 'manager' // manager only
  | 'till' // takes payment: cashier or manager
  | 'staff' // takes orders: waiter, cashier or manager
  | 'device'; // enrolled device credential

export type Principal =
  | { kind: 'user'; tenantId: string; userId: string; role: Role; outletIds: string[]; sessionId: string }
  | { kind: 'device'; tenantId: string; deviceId: string; outletId: string; counterId: string };

declare module 'fastify' {
  interface FastifyContextConfig {
    scope?: ScopeRule;
    permission?: Permission;
  }
  interface FastifyRequest {
    principal?: Principal;
  }
}
