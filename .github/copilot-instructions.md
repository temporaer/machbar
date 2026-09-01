# Machbar coding instructions

## Repository context

Machbar is an npm-workspace TypeScript application for shared household work:

- `packages/shared` defines dependency-free API contracts and domain
  vocabulary used by both applications.
- `apps/api` is the Fastify server, domain layer, Drizzle/SQLite persistence,
  authentication, notifications, and production static-file host.
- `apps/web` is a React/Vite mobile-first PWA. The API serves its compiled
  assets, so production is one process and one port.

Read `docs/architecture-rules.md` before behavioral changes; it is normative.
Use `docs/workflow.md` for product semantics and `docs/architecture.md` for the
data model and implementation rationale.

## Commands

Use Node.js 22+ and npm 10+. Install with `npm ci`. For local development, copy
`.env.example` to `.env` and run `npm run dev`; Vite proxies `/api` to Fastify.

| Purpose | Command |
|---|---|
| Architecture contracts | `npm run architecture` |
| Type-check all workspaces | `npm run typecheck` |
| Unit/integration tests | `npm test` |
| Production build | `npm run build` |
| Playwright configuration | `npm run test:e2e` |
| API tests only | `npm test -w @machbar/api` |
| Web tests only | `npm test -w @machbar/web` |
| One API test file | `npm test -w @machbar/api -- tests/agenda.test.ts` |
| One web test file | `npm test -w @machbar/web -- src/lib/sortOrder.test.ts` |
| One named Vitest test | `npm test -w @machbar/api -- tests/agenda.test.ts -t "name fragment"` |
| Watch one workspace | `npm run test:watch -w @machbar/web` |
| Apply migrations | `npm run db:migrate` |
| Load demo data | `npm run db:seed` |

There is no separate lint script. Match CI's order for code changes:

```bash
npm run architecture
npm run build -w @machbar/shared
npm run typecheck
npm test
npm run build
```

Building `@machbar/shared` first matters on a clean checkout because workspace
consumers resolve its generated `dist`.

## Architecture and data flow

API write flow is:

```text
Fastify route -> Zod schema/parseOrThrow -> domain mutation -> SQLite transaction
                                                    |-> activity/contribution
                                                    `-> notification outbox
```

Routes in `apps/api/src/routes` should remain thin. Domain invariants and
multi-table operations belong in `apps/api/src/domain/mutations.ts`; SQL/CTE
queries and hierarchy calculations belong in `apps/api/src/repo`. `Graph.load`
combines raw rows and repository/domain derivations into the nested API
projection. Fields such as effective ownership/tags, blockers, executability,
next actions, activation readiness, and stuck reasons are derived rather than
persisted.

The main web mutation flow is:

```text
page/component -> useTaskActions/useProjectActions -> taskMutations/API client
```

`useRetainedMutations` owns pending state, optimistic retention, conflict
refresh, and localized errors. The refresh provider consumes the authenticated
SSE invalidation stream. Different views may project optimistic results
differently, but they must not duplicate mutation semantics.

Today, Review, Waiting, Projects, and All are different compiled views over the
same task/project graph, not independent workflow stores. Review is a derived
maintenance queue; Today owns reached dates and follow-ups; Waiting is blocker
data; All is exhaustive inventory.

## Canonical paths and editing contracts

Before introducing a component, hook, action, mutation helper, endpoint,
domain command, picker, editor, gesture implementation, or persistence
abstraction, search for the same conceptual operation. Reuse, extend, or
consolidate the canonical implementation. Do not create a parallel path unless
the existing primitive cannot express required semantics, and explain why.

- Keep one canonical mutation path per domain operation. In particular, use
  `taskMutations.ts`/`useTaskActions.ts` for task changes,
  `useProjectActions.ts` for project changes, and
  `POST /api/tasks/:id/move` plus `taskTreeMove.ts`/`useOutlineOrganize.tsx` for
  every hierarchy move.
- Classify UI editing correctly: atomic properties save immediately; authored
  text uses explicit Edit/Save/Cancel; compound domain commands commit through
  one atomic backend operation.
- Keep pure domain helpers in React-free modules. Non-hook files must not import
  lower-case helpers from `use*.ts(x)` modules.
- Use focused existing pickers, editors, sheets, and swipe primitives instead
  of creating another mutation-owning surface.
- Inspect adjacent code after a change and remove obsolete implementations,
  compatibility wrappers, exports, tests, and documentation.
- Do not introduce speculative generic form engines, command buses, workflow
  engines, repository layers, giant configurable sheets, or abstractions with
  only one real consumer.
- Update `docs/architecture-rules.md`, its canonical primitive registry, and
  `docs/architecture.md` whenever an architectural primitive or canonical path
  changes.

## Domain and persistence conventions

- Task status is `captured | actionable | someday | done | cancelled`. Waiting
  is not a status: external waits and dependencies determine `blocked` and
  `executable`.
- Project lifecycle changes use dedicated command endpoints. Metadata PATCHes
  must not set status; render legal controls from the API's `availableActions`.
- Active projects require a driver and either executable progress or an
  intentional future waiting point. Do not approximate activation readiness or
  stuck diagnosis in the client.
- Task trees have arbitrary depth. Owner and tags inherit through parent tasks
  and projects using `inherit | explicit | none`; consume `effective*` fields
  rather than rebuilding inheritance in UI code.
- Calendar dates are strict `YYYY-MM-DD` values and must use the existing
  calendar-date helpers rather than timestamp arithmetic. Timestamps use ISO
  strings.
- Tasks and projects have monotonic revisions. Send `expectedRevision`, reject
  stale writes with `stale_write_conflict`, and keep the comparison inside the
  write transaction.
- Multi-table writes are explicit transactions. Domain errors use `AppError`
  and stable `ApiErrorCode` values from `@machbar/shared`.

## Web, tests, and migrations

- Keep built asset URLs relative for ingress, keep browser API requests at
  absolute `/api`, and retain `HashRouter`; these jointly support arbitrary
  proxy base paths without rebuilding.
- Put user-visible frontend copy in both `apps/web/src/i18n/de.ts` and `en.ts`.
  German defines the catalog shape and is the deterministic test fallback.
- API tests normally use `createTestContext()` for a migrated in-memory SQLite
  database and Fastify injection. Prefer behavioral, invariant, concurrency,
  and useful architecture-contract tests over assertions that freeze an
  internal call graph.
- `apps/api/src/db/schema.ts` is the schema source. Generate migrations from
  `apps/api` with `npx drizzle-kit generate --name describe_the_change`; commit
  the SQL, snapshot, and journal entry. Never rewrite a migration that may have
  run elsewhere. Add migration acceptance coverage for data transformations or
  table rebuilds.
