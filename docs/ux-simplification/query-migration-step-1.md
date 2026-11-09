# TanStack Query migration — Step 1 map

**Baseline:** `2e923f239e69fef583074b189bdd2abab013c4bd` (merged main,
2026-11-09). **Scope:** source-based design only. No application edits,
dependency changes, runtime experiments, tests, or browser checks were done.
TanStack Query is not present in this baseline.

## Verdict: REVISE before commissioning implementation

Project is not a closed slice if defined as only `GET /projects` and
`GET /projects/:id`: project DTOs also arrive inside agenda/discussion views,
their display is shared across several screens, and task mutations change
project-detail children and derived project facts without necessarily changing
the project revision. A bounded slice is possible only if those representations
and their canonical writers participate in one Query-owned server-state plan.

The shared `useAsync`, refresh/SSE transport, `useRetainedMutations`, task
actions, authored decisions, and placement leases cannot be removed in this
phase. The measured source inventory and preliminary estimate below do not
support a promise of net runtime LOC reduction. Do not start phase 2 until the
deletion budget is revised with evidence, or the user explicitly approves
changing the per-milestone reduction gate to a bounded setup cost and a later
whole-app reduction gate. The coordinator must not waive the approved LOC gate
silently. Do not create a DTO bridge or second retained project store to force
a negative number.

## 1. Smallest closed Project-resource boundary

`api.ts:758-759` defines distinct list (`ProjectWithActions[]`) and detail
(`ProjectDetail`) responses. Detail includes task children, child projects and
derived workflow facts; list responses are not a substitute for it. Current
read paths and actual consumers:

| Read/projection | Current path and callers | Boundary implication |
|---|---|---|
| Project list | `ProjectsPage.tsx:58`, `AllPage.tsx:41`, `ReviewPage.tsx:83`, `SharePage.tsx:258`; `CaptureForm.tsx:125`; `MoveProjectSheet.tsx:25-31`; `MoveTaskSheet.tsx:52` | Migrate as list data wherever the picker, inventory, Review lookup, creation destination or share/import flow consumes it. Keep each consumer's filters, selection and authored intent local. |
| Project detail | `ProjectDetailPage.tsx:124`; `ProjectWorkflowHost.tsx:71-127`; `ProjectConvertToTaskSheet.tsx:41,86`; `ProjectTaskEntrySheet.tsx:52,63`; `MoveProjectSheet.tsx:25,40,67`; `MoveTaskSheet.tsx:55`; `TaskSplitSheet.tsx:71,108`; `CleanupRoundActionSheet.tsx:49`; `CleanupRoundPage.tsx:260`; `projectActivationResolution.ts:97` | This is not just the detail route. Stale recovery, destination validation, current revisions and hierarchy/activation snapshots need authoritative reads. Preserve a genuinely fresh GET where the command/permission contract requires one; a cached Query result is not sufficient evidence of a fresh read. |
| Agenda/discussion representations | `TodayPage.tsx:59-63` reads agenda project entries; `DiscussionPage.tsx:17-22` consumes embedded projects; `WeekPage.tsx:365` reads a separate `WeekAgenda`; `SharePage.tsx:263` also reads an agenda | These endpoint results are distinct projections, not aliases for project detail. Audit their actual project fields and invalidate them when project or task changes affect their membership/order/derived facts. Do not pretend a list/detail key refreshes them. |
| Inventory and Review representations | `AllPage.tsx:41-74` combines projects and task search; `ReviewPage.tsx:77-106,339` combines Review items, projects and tasks; project rows are rendered by `ProjectStoryRow` in Projects, All, Discussion and ProjectDetail child stories | Query must own the complete result each affected view actually reads. Keep server-derived membership, visibility, grouping inputs and available actions authoritative; temporary placement does not decide whether a project belongs in a view. |
| Project child/task-derived detail | `ProjectDetailPage.tsx:124-148,744-760` feeds the project outline; task mutations in `useTaskActions.tsx` and task creation/move/conversion/batch paths alter that detail | Project detail children, membership, counts, next action/readiness and inherited/effective values can change after task writes even when the project's own revision is equal. Every relevant task writer must invalidate or reconcile project detail and affected project-containing projections. |

