// Tenants are addressed by subdomain. These are the seeded ones (scripts/seed.ts); BASE_DOMAIN defaults to localhost.
export const A_ID = '00000000-0000-4000-8000-00000000000a';
export const B_ID = '00000000-0000-4000-8000-00000000000b';
export const HOST_A = 'tenant-a.localhost';
export const HOST_B = 'tenant-b.localhost';

export const hostFor = (tenantId: string): string => (tenantId === B_ID ? HOST_B : HOST_A);
