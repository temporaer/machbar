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
