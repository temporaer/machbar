# Query migration: frozen whole-program deletion budget

**2026-11-09 · Frozen design handoff; execution decision recorded below.**
Source baseline: merged main `2e923f239e69fef583074b189bdd2abab013c4bd`.
Analysis worktree: `docs/query-migration-plan`, initially `7b8d47d7`.
Only this document was written. No application/dependency changes, library
experiments, tests, Git writes, publication, or nested agents were performed.
The coordinator's updated [plan](query-migration-plan.md) governs approval:
temporary growth is permitted; reduction is assessed over the **completed**
migration, not Project alone.

## Verdict and counting contract

**REVISE the reduction forecast, not the capability contract.** There is an
evidence-backed deletion opportunity, but not yet a defensible net-negative
forecast: the bounded model is **−159 to +281 runtime lines**. The lower end is
a falsifiable hypothesis, not a promised target; the interval's midpoint is
**+61**. A reviewed Project pilot can measure the major uncertainties before
expansion. This budget does not establish that Query cannot simplify the app,
and does not authorize implementation.

The coordinator's independent Git measurement is the denominator:

| Runtime source | Text files | Physical lines |
| --- | ---: | ---: |
| `apps/web/src` | 248 | 50,675 |
| `apps/api/src` | 126 | 33,374 |
| `packages/shared/src` | 9 | 4,405 |
| **Total** | **383** | **88,454** |

Use the same exclusion regex
`/(\.(test|spec)\.[^/]+$|\/(?:__tests__|__mocks__|test|tests)\/)/`;
exclude binary blobs. Count physical lines, including blanks/comments. This
denominator is **not removable LOC**. No API/shared runtime reduction is booked.
Do not move implementation outside these directories to improve the result.
The final acceptance number is the actual baseline-to-final runtime diff.

Below, **D** is identified baseline code removed/replaced; **A** is its
replacement plus incremental integration code. **Net = A − D**. Equivalent
call-site substitutions outside the enumerated blocks are budgeted at zero
net; additional call-site complexity is charged in A. Thus D is a measured
source-block ledger, not a prediction of every literal Git deleted line.
The final diff will also contain neutral rewrites on both sides. Never subtract
D again from a stage's already-net delta, or add this ledger to the older
Project-only net estimate.

## 1. Ownership transition, across the complete app

Read `AGENTS.md`, the normative architecture rules, workflow, relevant
architecture sections (read authority, retention/outline, WorkItem projection),
the contract-first guide, [restart context](reimplementation-context.md), and
the current [Project map](query-migration-step-1.md). The abandoned Query branch
is counterexample evidence only, not a source to port.

Source search found **48 `useAsync` invocations in 38 runtime files**. Replacing
only Project or Task does not permit deleting that executor. The following is
a resource/ownership closure, not another inventory of UI journeys:

| Milestone | Query-owned response families and affected boundaries |
| --- | --- |
| Project | List/detail reads and imperative prerequisite/conflict reads in the Step 1 map; Project-bearing agenda, discussion, week, Review and inventory results; destination pickers, conversion, batch task entry and cleanup targets. Migrate each actual aggregate result, not a project extracted into a second store. |
| Task | Task detail/workflow, Inbox, Waiting, task search (including Share/Review/All and dependency candidates), recurrence history, and Project-outline task values. Task conversion and outline moves relinquish their local server-value overrides. Aggregates already migrated stay single-owned. |
| Remaining reads | Goals/interventions, observation history/evidence and request-qualified coach polling; Refinement owner/task projections; intake/cleanup job results; activity/digest/contribution/counts; reflection; members/auth bootstrap/timezone; tags, HA/Paperless status, MCP/debug/AI context, push server config/preferences, Paperless document search. |
| Final cleanup | Last legacy fetch executor and version subscribers leave; SSE/reconnect/focus/visibility/online/timed refresh invalidate Query directly. Remove temporary dual invalidation, not the underlying transport. |

