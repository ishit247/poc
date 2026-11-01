import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { withTenant } from '../db.js';
import { ITEMS_BY, KINDS, SALES_BY, isProvisional, runReport, toCsv, type Kind } from '../reports.js';

// Reports (PLAN 14): a manager reads their own outlets only, one outlet or all of theirs together. Read-only.

const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
const date = z.string().refine(isDate, 'not a date');
const MAX_DAYS = 366;

const params = z.object({ kind: z.enum(KINDS) });
const query = z.object({
  from: date,
  to: date,
  outletId: z.string().uuid().optional(),
  by: z.string().max(20).optional(),
  format: z.enum(['json', 'csv']).default('json'),
}).strict();

export const reportRoutes: FastifyPluginAsync = async (app) => {
  // Scope: the outlets assigned to the caller, filtered before any query; a named outlet outside them is a 404.
  const cfg = { scope: 'outlet', permission: 'manager' } as const;

  app.get('/reports/:kind', { config: cfg }, async (req, reply) => {
    const ps = params.safeParse(req.params);
    const q = query.safeParse(req.query);
    if (!ps.success || !q.success) return reply.code(400).send({ error: 'invalid request' });
    const { from, to, outletId, by, format } = q.data;
    const kind: Kind = ps.data.kind;
    if (to < from) return reply.code(400).send({ error: 'the end date is before the start date' });
    if ((Date.parse(to) - Date.parse(from)) / 86_400_000 >= MAX_DAYS) return reply.code(400).send({ error: `ask for at most ${MAX_DAYS} days at a time` });
    if (by !== undefined && !(kind === 'sales' ? SALES_BY : kind === 'items' ? ITEMS_BY : ([] as readonly string[])).includes(by)) {
      return reply.code(400).send({ error: 'invalid request' });
    }
    const p = req.principal!;
    if (p.kind !== 'user') return reply.code(404).send({ error: 'not found' });
    if (outletId && !p.outletIds.includes(outletId)) return reply.code(404).send({ error: 'not found' });
    const outletIds = outletId ? [outletId] : p.outletIds;

    return withTenant(p.tenantId, async (c) => {
      const result = await runReport(c, kind, { outletIds, from, to, by });
      if (format === 'csv') {
        return reply.header('content-type', 'text/csv; charset=utf-8')
          .header('content-disposition', `attachment; filename="report-${kind}-${from}_${to}.csv"`)
          .send(toCsv(result));
      }
      return { kind, from, to, provisional: await isProvisional(c, outletIds, to), ...result };
    });
  });
};
