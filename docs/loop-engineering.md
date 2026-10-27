# Loop engineering

This repository is wired for an autonomous **verify-until-green** agent loop.
Two halves make it work: a local/CI verifier that the project owns, and an
**off-the-shelf** outer loop that reviews PRs and pushes fixes.

## Inner loop: the verifier

- `npm run verify` runs, failing fast and in CI order: architecture checks,
  `@machbar/shared` build, typecheck, tests, and the production build.
- `bash scripts/verify.sh` (also `npm run verify:all`) runs `npm run verify`
  followed by `python -m pytest` for the Home Assistant integration.
- None of these need a running server: vitest is in-process, the API uses an
  embedded `better-sqlite3` file, and the Python tests use the in-process
  `pytest-homeassistant-custom-component` harness. Playwright e2e self-starts a
  server via `playwright.config.ts` and is deliberately kept out of this loop.
- `scripts/codex-setup.sh` installs everything the offline loop needs
  (`npm ci`, then the Python test requirements). It is idempotent.
- Tests that need a real loopback socket (e.g. the MCP OAuth JWKS server) are
  skipped under `CODEX_SANDBOX_NETWORK_DISABLED=1` and are covered by CI
  instead. Do not try to make them pass inside the offline sandbox.

## Test execution

API and web suites use at most two Vitest workers. To compare worker counts on
another machine, run `VITEST_MAX_WORKERS=1 npm test` and
`VITEST_MAX_WORKERS=2 npm test` sequentially with the same code and dependencies.
Keep Vitest's per-file isolation enabled.

Web tests use jsdom by default. Add pure tests to `nodeTests` in
`apps/web/vitest.config.ts` to run them in Node without the DOM setup file.
Browser storage, React rendering, and interaction tests stay in the DOM project.
Both projects are included in the normal test and watch commands.

API global setup runs the real migrations once per Vitest invocation and writes
an unseeded database image in a temporary directory. `createTestDatabase()`
restores a separate in-memory connection for each fixture and enables foreign
keys. HTTP fixtures build the full Fastify app on that database; domain tests
can import the database helper directly. Seed data is applied only when requested.
Migration tests continue constructing historical databases and applying SQL
directly. The template is rebuilt for every invocation and watch rerun, and removed at
teardown.

Verification builds shared once before typechecking and testing, then runs
`build:apps`. The standalone `npm run build` still builds shared first.

## Outer loop: review and fix (off-the-shelf)

The review -> fix loop is **not** a repository-maintained workflow. Hand-rolling
a security-sensitive Action to call a model, resolve threads, and push commits
duplicates products that already do this well and is not worth maintaining.
Pick one of the following, in rough order of least to most setup:

1. **Codex cloud review + `@codex fix it` (recommended).**
   - Enable Codex **auto-review on every PR** once in the Codex cloud UI. Codex
     then posts a review on each new PR automatically.
   - To apply fixes, comment `@codex fix it` on the review (or on a specific
     review comment). Codex addresses the feedback and pushes to the PR branch.
   - This needs no repository workflow and no `OPENAI_API_KEY` secret in the
     repo; auth lives in the Codex cloud connection.

2. **This app's Agent merge.**
   - For a single PR, enable Agent merge to shepherd it: it addresses review
     comments, fixes failing CI, and resolves conflicts on that PR. It is a
     per-PR tool rather than a durable repo-level loop.

3. **A GitHub App for fully automatic review + fix.**
   - Install an app such as CodeRabbit, Qodo Merge, or Ellipsis if you want
     automatic review and fix-up on every PR without a per-PR trigger. These
     are maintained externally and handle the security-sensitive parts for you.

Whichever path you choose, the **inner loop still gates everything**: a fix is
only good once `bash scripts/verify.sh` is green (see `AGENTS.md` ->
"Running the loop" for the Definition of Done and iteration cap).

## Failure-class verification

The fast loop now includes three complementary contracts:

- `apps/api/tests/activation-preview.permissions.test.ts` is the preview route
  matrix: task create, planning, task batch, project batch and conversion ×
  household/work/durable-private scope × owner/other/unknown viewer. Fixtures
  separate durable privacy ownership from the project driver. This matrix uses
  activity-actor identity with OIDC disabled; session/OAuth authentication remains
  covered by its own existing suites. Each case compares
  source GET visibility with preview visibility, checks hidden-title suppression,
  hashes the entire SQLite snapshot to prove rollback, and checks notifications.
  Extend the operation table when adding a supported preview operation.
- `tests/contracts/activation.test.ts` exercises the real web API transport and
  decision/error adapters against the full Fastify app with migrated, isolated
  SQLite databases. Only `fetch` is bridged to `app.inject`; there are no canned
  HTTP responses or mocked domain functions. It covers ready and missing-driver
  previews, direct conflict/snapshot parity, conversion requiring a progress path,
  non-snapshot conflicts, stale refresh/retry and actor headers. Run it with
  `npm run test:contracts`. The existing web Vitest run includes a Node contract
  project using the API's shared migration template setup. Cross-package tests
  live outside production sources and have `tests/contracts/tsconfig.json`,
  included in the root typecheck command; application tsconfigs remain unchanged.
- `apps/web/src/lib/useTaskActions.sequences.test.tsx` runs every ordering of
  save response, refresh and interaction start for existing/new descendants.
  The actual task controller and placement hook must preserve unique rows,
  optimistic values, fresh equal-revision derived fields, authoritative child
  membership, interaction protection and eventual destination placement. Network
  and stale failures must roll back without discarding a newer refresh. Virtual
  time and deferred promises replace wall-clock sleeps.

These tests run in the existing `npm test` and CI jobs, without a browser or a
listening server. Database equality compares SHA-256 digests of the complete
serialized database, avoiding expensive assertion diffs over every byte.
The matrices cover these operations and sequences, not every authorization or
concurrency behavior in the application. Add a dimension when domain behavior
requires it; do not multiply unrelated combinations for coverage counts.

For bug fixes, show that the regression fails against the original bug or a
small equivalent mutation before recording its green result. A manually chosen
fixture that passes only the new implementation is insufficient evidence on its
own. PR validation should name the affected invariant, tested identities/error
variants/event orders and remaining browser-only limitations. Mobile CSS,
browser focus/layout and physical on-screen keyboards remain outside this fast
suite and need a separate browser/device check.
