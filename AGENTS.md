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
  build) followed by `python -m pytest`. None of these need a running server.
- Dependencies are installed once by `scripts/codex-setup.sh` during the
  network-enabled setup phase; the loop itself runs offline.
- Definition of Done: all of `scripts/verify.sh` passes AND a PR is open.
- Always run the verifier before finishing. Do not declare work complete on an
  unverified or red tree.
- Iteration cap: if the verifier is still failing after a few focused attempts
  (about three), stop and ask a human rather than continuing to loop.
- When review comments arrive, address them, re-run `bash scripts/verify.sh`,
  and only then re-request review.

The review-to-fix loop is automated by the
[`Codex address review feedback`](.github/workflows/codex-address-review.yml)
workflow; see [`docs/loop-engineering.md`](docs/loop-engineering.md) for how it
is triggered and the one-time setup it requires (repo secret `OPENAI_API_KEY`
and enabling Codex auto-review in the Codex cloud UI).

### Review rules

For the Codex PR reviewer:

- Enforce [`docs/architecture-rules.md`](docs/architecture-rules.md).
- Flag parallel or duplicate mutation paths for the same domain operation.
- Flag speculative abstractions with only a single real consumer.
- Prefer behavioral and invariant tests over tests that freeze an internal
  call graph.

