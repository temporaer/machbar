# Issue #360: operational archive design and synthetic measurements

## Read contract

`work_items.archived_at` remains the user-facing project lifecycle flag. The new nullable `operational_archived_at` marker is internal and only affects Today, Week, Inbox, and Waiting graph projections. Search, direct task and project reads, project detail, review, mutation rereads, and history continue to use the complete graph. Opening a parent task from the compact operational outline exposes its complete detail/history; the list shows a count of archived direct child branches.

## Eligibility and safety

- Tasks are candidates only in `done` or `cancelled`, with no recurrence and no external wait; reference tasks are kept. Projects are candidates only when completed or user-archived.
- A candidate is archived only after all direct children have markers. Repeated bounded batches therefore work bottom-up and ensure that no open descendant is hidden behind an archived ancestor.
- Terminal tasks and stories under an active project remain loaded. Their status contributes to active project completion summaries and completion review.
- The worker runs at startup and once per minute, at most 100 items per pass (hard cap 500). The single SQL statement repeats the candidate predicates at update time. A delayed/failed pass leaves extra terminal rows visible and is safe to retry.
- Reopen, non-terminal status changes, creation of a child/project, activation, conversion, and structural moves clear markers for the affected path or moved subtree inside the existing write transaction. Reparented terminal history is restored as visible history at its new location.
- Completed prerequisites may be absent from the operational task map. Their minimal title/status fact is loaded only for a visible dependent; viewer privacy is checked before returning that fact.

The initial backfill is the same idempotent worker pass used in production. It needs no user-visible status migration and can be interrupted at any batch boundary.

## Mutation coverage

The affected canonical paths are `taskCrud` create/update, `taskWorkflow` reopen, `commitmentActivation`, `storyCrud` child creation, `storyWorkflow` project transitions, `structuralMoves` task/project reparenting, and task/project role conversion. Repeated tasks and external-wait tasks are conservatively excluded from archival.

## Synthetic benchmark

Measured on the local Node 22.23.2 / SQLite 3.53.2 environment, with identical in-memory fixtures, 2 warmups and 7 measured `Graph.load()` calls per mode. Fixtures use nested chains of 10 tasks, half terminal and half active; the worker archives the terminal half before the operational measurement. p95 is nearest-rank over the seven samples (therefore the maximum sample). Timings are milliseconds.

| Tasks | Full median / p95 | Operational median / p95 | Rows retained |
|---:|---:|---:|---:|
| 100 | 3.55 / 6.41 | 4.01 / 6.91 | 50 |
| 1,000 | 20.37 / 21.43 | 18.73 / 21.65 | 500 |
| 5,000 | 121.22 / 135.17 | 97.78 / 119.10 | 2,500 |

At 5,000 tasks the measured median fell 19% and p95 fell 12%. At 100 tasks median rose 13%; at 1,000 tasks median fell 8% while p95 was effectively unchanged. The synthetic hierarchy is deliberately modest and lacks realistic notes, tags, dependencies, and production distribution. These results establish that the marker path works and gives a measurable reduction on larger synthetic fixtures, not a production latency forecast. The reproducible fixture/measurement is in `apps/api/tests/operational-archive-benchmark.test.ts`.

The result is intentionally conservative: task-history rows below active projects stay present so project completion metrics remain exact. Broader gains require evidence that terminal rows in completed project trees dominate real graph cost; no cache or separate graph engine is introduced here.