Representative non-`useAsync` owners are `identity.tsx:118-171`,
`householdTimezone.tsx:30-54`, `RecentActivity.tsx:29-83`,
`ActivityPage.tsx:36-74`, `ReflectionStartPage.tsx:19-64`,
`PushNotificationSettings.tsx:40-100`, `TaskPlanningSheet.tsx:563-581`,
and `MarkdownAttachmentSheet.tsx:88-102`. Intake duplicates its fetched record
at `IntakeReviewPage.tsx:195,340,391` and after writes/recovery.
Coach reads remain request-qualified (`useGoalActions.ts:96-105,185+`);
poll cadence and authored proposal drafts are not obsolete ownership.
Uncredited smaller removals in these paths are not necessary to make the
arithmetic negative.

### One cache, distinct contracts

- Mount the real Query provider above consumers, including bootstrap; do not
  infer production correctness from `test/testUtils.tsx`. The actual tree is
  `App.tsx:55-65,140-166`; `main.tsx` supplies StrictMode.
- Keys distinguish effective authenticated viewer/request actor, session
  lifetime, resource/response shape and all request parameters: IDs, filters,
  member/scope, dates/ranges, pagination cursor, coach request ID. Bootstrap
  auth identity is not inferred from a selected member. Keep login/logout,
  authentication-required handling, actor-storage synchronization and request
  actor installation (`identity.tsx:173-260`, `api.ts:89,181`).
  Cancel/remove obsolete private cache work on identity transitions; A→B→A
  must not let an old A response publish into a later A lifetime.
- Central revision-aware publication operates on **Query entries**, not an
  entity map beside Query. Existing response trees remain endpoint projections;
  no normalized client domain graph or generic command engine. Query's default
  arrival order alone is not revision reconciliation.
- Metadata acknowledgements (`ProjectWithActions`) may confirm their actual
  fields, not fabricate `ProjectDetail` children/read permission. List, detail,
  search, agenda and Refinement shapes remain distinct. Equal-revision fresh
  detail/aggregate reads can change derived graph facts and membership.
- Canonical actions retain expected revisions, lifecycle/preview/commit/replay
  semantics, localization and each command's own error feedback. `useMutation`
  does not by itself prohibit a duplicate in-flight item command.
- Optimistic changes live in Query; rollback is qualified to the mutation and
  affected fields/entries, never blind restoration of a whole previous cache
  over a newer read/write. Cancellation/lost responses do not prove rollback
  on the server. Read invalidation/recovery must settle that ambiguity.
- UI holds contain placement/interaction identity, not current DTO authority.
  Prove how held IDs obtain cache-owned display values after membership changes
  without resurrecting denied/deleted/converted content. Do not solve this with
  a second retained DTO store. This is a material pilot uncertainty.

## 2. Measured removal ledger

Paths below are relative to `apps/web/src`; inclusive line spans refer to the
source baseline, not future rebased line numbers. Counts were checked by
inclusive-range arithmetic. These are **gross replacements**, not free savings:
required behavior inside removed blocks is charged again in section 4.

### P — Project owners: 112 lines

| Source blocks | D | What disappears |
| --- | ---: | --- |
| `lib/useProjectActions.tsx:14-17,53-60,267,316-324` | 22 | Retained DTO type/member, value projector and per-caller confirmed-revision release scan. Keep the action-label concept as UI data. |
| `pages/ProjectDetailPage.tsx:93-94,131-143,219` | 16 | Local confirmed metadata DTO and precedence reconciliation. |
| `components/ProjectWorkflowHost.tsx:130-131` | 2 | Retained project fallback. **Not** the opening/accepted-read witnesses. |
| `components/MoveProjectSheet.tsx:16-17,19,21,24-44` | 25 | Source/catalog/destination fetch state and runners. Selection, submit error and activation decisions remain. |
| `components/MoveTaskSheet.tsx:35-37,40-41,49-70` | 27 | Project catalog/detail-derived values and local load runner. Keep selected destination and separate submit feedback. |
| `components/ProjectTaskEntrySheet.tsx:43-44,54-66,84-85` | 17 | Copied project/steps plus post-read/post-write DTO reconciliation. Query owns both Project metadata and returned tasks. |
| `components/ProjectConvertToTaskSheet.tsx:31,43,87` | 3 | Second fresh-detail owner. Keep three-way authored-text conflict reconciliation. |