### Reads that must remain fresh, not merely cached

The activation/reopen workflow read in `ProjectWorkflowHost.tsx:71-127` is
permission-bearing. On 403/404 it revokes renderable project content while
retaining only the opening and authored choices; an accepted GET is what
restores current requirements/revisions. `projectActivationResolution.ts:82-106`
reloads the decision snapshot after stale conflict. `MoveProjectSheet.tsx:23-41,67`
loads source, destination and choices, then reloads after stale conflict.
`ProjectConvertToTaskSheet.tsx:86-105`, `ProjectTaskEntrySheet.tsx:63-64`,
and `TaskSplitSheet.tsx:99-109` also refresh current state for conflict or
compound-command requirements. `CleanupRoundActionSheet.tsx:42-51` and
`CleanupRoundPage.tsx:260` read the current target for a command.

The implementation must prove which of these use a forced network read, and
which only need a current Query value, from the actual installed library and
the server contract in phase 2. This analysis does not assume library behavior.
Preview paths (`previewProjectSteps`, `previewTaskSteps`, task creation and
conversion previews) are decision/validation inputs, not committed Project
resource reads and must not silently become accepted resource data. Commit
paths remain the existing canonical endpoints.

## 2. State ownership: what Query replaces and what survives

| Concern | Current evidence | Target owner / rule |
|---|---|---|
| Fetched and confirmed project values | `useAsync` results; `ProjectDetailPage.tsx:89-92,131-149,205-220` stores `confirmedProject` after a write to protect detail metadata from an older GET; `ProjectWorkflowHost.tsx:130-142` has a retained fallback for non-Activation workflows, while Activation explicitly excludes it | Query cache is the sole fetched/confirmed server-value owner. Remove full-DTO fallbacks/overlays only when every Project-containing reader is on the agreed cache path. A metadata acknowledgement may update only fields/representations the response actually confirms; it is not a full-detail GET and cannot manufacture children, readiness, or read permission. |
| Optimism | `useProjectActions.tsx:53-59` projects `RetainedStory` DTOs over older rows; action methods at `:74-253` call canonical APIs | Keep canonical action semantics and expected revisions. Move server-value optimism/reconciliation into Query-owned entries; do not retain another `Map<id, Project DTO>`. Keep any action-label/confirmation token as small UI state if still needed. |
| Pending/error and concurrency | `useRetainedMutations.ts:19-35,48-103,105-187`; ProjectActions uses it at `useProjectActions.tsx:42` | Keep user-visible pending/error behavior and duplicate-in-flight protection. Narrow or replace Project DTO retention only after the cache path is proven. The hook remains required by `useTaskActions.tsx:54`, `useGoalActions.ts:38` and `useRefinementActions.ts:37`. |
| Row placement/interaction leases | `useProjectActions.tsx:264-265,303-325`; `ProjectStoryRow.tsx:99-108,210`; `useRetainedPlacement.ts:10-13` currently retains row buckets in a ref | Preserve placement and open interaction separately from server values. Existing placement behavior is not redundant, but its stored `T[]` rows are not already an ID-only implementation: identify any necessary adaptation so old row snapshots cannot become current read authority. Do not credit deletion of the shared placement helper. |
| Authored drafts/choices | ProjectDetail title/notes drafts and `contentBaselineRef` (`ProjectDetailPage.tsx:78-92,174-220`); move/activation/conversion/task-entry sheets keep choices locally | Keep explicit Edit/Save/Cancel, compound decisions, prompts, draft conflict handling, focus restoration and opener identity. Query refresh/denial must not discard authored intent or turn it into read authority. |
| Logical opening and read acceptance | `ProjectWorkflowHost.tsx:43-61,71-127,144+` has opening sequence, workflow identity and activation read/authority witness | Keep these UI-lifetime/permission witnesses. They are not redundant DTO storage. A cached object, canceled fetch's resolved promise, failed retry, or mutation response must not be treated as an accepted fresh read. |
| Project task/history facts | API detail and aggregate projections; backend `graph`/`workItem` derivations documented in `architecture.md:1670-1728` | Backend remains authority for children, effective values, blockers, readiness, actionability, and lifecycle legality. No client graph or fabricated detail GET. |

