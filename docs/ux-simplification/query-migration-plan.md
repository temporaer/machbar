# TanStack Query migration plan

**Date:** 2026-11-09

**Baseline:** current merged main, `2e923f239e69fef583074b189bdd2abab013c4bd`

**Authorization:** the initial assignment authorized planning only. The user
subsequently approved the revised execution sequence: "ok, then go ahead, step
by step." Establish the whole-migration budget first, then implement the bounded
Project pilot and proceed through the remaining consumers. Temporary setup
growth is allowed; the completed migration must reduce production LOC.

## Goal and ownership

Replace custom fetched/confirmed-state machinery with TanStack Query, rather
than putting Query underneath the same retained-state implementation.
Preserve existing capabilities and the recovery fixes merged in #262-#264.
Use [reimplementation context](reimplementation-context.md) as a source of
counterexamples, not code to transplant from #256.

| Responsibility | Target owner |
| --- | --- |
| Fetched and confirmed server data | Query cache, qualified by resource and effective viewer |
| Revision reconciliation and affected-query invalidation | Central cache integration used by canonical actions |
| Domain operations, expected revisions and API transport | Existing task/project action and mutation paths |
| Optimism | Narrow mutation projections; not another confirmed-data store |
| Drafts, choices, focus and opening identity | Existing local editor/workflow state |
| Temporary row placement and interaction lifetime | UI-only state, independent of server-value ownership |
| Workflow facts, permissions and legal lifecycle transitions | Backend |
| Authenticated SSE/reconnect transport | Existing transport, eventually invalidating Query |

These are proposed changes to current ownership, not a claim that main already
uses Query. Update the normative architecture rules and primitive registry with
an approved implementation, not as though this plan were already implemented.

## Sequence and gates

### Step 1: replacement/deletion map and LOC budget

**Assigned role:** one Luna implementation agent, operating in analysis-only mode.

**Status:** the initial Project-only map is complete with a historical
**REVISE** verdict.
The requested Luna run failed before its first turn with an authorization
error; the coordinator completed and checked the source analysis directly.
The user has now approved replacing the per-milestone LOC-reduction gate with
explicit temporary setup growth and a whole-migration reduction gate. The
[whole-migration budget](query-migration-budget.md) now accounts for named
deletions across Tasks, Goals, Refinement and remaining readers: 799 gross
replacement lines against an estimated 640 to 1,080 replacement/integration
lines. Its net range is -159 to +281; reduction is not established. The original
Project estimate was +50 to +360; the more explicit estimate is +223 to +458,
not a measured result or approved spending cap. The next step is a bounded
installed-library feasibility handoff before production reader migration.

Produce [the Step 1 map](query-migration-step-1.md), with:

- The smallest closed Project-resource boundary: list/detail reads, imperative
  freshness-dependent reads, canonical writes, and every affected consumer.
  Include project representations in Today, Review, All and task/compound
  workflows; do not assume one editor is an isolated resource.
- Current fetched, confirmed, optimistic and UI-lifetime owners, with file/line
  evidence. Classify them separately before proposing deletion.
- A replace/delete/keep table naming exact symbols, affected callers, proposed
  owner, and the milestone that permits removal.
- Measured source baselines and estimated replacement/deletion ranges, including
  shared setup and cross-resource integration. State assumptions and uncertainty.
- Observable invariants and a proportional counterexample matrix independent
  of a preferred implementation, plus relevant existing regression locations.
- A verdict: proceed with a bounded Project slice, revise its boundary, or
  block with concrete reasons. Do not solve an unclosed boundary by inventing
  another cache, generic recovery framework or client domain graph.

The original Step 1 assignment permitted no application edits, dependency
changes/installations, runtime experiments, Git publication or additional
agents. That restriction describes the completed analysis, not the subsequently
approved implementation. Review the end-to-end budget before commissioning
Step 2; count shared setup once and retain the original measured baseline.

### Step 2: complete the Project-resource migration

**Execution status:** installed-library feasibility probes on Query 5.107.1
are accepted for the bounded Project pilot. The native trailing-invalidation
adapter is 11 lines, with selected library-level counterexamples passing.
This is not production verification or evidence of final LOC reduction.
The Project implementation must freeze for review/reforecast before Tasks.