P becomes removable only with the full Project boundary, including aggregate
readers and cross-resource writes. Merely wrapping `useAsync` in Query or leaving
`projectStory` backed by a retained map does not meet the deletion obligation.

### T — Task value overlays: 44 lines

| Source blocks | D | What disappears |
| --- | ---: | --- |
| `lib/useTaskActions.tsx:56,563,614-617` | 6 | Confirmed-value projection/export/release scan. The adjacent `observeTasks` call remains. |
| `lib/taskHelpers.ts:137-142`; `components/TaskWorkflowHost.tsx:74-75` | 8 | Retained-value selector and fetched-or-retained fallback. |
| `components/TaskConvertToProjectSheet.tsx:33,42-44,48-52,124` | 10 | Local current-task owner and refresh synchronization; authored conversion choices remain. |
| `lib/useOutlineOrganize.tsx:118-122,131-139,238-242,267` | 20 | Local optimistic/accepted task-tree override and snapshot rollback assignment. Query must replace the behavior, not remove outline optimism. |

### R — Other fetched-value owners: 241 lines

| Source blocks | D | Required replacement boundary |
| --- | ---: | --- |
| `components/RefinementTools.tsx:44-53`; `lib/useRefinementActions.ts:127` | 11 | DTO overlay union becomes cache value plus UI-only matrix placement. |
| `pages/IntakeReviewPage.tsx:195,340,391,466,524,588,611,633` | 8 | Record storage/publications become cache publications. Keep draft/revision/conflict/debounce witnesses; adapted callers still have a cost. |
| `pages/ActivityPage.tsx:36-41,43-74` | 38 | Query-owned paginated events, cursor, status and obsolete-request handling. Keep filters and load-more/error affordances. |
| `components/RecentActivity.tsx:29,31-37,40-83` | 52 | Lazy query execution/version tracking. Preserve disclosure, load-on-open and invalidation while closed. |
| `pages/ReflectionStartPage.tsx:19-23,26,37-64` | 34 | Briefing fetch state/runner. **Re-express**, do not delete, selection-qualified private export consent and acceptance checks. |
| `lib/identity.tsx:118-120,122-124,130-171` | 48 | Members/auth fetch state/runners. Bootstrap gating, unauthenticated clearing and fallback/error semantics must survive. |
| `lib/householdTimezone.tsx:30-54` | 25 | Fetched timezone/load state; preserve disabled/loading/default behavior and consumer context. |
| `components/PushNotificationSettings.tsx:40-42,57-58,81-100` | 25 | Server config/preferences storage/read effect. Browser permission/service worker/subscription state remains local. |

### Shared final deletions: 402 lines

| Source blocks | D | Legal deletion point |
| --- | ---: | --- |
| `lib/useRetainedMutations.ts:1-193` | 193 | **After all four consumers migrate**: Project, Task, Goal and Refinement. Goal uses `<never>` (`useGoalActions.ts:35-38`): it contributes no removable DTO store, but still depends on pending/errors/in-flight handling. Timers/leases/holding IDs elsewhere must have a real replacement first. |
| `lib/useAsync.ts:1-204` | 204 | Last of the 48 call sites and any associated types/imports gone; accepted-read/error behavior proven on Query. |
| `lib/refresh.tsx:37,50,58,152-153` | 5 | Last version subscribers leave, including `RecentActivity` and intake polling (`IntakeReviewPage.tsx:150,439-443`). Replace provider wiring as needed; do not count the rest of the 172-line file. |
| **P + T + R + shared** | **799** | Each baseline line credited once. |