## 3. Replace/delete/keep map

| Current path/symbol (evidence) | Proposed owner | Exact disposition | Affected callers | Phase/dependency |
|---|---|---|---|---|
| `useAsync` Project reads at the list/detail and picker sites above | Query keys/hooks for each actual response shape | Replace only the Project-containing reads in the accepted closed set; preserve loading/error/retry UX and fresh-read semantics. | Projects, All, Review, Share, Capture, move, conversion, task-entry, cleanup and workflow surfaces | Project slice; requires identity scope and query/error contract first. |
| `useProjectActionsState.projectStory`, `RetainedStory`, `retained` (`useProjectActions.tsx:19-59,264`) | Query cache for server DTOs; action controller for canonical commands and minimal UI tokens | Delete DTO overlay/fallback after all readers are migrated. Keep action methods, `ProjectActionsProvider` if still the canonical action host, pending/errors, action feedback and `holdingIds` as justified. | `ProjectStoryRow`, Projects/All/Today/Review/Discussion/Detail/Workflow | After all Project-bearing results can be reconciled in Query. |
| Per-caller release effect (`useProjectActions.tsx:303-325`) | Cache reconciliation plus UI-only hold release | Remove the `authoritativeProjects` scan only after accepted Query results reliably reconcile *all* affected keys. Keep hold/lease release independent of cached DTO ownership. | Every `useProjectActions(authoritative)` caller | Depends on complete query inventory and sequence tests; no early deletion. |
| `ProjectDetailPage.confirmedProject` (`:89-92,131-149,205-220`) | Query cache for confirmed project metadata | Delete this `ProjectWithActions` metadata state and precedence merge; it is not a full `ProjectDetail` acknowledgement. Keep title/notes drafts, edit flags, baseline, save feedback and canonical `update` call. Preserve independently fetched tasks/child stories. | Project detail/outline | Once response-shape-aware cache reconciliation is tested. |
| `ProjectWorkflowHost` fetched read and retained fallback (`:71-142`) | Query detail read for data; local opening/read-acceptance witnesses for authorization | Replace fetch owner and remove retained full-DTO fallback. Keep `openingId`, read witness, denial behavior, fresh retry, drafts in focused sheet and focus restoration. | Every `story.*` workflow hosted here, including Activation, Deadline, Move, Conversion and Completion | Not an “Activation editor” slice; requires the complete Project detail path. |
| Sheet-local read DTOs: MoveProject `source/projects/destination` (`MoveProjectSheet.tsx:16-41`); Convert `freshProject` (`ProjectConvertToTaskSheet.tsx:31-44,86`); TaskEntry `currentProject` (`ProjectTaskEntrySheet.tsx:43-64,84`); MoveTask `projects/projectTasks` (`MoveTaskSheet.tsx:35-61`); Cleanup target (`CleanupRoundActionSheet.tsx:42-51`) | Query-owned list/detail results | Replace duplicate fetched DTO state; retain parent selection, prompt, authored text/steps, selection/search state, errors and commit decisions. Fresh conflict reloads stay explicit. | These focused compound workflows | Same resource boundary; no second DTO store. |
| `TaskSplitSheet.currentProject` (`TaskSplitSheet.tsx:62-109,131-136`) | Query detail for display; local revision snapshot for command | Replace only full fetched DTO use. Keep the compact project/ancestor revision snapshot and submitted decision fingerprint as command witnesses, not as a server-state map. | Task split/convert-parent workflow | Include cross-resource batch writes and stale retry. |
| Canonical project writes (`useProjectActions.tsx:74-253`; `ProjectsPage.tsx:78-95`; `ProjectDetailPage.tsx:225-240`; `MoveProjectSheet.tsx:52-68`; `ProjectConvertToTaskSheet.tsx:72-88`; project task batch endpoints) | Existing action/API/domain paths | Keep; add cache reconciliation/invalidation at the existing boundary. Do not introduce a second mutation API or generic command bus. | All current callers | Cache integration depends on confirmed response shape and expected revisions. |
| Canonical task writes (`useTaskActions.tsx:180-450`; `taskMutations.ts:35-59`; task move/conversion, CaptureForm, TaskSplit and ProjectTaskEntry batch routes) | Existing task actions/commands/API | Keep semantics. Add invalidation/reconciliation for Project detail and every changed Project-containing projection, including equal-project-revision derived facts. | Project outlines, Today/Review/All/Discussion and other project views | Must be in Project slice; task mutation hook itself is not migrated wholesale. |
| Outline moves (`useOutlineOrganize.tsx:253-270`; pure `taskTreeMove.ts:1-15`) | Existing move command and optimistic outline projection | Keep the canonical endpoint, expected revisions and geometry/tree helpers; successful moves and stale recovery must reach Query invalidation. Do not move hierarchy semantics into the cache. | Project/task outlines and their containing views | Cross-resource dependency, not a whole-file deletion opportunity. |
| Refinement apply and successor creation (`WorkRefinementReview.tsx:306`; `InlineSuccessorComposer.tsx:41`) | Existing compound/action paths and shared invalidation | Preserve reviewed atomic apply and successor creation. Their graph changes must invalidate Project-containing results just like ordinary task commands. | Refinement review, successor entry and project outlines | Include in the invalidation inventory; no new parallel mutation path. |
| `useRetainedMutations.ts` | Shared Task and non-Project callers | Keep file and shared Task implementation; delete no whole-file LOC in this milestone. | `useTaskActions` and other consumers | Later resource migrations only. |
| `useAsync.ts` and `refresh.tsx` | Existing non-Project readers plus current authenticated SSE/reconnect/visibility/timed refresh transport | Keep. A narrowly scoped Query invalidation integration may be needed while other `useAsync` resources remain; do not duplicate data ownership or claim refresh/SSE deletion. | Remaining non-Project readers and all current mutation/SSE invalidations | Delete only after final resource migration in later phase. |

