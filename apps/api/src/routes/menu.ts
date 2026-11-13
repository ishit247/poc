import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { withTenant } from '../db.js';
import { audit, type AuditEntry } from '../audit.js';
import type { Principal } from '../scope.js';
import { ITEM_DESCRIPTION_MAX, ITEM_IMAGE_MAX_BYTES, ITEM_IMAGE_TYPES } from '@pos/shared';
import { checkImage, lockItemImages, purgeItemImage, releaseItemImage, serveItemImage, storeItemImage } from '../itemImages.js';

const CAT_COLS = 'id, name, code, sort_order AS "sortOrder"';
const ITEM_COLS = 'id, category_id AS "categoryId", name, code, hsn_code AS "hsnCode", description, diet, image_sha256 AS "imageSha256", sort_order AS "sortOrder", ' +
  `COALESCE((SELECT array_agg(it.tag_id ORDER BY it.tag_id) FROM item_tag it WHERE it.item_id = item.id AND it.deleted_at IS NULL), '{}') AS "tagIds"`;
const TAG_COLS = 'id, name, sort_order AS "sortOrder"';
const PRICE_COLS = 'item_id AS "itemId", channel, price_paise::int AS "pricePaise", gst_rate_bp AS "gstRateBp"';

const uuid = z.string().uuid();
const channel = z.enum(['counter', 'zomato', 'swiggy']);
const name = z.string().trim().min(1).max(100);
const sortOrder = z.number().int().min(-1_000_000).max(1_000_000);

// Quick code (PLAN D16): two digits, text. Left out on create, the database hands out the next free one.
const quickCode = z.string().regex(/^[0-9]{2}$/);

/** A code someone typed is taken, or a scope has no free code left. Anything else is a real fault and stays a 500. */
function codeProblem(e: unknown): 'code in use' | 'no free code' | null {
  const x = e as { code?: string; constraint?: string; message?: string };
  if (x.code === '23505' && /_code_live_uq$/.test(x.constraint ?? '')) return 'code in use';
  if (x.code === 'P0001' && /^no free (category|item) code/.test(x.message ?? '')) return 'no free code';
  return null;
}
const nameTaken = (e: unknown) => (e as { code?: string; constraint?: string }).code === '23505' && (e as { constraint?: string }).constraint === 'tag_name_live_uq';

// Base shapes are kept free of refinements so `apply` can extend them (one schema per entity, not a copy).
const categoryBody = z.object({ name, code: quickCode.optional(), sortOrder: sortOrder.optional() }).strict();
const categoryPatch = categoryBody.partial().strict().refine((b) => Object.keys(b).length > 0);
const hsn = z.string().regex(/^[0-9]{4,8}$/).nullable();
const description = z.string().trim().min(1).max(ITEM_DESCRIPTION_MAX).nullable();
const diet = z.enum(['veg', 'egg', 'non_veg']).nullable();
const tagName = z.string().trim().min(1).max(30);
const tagBody = z.object({ name: tagName, sortOrder: sortOrder.optional() }).strict();
const tagPatch = tagBody.partial().strict().refine((b) => Object.keys(b).length > 0);
const TAGS_PER_ITEM = 50;
const itemTagsBody = z.object({ tagIds: z.array(uuid).max(TAGS_PER_ITEM) }).strict();
const itemBody = z.object({ categoryId: uuid, name, code: quickCode.optional(), hsnCode: hsn.optional(), description: description.optional(), diet: diet.optional(), sortOrder: sortOrder.optional() }).strict();
const itemPatch = itemBody.partial().strict().refine((b) => Object.keys(b).length > 0);
const priceBody = z.object({
  pricePaise: z.number().int().min(0).max(100_000_000),
  gstRateBp: z.number().int().min(0).max(4000),
}).strict();
const availableBody = z.object({ available: z.boolean() }).strict();
const idParams = z.object({ id: uuid });
const priceParams = z.object({ id: uuid, channel });
const stockParams = z.object({ outletId: uuid, itemId: uuid });

