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