Inventorying each writer does not require adding a Query call to each component.
Prefer one integration at the existing canonical mutation/refresh boundary when
it preserves the required freshness and ordering. The existing transport must
still invalidate unmigrated readers, without owning a second Project DTO cache.

## 4. Measured baseline and estimated budget

Measurement definition: physical `wc -l` lines in current worktree source at the
specified baseline; blank lines and comments count; tests, generated output,
docs, manifests and lockfiles do not. This is not a deletable-line count.

| Runtime owner/path set | Measured lines |
|---|---:|
| `useProjectActions.tsx` 327; `useRetainedMutations.ts` 193; `useAsync.ts` 204; `refresh.tsx` 172; `useRetainedPlacement.ts` 15; `ProjectsPage.tsx` 387; `ProjectDetailPage.tsx` 822; `ProjectWorkflowHost.tsx` 294; `App.tsx` 166 | **2,580** |
| Broader 26-file sampled affected footprint, listed by the command below | **7,676** |

These are current source measurements, not comparisons to the abandoned #256
branch. The 7,676-line set includes large files with substantial unrelated UI;
neither total can be treated as a removal opportunity. `useProjectActions.tsx`
is 327 lines but its canonical mutations mostly stay. `useRetainedMutations`,
`useAsync` and `refresh` cannot be deleted while Task/other resource consumers
remain.

Reproduce the 26-file footprint from the repository root:

```bash
wc -l \
  apps/web/src/lib/{useProjectActions.tsx,useRetainedMutations.ts,useAsync.ts,refresh.tsx,useRetainedPlacement.ts,projectActivationResolution.ts,useTaskActions.tsx,taskMutations.ts} \
  apps/web/src/pages/{ProjectsPage,ProjectDetailPage,TodayPage,ReviewPage,AllPage,DiscussionPage,WeekPage,SharePage,CleanupRoundPage}.tsx \
  apps/web/src/components/{ProjectWorkflowHost,MoveProjectSheet,MoveTaskSheet,ProjectConvertToTaskSheet,ProjectTaskEntrySheet,TaskSplitSheet,CaptureForm,CleanupRoundActionSheet}.tsx \
  apps/web/src/App.tsx
```

This is a reproducible sample, not the entire dependency closure; for example,
the additional move/refinement/successor writer boundaries above are not counted
in this subtotal. Do not add the 2,580-line core subtotal to it a second time.

