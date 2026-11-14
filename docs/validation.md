# Validation guide

How to find out whether the application is in a good state, what each check proves, and what it does not.
Everything runs locally. Run `pnpm run validate -- --list` to see the stages.

## One command, live feedback

```
pnpm run validate:quick       # about 1 min, no database reset
pnpm run validate:standard    # about 5 min, destroys and rebuilds the dev database
pnpm run validate:full        # 15+ min, adds the tablet build and the mutation checks
node scripts/validate.mjs typecheck db      # any stages, in the order given
```

The runner ([scripts/validate.mjs](../scripts/validate.mjs)) shows a spinner per stage with elapsed time and a live
count of passing and failing tests, prints the last lines of any failure, and ends with `ALL STAGES PASSED` or
`NOT VALIDATED`. Full logs go to `.validation/<stage>.log`; `.validation/report.html` is a summary to open from disk.
Flags: `--yes` skips the confirmation before a destructive stage, `--keep-going` does not stop at the first failure.

**Avoiding surprises.** Stages marked destructive ask first. The runner refuses to start while a mutation run is in
progress, because that run owns the database and rewrites source files while it works, so any other result would be
about a mutant, not the real code.

## Stages

| Stage | What it runs | Proves | Does not prove |
|---|---|---|---|
| `env` | Node >= 22, Docker daemon, Postgres container up | The machine can run the rest | Anything about the code |
| `typecheck` | `tsc --noEmit` in every package | Types agree across API, tablet, shared code | Behaviour |
| `fresh` (destructive) | `up:fresh`: drops volumes, applies 0001.. in order, seeds two tenants | The schema and seeds still build from nothing (PLAN workflow rule) | That the data is right |
| `db` | `db/test/rls.test.mjs`, `trading.test.mjs`, `online.test.mjs` on real Postgres | Tenant isolation, trading invariants (receipt series, immutability, REVOKEs), online order lifecycle floor | API-level authorisation |
| `unit-api` | `apps/api/test/*.test.ts` | Permission and scope checks, auth and lockout, orders, sync push/pull | The UI |
| `unit-counter` | `apps/counter/test/*.test.ts` | Sale arithmetic, push queue, receipt layout | Real printing or a real tablet |
| `build` | `tsc` and `vite build` for the tablet | The shipped bundle compiles | That it renders |
| `mutation` (slow, destructive) | `scripts/mutation-checks.mjs`: weakens one guard at a time on a fresh database | The tests for tenant isolation, auth, sync and money actually fail when the guard is removed (not vacuous) | Guards that have no mutant yet |

A mutant reported BROKEN (its code did not load) proves nothing and counts as a gap. A mutant that survives means a
guard is not protected by any test: fix the test, not the report.

## Browser scripts (not stages)

Playwright with the installed Edge against the Docker stack on :8080, at tablet sizes. Run `fresh` before each one
(API tests add cashiers with other PINs). Each prints `N/N` and writes `.validation/<script>.log`.

| Script | Covers |
|---|---|
| `scripts/browser-flow.mjs` | The whole counter flow: offline reload and PIN, reconnect, tab killed mid-push, receipt gaps, reprint, online queue, shift close, force-close, day close, reports |
| `scripts/browser-sell.mjs` | Sell screen: code search, hold/resume, quick cash, UPI, offline sale, table strip and map |
| `scripts/browser-tables.mjs` | Two devices on one table: open orders by pull and SSE, paying and voiding another device's order, refused payments |
| `scripts/browser-tablets.mjs` | Manager tools → Tablets: revoke and rename |
| `scripts/browser-menu.mjs` | Manager tools → Menu: the menu editor, pictures, CSV |

## Checks that are not scripted

CLAUDE.md asks for these where the change touches them. Do them by hand, and record the result in the phase file's
step row (or PLAN.md 0.2 for a full pass).

1. **Printing and storage on real hardware**: print a 58 mm receipt on the H58BT; check `storage.persist()` and that
   offline sales survive a tablet restart. Nothing else can stand in for these.
2. **A new screen** not yet covered by a script above: check it at about 1024 x 768 and 768 x 1024. Unit tests have
   passed before while the UI was broken.
3. **Two-tenant isolation by hand**: sign in to tenant A, request an id that belongs to tenant B, expect not found.
4. **Seed sanity**: after `fresh`, the two seeded tenants each have an outlet, a menu and a manager who can sign in.
5. **Working tree**: after any mutation run, `git status` shows only your own changes. A modified source file you did
   not touch means a mutant was left in.

## Reading a failure

1. Open `.validation/<stage>.log` and search for `not ok`.
2. Rerun just that stage: `node scripts/validate.mjs db`.
3. If it only fails after other stages, suspect leftover state: run `fresh` first.
4. Do not change a test to match new behaviour before deciding which one is wrong.

## When to run what

| Situation | Run |
|---|---|
| Comment, copy, formatting | `quick` |
| Schema or seed change | `standard` |
| Tenant isolation, auth, sync, money, background job, or a new guard | `standard`, then `mutation`, plus the browser check |
| Before a phase is called done | `full` and the manual checks above |
