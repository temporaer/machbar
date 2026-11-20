# Graph and task-mutation scaling audit

## Scope and conclusion

This is a measurement-only audit. No production mutation, graph, response, or
read-invalidation behavior is changed. The evidence supports **over-eager
reconstruction at write boundaries as the first problem to address**, not a
conclusion that the domain graph is an inappropriate model. It also identifies
intrinsic graph costs worth measuring separately: recursive next-action
descendant expansion and several full-list JavaScript membership scans.

The strongest concrete finding is the task-child batch path. A batch of `N`
children currently performs `6N + 3` full `Graph.load()` calls in the measured
task-batch route. This is confirmed by runtime instrumentation, not inferred
only from source. Each load rebuilds effective owner/tag/context state and the
next-action projection for the household.

## Reproduce the measurements

From the repository root, with dependencies installed:

```bash
npm run build -w @machbar/shared
npx tsx apps/api/scripts/graph-scaling-audit.ts
```

By default the harness measures 100, 1,000, and 5,000 task fixtures with one
warm-up and three measured runs per operation. To narrow or increase repetitions:

```bash
AUDIT_SIZES=100,1000 AUDIT_REPEATS=5 npx tsx apps/api/scripts/graph-scaling-audit.ts
```

Each fixture has 5–20 projects, nested task trees (up to four levels per
fixture branch), two owners, five tags, two physical contexts, dependencies,
and absolute reminders. Task statuses and action/reference kinds vary. Each
sample and warm-up runs inside a SQLite savepoint and is rolled back, so all
repetitions of a scenario see the same seeded household state. The measured
operations are root create, project-task create, status change, cancel,
complete, reopen, move, Today read, and child batches of 1/5/20/30. Setup,
migrations, fixture inserts, and rollback are outside request timing.

The full default run is CPU-heavy at 5,000 tasks because it executes every
operation and batch size. `AUDIT_OPERATIONS` can select an exact comma-separated
subset (including `create-1-children`, etc.) when splitting the matrix:

```bash
AUDIT_SIZES=100 AUDIT_REPEATS=3 npx tsx apps/api/scripts/graph-scaling-audit.ts
AUDIT_SIZES=1000 AUDIT_REPEATS=3 AUDIT_OPERATIONS=create-root,create-under-project,status-change,cancel,complete,reopen,move-task,today-view,create-1-children,create-5-children,create-20-children,create-30-children npx tsx apps/api/scripts/graph-scaling-audit.ts
AUDIT_SIZES=5000 AUDIT_REPEATS=3 AUDIT_OPERATIONS=create-root,create-under-project,status-change,cancel,complete,reopen,move-task,today-view npx tsx apps/api/scripts/graph-scaling-audit.ts
```

The harness reports API-injection wall time, prepared SQL statement count and
elapsed time, inclusive `Graph.load()` count/time and the SQL portion inside
those loads, and serialized response bytes. It runs in one process against
in-memory SQLite on localhost; it does not measure network/browser latency.
Statement timing wraps synchronous prepared-statement calls, so it is
instrumented wall time rather than SQLite's internal CPU timer. With three
samples, p95 is the maximum observed sample (nearest-rank percentile).

**Measurement boundary:** request validation, authorization, domain transaction
and invariant work, graph assembly, and response generation are not each
independently instrumented. SQL and graph inclusive time expose two nested
costs; subtracting them gives only an approximate non-SQL portion of graph
assembly. Request wall time minus graph time is not a clean transaction or
serialization measurement. The test app has OIDC disabled, and frontend
invalidation/refetch is excluded. Thus these are reproducible API-local
measurements, not end-to-end user latency or production authentication
measurements. Keep these limits in mind when comparing results.

## Call-path and projection matrix

