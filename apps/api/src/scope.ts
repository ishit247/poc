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

export type Permission =
  | 'manager' // signed-in manager session
  | 'staff' // signed-in manager or cashier session
  | 'device'; // enrolled device credential

export type Principal =
  | { kind: 'user'; tenantId: string; userId: string; role: 'manager' | 'cashier'; outletIds: string[]; sessionId: string }
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