**Estimated phase-2 deltas, mutually exclusive buckets (runtime only):**

| Bucket | Estimated lines | Accounting |
|---|---:|---|
| Query client/provider, viewer-qualified Project key/read helpers, cache reconciliation and refresh/SSE invalidation integration | +100 to +180 | Shared setup counted once; no installed-library behavior is assumed here. |
| Project list/detail/aggregate readers plus response-aware project/task write reconciliation and explicit fresh-read paths | +120 to +260 | Includes cross-resource invalidation, metadata-vs-detail handling and representation-specific readers; excludes generic shared setup above. |
| Remove Project DTO overlays, detail confirmed-DTO fallback and duplicated fetched DTO copies | −80 to −170 | Does **not** count action semantics, drafts, hold IDs/leases, shared hooks, SSE, `useAsync`, or `useRetainedPlacement` as deleted. |
| **Estimated net runtime delta** | **+50 to +360** | Range arithmetic; likely positive until implementation evidence shows otherwise. |

The range is uncertain because query shape, invalidation fan-out, placement
adaptation and response contracts remain design decisions. These are preliminary
planning estimates, not measured replacement code or guaranteed bounds.
Historical Query work in the preserved
reimplementation context added 338 runtime lines in its own snapshot; it is a
warning, not a directly comparable estimate. Do not book a negative delta in
advance.

| Non-runtime | Estimate/status |
|---|---|
| Tests | +200 to +450 lines estimated to adapt focused sequences, cover query/cache identity/freshness and mount prerequisites, and add real-app/browser coverage. Existing large activation/page tests should be extended selectively, not copied wholesale. |
| Documentation | +25 to +60 lines estimated for normative registry/architecture updates after approval; none in this Step 1 artifact changes normative docs. |
| Manifest | One web dependency declaration is likely; package/version location remains unselected because Query is absent and no library probe/install is authorized. |
| Lockfile | Unknown until approved package/version and npm resolution; record actual diff later, not a fabricated line estimate. |

## 5. Observable invariants and counterexample matrix

These contracts precede any implementation choice. Preserve established behavior
and apply the approved resource contract without claiming all current surfaces
already satisfy every invariant. Activation/Detail regressions provide specific
evidence; this source inventory is not runtime verification of all other editors.

1. A response older than a successful write never regresses a confirmed project
   value; a fresh equal-project-revision detail response still replaces child
   membership and derived facts.
2. A metadata acknowledgement is not a detail GET and does not restore content
   after a denied Project read. Denied content, including text/labels/attributes
   and form values, is absent until an accepted qualifying read.
3. Only a genuinely accepted fresh GET can clear a read denial or supply current
   activation/deadline/compound requirements. Cached data, canceled fetches,
   resolved promises without a new GET, failed retries and mutation responses
   cannot impersonate that acceptance.
4. Data publication is qualified by effective request actor/viewer and logical
   opening, not just project ID or revision. Old A responses must not publish
   after A→B→A or replace a new opening's data/error.
5. Accepted read authority is not runner idleness: an accepted 200 remains
   usable when a queued 503 follows; a queued 403 revokes authority. Errors from
   delayed commands preserve their own feedback but cannot overwrite newer
   requirements unless their target revision is strictly newer.
6. Fresh server values normalize decisions: if a new accepted read removes a
   driver requirement, stale driver choices/requirements do not persist or
   regain provenance. Older/equal/newer error-supplied requirements are ordered
   against the accepted read, not arrival alone.
7. Save/refresh/interaction order preserves one visible row, current values and
   authoritative membership; interaction leases protect placement, not stale
   DTOs. Failed optimistic projections must not roll back a newer confirmation;
   cancellation or a lost response does not prove that the server rolled back.
   Preserve authoritative recovery/replay identity. Retained placement is
   eventually released after convergence or expiry/interaction end.
8. Project membership, child tasks/stories, workflow readiness and lifecycle
   actions remain backend-derived; preview is read/decision-only, commit stays
   atomic/revision-checked, and retries retain their existing logical identity.