The whole retained hook is gross replacement, not 193 lines of redundant
server-state logic. Nor are these whole-file anchors deletion allowances:
`useProjectActions` **327**, `useTaskActions` **620**, `refresh` **172**,
`useRetainedPlacement` **15**. The latter four total **1,134** lines;
only **33** Project-action, Task-action and refresh lines from them are booked
above. `useRetainedPlacement` receives **zero** whole-file deletion credit.

## 3. Retained behavior: no savings booked

- Project action calls/status prediction/revision-safe update, append,
  scheduling, review and lifecycle controls remain canonical
  (`useProjectActions.tsx:69-258`). Task commands, child policies, recurrence,
  external waits and task mutation transport remain; no wholesale 620-line cut.
- Task interaction/ancestry registry
  (`useTaskActions.tsx:63-114,123-128`) is **UI lifetime**, not obsolete
  confirmed state. Keep observation, inherited leases, original placement paths
  and eventual release, even when Query owns values.
- `useRetainedMutations.ts:24-25,28,39-46,62-100` contains real hold/timer/lease
  behavior; `:22,27,29,102-109,122-133,159-174` contains required feedback and
  concurrency behavior. Removing the file requires paying to preserve these
  responsibilities. Query mutation status is not a complete substitute.
- Preserve `useRetainedPlacement`, `retainedPlacement`, interaction primitives
  and row/tree/bucket semantics. Current stored row snapshots must not remain
  a parallel **value authority**. ID-only adaptation and display lookup costs
  are charged below, not assumed free.
- Keep geometry/projection helpers and drag/keyboard/focus/stale-row guards in
  `useOutlineOrganize`; only the value override is budgeted out. Keep
  `TaskSplitSheet.tsx:62-65` revision/status command snapshots: they are not a
  full Project DTO cache.
- Keep authored drafts, merge baselines, creation intent/retry identity,
  compound prompts and read/opening witnesses. In particular,
  `ProjectWorkflowHost.tsx:43-128` implements permission/read acceptance:
  no bulk deletion credit. Preserve same-batch revocation and accepted-200
  followed by queued-503 versus queued-403 behavior.
- `refresh.tsx:62-150,162-172` retains external coalescing, authenticated SSE,
  own-client filtering, reconnect polling, visibility/focus/online and timed
  eligibility. Avoid competing default Query focus/reconnect behavior.
  Identity-gated SSE and HashRouter/relative assets/absolute `/api` stay.
- Backend visibility, lifecycle, graph derivation, no-write previews,
  transactions and revision/error contracts do not migrate into the browser.

## 4. Replacement budget, counted once

Estimates are conservative planning envelopes, not library-proven minima or
guaranteed bounds. They count retained semantics rewritten as well as genuinely
new setup. Equivalent existing call lines are neutral; integration overhead
and replacements of the measured ledger are included here.

| A bucket | Estimated runtime lines | Exclusive responsibility |
| --- | ---: | --- |
| A1 real provider and lifetime | 70–110 | QueryClient defaults, production mounting, bootstrap/session/actor boundaries and cleanup. No response DTO store. |
| A2 resource keys/read definitions | 90–150 | **All** resource shapes/parameters above; split Project 20–40, Task 30–45, remaining 40–65. Existing transport remains. |
| A3 central cache publication | 120–200 | Revision/shape-aware acceptance, metadata/full distinction, affected projection invalidation, qualified optimistic rollback and fresh-read integration. Project 70–120, Task 35–50, remaining 15–30. No second entity store or recovery framework. |
| A4 action feedback/concurrency | 70–110 | Shared mutation pending/errors, duplicate-in-flight guard, stale recovery and canonical-action wiring. Project 50–80, Task 10–15, Goal/Refinement 10–15. Does not include command bodies retained above. |
| A5 UI-only retention adaptation | 110–160 | Hold timers/leases/action labels, ID placement and cache-value lookup; Project 80–120, Task 20–25, Refinement 10–15. Existing ancestry/geometry remains uncredited. |
| A6 Project caller overhead | 40–90 | Reader/aggregate/imperative-read and batch/compound integration beyond neutral substitutions; excludes A1–A5. |
| A7 Task caller overhead | 40–90 | Task/outline/search/recurrence/compound integration beyond neutral substitutions; excludes A1–A5 and already migrated aggregate wiring. |
| A8 remaining caller replacements | 90–150 | Bootstrap, paginated/lazy activity, jobs/coach, settings/search and other R-owner replacements/adapters beyond A1–A5. Preserve independent error/read/polling behavior. |
| A9 refresh integration | 10–20 | Temporary dual invalidation 5–10, then final direct Query wiring 5–10. Existing transport retained, counter removed last. |
| **A total** | **640–1,080** | No bucket is reused as another phase's setup. |
| **D total** | **799** | Measured source blocks, not all affected files. |
| **Completed net A − D** | **−159 to +281** | Hypothesis crosses zero; reduction is not established. |

