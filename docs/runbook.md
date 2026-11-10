<meta charset="utf-8">

# Runbook: running the POS server

For the one person who hosts and supports this (PLAN D11). Written 2026-11-10, before hosting is chosen (Q4), so
it covers what does not depend on the provider; the provider-specific parts are marked **(Q4)**.

## 1. Before the first real tenant: replace every dev value

The repository ships public dev values so a fresh machine runs with one command. A real server must replace each one.
Nothing below may reach a real server unchanged.

| What | Where (dev value) | Real server |
|---|---|---|
| `SECRETS_KEY` | `docker-compose.yml` (`dev-only-key-…`) | `openssl rand -base64 32`. The API refuses to start without it (`NODE_ENV=production`). Keep a copy **outside** the server and outside the backups (section 2.3) |
| Database role passwords | `db/init/01-roles.sql`, the URLs in `docker-compose.yml` | new passwords for `pos_owner`, `pos_app`, `app_platform`, `postgres`, changed in both places together |
| S3 key pair | `x-s3-env` in `docker-compose.yml`, `scripts/garage-init.mjs` | a new key from the object store **(Q4)** |
| Console operators | `scripts/seed.ts` (fixed password and authenticator secret) | do not run the seed on a real server; create operators with their own password and authenticator |
| `PLATFORM_HOST` | unset (console on every host) | the console's own host name, so `/platform/*` answers nowhere else |
| `BASE_DOMAIN` | `localhost` | the domain tenants' subdomains hang off |
| `TRUST_PROXY` | `1` | `1` only while the bundled nginx is the only way in; the API port must stay unpublished |
| TLS | none (http on :8080, :8081) | terminate TLS in front of nginx **(Q4)**; the counter's service worker and `storage.persist()` need https |

Also decide the cut-over to additive-only migrations (PLAN section 18, CLAUDE.md) **before** the first real tenant.

## 2. Backups

### 2.1 What and how

- `node scripts/backup.mjs` writes one `pg_dump` (custom format) to `.backups/pos-<UTC time>.dump`. Owners are kept
  (no `--no-owner`): a restore that re-owned the tables to the superuser would make the SECURITY DEFINER functions run
  as superuser and step around row-level security.
- It runs as `postgres`. It cannot run as `pos_owner` or `pos_app`: every table has FORCEd row-level security, and
  Postgres refuses the dump ("query would be affected by row-level security policy", checked 2026-11-10). On a real
  server, give backups their own role: `LOGIN BYPASSRLS` with `SELECT` on every table and nothing else, and use it in
  place of `postgres`.
- Schedule: nightly at least, from cron or a systemd timer on the host, copied the same night to storage on another
  machine or provider **(Q4)**. Keep 14 daily and 8 weekly.
- Point-in-time recovery (WAL archiving) is not set up; a nightly dump loses up to a day of server data. Counters
  hold their own unsynced sales until they are sent, so the loss is what had synced since the last dump. Decide with
  Q4 whether the provider's managed Postgres gives PITR.

### 2.2 What a backup does not hold

- **Item pictures** live in the object store (Garage in dev), under `t/<tenant>/<sha256>` and the catalog prefix. A
  database restore without them shows items with no picture (sales and money are unaffected). Back the bucket up with
  the provider's tool or `rclone sync` **(Q4)**.
- **`SECRETS_KEY`.** Without it the webhook secrets and console authenticator seeds in the dump cannot be opened:
  webhooks then fail and operators cannot sign in. Store the key apart from the dump (a password manager, plus a
  printed copy in a safe place).
- **Role passwords and database-level grants** (`GRANT CONNECT`) are per server, from `db/init/01-roles.sql`.

### 2.3 The restore drill (monthly, and after any schema change)

```
node scripts/backup.mjs
node --import tsx scripts/restore-drill.ts            # newest dump; --keep leaves the scratch database
```

It restores into a scratch database `pos_restore_drill` beside `pos` and fails unless: every table has the same row
count; the same tables have row security enabled and forced with the same policies; owners (tables and functions,
including SECURITY DEFINER) and grants for `pos_app` and `app_platform` match; `pos_app` stamped as tenant A sees its
own sales and no other tenant's; and every sealed secret opens under the current `SECRETS_KEY`.