// --- one menu change as one transaction (POST /menu/apply) -----------------
// A row created in the same change is named by a client ref ("tmp-…") until it has an id; the response maps refs to ids.
const APPLY_MAX_OPS = 500;
const ref = z.string().regex(/^tmp-[A-Za-z0-9_-]{1,40}$/);
const idOrRef = z.union([uuid, ref]);
const ops = <T extends z.ZodType>(s: T) => z.array(s).max(APPLY_MAX_OPS).optional();
const changesSomething = (b: object) => Object.keys(b).length > 1; // more than the id
const applyBody = z.object({
  tags: z.object({ create: ops(tagBody.extend({ ref }).strict()) }).strict().optional(),
  categories: z.object({
    create: ops(categoryBody.extend({ ref }).strict()),
    update: ops(categoryBody.partial().extend({ id: uuid }).strict().refine(changesSomething)),
    delete: ops(uuid),
  }).strict().optional(),
  items: z.object({
    create: ops(itemBody.extend({ ref, categoryId: idOrRef, tagIds: z.array(idOrRef).max(TAGS_PER_ITEM).optional() }).strict()),
    update: ops(itemBody.partial().extend({ id: uuid, categoryId: idOrRef.optional(), tagIds: z.array(idOrRef).max(TAGS_PER_ITEM).optional() }).strict().refine(changesSomething)),
    delete: ops(uuid),
  }).strict().optional(),
  prices: z.object({
    set: ops(priceBody.extend({ itemId: idOrRef, channel }).strict()),
    delete: ops(z.object({ itemId: uuid, channel }).strict()),
  }).strict().optional(),
}).strict();
type ApplyBody = z.infer<typeof applyBody>;

const opCount = (d: ApplyBody) => [d.tags?.create, d.categories?.create, d.categories?.update, d.categories?.delete,
  d.items?.create, d.items?.update, d.items?.delete, d.prices?.set, d.prices?.delete].reduce((n, l) => n + (l?.length ?? 0), 0);

/** Thrown inside the apply transaction to roll the whole change back and name the op that failed. */
class ApplyFailure extends Error {
  constructor(readonly status: 400 | 409, readonly error: string, readonly list: string, readonly index: number) { super(error); }
}

const bad = (reply: FastifyReply) => reply.code(400).send({ error: 'invalid request' });
const notFound = (reply: FastifyReply) => reply.code(404).send({ error: 'not found' });

/** Builds "col = $n" pairs from a validated patch, using a fixed column map (never client keys). */
function setClause(patch: Record<string, unknown>, cols: Record<string, string>, start: number) {
  const keys = Object.keys(patch).filter((k) => k in cols);
  return { sql: keys.map((k, i) => `${cols[k]} = $${start + i}`).join(', '), values: keys.map((k) => patch[k]) };
}
const CATEGORY_SET = { name: 'name', code: 'code', sortOrder: 'sort_order' };
const ITEM_SET = { categoryId: 'category_id', name: 'name', code: 'code', hsnCode: 'hsn_code', description: 'description', diet: 'diet', sortOrder: 'sort_order' };

async function liveExists(c: pg.PoolClient, table: 'category' | 'item', id: string) {
  const r = await c.query(`SELECT 1 FROM ${table} WHERE id = $1 AND deleted_at IS NULL`, [id]);
  return (r.rowCount ?? 0) > 0;
}

// --- per-entity writes: the single routes and `apply` both call these. Each runs inside the caller's withTenant
// transaction, writes its audit row, and lets constraint errors (code or tag name taken) propagate to the caller.
type Who = Pick<AuditEntry, 'tenantId' | 'actorKind' | 'actorId'>;
const actor = (p: Principal): Who => ({ tenantId: p.tenantId, actorKind: p.kind, actorId: p.kind === 'user' ? p.userId : p.deviceId });

async function loadMenu(c: pg.PoolClient) {
  const [cats, items, prices, tags] = await Promise.all([
    c.query(`SELECT ${CAT_COLS} FROM category WHERE deleted_at IS NULL ORDER BY sort_order, name`),
    c.query(`SELECT ${ITEM_COLS} FROM item WHERE deleted_at IS NULL ORDER BY sort_order, name`),
    c.query(`SELECT ${PRICE_COLS} FROM item_price WHERE deleted_at IS NULL`),
    c.query(`SELECT ${TAG_COLS} FROM tag WHERE deleted_at IS NULL ORDER BY sort_order, name`),
  ]);
  return { categories: cats.rows, items: items.rows, prices: prices.rows, tags: tags.rows };
}

