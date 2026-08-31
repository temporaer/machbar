# Machbar coding instructions

Read `docs/architecture-rules.md` before behavioral changes.

Before introducing a component, hook, action, mutation helper, endpoint,
domain command, picker, editor, gesture implementation, or persistence
abstraction, search for the same conceptual operation. Reuse, extend, or
consolidate the canonical implementation. Do not create a parallel path unless
the existing primitive cannot express required semantics, and explain why.

- Keep one canonical mutation path per domain operation. Different screens may
  have different presentation and optimistic projections, but must share the
  underlying mutation semantics.
- Keep pure domain helpers outside React hooks. UI presentation should call
  domain actions/commands, which call API transport.
- Inspect adjacent code after a change and remove obsolete implementations,
  compatibility wrappers, exports, tests, and documentation.
- Do not introduce speculative generic form engines, command buses, workflow
  engines, repository layers, giant configurable sheets, or abstractions with
  only one real consumer.
- Update `docs/architecture-rules.md`, its canonical primitive registry, and
  `docs/architecture.md` whenever an architectural primitive or canonical path
  changes.
- Prefer behavioral, invariant, concurrency, and useful architecture-contract
  tests over assertions that freeze today's internal call graph.

Run `npm run architecture`, `npm run typecheck`, `npm test`, and
`npm run build` for changes that affect code.
