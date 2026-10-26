# Coding agents

Read [`docs/architecture-rules.md`](docs/architecture-rules.md) before making
behavioral changes.

## Search before adding

Before adding a component, hook, action, mutation helper, API endpoint, domain
command, picker, editor, gesture, or persistence abstraction, search for the
same conceptual operation. Extend, reuse, or consolidate the existing
implementation by default. A parallel path needs a concrete reason the
canonical path cannot express the required semantics.

## Preserve the architecture

- One domain operation has one canonical mutation path. UI contexts may differ
  in presentation, navigation, and optimistic projection, not domain semantics.
- Keep pure domain helpers outside React hooks. Presentation depends on actions;
  actions depend on API transport.
- A refactor is not complete when the new path works. Delete or consolidate
  adjacent implementations, wrappers, exports, and docs made redundant.
- Do not preserve internal compatibility paths without a current caller or
  deployment need.
- Avoid speculative form engines, command buses, workflow engines, repository
  layers, giant configurable sheets, and abstractions with one real consumer.
  A shared abstraction should normally simplify at least two concrete callers.
- If a PR adds, replaces, renames, or removes an architectural primitive,
  update the canonical registry and architecture documentation in the same PR.

Prefer behavioral, invariant, and concurrency tests over tests that freeze an
internal call graph. Run `npm run architecture` before the normal typecheck,
tests, and build.

## Running the loop

This repository is set up for an autonomous verify-until-green agent loop.

- Verify everything with a single command: `bash scripts/verify.sh`. It runs the
  Node checks (`npm run verify`: architecture, shared build, typecheck, tests,
  build) followed by `python -m pytest`. No external server is needed; cross-runtime tests start their own isolated API.
- Dependencies are installed once by `scripts/codex-setup.sh` during the
  network-enabled setup phase; the loop itself runs offline.
- Network/loopback tests are skipped under `CODEX_SANDBOX_NETWORK_DISABLED` and
  are covered by CI instead; do not try to make them pass in the sandbox.
- Definition of Done: all of `scripts/verify.sh` passes AND a PR is open.
- Before calling a behavioral change verified, identify the failure class and
  cover it at the lowest suitable level. Extend the existing authorization,
  transport-contract or event-sequence matrix when the changed behavior fits
  one. Do not substitute a happy-path mock for a server contract test.
- For a regression, demonstrate that the test rejects the old bug (on the
  faulty revision or with a small, temporary equivalent mutation), then restore
  the production code and verify green. Record the evidence in the PR. For new
  behavior without a faulty revision, state the invariant and negative case.
- Changes to work-item preview routes require owner/other/unknown viewer cases,
  the relevant household/work/durable-private scopes, and no-write/no-notify
  assertions. New error shapes must reach the real web client/decision adapter.
- Changes to retention or reconciliation require relevant save/refresh/interaction
  orderings, uniqueness, authoritative values/membership and eventual release.
  Keep browser-only visibility/focus checks separate; API/jsdom success is not
  evidence of CSS layout or a physical keyboard working.
- Browser-visible changes also require `npm run build && npm run test:e2e`
  (desktop/mobile Chromium). Do not rely solely on provider-rich component test
  wrappers to prove the real app mount tree works. The browser CI job runs in
  parallel and saves failure traces.
- Always run the verifier before finishing. Do not declare work complete on an
  unverified or red tree.
- Iteration cap: if the verifier is still failing after a few focused attempts
  (about three), stop and ask a human rather than continuing to loop.
- When review comments arrive, address them, re-run `bash scripts/verify.sh`,
  and only then re-request review.

The review-to-fix loop is handled off the shelf rather than by a repo-owned
workflow; see [`docs/loop-engineering.md`](docs/loop-engineering.md) for the
recommended options (Codex cloud auto-review plus `@codex fix it`, this app's
Agent merge, or a GitHub App such as CodeRabbit or Qodo Merge).

### Review rules

For the Codex PR reviewer:

- Enforce [`docs/architecture-rules.md`](docs/architecture-rules.md).
- Flag parallel or duplicate mutation paths for the same domain operation.
- Flag speculative abstractions with only a single real consumer.
- Prefer behavioral and invariant tests over tests that freeze an internal
  call graph.