async function createCategory(c: pg.PoolClient, who: Who, b: z.infer<typeof categoryBody>) {
  const r = await c.query(`INSERT INTO category (tenant_id, name, code, sort_order) VALUES ($1, $2, $3, $4) RETURNING ${CAT_COLS}`,
    [who.tenantId, b.name, b.code ?? null, b.sortOrder ?? 0]);
  await audit(c, { ...who, action: 'category.create', entity: 'category', entityId: r.rows[0].id });
  return r.rows[0];
}

async function updateCategory(c: pg.PoolClient, who: Who, id: string, patch: Partial<z.infer<typeof categoryBody>>) {
  const set = setClause(patch, CATEGORY_SET, 2);
  const r = await c.query(`UPDATE category SET ${set.sql} WHERE id = $1 AND deleted_at IS NULL RETURNING ${CAT_COLS}`, [id, ...set.values]);
  if (r.rowCount) await audit(c, { ...who, action: 'category.update', entity: 'category', entityId: id });
  return r.rows[0] as Record<string, unknown> | undefined;
}

async function deleteCategory(c: pg.PoolClient, who: Who, id: string) {
  const used = await c.query('SELECT 1 FROM item WHERE category_id = $1 AND deleted_at IS NULL LIMIT 1', [id]);
  if (used.rowCount) return 'in-use' as const;
  const r = await c.query('UPDATE category SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL', [id]);
  if (!r.rowCount) return 'missing' as const;
  await audit(c, { ...who, action: 'category.delete', entity: 'category', entityId: id });
  return 'ok' as const;
}

/** Null when the category is not live (removed, or another tenant's: RLS hides it). */
async function createItem(c: pg.PoolClient, who: Who, b: z.infer<typeof itemBody>) {
  if (!(await liveExists(c, 'category', b.categoryId))) return null;
  const r = await c.query(
    `INSERT INTO item (tenant_id, category_id, name, code, hsn_code, description, diet, sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING ${ITEM_COLS}`,
    [who.tenantId, b.categoryId, b.name, b.code ?? null, b.hsnCode ?? null, b.description ?? null, b.diet ?? null, b.sortOrder ?? 0]);
  await audit(c, { ...who, action: 'item.create', entity: 'item', entityId: r.rows[0].id });
  return r.rows[0] as Record<string, unknown> & { id: string };
}

// A move to another category may change the item's code (kept if free there, else the next free one). The row
// returned carries the code the item has now; the old one is not reported.
async function updateItem(c: pg.PoolClient, who: Who, id: string, patch: Partial<z.infer<typeof itemBody>>) {
  if (patch.categoryId && !(await liveExists(c, 'category', patch.categoryId))) return 'bad-category' as const;
  const set = setClause(patch, ITEM_SET, 2);
  const r = await c.query(`UPDATE item SET ${set.sql} WHERE id = $1 AND deleted_at IS NULL RETURNING ${ITEM_COLS}`, [id, ...set.values]);
  if (!r.rowCount) return 'missing' as const;
  await audit(c, { ...who, action: 'item.update', entity: 'item', entityId: id });
  return r.rows[0] as Record<string, unknown>;
}

/** The caller must have taken lockItemImages first in this transaction (see itemImages.ts). Returns the picture to purge
 *  after commit, or null when the item is not live. */
async function deleteItem(c: pg.PoolClient, who: Who, id: string) {
  const r = await c.query('UPDATE item SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL RETURNING image_sha256', [id]);
  if (!r.rowCount) return null;
  const released = await releaseItemImage(c, who.tenantId, r.rows[0].image_sha256);
  // Tombstone the prices too, so devices drop them in the same pull.
  await c.query('UPDATE item_price SET deleted_at = now() WHERE item_id = $1 AND deleted_at IS NULL', [id]);
  await c.query('UPDATE item_tag SET deleted_at = now() WHERE item_id = $1 AND deleted_at IS NULL', [id]);
  await audit(c, { ...who, action: 'item.delete', entity: 'item', entityId: id });
  return { released };
}