| Counterexample (not a Cartesian product) | Evidence to reuse/adapt; remaining gap |
|---|---|
| Hold a Project GET, commit newer metadata, then settle the old GET; separately return equal project revision with changed children/counts/readiness | `ProjectDetailPage.test.tsx:231-350` already protects same-revision child membership and fresh child-project/count facts during a hold. Adapt the real Query publication boundary and nested task/child-project representations. |
| Deny detail GET, then acknowledge metadata; failed retry, canceled signal or cached/resolved result follows | `ProjectActivationSheet.recovery.test.tsx:77-182` covers denial/recovery; preserve strict no-stale-DOM assertions. Add metadata-ack, cancellation and cache-hit cases at the real transport/cache boundary. |
| Open viewer/opening A, switch to B, return to A, then settle A's old success/error | `ProjectWorkflowHost.tsx:43-61,144+` provides existing logical-opening witness; no current Query key/cache test establishes actor/opening isolation. |
| Accepted 200 followed by queued 503 versus queued 403 | `ProjectActivationSheet.recovery.test.tsx:472-545`; preserve both outcomes, including current-read acceptance when runner is not idle. Test against the installed library only in approved phase 2. |
| Delayed activation command errors older/equal/newer than accepted GET; fresh read removes driver requirement | `ProjectActivationSheet.recovery.test.tsx:183-435`; same-opening expired errors/success and same-batch denial are at `:586-752+`. Adapt to cache-level ordering and fresh normalization. Keep the command's own error feedback. |
| Save × refresh × interaction start/release; removed/promoted/new project children; network/stale failure and eventual release | Adapt `ProjectDetailPage.test.tsx:231-350` and the established event-sequence pattern in `useTaskActions.sequences.test.tsx`. Add project-specific orders; current task sequence coverage is not proof for Project. |
| Task create/move/complete/convert/batch changes Project detail at equal parent revision; reparent or role-convert a project and retry stale command | Use the real serialized API contracts for the mutation response and detail GET. Include role conversion preserving the item ID while an older Project GET remains pending: that response must not resurrect the former role. Preserve no-write/no-notify preview contracts; broad mocked component fixtures do not establish them. |

Early/read/error/preview/commit/replay exits in scope include Project GET
403/404 and stale reads; command stale conflicts and fresh requirement reloads;
project/task preview responses; project create with its caller-owned creation
intent; canonical metadata/lifecycle/delete/move/conversion commits; and
project/task batch commits. Existing creation retry identity is not part of
Query cache identity and must not be regenerated by a refetch.

## 6. Real mount prerequisites and handoff

The real entry is `main.tsx:1-24` (`StrictMode` → `App`), not the component
fixture. `App.tsx:39-59,140-166` mounts `IdentityProvider`, gated
`IdentityAwareRefreshProvider`/`RefreshProvider` and Project/Task action
providers; `refresh.tsx:20-172` owns authenticated SSE, reconnect polling,
focus/online/visibility invalidations and timed eligibility. API requests read
the actor at `api.ts:89,181` from `identityStorage`; `identity.tsx:121-123,
209-213,243-246` manages identity/actor changes. Query keys/cache lifetime must
follow the effective request actor, and logout, auth transitions, selected
member changes and cross-tab actor changes must not expose another viewer's
cached data.

`test/testUtils.tsx:15-48` mounts convenient providers and a `MemoryRouter`,
but not the production `IdentityAwareRefreshProvider` gating or actual
`HashRouter`/SSE lifecycle. It cannot alone prove the production mount,
identity reset, real focus/layout or desktop/mobile behavior. Future visible
implementation requires the documented browser gate; no runtime/browser claim
is made here.

**Frozen handoff:** the bounded candidate is list + detail + every Project-bearing
aggregate/picker/compound read above, all current canonical Project writes, and
task writes that alter Project detail or its projections. Keep canonical action
paths, local drafts/decisions/opening witnesses, server-derived workflow facts,
and placement leases. Remove only Project DTO duplication after the query path
owns every listed representation. No phase-2 implementation assignment is
justified until a revised boundary/deletion budget passes the agreed gate, or
the user explicitly approves a different milestone cost/acceptance proposal.
Stop if closure requires a second Project DTO owner, fabricated detail reads,
or a generic recovery/cache framework.