One `Graph.load()` currently runs four repository derivations:
`getEffectiveOwners`, `getEffectiveTagIds`,
`getEffectivePhysicalContextIds`, and
`getNextActionTaskIdsByProjectProjection`
([`domain/graph.ts`](../apps/api/src/domain/graph.ts#L274-L312)).
It then loads work items, reminders, tags, contexts, task relations,
dependencies, waits, criteria, and assembles task/project records and derived
blocker, readiness, and health state. Viewer-aware loads still compute the
effective maps and next-action projection over all rows before filtering
visible work items ([`domain/graph.ts`](../apps/api/src/domain/graph.ts#L291-L330)).

| Operation / path | Complete graph or expensive-query behavior | Why it is needed today / scoped alternative |
|---|---|---|
| `GET` compiled views, task list/detail, search, MCP, and most project reads | Usually one `Graph.load()` per handler ([`routes/views.ts`](../apps/api/src/routes/views.ts#L99-L180), [`routes/tasks.ts`](../apps/api/src/routes/tasks.ts#L96-L110), [`routes/projects.ts`](../apps/api/src/routes/projects.ts#L103-L131), [`routes/search.ts`](../apps/api/src/routes/search.ts#L14-L18), [`mcp/tools.ts`](../apps/api/src/mcp/tools.ts#L423)) | These return derived, viewer-filtered records; retain the authoritative projection. Investigate duplicate same-request project loads separately. |
| Root task create | 2 in the measured API path: `insertTask()` returns `getTaskOrThrow()` and the route projects the final response through `taskOrThrow()` ([`domain/taskCrud.ts`](../apps/api/src/domain/taskCrud.ts#L368-L395), [`domain/taskCrud.ts`](../apps/api/src/domain/taskCrud.ts#L515-L535), [`routes/tasks.ts`](../apps/api/src/routes/tasks.ts#L196-L215)) | The local insert needs row facts, while the route needs the authoritative response DTO. Measure whether the transactional return can be minimal without changing mutation/read ownership. |
| Task under a parent / child create | 6 for one API child: parent lookup, repeated parent-acceptance lookup, insert-time parent lookup and acceptance lookup, insert result lookup, and response projection ([`domain/taskCrud.ts`](../apps/api/src/domain/taskCrud.ts#L320-L329), [`domain/taskCrud.ts`](../apps/api/src/domain/taskCrud.ts#L387-L395), [`domain/taskCrud.ts`](../apps/api/src/domain/taskCrud.ts#L630-L692), [`routes/tasks.ts`](../apps/api/src/routes/tasks.ts#L218-L236)) | The constraints are local to the parent and project chain; test a scoped transactional snapshot while preserving revisions, scope inheritance, and first-action-child classification. |
| Child batch of `N` | **`6N + 3` loads**, observed for 1/5/20/30. One batch preflight parent lookup; five per child in the canonical child/create-return path; one response graph plus parent and `N` per-task response projections ([`domain/taskStepBatch.ts`](../apps/api/src/domain/taskStepBatch.ts#L104-L165), [`routes/tasks.ts`](../apps/api/src/routes/tasks.ts#L239-L265)) | Preserve atomicity and one authoritative post-commit projection. Prevalidate shared parent/project facts once; avoid per-child household graph reads; reuse the response graph for all returned records only if visibility and DTO equality are proven. |
| Child-batch project invariants | Each child calls `projectHasNextAction()` before insert and usually after it; that helper executes the recursive all-project CTE ([`domain/taskCrud.ts`](../apps/api/src/domain/taskCrud.ts#L665-L672), [`domain/taskCrud.ts`](../apps/api/src/domain/taskCrud.ts#L718-L735), [`domain/workItemShared.ts`](../apps/api/src/domain/workItemShared.ts#L98-L100), [`repo/nextActionRepo.ts`](../apps/api/src/repo/nextActionRepo.ts#L49-L75)) | This is separate from the `Graph.load()` count. A project-scoped query or a batch baseline/transition calculation is a candidate only after contribution and next-action semantics are demonstrated for intermediate children. |
| Batch position and open-child checks | For each child, `nextTaskPosition()` reads/sorts all direct siblings and reduces them; the first-action and open-child checks also query the same destination ([`domain/taskRowInsert.ts`](../apps/api/src/domain/taskRowInsert.ts#L43-L46), [`repo/treeRepo.ts`](../apps/api/src/repo/treeRepo.ts#L14-L19), [`domain/taskCrud.ts`](../apps/api/src/domain/taskCrud.ts#L639-L684)) | Candidate for once-per-batch shared state and incremental position allocation. Keep same transaction, deterministic sibling order, and concurrent-write correctness. |
| Status/cancel/complete/reopen/move | At the 100-task fixture: 3/4/7/3/3 graph loads respectively. Complete also reads descendants and their records; lifecycle before/after graph reads are explicit in [`taskWorkflow.ts`](../apps/api/src/domain/taskWorkflow.ts#L101-L202); move derives owner inheritance before and after in [`structuralMoves.ts`](../apps/api/src/domain/structuralMoves.ts#L333-L343). | Distinguish required transition/inheritance facts from whole response records. Do not remove before/after checks until each invariant has a targeted equivalent. |
| Activation preview | `previewActivation()` loads a viewer-filtered graph before running the canonical mutation in a rollback transaction, then loads after only on its successful preview branch ([`domain/activationPreview.ts`](../apps/api/src/domain/activationPreview.ts#L10-L47)). | The initial projection enforces viewer visibility; the after projection verifies proposed activation. The rollback-only write and early `project_commitment_resolution_required` path differ and should be profiled separately. |
| Receipt replay | No graph is needed to replay the mutation itself; task/project create routes still construct their response projection after `createWithReceipt()` returns, including replay ([`routes/tasks.ts`](../apps/api/src/routes/tasks.ts#L212-L215), [`routes/projects.ts`](../apps/api/src/routes/projects.ts#L155-L167)). | Preserve receipt identity and authoritative current visibility/DTO. Benchmark replay as a separate request class before proposing response changes. |
| Project read/write routes | The `convert-to-task` route loads before validation and after conversion; project move loads for visibility and then after the move ([`routes/projects.ts`](../apps/api/src/routes/projects.ts#L304-L334)). Several project helpers also load their own graph. | Reuse an already-authorized same-request projection where all data and viewer scope match; otherwise retain separate projections. |
| Refinement, cleanup, activity and notifications | `refinementRepo` computes effective owners and tags, then calls `Graph.load()`; cleanup and digest operations load a graph; outbox reminder work computes effective owners without a full graph ([`repo/refinementRepo.ts`](../apps/api/src/repo/refinementRepo.ts#L109-L127), [`cleanupRound/jobs.ts`](../apps/api/src/cleanupRound/jobs.ts#L145), [`activity/digest.ts`](../apps/api/src/activity/digest.ts#L1081-L1158), [`notifications/outbox.ts`](../apps/api/src/notifications/outbox.ts#L103-L143)). | Avoid duplicate derivations within one background operation where both outputs are required; do not assume public viewer visibility rules apply to background work. |

`Graph.load()` call-site inventory: direct routes in views/tasks/projects/search,
MCP reads, task CRUD/workflows/capabilities/structural moves, activation
preview, story workflow, refinement/intake, cleanup, reflection/activity
digest, and Home Assistant snapshot application. `rg -n 'Graph\\.load\\('
apps/api/src` lists current sites. Query-only derivations that can be costly
without a graph include `getNextActionTaskIdsByProject()`,
`getEffectiveOwners()` and project readiness/plan helpers; the latter are
called directly from task and structural mutations.

## Measured results

The tables below report API wall median/p95, SQL elapsed median/p95 and
statement count, and inclusive graph-load count/time median/p95. Times are
milliseconds; Graph time includes its SQL and must not be added to SQL time.

| Fixture tasks | Operation | API wall median / p95 | SQL median / p95; statements | Graph loads; inclusive ms median / p95 | Response bytes |
|---:|---|---:|---:|---:|---:|
| 100 | root create | 18.84 / 20.43 | 9.83 / 11.14; 11 | 2; 15.53 / 16.19 | 1,351 |
| 100 | task under project | 23.85 / 24.38 | 13.30 / 15.17; 12 | 2; 16.41 / 17.43 | 2,002 |
| 100 | status change | 26.19 / 26.56 | 15.64 / 15.84; 20 | 3; 21.56 / 22.12 | 1,380 |
| 100 | cancel | 30.62 / 33.02 | 19.56 / 20.07; 24 | 4; 28.00 / 30.46 | 1,385 |
| 100 | complete | 61.05 / 79.92 | 39.03 / 49.02; 40 | 7; 55.02 / 73.12 | 1,380 |
| 100 | reopen | 23.72 / 24.48 | 14.56 / 15.00; 17 | 3; 20.25 / 22.00 | 1,363 |
| 100 | move | 27.31 / 27.97 | 17.58 / 17.84; 30 | 3; 20.11 / 20.39 | 1,996 |
| 100 | Today read | 11.95 / 12.92 | 4.63 / 4.66; 5 | 1; 6.77 / 6.94 | 16,679 |
| 100 | batch 1 | 73.70 / 75.21 | 50.11 / 50.30; 47 | 9; 67.05 / 68.39 | 9,557 |
| 100 | batch 5 | 260.01 / 275.40 | 180.49 / 184.92; 175 | 33; 233.17 / 248.05 | 25,377 |
| 100 | batch 20 | 1,105.34 / 1,116.29 | 799.81 / 800.44; 655 | 123; 988.11 / 994.17 | 84,742 |
| 100 | batch 30 | 1,687.66 / 1,716.02 | 1,231.67 / 1,262.91; 975 | 183; 1,504.80 / 1,529.87 | 124,332 |
| 1,000 | root create | 819.78 / 822.16 | 783.76 / 789.26; 11 | 2; 767.71 / 773.52 | 1,354 |
| 1,000 | task under project | 1,050.58 / 1,058.92 | 1,022.48 / 1,027.33; 12 | 2; 766.94 / 773.55 | 2,004 |
| 1,000 | status change | 1,278.37 / 1,288.78 | 1,236.69 / 1,240.03; 20 | 3; 1,149.00 / 1,153.51 | 1,382 |
| 1,000 | cancel | 1,604.13 / 1,610.12 | 1,554.54 / 1,556.57; 24 | 4; 1,553.26 / 1,557.74 | 1,387 |
| 1,000 | complete | 2,760.14 / 2,787.61 | 2,674.20 / 2,697.48; 40 | 7; 2,671.23 / 2,697.29 | 1,382 |
| 1,000 | reopen | 1,182.21 / 1,245.58 | 1,146.33 / 1,195.66; 17 | 3; 1,137.53 / 1,197.14 | 1,365 |
| 1,000 | move | 1,426.63 / 1,451.60 | 1,385.86 / 1,403.61; 55 | 3; 1,142.20 / 1,154.69 | 1,999 |
| 1,000 | Today read | 430.36 / 437.09 | 364.61 / 366.84; 5 | 1; 379.58 / 386.33 | 36,810 |
| 1,000 | batch 1 | 3,790.99 / 3,824.78 | 3,662.86 / 3,690.56; 47 | 9; 3,494.68 / 3,510.32 | 11,501 |
| 1,000 | batch 5 | 14,471.68 / 14,589.87 | 14,066.97 / 14,124.68; 175 | 33; 13,007.14 / 13,130.39 | 27,357 |
| 1,000 | batch 20 | 54,200.55 / 54,818.04 | 52,696.09 / 53,273.64; 655 | 123; 48,287.53 / 48,854.36 | 86,858 |
| 1,000 | batch 30 | 79,305.61 / 80,456.86 | 77,480.93 / 78,529.12; 975 | 183; 70,662.12 / 71,750.60 | 126,538 |
| 5,000 | root create | 19,078.60 / 19,113.65 | 18,873.82 / 18,922.17; 11 | 2; 18,045.48 / 18,083.81 | 1,354 |
| 5,000 | Today read | 8,994.83 / 9,146.22 | 8,724.07 / 8,852.97; 5 | 1; 8,813.06 / 8,960.72 | 73,304 |

The 100-task batch results alone establish the batch-size amplification:
graph loads rise exactly with `6N + 3`, while SQL statements rise from 47 to 975
and response bytes from 9.6 KB to 124 KB between 1 and 30 children. At 1,000
tasks the median Today read is 430 ms versus 12 ms at 100 tasks, despite just
one graph load; this indicates material intrinsic graph/read-model cost in
addition to repeated write-boundary work. At 1,000 tasks, the 30-child batch
takes a median 79.3 seconds and makes 183 graph loads. At 5,000 tasks, one
Today read takes a median 9.0 seconds; root creation, which loads the graph
twice, takes 19.1 seconds. Approximately 99% of the inclusive graph time in
those two 5,000-task measurements is synchronous prepared-SQL time. A full
5,000-task 30-child request would multiply that already expensive path across
183 graph loads; it is excluded from the initial 5,000-task matrix rather than
reporting an uncompleted run as a measurement.

The measurements ran on 2026-11-20 with Node v22.23.4, SQLite 3.53.2,
Linux x64, an AMD EPYC 9V45 runner reporting 4 CPUs and 15.6 GiB RAM. They
are local in-memory benchmark data, not a representative production database
snapshot.

### Query plans and indexes

The repeatable harness reports the local SQLite plan for the two local
lookups exercised by child creation. On SQLite 3.53.2, the child lookup uses
`work_items_parent_idx (parent_id=?)`; the dependency lookup uses the covering
`task_dependencies_unique (task_id=?)` index. These point lookups are
indexed, but the child index does not cover role/kind/position, and position
allocation reads and sorts all direct siblings. This is not a claim that the
recursive next-action CTE has an optimal plan; its full `EXPLAIN QUERY PLAN`
is a follow-up measurement.

## Scaling diagnosis

**Repeated reconstruction (observed):** measured child batches grow from 9 to
183 full graph loads as batch size grows from 1 to 30. Each of those loads
repeats household-wide effective inheritance and next-action projections.
Separately, every child repeats project-level next-action checks. This
establishes a write-boundary amplification problem independently of whether a
single graph read is acceptable.

**Intrinsic query/assembly cost (observed):**
the next-action query recursively materializes task descendants and uses them
for descendant blockers and project-container state
([`nextActionRepo.ts`](../apps/api/src/repo/nextActionRepo.ts#L49-L132)).
For a chain of height `H`, ancestor/descendant rows may grow with `N×H` and
quadratically in a worst-case deep chain. Effective owner/tag/context CTEs
walk the hierarchy over every task. Graph assembly also uses repeated
`Array.some()` membership scans while mapping raw task parents and filtering
relations ([`domain/graph.ts`](../apps/api/src/domain/graph.ts#L373-L381),
[`domain/graph.ts`](../apps/api/src/domain/graph.ts#L425-L467),
[`domain/graph.ts`](../apps/api/src/domain/graph.ts#L511-L529)); those are
potentially quadratic in row counts. The scale results show that a single
`Graph.load()` grows from roughly 7 ms of SQL at 100 tasks to 380 ms at 1,000
and 8.7–17.9 seconds at 5,000, depending on the operation. The non-SQL portion
of a graph load remains much smaller than its SQL portion in these fixtures.
The benchmark does not attribute SQL time to individual CTEs; the next-action
descendant projection and three inheritance CTEs need isolated query profiling
before assigning blame among them. The hierarchy fixture is bounded-depth, so
its results do not establish worst-case deep-chain behavior.

**Not established:** these synthetic household fixtures do not prove
production latency, memory behavior, or worst-case hierarchy scaling. The
observed child lookup index does not explain the recursive CTE's full plan.
Request-stage timing beyond API wall/SQL/graph, activation-preview latency,
receipt-replay latency, 5,000-task lifecycle/move operations, background batch
behavior, and browser invalidation/refetch remain unmeasured.

## Prioritized follow-up proposals

1. **Child-batch transaction amplification (highest priority).** In a separate,
   narrowly scoped implementation issue, let the canonical batch operation
   reuse the validated parent/project snapshot and batch-scoped first-child,
   open-child, and position facts. Return only transactional facts needed by
   contributions/activity, then project the API response once after commit.
   The route already builds a viewer-aware graph but calls `taskOrThrow()` for
   the parent and every created child; reuse is a candidate only if the
   response remains identical to a subsequent GET. At 30 children, the
   measured baseline is 183 graph loads; the arithmetic upper bound for
   eliminating per-child loads is 180, not a promised latency saving.
   **Risk:** first-child classification, revision races, project commitment,
   contribution reason/count, owner/context/tag inheritance, visibility, and
   response equality. Add tests for reference-first then action child,
   captured/someday parent, XL breakdown contribution precedence, project
   due-plan/next-action transitions, stale parent/project revisions, invalid
   last child rollback, and serialized response versus GET.

2. **Repeated project-wide next-action checks.** Measure and consider a
   project-scoped targeted query or batch transition check for
   `projectHasNextAction()`. Preserve the exact point where the first newly
   eligible child changes the contribution reason; a final-state-only check
   is insufficient if an earlier child was the first transition.
   **Risk:** dependencies, waits, nested/reference descendants, status and
   revisit dates, terminal projects, and multiple project ancestors.

3. **Single-graph assembly cost.** Use the scale table and full CTE query plan
   to determine whether `Graph.load()` itself needs a separately scoped
   optimization. Replace repeated in-memory `Array.some()` membership tests
   with maps/sets only if profiling confirms their contribution. Preserve one
   authoritative derived model, viewer-specific filtering, and all current
   task/project projections. Do not add a mutable graph cache or denormalized
   state.

4. **Lifecycle and structural mutations.** Profile before/after graph loads
   separately for completion, cancellation, status changes, moves, and
   activation preview. Replace only local facts with explicit scoped
   invariant checks; keep descendant/dependency, revision, containment,
   commitment, authorization and access-revocation checks authoritative.

No architecture-changing follow-up should start until a human reviews this
audit and approves its exact behavior/test scope. Preserve the existing
mutation/read ownership and refresh architecture.
