# Cafeteria POS

Start with [PLAN.md](PLAN.md). Section 0 is the handover: what this is, what is
already decided, and the first steps. Read it before doing anything, then follow
the phase order in section 19.

Do not re-ask decisions listed as resolved in PLAN.md. Ask the user only about
the open questions in section 17, and only when you reach the phase that needs
the answer.

# Working agreements

What follows are policies, not preferences. **If one of them is wrong for the
task in front of you, say so and ask before departing from it.** Never decide
silently to skip one — an unasked-for exception is indistinguishable from
forgetting.

## Development phase: no real tenant yet

Until the first real caterer holds real data, there is no production database.
Every row came from a seed script or from someone testing, and a single command
(create it in phase 1, e.g. `up:fresh`) must recreate everything in under a minute.

So **fix the schema where it was first written, and reseed.** Do not add a patch
migration to correct an earlier one.

- A column modelled wrong gets corrected **in its original migration file**.
  A `0034_fix_0023.sql` buys nothing and turns the schema's history into a record
  of mistakes instead of a description of the design.
- If the migration runner tracks files by name only (no checksum), an edited file
  re-applies cleanly against a fresh volume. Keep it that way while in this phase.
- **Update the seeds in the same change.** A schema the seed no longer fits is a
  schema nobody can run. Seeds include at least two tenants, so isolation tests
  are meaningful.
- Verify with the fresh-start command, which destroys the volumes, re-runs every
  migration from `0001`, and reseeds. If a change only works against a database
  that already exists, it is not finished.

The switch to additive-only migrations is a one-way door. **Ask before:** editing
a migration once anything real depends on it — the first real tenant, or any
environment holding data a person typed and would miss.

## Editing files

- Change files with the Edit tool, or Write for new ones. Do not patch files
  through `sed`, `python`, or a heredoc when Edit would do: a file changed outside
  the editing tools gets re-printed in full afterwards.
- Never re-read a file to check that an edit landed. The edit would have failed
  loudly if it had not.
- **Ask before:** a mechanical change across many files at once, where a script
  genuinely is the cheaper tool.

## Command output

- Filter at the source. `| grep`, `| tail`, `-q`, `--format` — decide what
  matters before running the command, not after reading the output.
- Never surface a full test-suite or build log. Extract the summary line, the
  failing test, and the assertion.

## Reading

- Read the range you need, not the whole file. Search before reading: find the
  few lines that matter, then read around them.

## Long-running work

- Background anything slow — test suites, container starts, installs — and come
  back to filtered output. Do not poll it, and do not sit in a foreground wait.
- Never chain sleeps to wait for a condition. Use an `until` loop in a
  background command.

## How much verification

Match the verification to what the change can break.

- Behaviour that people depend on — tenant isolation, an authorisation check,
  sync, money arithmetic, a background job — gets a browser check, real services
  (real Postgres, not fakes), and a mutation to prove the test is not vacuous.
- Comments, documentation, formatting, and copy get a typecheck and a lint, and
  nothing more.
- Say which of the two happened. A change reported as verified when only the
  types were checked is worse than one honestly reported as unverified.
- Green tests have coexisted with a broken UI before: check UI work in a real
  browser at tablet size, and use browser automation for diagnosis rather than
  growing a large functional suite.
- **Ask before:** spending a long verification pass on something that looks
  cosmetic but might not be. Describe the risk and let the decision be made.

## Security rules that recur

- **A permission answers *what*, never *whose*.** Every route taking an id needs
  a permission check *and* a scope check (same tenant, same outlet, and for a
  cashier the shift they own), and must declare its scope rule. A test
  enumerates routes and fails if one lacks a declaration.
- **GRANT never withholds; REVOKE does.** If default privileges already grant all
  four rights, a narrow `GRANT` restricts nothing. Restrict with `REVOKE` and
  test it (e.g. `audit` must be insert/select only for the app role).
- **Audit writes need a SAVEPOINT.** A try/catch around an audit insert on the
  caller's transaction keeps the promise and loses their work; use a savepoint so
  an audit failure cannot abort the business write, or fail both deliberately.

## Documents and deliverables

- Every document belongs in this repository: write plans, guides, reports and
  checklists to a file under `docs/` and say where it is.
- **Never publish a document as a hosted artifact** (claude.ai or anywhere
  else). A page outside the repository is invisible to `git`, cannot be reviewed
  in a diff, and publishing is close to irreversible.
- HTML documents are bare fragments opened from disk; give them
  `<meta charset="utf-8">` or dashes and curly quotes arrive as mojibake.
- **Ask before:** producing a deliverable in any form that lives outside the
  working tree.

## Development stays on this machine

During development, the repository and this machine are the only places project
information lives. (Running the finished product on the user's own server is the
product's runtime and is a separate, decided matter — see D11 in PLAN.md.)

- No hosted artifacts, no cloud or remote execution, no scheduled routines that
  ship the working tree elsewhere.
- Sessions are local only; Remote Control stays off (`.claude/settings.json`
  disables it). A session that finds Remote Control connected says so at once
  and asks before doing anything else.
- Nothing is pasted outward: source, schema, seed data, logs, screenshots,
  `.env` values and any tenant's sales data do not go into a web search, a URL
  query string, an issue tracker, a paste service, or a third-party API. Reading
  public documentation is fine; sending project content out with the request is
  not.
- No new git remotes; `git push` goes where the repository already points.
- **Ask before:** any step that moves project information off this machine, even
  a convenience. Say what would be sent and to whom.

## Tooling and environment

- Windows machine. Install tooling and large caches (package stores, Docker
  data, build caches) on the **D:** drive, not C:.
- If the stack is started through a package-manager script named `up`, be careful
  with pnpm: bare `pnpm up` means `pnpm update` and bumps dependencies. Prefer
  `pnpm run up`, or name the script something else.

## Multi-agent work

- Do not spawn workflows or parallel subagents unless asked for by name. **Ask
  before** proposing one, with a sentence on what it would cost.

## Session hygiene

- One task per session. When a piece of work is finished and the next request is
  unrelated, say plainly that a fresh session would carry less baggage.
- Name files by path when referring to them.