### Staged totals

All deltas below are **net**, with gross A/D shown to avoid double counting.
Bootstrap Query setup is included at the start, not hidden in a later tranche.

| Stage | A | D | Net stage delta | Cumulative delta |
| --- | ---: | ---: | ---: | ---: |
| Initial shared setup within Project pilot | 295–480 | 0 | +295 to +480 | +295 to +480 |
| Complete Project callers/owners | 40–90 | P 112 | −72 to −22 | **+223 to +458** |
| Tasks/outline ownership | 135–225 | T 44 | +91 to +181 | +314 to +639 |
| Remaining readers, Goal/Refinement; final retained-hook removal | 165–275 | R 241 + hook 193 | −269 to −159 | +45 to +480 |
| Last executor and version-counter cleanup | 5–10 | 204 + 5 | −204 to −199 | **−159 to +281** |

Tasks alone cannot remove `useRetainedMutations`: its two other consumers must
leave first. Executor deletion is deliberately credited only at final closure,
even if its final consumer happens to migrate earlier in that stage.
Temporary bridge removal is included in A9's final wiring allowance; no
additional baseline deletion credit is invented for new temporary code.

### Sensitivity and decision

Break-even requires **A < 799**; a meaningful −100-line margin requires
**A ≤ 699**. That is close to the estimated 640-line lower bound. Relative to
that lower-bound scenario, +160 replacement lines already removes the negative
result. Provider/lifetime, central publication and UI-only retention together
are **300–470** lines before keys, feedback and callers. These are concrete
uncertainties, not reasons to delete behavior.

The earlier Project-only **+50 to +360** remains a preliminary warning, not a
ceiling or evidence of whole-app impossibility. This pass budgets a more explicit
**+223 to +458** pilot, including shared setup and paid UI-only replacement.
If actual shared code approaches the high estimates, later deletion of the
known 799 lines is insufficient. Additional measured removals may improve the
case, but none are pre-credited; do not rescue the forecast with all TaskActions,
SSE, placement or unexamined UI code.

**Conclusion:** a small reduction is arithmetically plausible, but the
whole-program net-negative hypothesis has insufficient margin to be called
credible as a delivery forecast today. Review can authorize a bounded
measurement pilot, not promise reduction from this analysis. Reforecast once
the shared implementation/probes have real measurements; stop expansion if no
supported negative end-state remains.

### Non-runtime costs, separate

| Category | Planning allowance / accounting |
| --- | --- |
| Tests | Approximately +400–900 net lines across the completed migration; adapt existing regressions, add a few installed-library/cache/real-mount cases, remove obsolete hook-only tests only after their behavioral replacement exists. This is an estimate, not scope approval. |
| Documentation | Approximately +40–100 net normative architecture/registry lines, plus these design artifacts reported separately at actual size. No runtime “saving” from moving explanations here. |
| Manifests | Query dependency plus required root/web patch-version metadata; exact selected version only after authorization. No installation in this pass. |
| Lockfile | Unknown until approved resolution; report actual diff, not an invented estimate or part of runtime LOC. |

