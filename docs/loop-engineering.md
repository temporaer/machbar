# Loop engineering

This repository is wired for an autonomous **verify-until-green** agent loop.
Two halves make it work: a local/CI verifier that the project owns, and an
**off-the-shelf** outer loop that reviews PRs and pushes fixes.

## Inner loop: the verifier

- `npm run verify` runs, failing fast and in CI order: architecture checks,
  `@machbar/shared` build, typecheck, tests, and the production build.
- `bash scripts/verify.sh` (also `npm run verify:all`) runs `npm run verify`
  followed by `python -m pytest` for the Home Assistant integration.
- No externally running server is needed: vitest is in-process, the API uses an
  embedded `better-sqlite3` file, and the Python tests use the in-process
  `pytest-homeassistant-custom-component` harness. The Python cross-runtime tests additionally self-start a disposable built Node
  API over loopback. Playwright self-starts a separate disposable API using
  `playwright.config.ts` and runs in its own parallel CI job.
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

## Contract-first verification

Before changing behavior, write a small scenario matrix derived from the domain
contract. Record the invariant, relevant inputs/identities/states/event orders,
public entry and error paths, expected visible/persisted effects, and test layer.
Use working notes or PR validation; this is reasoning evidence, not a new artifact
or a demand for every possible combination. Simple changes need only a few lines.

Select dimensions according to the actual risk:

| Failure class | Counterexamples and assertions to consider |
| --- | --- |
| Authorization / data exposure | Read, preview, commit, replay and early stale/validation errors; owner, other and unknown viewer; task/project/ancestor owners differing; both work scope and durable privacy. Assert sensitive response fields are absent and rejected writes leave data, activity/outbox and notifications unchanged. A status code alone is insufficient. |
| Retry / operation identity | Two identical intents, both responses lost after commit, reversed retry order, a new identical caller, navigation away/back, and success followed by a deliberate new creation. Assert each caller recovers its own result and emits effects once. Identity follows the logical operation, not payload equality or FIFO position. |
| State / concurrency | Save versus refresh versus open interaction in relevant orders; removed/promoted/new descendants; equal-revision derived changes; stale/network failures and eventual release. Assert uniqueness, current values and membership, preserved drafts/focus/placement as applicable, and recovery. |
| Lifecycle / representation | Active, deferred, completed, archived, converted and deleted states relevant to the change. Existing IDs can change roles. Test the public projection/response a caller consumes, not merely row existence. |
| Persistence / migration | Upgrade with existing data, rollback, restart/restore as relevant; SQL plus snapshot/journal chain; generation of the next migration. Applying today's SQL alone does not validate future schema generation. |
| UI / environment | Actual production providers/routing, touch CSS and focus transitions. Identify extra capabilities supplied by wrappers/mocks. Use real app/browser checks for boundaries those fixtures cannot establish. |

Add the highest-risk counterexamples before implementing the fix. Demonstrate
that a regression rejects the faulty revision or a small equivalent mutation;
this establishes that scenario's sensitivity, not completeness of the matrix.
For new behavior, state positive and negative invariants independently of the new
code. A mocked API response must be backed by a real serialized contract test
when its shape/meaning is what the change relies on, including error variants.

After the code is green, revisit the matrix and inspect adjacent callers and
all early exits. Ask which plausible input/state/order the current tests still
assume away. Add relevant missing cases, or state the remaining limitation and
its consequence. Do not change an invariant merely to accommodate the proposed
implementation without a domain reason. Keep external review as an independent
check; this pass does not replace it.

In PR validation, name the invariant and counterexamples, the evidence that the
regression was sensitive, and what remains untested. Classify findings honestly:
pre-existing app bug, bug introduced by this implementation, or verification-only
change. Report test counts/coverage as measurements; do not infer absence of
production bugs or complete failure-class coverage from them.

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

## Production-boundary gap closure

- API write matrices now include final mutations, destructive operations,
  destinations/dependencies, actual authenticated sessions and spoofed actors.
  Rejected writes must return an error before changing database state or
  publishing events. The original code failed eight final-write matrix cases
  and fifteen destructive/session cases; these were real behavioral failures.
- `tests/contracts/retries.test.ts` drops real successful API responses after
  commit. Both ordinary task/project retries duplicated work before the receipt
  fix. The test also protects deliberate subsequent and simultaneous creations.
- `apps/api/tests/recovery.test.ts` uses persistent SQLite: pre-receipt upgrade,
  repeated migration, reopen, online backup/restore and a real killed writer
  process. `representative-load.test.ts` exercises 1000 tasks through reads and
  a write with a bounded graph-load budget. This is a functional scale check,
  not a production capacity or tail-latency benchmark.
- `tests/e2e/core.spec.ts` runs fourteen real-browser cases (seven scenarios × desktop
  and mobile Chromium): visible/tappable completion, dialog focus restoration,
  two live sessions with stale writes and offline reconnection, Discussion live
  contents actual service-worker activation/control, and both creation forms retrying a
  committed response lost by the browser. Any page exception
  fails its test. Discussion failed with a real missing-provider exception before
  the fix. Run `npm run build && npm run test:e2e`. The server uses a disposable
  temporary database and never reuses a developer server. CI installs Chromium
  dependencies and retains failure traces.
- `tests/test_live_api_contract.py` exercises the packaged Python HTTP client
  against the built Node API on an ephemeral loopback port, with real pairing,
  context snapshots, request leasing/completion and invalid credentials. Run
  after `npm run build`; the full verifier already builds before pytest. These
  tests skip in the offline sandbox and run in normal CI. No cloud AI or actual
  household account is contacted.

Boundaries that still need a staging/device exercise: real Pocket ID redirects,
real push-provider/device receipt and OS notification clicks, live Home Assistant
AI/calendar services, Paperless credentials, physical keyboards and non-Chromium
browsers. Mocked/provider-specific existing tests plus the loopback/browser
contracts do not prove those deployed services are healthy. Cross-runtime tests
use the real HTTP client but supply a fixture analysis result; they do not grade
AI output quality. Ordinary creation replay covers task/project root POSTs and
retry within the current client runtime; batch endpoints and capture recovery
across a page reload are not claimed as covered retry contracts.

Review follow-up contracts also cover caller-owned retry identity (including
reverse-order retries and a new identical form while another result is unknown),
hidden project activation snapshots on final writes, role-converted receipt
results, and migration snapshot drift. The creation APIs require an explicit
CreationIntent at compile time, so new production callers must choose their
operation lifetime rather than inheriting an implicit payload queue. Activation
fixtures deliberately give task, project and ancestor different owners.
