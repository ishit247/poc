<meta charset="utf-8">

# Faster mutation runs — plan

Status: **proposed 2026-11-15, not started.** Model plan: STANDARD (test tooling; no product behaviour changes).

## Why a full run takes 3–4 hours

`scripts/mutation-checks.mjs` has ~530 mutants; all but the `noDb` groups (13 test commands) call
`scripts/up-fresh.mjs` before their tests. That script does `docker compose down -v`, then `up -d --build --wait`:
it **rebuilds the API, counter and admin images** (the mutated file is in the build context), waits for Postgres,
Garage and nginx to be healthy, initialises Garage, then runs migrations and the seed in containers. That is roughly
25 s per mutant at 3.5 h / ~500 mutants. But the tests themselves never touch the containers except Postgres: the API
tests run the app in-process (`buildApp()`), the DB tests connect to `localhost:55432`. **Nearly all of the time goes
on rebuilding the stack, not on the tests.**

(The 25 s is an average worked out from the total, not a measurement. Step 1 measures it.)

## What each mutant actually needs

| Mutant touches | Needs before its tests | Today |
|---|---|---|
| `apps/*/src`, `packages/*/src` (most mutants) | an untouched database: the migrated, seeded state | full stack rebuild |
| `db/migrations/*.sql` (schema mutants) | migrations re-run from `0001` under the mutation, then the seed | full stack rebuild |
| tablet or shared code with `noDb` | nothing | nothing (already fast) |

## Approach

1. **Measure.** Time the fresh start and the test command separately for each mutant, and write them to the log
   (`id | result | up s | test s`). Run about 20 mutants of each kind. This confirms the figures above before
   anything is built, and gives the baseline.
2. **Reset by template, not by Docker** (expected to be the big win). Start the stack once at the beginning of the run.
   Migrate and seed once into a database `pos_template`. Before each source-code mutant:
   `DROP DATABASE pos WITH (FORCE); CREATE DATABASE pos TEMPLATE pos_template;` takes about a second. Roles and grants
   are cluster-wide, so RLS and the `REVOKE`s carry over. Schema mutants instead run `scripts/migrate.mjs` and
   `scripts/seed.ts` **on the host** (node + tsx, as the containers do) against a fresh empty `pos`. No image build;
   a migration that does not load still fails here and is reported BROKEN, as today. The run ends by restoring `pos`
   from an unmutated template, as the current last line does.
   - *Garage:* the seed uploads item pictures, and the picture tests delete objects. A clone of the template can then
     point at bytes already gone. Either re-run `garage-init.mjs` and re-upload the seed pictures for mutants whose
     tests use pictures, or keep a per-run bucket. Decide this at the step, after checking `item-images.test.ts`.
   - *Expected:* ~2–4 s overhead per source mutant instead of ~25 s. A full run of perhaps 40–60 min, still serial.
3. **Group by test command.** Mutants of the same file and test command can share one template clone only if the
   tests leave no state, which they do not. So keep a clone per mutant, but build `pos_template` **once per schema
   state**, not once per mutant. Schema mutants stay one build each (~35 of them).
4. **Parallel workers** (after 2, only if the run is still too slow). N workers, each with its own copy of the working
   tree (mutants edit files in place) and its own database `pos_w1..pos_wN`, cloned from the same template. Point the
   tests at it through `APP_DATABASE_URL` / `PLATFORM_DATABASE_URL` / `OWNER_DATABASE_URL`, which the code already
   reads. With 4 workers, perhaps 15 min. Costs: disk for the copies, a check that no test hard-codes the database
   name, and Garage isolation per worker (bucket per worker).
5. **Only what changed** (optional, last). Cache each mutant's result keyed by a hash of the mutated file, its test
   files and `db/migrations/*`, so a "before the phase is done" run re-checks only mutants whose code or tests moved.
   A full uncached run stays the rule before the first real tenant. Risk: a cache hides an interaction across files
   that no key covers, so it is a convenience for daily work, never the sign-off.

## What does not change

- One mutant at a time per working copy, the original file always restored (including Ctrl-C), BROKEN kept apart
  from caught.
- Each mutant still starts from the same migrated, seeded state; only the way that state is produced changes.
- `--check` runs nothing and touches no database (fixed 2026-11-15: it used to run a fresh start at the end).

## Risks

- A template clone hides a seed or migration that depends on Docker-only environment (env vars, secrets). Mitigation:
  the template is built by the same scripts with the same env as `docker-compose.yml`'s `db-env` / `s3-env` /
  `secrets-env`, and a step 2 test compares a template-cloned database with an `up:fresh` one (table row counts, the
  schema dump).
- `DROP DATABASE … WITH (FORCE)` needs Postgres 13+ and a connection as the owner, not as `pos_app`.

## Steps

| # | Step | State |
|---|------|-------|
| 1 | Measure: per-mutant timing in the log | not started |
| 2 | Template reset for code mutants; host-side migrate and seed for schema mutants; Garage handling | not started |
| 3 | One template per schema state | not started |
| 4 | Parallel workers (only if still too slow) | not started |
| 5 | Cache by content hash (optional) | not started |