## 5. Bounded Project pilot assignment — review before execution

**Candidate assignment, frozen for coordinator review.** Work from merged main
plus approved design docs, not the abandoned Query branch. Stop after one
complete Project resource migration and its evidence. Other resources migrate
later; no generic migration platform.

### Boundary and canonical writes

Own Query setup and the P owners above; replace Project list/detail fetching
in Projects/ProjectDetail, Capture/Share, All/Review, both workflow/compound
hosts as applicable, move destination reads, conversion, task entry/split
prerequisites and cleanup. Query also owns whole Project-containing
agenda/discussion/week/Review/inventory responses where used; do not retain
their Project values in legacy fetch state. For mixed task/project cleanup
reads, migrate the Project branch without inventing a mixed DTO bridge.
Task-only queries may remain on the old executor.

Use existing `useProjectActions`, pure `taskMutations`/`useTaskActions`,
`useOutlineOrganize`/move endpoints, and existing create/delete/convert/batch,
Share, refinement-apply and successor commands. Integrate their existing
success/stale refresh boundary so **every** task/project write that changes
Project detail or aggregate membership invalidates Query, including equal
Project revision. Do not add a competing raw write path to make integration
easy. Broad invalidation of the current viewer's affected projections is
acceptable before proven narrower selectors; no client graph reconstruction.

### Probes required first, against the actual installed library

After authorization, select/install the intended Query version and write/run
only the following small behavior probes before production migration:

1. Held GET r4, confirmed metadata r5, then old success and cancellation;
   confirm publication/revert behavior, and separately accept equal-r detail
   with changed derived children. Observe **cache values**, not only promises.
2. Denied detail followed by retry/cache hit, deduplicated imperative fetch and
   last-observer cancellation with a consumed signal. Establish what proves a
   new accepted GET; a resolved promise must not certify permission.
3. Invalidation while reading: accepted 200 then queued 503 versus 403;
   accepted-read witnessing must precede queued-read completion and React
   rendering. Check StrictMode observer mount/unmount.
4. Optimistic mutation, newer read/write, then failure; rollback must not undo
   newer values. Identity A→B→A with old success/error must not publish.

Use the results to choose the smallest integration. Do not port disproved
historical cancellation workarounds. If these contracts need a second store,
permanent cache, generic recovery runner or pervasive epochs at every caller,
**stop and return the evidence** rather than build that framework.

### Deletion and acceptance obligations

- Remove all P server-value owners and Project `useAsync` invocations in the
  agreed closure. Remove retained Project DTO storage, overlay projector and
  per-view catch-up scans. Query-under-old-stores is a failed pilot.
- Keep the shared executor/retained hook for genuinely unmigrated consumers;
  temporary dual invalidation has no Project DTO ownership. Keep UI-only
  hold IDs, leases, action badges and original placement behavior.
- Older reads never roll back newer confirmations; full equal-r reads own
  current children/readiness/counts. Metadata writes do not authorize detail,
  and previews never become confirmed detail.
- Viewer/session/opening replacement isolates success, error and command
  completion. GET 403/404 removes protected DOM/attributes/control values;
  harmless failures retain usable content. Failed/cached/canceled retries do
  not clear denial. Only an accepted qualified fresh GET restores authority.
- Preserve Activation same-batch authority revocation and queued-read
  acceptance. Older/equal command errors cannot overwrite a newer accepted
  GET's requirements; strictly newer errors may update them. Keep each
  command's own feedback and fresh-read choice normalization.
- Save/refresh/interaction orders preserve current values, unique rows,
  authoritative membership and eventual placement release. Role conversion
  with the same ID cannot be undone by an older Project response.
- Retain authored text/decisions/creation identity and GET-only retries.
  Compact revision snapshots are command witnesses, not duplicate DTO stores.
  Preserve real app providers, auth gating and HashRouter contracts.

