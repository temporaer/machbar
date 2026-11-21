# Graph and task-mutation scaling audit

**Baseline and status:** These measurements were collected against the pre-#343 base
revision `3cf78725cbdfafee9b9620c25f08daeaf6f9a1fe`. PR #343 remains open and
changes task-create projection costs, so the task-create numbers below are a
pre-#343 baseline and must be remeasured after #343 lands before comparing them
with the resulting behavior. This is a bounded audit report, not completion of
all investigation requested by #344; the follow-up tracks are [#346](https://github.com/temporaer/machbar/issues/346)
and [#347](https://github.com/temporaer/machbar/issues/347).

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

## #346 child-batch follow-up

The canonical child-batch path now reuses its parent snapshot and batch-scoped
child/position facts. The route also projects the response from one viewer-aware
post-commit graph. The exact same audit harness was run on the PR branch with
three measured repetitions and one warm-up for each case:

```bash
AUDIT_SIZES=100,1000,5000 AUDIT_REPEATS=3 \
AUDIT_OPERATIONS=create-1-children,create-5-children,create-20-children,create-30-children \
npx tsx apps/api/scripts/graph-scaling-audit.ts
```

The run is [GitHub Actions run 44826483350](https://github.com/temporaer/machbar/actions/runs/44826483350).
Values are median / p95. The pre-change values below come from the #345
measurement table above; the post-change run used a GitHub-hosted runner, while
the baseline ran on the machine documented in that table. Wall and elapsed-time
comparisons are therefore indicative rather than a controlled same-machine
comparison. Graph-load counts, SQL statement counts, and response sizes are
directly comparable.

| Fixture tasks | Batch | Wall ms before → after | SQL ms before → after | SQL statements before → after | Graph loads before → after | Graph ms before → after | Response bytes |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 100 | 1 | 73.70 / 75.21 → 38.77 / 41.72 | 50.11 / 50.30 → 20.12 / 22.13 | 47 → 12 / 12 | 9 → 2 / 2 | 67.05 / 68.39 → 25.41 / 26.40 | 9,557 |
| 100 | 5 | 260.01 / 275.40 → 37.49 / 37.91 | 180.49 / 184.92 → 21.07 / 21.40 | 175 → 16 / 16 | 33 → 2 / 2 | 233.17 / 248.05 → 20.31 / 20.39 | 25,377 |
| 100 | 20 | 1,105.34 / 1,116.29 → 66.86 / 67.53 | 799.81 / 800.44 → 35.75 / 35.86 | 655 → 31 / 31 | 123 → 2 / 2 | 988.11 / 994.17 → 21.84 / 23.67 | 84,742 |
| 100 | 30 | 1,687.66 / 1,716.02 → 86.87 / 92.79 | 1,231.67 / 1,262.91 → 47.61 / 49.95 | 975 → 41 / 42 | 183 → 2 / 2 | 1,504.80 / 1,529.87 → 24.12 / 25.91 | 124,332 |
| 1,000 | 1 | 3,790.99 / 3,824.78 → 1,389.88 / 1,395.09 | 3,662.86 / 3,690.56 → 1,344.18 / 1,353.25 | 47 → 12 / 12 | 9 → 2 / 2 | 3,494.68 / 3,510.32 → 1,008.74 / 1,014.75 | 11,501 |
| 1,000 | 5 | 14,471.68 / 14,589.87 → 1,580.50 / 1,584.78 | 14,066.97 / 14,124.68 → 1,528.59 / 1,538.06 | 175 → 16 / 16 | 33 → 2 / 2 | 13,007.14 / 13,130.39 → 983.50 / 985.11 | 27,357 |
| 1,000 | 20 | 54,200.55 / 54,818.04 → 2,470.49 / 2,476.03 | 52,696.09 / 53,273.64 → 2,395.41 / 2,402.14 | 655 → 31 / 31 | 123 → 2 / 2 | 48,287.53 / 48,854.36 → 999.98 / 1,012.05 | 86,858 |
| 1,000 | 30 | 79,305.61 / 80,456.86 → 3,063.60 / 3,088.54 | 77,480.93 / 78,529.12 → 2,965.23 / 2,996.61 | 975 → 41 / 41 | 183 → 2 / 2 | 70,662.12 / 71,750.60 → 1,005.15 / 1,024.60 | 126,538 |

For 30 children, both fixture sizes now use two graph loads regardless of batch
size. On the 1,000-task fixture, SQL statements fell from 975 to 41 and the
response stayed at 126,538 bytes. The benchmark's measured median wall time
fell from 79.3 s to 3.06 s; that timing comparison includes the runner
difference noted above.

A 5,000-task fixture was feasible on the updated path and is recorded
separately; the pre-change 5,000-task child batch was not measured, so no
baseline is inferred:

| Fixture tasks | Batch | Wall ms median / p95 | SQL ms median / p95 | SQL statements median / p95 | Graph loads median / p95 | Graph ms median / p95 | Response bytes median / p95 |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 5,000 | 1 | 31,852.00 / 31,905.71 | 31,577.73 / 31,604.21 | 12 / 12 | 2 / 2 | 23,074.33 / 23,084.72 | 15,308 / 15,308 |
| 5,000 | 5 | 37,195.15 / 37,247.01 | 36,893.63 / 36,960.01 | 16 / 16 | 2 / 2 | 23,140.65 / 23,190.82 | 31,164 / 31,164 |
| 5,000 | 20 | 57,123.40 / 57,125.97 | 56,769.16 / 56,771.20 | 31 / 31 | 2 / 2 | 23,118.61 / 23,124.67 | 90,664 / 90,664 |
| 5,000 | 30 | 70,771.60 / 70,942.68 | 70,336.69 / 70,527.21 | 41 / 42 | 2 / 2 | 23,290.79 / 23,321.05 | 130,344 / 130,344 |

At 5,000 tasks, the two graph projections account for about 23.3 s of the
70.3 s measured SQL time (roughly one third); about 47.0 s of SQL time is
outside `Graph.load()`. The aggregate harness does not attribute that
remainder to individual statements. It likely includes the project-wide
next-action and task-plan invariant queries, but that is not established by
these measurements. This residual request measurement is handed to #347 for
per-statement/CTE attribution; #348 does not change those remaining queries.

## Scaling diagnosis

**Repeated reconstruction (observed):** measured child batches grow from 9 to
183 full graph loads as batch size grows from 1 to 30. Each of those loads
repeats household-wide effective inheritance and next-action projections.
Separately, every child repeats project-level next-action checks. This
establishes a write-boundary amplification problem independently of whether a
single graph read is acceptable.

**Single-load scaling (observed; cause not isolated):** a single
\`Graph.load()\` grows from roughly 7 ms of SQL at 100 tasks to 380 ms at 1,000
and 8.7–17.9 seconds at 5,000, depending on the operation. The non-SQL portion
of a graph load remains much smaller than its SQL portion in these fixtures.
This establishes poor single-load scaling in these synthetic fixtures, but it
does not identify which query, CTE, or assembly operation causes that growth.

The next-action query recursively materializes task descendants and uses them
for descendant blockers and project-container state
([\`nextActionRepo.ts\`](../apps/api/src/repo/nextActionRepo.ts#L49-L132)).
Effective owner/tag/context CTEs walk the hierarchy over every task. Graph
assembly also contains repeated \`Array.some()\` membership scans
([\`domain/graph.ts\`](../apps/api/src/domain/graph.ts#L373-L381),
[\`domain/graph.ts\`](../apps/api/src/domain/graph.ts#L425-L467),
[\`domain/graph.ts\`](../apps/api/src/domain/graph.ts#L511-L529)). These
are profiling hypotheses only: this audit does not measure their individual
contribution, nor establish that any one of them explains the observed SQL
time. Attribute the cost with per-query/CTE profiling and query plans before
changing the read model. The hierarchy fixture is bounded-depth, so these
results do not establish worst-case deep-chain behavior.

**Not established:** these synthetic household fixtures do not prove
production latency, memory behavior, or worst-case hierarchy scaling. The
observed child lookup index does not explain the recursive CTE's full plan.
Request-stage timing beyond API wall/SQL/graph, a 5,000-task child batch,
5,000-task lifecycle/move operations, activation-preview branch breakdown,
idempotency/receipt-replay latency, background batch behavior, and end-to-end
browser invalidation/refetch remain unmeasured.

## Prioritized follow-up proposals

1. **Child-batch transaction amplification (highest priority; implementation
   tracked in [#346](https://github.com/temporaer/machbar/issues/346)).** In a separate,
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

2. **Repeated project-wide next-action checks (also tracked in
   [#346](https://github.com/temporaer/machbar/issues/346)).** Measure and consider a
   project-scoped targeted query or batch transition check for
   `projectHasNextAction()`. Preserve the exact point where the first newly
   eligible child changes the contribution reason; a final-state-only check
   is insufficient if an earlier child was the first transition.
   **Risk:** dependencies, waits, nested/reference descendants, status and
   revisit dates, terminal projects, and multiple project ancestors.

3. **Single-graph cost attribution (profiling tracked in [#347](https://github.com/temporaer/machbar/issues/347)).** Use per-query/CTE timing and query plans
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

## #347 single `Graph.load()` attribution

Measured with the isolated profiler on the same GitHub-hosted runner for the
pre-#343 revision, PR #343 head, and the current revision after #348. Each
balanced-fixture value is the median of three fresh-process measurements,
with one warm-up per measurement. Times are milliseconds.

| Revision | Tasks | Wall | Prepared SQL | Outside prepared SQL |
|---|---:|---:|---:|---:|
| pre-#343 | 100 | 15.16 | 8.46 | 6.69 |
| #343 head | 100 | 17.29 | 8.42 | 8.88 |
| after #348 | 100 | 14.63 | 8.50 | 6.14 |
| pre-#343 | 1,000 | 681.16 | 646.05 | 35.11 |
| #343 head | 1,000 | 677.85 | 647.83 | 30.68 |
| after #348 | 1,000 | 678.81 | 646.57 | 30.90 |
| pre-#343 | 5,000 | 16,346.36 | 16,179.27 | 167.09 |
| #343 head | 5,000 | 16,256.33 | 16,094.10 | 160.20 |
| after #348 | 5,000 | 16,400.23 | 16,238.35 | 161.13 |

The balanced fixture shows no material change across these revisions: one
`Graph.load()` takes about 0.68 s at 1,000 tasks and 16.3 s at 5,000.
At 5,000, prepared SQL accounts for about 99% of measured wall time, so graph
assembly membership scans are not the main cost in this fixture.

The largest query is the recursive next-action sort-key query. Its median was
10,196 ms before #343, 10,278 ms at #343, and 10,357 ms after #348 for 5,000
tasks (11,295 rows). The next three expensive statements compute effective
tags, owners, and physical contexts; each took about 1.9–2.0 s and returned
5,000 rows. At 1,000 tasks the same next-action query took about 411 ms, while
the three inheritance queries took about 76–78 ms each. The profiler records
SQLite `EXPLAIN QUERY PLAN` output for each statement in the workflow artifact.

The deep-chain fixture exposes a separate hierarchy sensitivity. At 100
tasks, `Graph.load()` took 96 ms (84 ms in prepared SQL); the next-action
recursive query accounted for 77 ms. At 1,000 and 5,000 tasks, the isolated
measurement exceeded its 90-second limit. Those cases are recorded as timed
out, not as successful samples, and the parent continued to produce the
balanced measurements. This confirms a severe deep-chain scaling risk but
does not distinguish whether the recursion, sort-key expansion, or another
part of that query dominates at those depths. A focused query-level benchmark
with controlled depth increments is the next diagnostic.

The profiling run completed successfully:
[run 44871845526](https://github.com/temporaer/machbar/actions/runs/44871845526).
Its JSON artifact is retained for seven days. The measurement-only harness is
`apps/api/scripts/graph-load-profile.ts`; each fixture runs in a fresh Node
process with a 2 GiB heap limit, a 90-second timeout, and independent result
collection. No production code or read-model behavior changed.