async function createTag(c: pg.PoolClient, who: Who, b: z.infer<typeof tagBody>) {
  const r = await c.query(`INSERT INTO tag (tenant_id, name, sort_order) VALUES ($1, $2, $3) RETURNING ${TAG_COLS}`, [who.tenantId, b.name, b.sortOrder ?? 0]);
  await audit(c, { ...who, action: 'tag.create', entity: 'tag', entityId: r.rows[0].id });
  return r.rows[0] as Record<string, unknown> & { id: string };
}

// Replaces an item's whole tag set. Unknown, removed or another tenant's tag ids are refused (RLS hides them).
async function setItemTags(c: pg.PoolClient, who: Who, id: string, tagIds: string[]) {
  const want = [...new Set(tagIds)];
  if (!(await liveExists(c, 'item', id))) return 'missing' as const;
  const live = await c.query('SELECT id FROM tag WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL', [want]);
  if (live.rowCount !== want.length) return 'bad-tag' as const;
  await c.query('UPDATE item_tag SET deleted_at = now() WHERE item_id = $1 AND deleted_at IS NULL AND NOT (tag_id = ANY($2::uuid[]))', [id, want]);
  await c.query(
    `INSERT INTO item_tag (tenant_id, item_id, tag_id)
     SELECT $1, $2, t FROM unnest($3::uuid[]) t
      WHERE NOT EXISTS (SELECT 1 FROM item_tag x WHERE x.item_id = $2 AND x.tag_id = t AND x.deleted_at IS NULL)`,
    [who.tenantId, id, want]);
  await audit(c, { ...who, action: 'item.tags', entity: 'item', entityId: id });
  return (await c.query(`SELECT ${ITEM_COLS} FROM item WHERE id = $1`, [id])).rows[0] as Record<string, unknown>;
}

/** Null when the item is not live. */
async function setPrice(c: pg.PoolClient, who: Who, itemId: string, ch: z.infer<typeof channel>, b: z.infer<typeof priceBody>) {
  if (!(await liveExists(c, 'item', itemId))) return null;
  const r = await c.query(
    `INSERT INTO item_price (tenant_id, item_id, channel, price_paise, gst_rate_bp) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (item_id, channel) WHERE deleted_at IS NULL
     DO UPDATE SET price_paise = EXCLUDED.price_paise, gst_rate_bp = EXCLUDED.gst_rate_bp
     RETURNING ${PRICE_COLS}`,
    [who.tenantId, itemId, ch, b.pricePaise, b.gstRateBp]);
  await audit(c, { ...who, action: 'price.set', entity: 'item', entityId: itemId, detail: { channel: ch, ...b } });
  return r.rows[0] as Record<string, unknown>;
}

/** False when the item has no live price on that channel. */
async function deletePrice(c: pg.PoolClient, who: Who, itemId: string, ch: z.infer<typeof channel>) {
  const r = await c.query('UPDATE item_price SET deleted_at = now() WHERE item_id = $1 AND channel = $2 AND deleted_at IS NULL', [itemId, ch]);
  if (!r.rowCount) return false;
  await audit(c, { ...who, action: 'price.delete', entity: 'item', entityId: itemId, detail: { channel: ch } });
  return true;
}

/**
 * Applies a whole menu change in one transaction: every op or none. Order is fixed so that a change can lean on its
 * own earlier ops: new tags and categories exist before items name them, items are removed before new ones claim their
 * codes, and categories are removed last, after this change has moved or removed their items. Returns the pictures to
 * purge after commit and the client refs mapped to real ids.
 */