Adapt existing `ProjectDetailPage.test.tsx`,
`ProjectActivationSheet.recovery.test.tsx`, `MoveProjectSheet.test.tsx`,
`MoveTaskSheet.test.tsx`, `ProjectTaskEntrySheet.test.tsx`,
`TaskSplitSheet.test.tsx`, and the ordering pattern in
`lib/useTaskActions.sequences.test.tsx`. Preserve refresh transport tests;
port relevant behavior from `useAsync.test.tsx`, not its runner implementation.
Use `tests/contracts/activation.test.ts` and
`apps/api/tests/activation-preview.permissions.test.ts` when response/error/
preview shape matters. Do not import the abandoned test suite wholesale.
Add real production-mount/identity evidence; provider-rich fixtures are not
proof of SSE/auth lifecycle or browser privacy/focus.

**Excluded:** full Task/Goal/Refinement/bootstrap migration, backend/schema/domain
policy changes, editor redesign, new features, unrelated recovery repairs,
normalizing a client domain graph, or deleting UI interaction ancestry/SSE.
Bootstrap is touched only as necessary to install the real provider and safe
identity lifetime; its fetched ownership moves in the later stage.

**Expected temporary runtime growth:** +223–458 against the baseline, including
shared setup. Record actual A/D and test/docs/manifest/lockfile costs separately.
Require focused behavioral evidence, `bash scripts/verify.sh`, and
`npm run build && npm run test:e2e` for desktop/mobile Chromium before calling
the pilot verified. No tests were run for this design-only artifact.

**Stop condition:** freeze the pilot after those gates and reconcile the
whole-program forecast before any next resource. Stop earlier for a missing
capability/read-identity invariant, a few focused failed attempts, growth above
the revised envelope, a second DTO/recovery framework, or measured remaining
costs that eliminate a defensible negative end-state. Return evidence and
uncertainty; do not broaden scope, weaken privacy/placement, or declare the
hybrid architecture complete. Approval, implementation, review and publication
remain the coordinator's responsibility.

## 6. Coordinator decision: measure feasibility before rollout

The user approved proceeding step by step, with temporary setup growth and an
end-state reduction requirement. This budget completes the first step, but
does **not** justify claiming that the completed migration will be smaller.
The Project forecast has become +223 to +458 as retained behavior is priced
explicitly; the original +50 to +360 was preliminary, not a silently expandable
cap or an achieved result.

Proceed first with the installed-library probes described above, not a broad
reader migration. Select the dependency, use a temporary probe harness, and
record actual stock behavior and the smallest necessary integration. Include
the unresolved held-row value lookup: IDs/leases must obtain current values
from Query without recreating a retained DTO map or normalizing a client graph.
Keep experiment code separate from production behavior and distinguish a
library-level result from proof of the real app's identity/provider wiring.

Freeze that handoff before production migration. Review whether the required
publication, accepted-read, invalidation and placement integration fits the
budget and still leaves a supported negative end-state. Then either commission
the bounded Project pilot or report the concrete failed assumption. Do not
silently turn an uncertain forecast into a reduction promise, ship Query
underneath the old owners, or expand to Tasks before the Project evidence is
reviewed.

### Installed-library handoff accepted for the bounded Project pilot

Luna's temporary probes on Query **5.107.1** established response-aware
publication, raw fetch-success callbacks distinct from manual/cache results,
conditional rollback, and a native MutationCache held-value candidate. Stock
invalidation did **not** schedule a trailing read during initial loading.
An **11-line** native per-Query join/refetch adapter passed the selected
counterexamples: shared trailing work, independent fast/slow readers, no extra
idle fetch, queued 503 versus 403, and removal/replacement identity.

The temporary harness passed ten cases and web typechecking; it is not
production, API-contract or browser evidence. Actual actor/provider wiring,
all response shapes, offline behavior, UI holds/GC and denied/converted-value
retirement still require the Project implementation and its acceptance matrix.