**Current verdict: BLOCKED; do not expand or ship.** The first production
handoff was rejected at net +346 runtime lines, with focused suites red and
missing cache-publication, typed-placement and scope-retirement contracts.
One bounded correction pass reached net **+697** (+1,127/-430, including new
runtime files). The existing remaining ledger now projects **+315 to +520**
at completion, not a reduction. Focused passing cases do not establish parity:
coordinator production-helper counterexamples also reproduce failed ordinary
rollback and missed nested-project publication. See the
[frozen outcome](query-migration-budget.md#7-frozen-project-outcome-blocked)
for evidence and limits. The required verifier also fails on 64 web cases;
the failure classification is incomplete, not evidence of 64 production bugs.
Preserve the experiment; Tasks, shipping and a
production PR remain gated. This rejects the current implementation/forecast,
not every possible Query design.

After reviewing the revised whole-migration budget, first resolve the named
library/placement uncertainties in a bounded probe handoff. Do not treat its
mixed forecast as proof of end-state reduction. If that handoff supports the
resource migration:

1. Establish Query in the real app provider tree, viewer-qualified resource
   identity, and the smallest central reconciliation/invalidation integration.
   Prove relevant behavior against the actual installed library before relying
   on cancellation, cache publication or imperative-fetch assumptions.
2. Move the agreed Project read and canonical write paths together. Account
   for other mounted readers, aggregate projections and task writes that affect
   project detail. No migrated resource may retain competing fetched/confirmed
   ownership through `useAsync` or a retained DTO map.
3. Remove Project retained-value overlays and per-view release bookkeeping
   identified in Step 1. Preserve drafts and placement behavior without using
   a stored server DTO as their lifetime owner.
4. Update architecture documentation and enforcement, remove obsolete callers
   and tests, and preserve behavioral regressions at appropriate boundaries.

The milestone is a working resource migration, not merely a provider,
`useQuery` wrapper or renamed retention controller. Existing Tasks and other
unmigrated resources may temporarily use their old paths, with the boundary and
remaining removals explicit.

### Step 3: migrate Tasks and remove shared retained server-state ownership

Apply the accepted resource pattern to task reads and canonical task mutations.
Preserve arbitrary-depth outlines, membership, moves, pending feedback and
interaction retention. Include the remaining Goal/Refinement mutation consumers
before deleting shared retained server-state machinery; do not credit that
deletion to Step 2 or remove their behavior to make the budget pass.
Do not redesign backend workflow policy or UI capabilities during the migration.

### Step 4: finish remaining reads and invalidation cleanup

Migrate remaining resources, including bootstrap/configuration paths as needed.
Delete `useAsync` and the old refresh-counter ownership when their final callers
are removed. Keep authenticated SSE, reconnect, visibility and timed-eligibility
behavior, feeding the canonical Query invalidation path. Remove temporary
integration paths and update the registry to describe the actual final system.

## Invariants and counterexamples

Step 1 must locate the actual affected paths and refine this initial matrix:

| Invariant | Counterexample to preserve |
| --- | --- |
| Older reads cannot roll back confirmed values | Held GET settles after a higher-revision mutation response |
| Metadata acknowledgement is not a full authorized read | Mutation confirmation arrives after a denied detail GET |
| Fresh derived facts remain authoritative | Equal entity revision but changed children/readiness |
| Cached data and resolved promises do not grant permission | Denial, failed retry, cached result or observer cancellation |
| Identity and logical opening qualify publication | Viewer/opening A-to-B-to-A; old success/error settles later |
| Acceptance is independent of runner idleness | Accepted 200 followed by queued 503; queued 403 still revokes |
| Draft ownership is independent of fetched data | Edit, refresh/denial/recovery, Save/Cancel and replacement opening |
| Current decisions/revisions survive editing | API-error requirements, newer GET and delayed older/equal/newer errors |
| Optimism and row retention do not corrupt server membership | Save/refresh/interaction reorderings, removal, rollback and eventual release |
| Mutations and reads retain their existing semantics | Explicit commit, GET-only recovery, stale conflict and fresh prerequisite reads |

Do not import the abandoned test suite wholesale, weaken privacy assertions, or
claim that provider-rich component fixtures prove the real app mount tree.
Separate existing defects from introduced ones; record evidence gaps explicitly.

## Acceptance and measurement

- Behavioral parity is mandatory; fewer controls, tests or files alone do not
  establish simplification.
- Each milestone must remove old server-state ownership responsibilities.
  The Project pilot may temporarily increase LOC, with setup included in its
  measured diff. The **completed migration** must demonstrate lower production
  LOC against the baseline above; a hybrid architecture is not the final result.
- Reconcile the pilot's measured growth and named later deletions with the
  whole-migration budget before expanding. Materially exceeding the preliminary
  range, needing another custom cache/recovery framework, or losing a credible
  end-state reduction requires revisiting the design, not silently moving the
  goalposts or abandoning behavior.
- Count runtime additions/deletions under `apps/*/src` and `packages/*/src`,
  excluding tests and test support. Report tests, documentation, package metadata
  and lockfile changes separately.
- Count shared Query setup in the first milestone. Do not count the same helper
  deletion twice or claim removal while Tasks/other resources still consume it.
- Baselines are measurements; replacement budgets are estimates, not promises.
  Reconcile estimates against the final diff and explain material differences.
- Approved code changes require the repository verifier and applicable
  desktop/mobile browser gate. Relevant regressions must reject the old failure,
  or use explicit positive/negative invariants for genuinely new behavior.
- No migration milestone is accepted solely on a green test count or LOC delta.

## Execution and handoff

One coordinator publishes; one coding agent writes the assigned slice at a
time, with Luna requested for implementation. An agent's actual availability
must be reported honestly rather than treating a failed launch as active work.
The agent reports a frozen handoff before the coordinator edits its files.
The original Step 1 owned only `query-migration-step-1.md`; the separate
end-to-end budget assignment owns only `query-migration-budget.md`.
The coordinator owns this plan and its README links. Existing preserved
branches/worktrees remain untouched.

Each later assignment must name its baseline, exact owned paths, deletions,
callers, invariants, exclusions, evidence requirements and stop condition.
After a few focused unsuccessful attempts, freeze and report the blocker rather
than growing an unapproved framework or broadening into other editor repairs.