async function applyChange(c: pg.PoolClient, who: Who, d: ApplyBody) {
  const refs = new Map<string, string>();
  const released: (string | null)[] = [];
  const fail = (status: 400 | 409, error: string, list: string, index: number): never => { throw new ApplyFailure(status, error, list, index); };
  const resolve = (v: string, list: string, index: number) => (v.startsWith('tmp-') ? refs.get(v) ?? fail(400, 'unknown ref', list, index) : v);
  const remember = (r: string, id: string, list: string, index: number) => {
    if (refs.has(r)) fail(400, 'duplicate ref', list, index);
    refs.set(r, id);
  };
  /** Runs one op; a constraint the person can fix (code or tag name taken) becomes a 409 naming that op. */
  const each = async <T>(list: string, rows: T[] | undefined, fn: (row: T, index: number) => Promise<void>) => {
    for (const [index, row] of (rows ?? []).entries()) {
      try { await fn(row, index); } catch (e) {
        if (e instanceof ApplyFailure) throw e;
        const why = codeProblem(e) ?? (nameTaken(e) ? 'tag name in use' : null);
        if (why) fail(409, why, list, index);
        throw e;
      }
    }
  };
  const tagsFor = async (itemId: string, tagIds: string[], list: string, index: number) => {
    const out = await setItemTags(c, who, itemId, tagIds.map((t) => resolve(t, list, index)));
    if (out === 'missing') fail(409, 'not found', list, index);
    if (out === 'bad-tag') fail(409, 'tag not found', list, index);
  };

  if (d.items?.delete?.length) await lockItemImages(c, who.tenantId); // first: see itemImages.ts

  await each('tags.create', d.tags?.create, async ({ ref: r, ...b }, i) => remember(r, (await createTag(c, who, b)).id, 'tags.create', i));
  await each('categories.create', d.categories?.create, async ({ ref: r, ...b }, i) => remember(r, (await createCategory(c, who, b)).id, 'categories.create', i));
  await each('categories.update', d.categories?.update, async ({ id, ...patch }, i) => {
    if (!(await updateCategory(c, who, id, patch))) fail(409, 'not found', 'categories.update', i);
  });
  await each('items.delete', d.items?.delete, async (id, i) => {
    const out = await deleteItem(c, who, id);
    if (!out) fail(409, 'not found', 'items.delete', i);
    else released.push(out.released);
  });
  await each('items.create', d.items?.create, async ({ ref: r, tagIds, categoryId, ...b }, i) => {
    const row = await createItem(c, who, { ...b, categoryId: resolve(categoryId, 'items.create', i) });
    if (!row) return fail(409, 'category not found', 'items.create', i);
    remember(r, row.id, 'items.create', i);
    if (tagIds?.length) await tagsFor(row.id, tagIds, 'items.create', i);
  });
  await each('items.update', d.items?.update, async ({ id, tagIds, categoryId, ...b }, i) => {
    const patch = categoryId ? { ...b, categoryId: resolve(categoryId, 'items.update', i) } : b;
    if (Object.keys(patch).length) {
      const out = await updateItem(c, who, id, patch);
      if (out === 'missing') fail(409, 'not found', 'items.update', i);
      if (out === 'bad-category') fail(409, 'category not found', 'items.update', i);
    }
    if (tagIds) await tagsFor(id, tagIds, 'items.update', i);
  });
  // An emptied price cell: the item must still be live; a price already gone is the state asked for.
  await each('prices.delete', d.prices?.delete, async ({ itemId, channel: ch }, i) => {
    if (!(await liveExists(c, 'item', itemId))) fail(409, 'not found', 'prices.delete', i);
    await deletePrice(c, who, itemId, ch);
  });
  await each('prices.set', d.prices?.set, async ({ itemId, channel: ch, ...b }, i) => {
    if (!(await setPrice(c, who, resolve(itemId, 'prices.set', i), ch, b))) fail(409, 'not found', 'prices.set', i);
  });
  await each('categories.delete', d.categories?.delete, async (id, i) => {
    const out = await deleteCategory(c, who, id);
    if (out === 'in-use') fail(409, 'category has items', 'categories.delete', i);
    if (out === 'missing') fail(409, 'not found', 'categories.delete', i);
  });
  return { released, refs: Object.fromEntries(refs) };
}