Last run 2026-11-10 on the dev stack: passed in 3.9 s (48 tables, 47 policies, 110 owners, 136 grants, 10 own
sales and 0 foreign for tenant A, 4/4 secrets). Run with a wrong `SECRETS_KEY` it fails check 5 (0/4), as it should.

### 2.4 Restoring for real (new server)

1. Create the roles: `db/init/01-roles.sql` with the real passwords (section 1). The roles must exist first, because
   the dump keeps owners.
2. Create the empty database owned by `pos_owner` and grant `CONNECT` to `pos_app`, `app_platform`.
3. `pg_restore -U postgres -d pos --exit-on-error <dump>`. Do **not** run the `migrate` service first; the dump
   already holds the schema and the migration record.
4. Set the same `SECRETS_KEY` as the old server, then start the API.
5. Restore the picture bucket.
6. Check: `/api/health`, a console sign-in (proves the key), the platform health view, one counter syncing.

## 3. Incidents

Most of these show first in the console's health view (warnings `device-stale`, `device-unsynced`, `sync-rejected`,
`outbox-failed`, `outbox-backlog`, `integration-quiet`, `webhook-rejected`, `version-skew`).

**A tablet is lost or stolen.** On any other tablet of the outlet: ⋮ → Manager tools → Tablets → Revoke…, with a
reason (lost, stolen, replaced); it is audited with the manager's name and the reason. Tablets are told apart by their
label (given when the enrolment code is made, or with Rename on the same screen), counter, last seen and enrolment
date. Name every tablet when it is enrolled, so the right one is revoked. The server then refuses its
credential. A tablet cannot revoke itself while it holds records not yet sent (they could never be sent afterwards). Whatever it recorded *before* the revocation, by its own clock, is still accepted
if it ever syncs; nothing after. Not built yet: a tablet that stays offline does not lock itself after N days (Q9), so
until then a stolen offline tablet keeps working locally. Enrol the replacement with a new code.

**A tablet's clock is wrong.** Events stamped more than 5 minutes ahead of the server are accepted and flagged
`clock_ahead` (ingest keeps the sale, it does not refuse money). Fix the tablet's time setting (automatic time on),
then look at that day's flagged events before closing the day.

**A tablet holds unsynced sales (`device-unsynced`, or the header count does not fall).** Do **not** clear the
browser's data or uninstall: unsynced sales exist only on that tablet. Check it has network, press sync (⟳), and read
the banner. A "not accepted by the server" banner means parked records: the server refused them for a reason it
recorded (`sync-rejected` in the health view); they will not resend. A refused payment has its own banner and a
manager acknowledges it on that tablet (phase 12 step 7d).

**`outbox-failed` / `outbox-backlog`.** Messages to Zomato/Swiggy retry with backoff and stop after 8 attempts as
`failed`, visible, never claimed as sent. Until phase 9 has real partner APIs every send fails by design.

**`webhook-rejected` / `integration-quiet`.** A rejected webhook is kept with its raw payload (`inbound_event`). A
signature failure means the platform's secret and ours differ, or `SECRETS_KEY` changed. A quiet integration may mean
the platform stopped sending.

**`version-skew`.** Tablets pick up a new build on their next load (service worker). Ask the outlet to reload each
tablet when it has nothing unsynced.

**Staff see "Too many requests" (HTTP 429).** Limits: 300 requests a minute per client IP overall; 10 a minute for
manager sign-in, enrolment, invite redemption and console sign-in; 30 a minute per device for PIN sign-in, on top of
the PIN lockout. Every tablet at a school usually shares one public IP, so a large outlet shares the 300. If 429s show
up in the API log for a school's IP during service, raise the global limit in `apps/api/src/app.ts`. The client IP
is the one nginx saw, which nginx sets itself; a client cannot forge it.

**`SECRETS_KEY` is lost.** Sales, menus and staff are untouched (they are not encrypted). Webhook secrets must be
re-issued with each platform and re-entered; console operators need a new authenticator. Until phase 9 has an
integration screen, both are a database task.

**The API will not start: "SECRETS_KEY is not set".** It is required under `NODE_ENV=production` (the API image).
Set it, with the same value as before; a new key does not open the secrets already stored.