Authorize that bounded Project pilot, not expansion to Tasks or a promise of
end-state reduction. Count all setup in its diff, aim near the low end of the
forecast, and freeze for reforecast/review at the milestone. Stop for another
DTO/cache/recovery framework, capability loss, growth beyond the forecast
envelope, or loss of a supported negative end-state. Preserve the probe
observations, but do not ship a large temporary test harness in place of
focused production regressions.

## 7. Frozen Project outcome: BLOCKED

The bounded correction pass is frozen, not accepted or shipped. The coordinator
independently measured **+1,127/-430 runtime lines, net +697**, versus
`2e923f239e69fef583074b189bdd2abab013c4bd`, including both untracked runtime
modules and excluding tests/support with the original counting rule.
This exceeds the Project envelope and is not rescued by counting only tracked
files or comparing against an intermediate commit.

| Reforecast | Runtime lines |
| --- | ---: |
| Measured Project pilot, including shared setup | +697 |
| Remaining estimated additions/replacements | +305 to +510 |
| Remaining ledger removals | -687 |
| **Projected completed migration** | **+315 to +520** |

No evidence-backed additional removal set closes that gap. Do not continue to
Tasks on the assertion that later deletions will pay for it. Moving UI/graph
behavior outside the measurement, dropping capabilities, or extending another
custom cache/recovery framework is not an acceptable correction.

### Correctness evidence is also incomplete

Luna reported a passing focused 11-file run (206 cases), followed by 37 Today
cases with a valid mock. Those runs do not establish the full contract.
Coordinator counterexamples against the actual `publishProjectToQueries`
implementation reproduce two defects introduced by this pilot:

- Publish an optimistic metadata revision 5 over confirmed revision 4, then
  invoke its rollback without an intervening read. The cache remains at
  revision 5 with optimistic content: the sharing policy rejects the rollback
  as an older revision.
- Publish a child project's confirmed metadata while it appears in a cached
  parent detail's `childStories`. The child remains at its old revision:
  encountering the parent Project record stops traversal before its children.

The observations are production-helper counterexamples using existing typed
fixtures, not end-to-end API/browser proof. A plain cache revision check and a
rollback-only-after-newer-read case missed the first failure dimension; a
root/list-only publication case missed the second. Preserve both in any
successor design's independent matrix. These are pilot defects, not evidence
that merged main has the same defects.

Reproduction and logs are preserved in this session's `files/` directory:
`query-project-counterexamples.mts`,
`query-project-publication-counterexamples.log`,
`query-project-focused-correction.log`, and
`query-project-frozen-verify.log`. The standalone reproduction runs from the
pilot worktree under Node 22:

```bash
node_modules/.bin/tsx ../query-project-counterexamples.mts
```

Its expected result on the frozen implementation is a failed assertion showing
revision 5 instead of rollback revision 4, and child revision 4 instead of 5.
Real actor/session wiring, denial/conversion during held leases, offline
behavior and desktop/mobile browser behavior remain unverified.

The required `bash scripts/verify.sh` was run once on this frozen experimental
tree under Node 22. Architecture, shared build, all typechecks and the API suite
passed. The web suite failed: **64 failures across six files**, with 1,753
passing cases. Production app builds and Python checks were not reached after
that failure; browser/e2e checks were not run. The failures have not all been
classified as production defects versus missing fixture prerequisites.
Regardless, neither the passing focused subset nor these existing tests
supersedes the two independently reproduced production-helper defects.

### Stop, preserve, do not silently change the goal

No Task migration or production publication is authorized by this outcome.
Keep the experimental application work separate from the documentation branch;
main remains unchanged. Resume only with a materially different, evidence-backed
design/budget or an explicitly changed goal, not another patch loop on this
forecast. A future design must distinguish confirmed server values from pending
optimistic projections before choosing a revision floor and must traverse
arbitrary-depth representations without turning into a client domain graph.
This result rejects this implementation and forecast; it does not prove that
every possible TanStack Query migration must grow the application.