export const menuRoutes: FastifyPluginAsync = async (app) => {
  const mgr = { scope: 'tenant', permission: 'manager' } as const;

  app.get('/menu', { config: mgr }, async (req) => withTenant(req.principal!.tenantId, loadMenu));

  // The manager menu editor's Save (docs/manager-menu-editor-plan.md): one diff, all or nothing. A failure names the op
  // ({ list, index }) so the screen can mark the row; 409 means the menu changed underneath (reload) or a code is taken.
  app.post('/menu/apply', { config: mgr, bodyLimit: 1024 * 1024 }, async (req, reply) => {
    const b = applyBody.safeParse(req.body);
    if (!b.success) return bad(reply);
    const n = opCount(b.data);
    if (n === 0) return reply.code(400).send({ error: 'nothing to apply' });
    if (n > APPLY_MAX_OPS) return reply.code(400).send({ error: 'too many changes' });
    const p = req.principal!;
    try {
      const out = await withTenant(p.tenantId, async (c) => ({ ...(await applyChange(c, actor(p), b.data)), menu: await loadMenu(c) }));
      for (const sha of out.released) await purgeItemImage(p.tenantId, sha);
      return { ...out.menu, refs: out.refs };
    } catch (e) {
      if (e instanceof ApplyFailure) return reply.code(e.status).send({ error: e.error, op: { list: e.list, index: e.index } });
      throw e;
    }
  });

  // --- categories ---------------------------------------------------------
  app.post('/categories', { config: mgr }, async (req, reply) => {
    const b = categoryBody.safeParse(req.body);
    if (!b.success) return bad(reply);
    const p = req.principal!;
    try {
      return reply.code(201).send(await withTenant(p.tenantId, (c) => createCategory(c, actor(p), b.data)));
    } catch (e) {
      const why = codeProblem(e);
      if (why) return reply.code(409).send({ error: why });
      throw e;
    }
  });

  app.patch('/categories/:id', { config: mgr }, async (req, reply) => {
    const ids = idParams.safeParse(req.params);
    const b = categoryPatch.safeParse(req.body);
    if (!ids.success || !b.success) return bad(reply);
    const p = req.principal!;
    try {
      return (await withTenant(p.tenantId, (c) => updateCategory(c, actor(p), ids.data.id, b.data))) ?? notFound(reply);
    } catch (e) {
      const why = codeProblem(e);
      if (why) return reply.code(409).send({ error: why });
      throw e;
    }
  });

  app.delete('/categories/:id', { config: mgr }, async (req, reply) => {
    const ids = idParams.safeParse(req.params);
    if (!ids.success) return bad(reply);
    const p = req.principal!;
    const out = await withTenant(p.tenantId, (c) => deleteCategory(c, actor(p), ids.data.id));
    if (out === 'in-use') return reply.code(409).send({ error: 'category has items' });
    return out === 'ok' ? { ok: true } : notFound(reply);
  });

  // --- items --------------------------------------------------------------
  app.post('/items', { config: mgr }, async (req, reply) => {
    const b = itemBody.safeParse(req.body);
    if (!b.success) return bad(reply);
    const p = req.principal!;
    try {
      const row = await withTenant(p.tenantId, (c) => createItem(c, actor(p), b.data));
      return row ? reply.code(201).send(row) : bad(reply);
    } catch (e) {
      const why = codeProblem(e);
      if (why) return reply.code(409).send({ error: why });
      throw e;
    }
  });

  app.patch('/items/:id', { config: mgr }, async (req, reply) => {
    const ids = idParams.safeParse(req.params);
    const b = itemPatch.safeParse(req.body);
    if (!ids.success || !b.success) return bad(reply);
    const p = req.principal!;
    try {
      const out = await withTenant(p.tenantId, (c) => updateItem(c, actor(p), ids.data.id, b.data));
      if (out === 'bad-category') return bad(reply);
      return out === 'missing' ? notFound(reply) : out;
    } catch (e) {
      const why = codeProblem(e);
      if (why) return reply.code(409).send({ error: why });
      throw e;
    }
  });

  app.delete('/items/:id', { config: mgr }, async (req, reply) => {
    const ids = idParams.safeParse(req.params);
    if (!ids.success) return bad(reply);
    const p = req.principal!;
    const out = await withTenant(p.tenantId, async (c) => {
      await lockItemImages(c, p.tenantId); // first: see itemImages.ts
      return deleteItem(c, actor(p), ids.data.id);
    });
    if (!out) return notFound(reply);
    await purgeItemImage(p.tenantId, out.released);
    return { ok: true };
  });

  // --- tags (PLAN D17) -------------------------------------------------------
  app.get('/tags', { config: mgr }, async (req) =>
    withTenant(req.principal!.tenantId, async (c) => ({ tags: (await c.query(`SELECT ${TAG_COLS} FROM tag WHERE deleted_at IS NULL ORDER BY sort_order, name`)).rows })));

  app.post('/tags', { config: mgr }, async (req, reply) => {
    const b = tagBody.safeParse(req.body);
    if (!b.success) return bad(reply);
    const p = req.principal!;
    try {
      return reply.code(201).send(await withTenant(p.tenantId, (c) => createTag(c, actor(p), b.data)));
    } catch (e) {
      if (nameTaken(e)) return reply.code(409).send({ error: 'tag name in use' });
      throw e;
    }
  });

  app.patch('/tags/:id', { config: mgr }, async (req, reply) => {
    const ids = idParams.safeParse(req.params);
    const b = tagPatch.safeParse(req.body);
    if (!ids.success || !b.success) return bad(reply);
    const p = req.principal!;
    const set = setClause(b.data, { name: 'name', sortOrder: 'sort_order' }, 2);
    try {
      const row = await withTenant(p.tenantId, async (c) => {
        const r = await c.query(`UPDATE tag SET ${set.sql} WHERE id = $1 AND deleted_at IS NULL RETURNING ${TAG_COLS}`, [ids.data.id, ...set.values]);
        if (r.rowCount) await audit(c, { ...actor(p), action: 'tag.update', entity: 'tag', entityId: ids.data.id });
        return r.rows[0];
      });
      return row ?? notFound(reply);
    } catch (e) {
      if (nameTaken(e)) return reply.code(409).send({ error: 'tag name in use' });
      throw e;
    }
  });

  // Removing a tag tombstones its item links in the same transaction, so devices drop both in one pull.
  app.delete('/tags/:id', { config: mgr }, async (req, reply) => {
    const ids = idParams.safeParse(req.params);
    if (!ids.success) return bad(reply);
    const p = req.principal!;
    const ok = await withTenant(p.tenantId, async (c) => {
      const r = await c.query('UPDATE tag SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL', [ids.data.id]);
      if (!r.rowCount) return false;
      await c.query('UPDATE item_tag SET deleted_at = now() WHERE tag_id = $1 AND deleted_at IS NULL', [ids.data.id]);
      await audit(c, { ...actor(p), action: 'tag.delete', entity: 'tag', entityId: ids.data.id });
      return true;
    });
    return ok ? { ok: true } : notFound(reply);
  });

  app.put('/items/:id/tags', { config: mgr }, async (req, reply) => {
    const ids = idParams.safeParse(req.params);
    const b = itemTagsBody.safeParse(req.body);
    if (!ids.success || !b.success) return bad(reply);
    const p = req.principal!;
    const out = await withTenant(p.tenantId, (c) => setItemTags(c, actor(p), ids.data.id, b.data.tagIds));
    if (out === 'bad-tag') return bad(reply);
    return out === 'missing' ? notFound(reply) : out;
  });

  // --- pictures ------------------------------------------------------------
  // Raw image bodies. The bytes are stored once per distinct picture; the item carries only the hash, which is what
  // pull delivers. A tablet fetches the bytes from /device/item-images/:sha256 when it meets a hash it does not hold.
  app.addContentTypeParser([...ITEM_IMAGE_TYPES], { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

  app.put('/items/:id/image', { config: mgr, bodyLimit: ITEM_IMAGE_MAX_BYTES }, async (req, reply) => {
    const ids = idParams.safeParse(req.params);
    if (!ids.success) return bad(reply);
    const img = checkImage(req.body, req.headers['content-type']);
    if (!img) return bad(reply);
    const p = req.principal!;
    const out = await withTenant(p.tenantId, async (c) => {
      await lockItemImages(c, p.tenantId); // first: see itemImages.ts
      const cur = (await c.query('SELECT image_sha256 FROM item WHERE id = $1 AND deleted_at IS NULL', [ids.data.id])).rows[0];
      if (!cur) return 'missing' as const;
      if (!(await storeItemImage(c, p.tenantId, img.sha256, img.type, req.body as Buffer))) return 'full' as const;
      let released: string | null = null;
      if (cur.image_sha256 !== img.sha256) {
        await c.query('UPDATE item SET image_sha256 = $2 WHERE id = $1', [ids.data.id, img.sha256]);
        released = await releaseItemImage(c, p.tenantId, cur.image_sha256);
      }
      await audit(c, { ...actor(p), action: 'item.image.set', entity: 'item', entityId: ids.data.id, detail: { sha256: img.sha256, bytes: (req.body as Buffer).length } });
      return { released };
    });
    if (out === 'missing') return notFound(reply);
    if (out === 'full') return reply.code(409).send({ error: 'picture limit reached' });
    await purgeItemImage(p.tenantId, out.released);
    return { ok: true, imageSha256: img.sha256 };
  });

  app.delete('/items/:id/image', { config: mgr }, async (req, reply) => {
    const ids = idParams.safeParse(req.params);
    if (!ids.success) return bad(reply);
    const p = req.principal!;
    const out = await withTenant(p.tenantId, async (c) => {
      await lockItemImages(c, p.tenantId); // first: see itemImages.ts
      const cur = (await c.query('SELECT image_sha256 FROM item WHERE id = $1 AND deleted_at IS NULL', [ids.data.id])).rows[0];
      if (!cur) return null;
      let released: string | null = null;
      if (cur.image_sha256) {
        await c.query('UPDATE item SET image_sha256 = NULL WHERE id = $1', [ids.data.id]);
        released = await releaseItemImage(c, p.tenantId, cur.image_sha256);
        await audit(c, { ...actor(p), action: 'item.image.remove', entity: 'item', entityId: ids.data.id });
      }
      return { released };
    });
    if (!out) return notFound(reply);
    await purgeItemImage(p.tenantId, out.released);
    return { ok: true };
  });

  // By manager session (for the menu editor) and by device credential (for the tablet cache). Scope: the
  // caller's own tenant; the hash only means something inside it, and RLS pins the tenant.
  app.get('/item-images/:sha256', { config: mgr }, async (req, reply) =>
    serveItemImage(req, reply, req.principal!.tenantId, (req.params as { sha256: string }).sha256));
  app.get('/device/item-images/:sha256', { config: { scope: 'tenant', permission: 'device' } }, async (req, reply) =>
    serveItemImage(req, reply, req.principal!.tenantId, (req.params as { sha256: string }).sha256));

  // --- channel prices -----------------------------------------------------
  app.put('/items/:id/prices/:channel', { config: mgr }, async (req, reply) => {
    const ps = priceParams.safeParse(req.params);
    const b = priceBody.safeParse(req.body);
    if (!ps.success || !b.success) return bad(reply);
    const p = req.principal!;
    return (await withTenant(p.tenantId, (c) => setPrice(c, actor(p), ps.data.id, ps.data.channel, b.data))) ?? notFound(reply);
  });

  app.delete('/items/:id/prices/:channel', { config: mgr }, async (req, reply) => {
    const ps = priceParams.safeParse(req.params);
    if (!ps.success) return bad(reply);
    const p = req.principal!;
    const ok = await withTenant(p.tenantId, (c) => deletePrice(c, actor(p), ps.data.id, ps.data.channel));
    return ok ? { ok: true } : notFound(reply);
  });

  // --- stock toggle: cashier or manager, only at their own outlets ----------
  app.put('/outlets/:outletId/items/:itemId', { config: { scope: 'outlet', permission: 'till' } }, async (req, reply) => {
    const ps = stockParams.safeParse(req.params);
    const b = availableBody.safeParse(req.body);
    if (!ps.success || !b.success) return bad(reply);
    const p = req.principal!;
    if (p.kind !== 'user' || !p.outletIds.includes(ps.data.outletId)) return notFound(reply);
    const ok = await withTenant(p.tenantId, async (c) => {
      if (!(await liveExists(c, 'item', ps.data.itemId))) return false;
      await c.query(
        `INSERT INTO outlet_item (tenant_id, outlet_id, item_id, available) VALUES ($1,$2,$3,$4)
         ON CONFLICT (outlet_id, item_id) DO UPDATE SET available = EXCLUDED.available, deleted_at = NULL`,
        [p.tenantId, ps.data.outletId, ps.data.itemId, b.data.available]);
      await audit(c, { tenantId: p.tenantId, actorKind: 'user', actorId: p.userId, action: 'stock.set', entity: 'item', entityId: ps.data.itemId, detail: { outletId: ps.data.outletId, available: b.data.available } });
      return true;
    });
    return ok ? { ok: true } : notFound(reply);
  });
};
