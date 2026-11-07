# Findings and capability baseline

See [the strategy](README.md) and [implementation plan](implementation-plan.md).
Evidence refers to source baseline `53610842`; line numbers may move.

## Evidence conventions

**Source-observed** means the inspected implementation expresses the behavior.
**Inferred impact** means a plausible consequence, not observed user sentiment
or a reproduced browser defect. Existing test references identify inspected
contracts, not sensitivity to a proposed regression. All interaction counts are
source-derived estimates from the named starting point; they exclude network
waiting, scrolling and text length. They are not timing measurements.

## Protected capability inventory

| Workflow family | Existing supported outcomes that must remain reachable |
| --- | --- |
| Global/contextual capture | Immediate title entry, Enter submission, literal text, optional syntax/suggestions, project or Inbox destination, Work defaults, photo/file/crop, optional AI processing, success feedback and Open |
| Guided capture | Optional endless prompts, Back/Next/picker/swipes, literal unassigned household thoughts, card-owned drafts, bounded card history without persisted thought text, retry and explicit Exit protection |
| Share/material | Incoming text/URLs/files, create or append to existing work, local media handling and existing import/calendar-conflict recovery |
| Clarification | Explicit classification, guarded project conversion, independent re-clarification, separate clarification revisit, queue advancement on success and existing commitment preservation |
| Today/Week | Backend-derived execution/attention; distinct owner/shared lanes and calendar windows; distinct plan/deadline/revisit; dated backlog tasks where supported; selected unplanned work; drag and non-gesture planning |
| Waiting | External reason and follow-up history, continue/end wait, independent task prerequisites and context availability |
| Review/cleanup | Derived maintenance, explicit acknowledgement, canonical repairs and return focus; optional owner/effort tools; advisory AI with separate dismissal, acknowledgement and atomic confirmed changes |
| Projects/All/details/outlines | Active/backlog/terminal access, exhaustive ordinary inventory/search, arbitrary depth, breadcrumbs, authored Save/Cancel, direct metadata controls, notes/material, criteria, legal lifecycle and guarded move/conversion/deletion |
| Goals/interventions | Owner journal, manual paths without AI, explicit coach acceptance, private backing work, immutable observation history, evidence-based review and explicit continue/adjust/stop |
| Reflection/activity/discussion | User-triggered factual export with fresh private-work consent, separate digest and chronological activity, nomination independent of lifecycle and acknowledgement |
| More/settings/integrations | Grouped tools, locale/theme/timezone/notifications, identity and household administration, optional HA/Paperless, named revocable fixed-scope MCP access and developer diagnostics |

The canonical interaction spine remains presentation -> `useWorkItemCommands`
-> existing workflow hosts/actions -> transport -> authorized domain mutations.
Backend projections remain authoritative for eligibility, readiness and
diagnosis. Different views are not independent workflow stores.

Evidence: `apps/web/src/App.tsx:78-123`,
`apps/web/src/lib/useWorkItemCommands.ts:181-300,365-580`,
`docs/architecture-rules.md:57-183,224-339,386-569`.

## S01: Week retains the previous query's presentation

**Origin:** AUD-03 / ARCH-06. **Type:** source-observed state defect; runtime
reproduction outstanding. **Impact:** high. **Cost:** medium.

**Before:** Load Week -> change scope, selected member where supported, or
window -> replacement read is slow or fails -> previous cards can remain under
the new controls. The page maintains an agenda independently of its query key.
Failed mutations can restore a captured previous agenda unconditionally.

Evidence:
`apps/web/src/pages/WeekPage.tsx:361-391,394-427,443,517-556`;
`apps/web/src/lib/useAsync.ts:164-176`.
Today offers a narrow identity-qualified precedent:
`apps/web/src/pages/TodayPage.tsx:53-69`.

**After:** Render an optimistic agenda only for its originating query.
Qualify reads, dragged items, writes, errors and rollback, not just cards.
An older failure must also not overwrite a later accepted edit or authoritative
refresh within the same query. Keep the existing canonical commands and
same-query optimism; do not introduce an optimistic-query framework.

**Capability map:** scope/window/member navigation, optimistic drag, rollback,
authoritative membership and detail-based planning remain. No extra controls,
decisions or mutation paths. Inferred benefit is less misleading context and
recovery; no tap reduction is claimed.

**Counterexample:** Drag in Work/window A -> select Household/window B -> B loads
-> A fails. Neither old cards nor A's rollback/error belongs to B. Separately,
test an earlier failed edit after a later accepted edit in A.

Private cards surviving a selection change are a presentation risk, **not
evidence of a server authorization bypass**.

## S02: Revisit drag previews one clock value and commits another

**Origin:** AUD-04 / ARCH-07. **Type:** source-observed projection/commit
disagreement; desired semantics unresolved. **Impact:** high. **Cost:** decision
first, likely medium implementation.

**Before:** Set a non-midnight revisit -> drag its Week card to another date.
The optimistic projection preserves local clock time; canonical task command
execution constructs midnight. Reopening Planning can therefore show a
different value from the preview.

Evidence:
`apps/web/src/pages/WeekPage.tsx:135-149`;
`apps/web/src/lib/useWorkItemCommands.ts:407-448`;
`packages/shared/src/revisit.ts:285-294`.
The existing midnight fixture
`apps/web/src/pages/WeekPage.test.tsx:384-425` does not decide the timed case.

**Proposed direction, blocked:** Decide the existing date-change intent's
clock, precision and DST contract, then align projection and execution.
`apps/web/src/lib/taskAvailability.ts:36-46` already provides
`taskRevisitForLocalDate`, including unchanged-date identity. Prefer that reuse
if clock preservation is confirmed, rather than a new time editor or setting.
Do not silently choose midnight or preservation solely from one fixture.

**Capability map:** one drag remains one drag; ordinary and external-wait task
paths remain canonical. Preserve explicit clearing, stored schedule/deadline,
wait reason/history, and existing story-role command support. Week's task-only
drop guard does not authorize removal of other command callers.

**Counterexamples:** 15:30 ordinary/waiting revisits, unchanged date with seconds,
household timezone, DST gap/overlap, clear and post-refresh persistence.
Invalid local time must reject before transport, never become a silent clear.
Existing move helpers differ on same-date precision, so sharing a name alone
is not sufficient verification.

## S03: Focused workflow requests can have no visible loading/recovery

**Origin:** AUD-02 / INT-01 / ARCH-05. **Type:** source-observed recovery gap.
**Impact:** high. **Cost:** medium.

**Before:** Open a rail and choose Plan/Owner/Structure, or activate a detail
property/shortcut -> host fetches target -> absent usable data means no sheet.
The rail has already closed. Project completion also needs additional detail.
From a closed rail, approximately two activations request the workflow, but no
in-workflow explanation or recovery appears when that read fails.

Evidence:
`apps/web/src/components/TaskWorkflowHost.tsx:68-95`;
`apps/web/src/components/ProjectWorkflowHost.tsx:43-51,104-106`;
`apps/web/src/components/TaskRow.tsx:310-315`;
`apps/web/src/lib/useWorkItemCommands.ts:275-300`.

**After:** The owning host presents existing Loading/Error/Retry/Close
primitives when usable content is absent. A usable retained editor stays
mounted; background read errors must not replace it or erase its draft.
Reuse `apps/web/src/components/AsyncStates.tsx:3-39` and `BottomSheet`, not
another fetching layer or workflow host.

**Capability map:** all existing commands/sheets and successful launch counts
remain. Retry preserves target/command; Close restores opener or safe fallback.
Suspended planner contexts remain suspended with one foreground modal.

**Counterexamples:** slow/deleted/inaccessible target; required completion
detail missing despite a retained project; Close before response; close/reopen;
planner -> prerequisite detail -> workflow; retry after failure. Loading-to-editor
transition must not cause focus bounce or late reopening. Reads write nothing.

## S04: Loaded core lists hide failed background refreshes

**Origin:** AUD-01 / ARCH-05. **Type:** source-observed caller omission.
**Impact:** high across core journeys. **Cost:** medium across resources.

**Before:** Load successfully -> revalidation fails -> retained data remains
but core callers inspect only foreground `error`. Keeping data is intentional;
not explaining its failed refresh is the gap.

Evidence:
`apps/web/src/lib/useAsync.ts:117-137,164-188`;
`apps/web/src/lib/useAsync.test.tsx:117-137`;
`apps/web/src/pages/InboxPage.tsx:32-40,108-110`;
`apps/web/src/pages/WeekPage.tsx:365-368,514-516`;
`apps/web/src/pages/AllPage.tsx:36-76,93-101`;
`apps/web/src/pages/ReviewPage.tsx:72-96`.
Existing nonblocking example:
`apps/web/src/components/ActivityDigest.tsx:284-293`.

**After:** Keep readable data and show an announced, nonblocking refresh error
with the failed resource's Retry. Distinguish initial, empty, mutation and
refresh states. Do not add polling, page-level fetch throttles or blanket reload.

**Capability map:** Today, Inbox, Week, Waiting, Projects, All and Review retain
their views and mutation paths. Review's three resources need independent
recovery. The regression reviewer also identified Discussion as a sibling
omission: include its list read or explicitly defer it, never claim app-wide
parity from the seven-page slice.

**Counterexamples:** one Review resource fails while others succeed; refresh
error alongside mutation error; retry while read pending; successful recovery.
Retry must not acknowledge items, repeat writes or steal focus.
Successful paths add no action; failure gains one displayed retry decision.

Suggested DE/EN meaning:
**"Aktualisierung fehlgeschlagen. Angezeigte Daten sind möglicherweise nicht
aktuell." / "Refresh failed. Displayed data may be out of date."**
Resource-specific wording is required where several queries coexist.

## S05: Labels conflate entry, completion and reconsideration

**Origin:** AUD-06 / INT-06. **Type:** source-observed wording inconsistency;
user misunderstanding inferred. **Impact:** medium. **Cost:** small.

**Before:** Inbox's "Jetzt klären / Clarify now" opens a queue. The same wording
on a flagged task's detail/rail immediately resolves clarification. Separately,
backlog "Plan activation..." copy opens `story.defer` reconsideration, not
activation.

Evidence:
`apps/web/src/pages/InboxPage.tsx:81-88`;
`apps/web/src/components/TaskDetailSheet.tsx:440-442`;
`apps/web/src/lib/workItemRail.ts:28-32,66-69`;
`apps/web/src/lib/useWorkItemCommands.ts:381-389`;
`apps/web/src/i18n/de.ts:923,929,938,944`;
`apps/web/src/i18n/en.ts:985,991,1000,1006`.
Immediate resolution is an existing contract:
`apps/web/src/components/TaskDetailSheet.test.tsx:1950-1970`.

**After:** Distinguish queue entry, explicit resolution, captured classification
and project revisit in visible and accessible text. Suggested meanings:

| Effect | German | English |
| --- | --- | --- |
| Open queue | Eingang klären | Clarify Inbox |
| Resolve flagged organized work | Klärung abschließen | Finish clarification |
| Classify captured action | Als machbar einordnen | Classify as actionable |
| Reconsider project | Wiedervorlage / Projekt erneut ansehen | Revisit / Set when to review this project again |

**Capability map:** same commands and activation counts; no confirmation added.
Clarification resolution preserves existing commitments. Viewing/editing does
not acknowledge; revisit never promises automatic activation.

**Counterexample:** scheduled or waiting re-clarification resolves without
demotion or changed dates; a backlog revisit reaches Review without activation.

## S06: A three-state scope looks like a binary icon toggle

**Origin:** AUD-07 / INT-02 / ARCH-02. **Type:** source-observed semantics;
comprehension benefit inferred. **Impact:** medium across five views.
**Cost:** small presentation change, small-medium optional reuse.

**Before:** Mine -> Household -> Work -> Mine cycles through one icon. Both
non-Mine modes use `aria-pressed=true`; accessible text names the next action
more clearly than the current state. Reaching a target takes one or two
activations.

Evidence:
`apps/web/src/lib/todayScope.ts:3-28`;
`apps/web/src/pages/TodayPage.tsx:190-211`;
`apps/web/src/pages/InboxPage.tsx:58-84`;
`apps/web/src/pages/WeekPage.tsx:483-511`;
`apps/web/src/pages/WaitingPage.tsx:40-65`;
`apps/web/src/pages/ProjectsPage.tsx:219-243`.

**After:** Keep the existing cycle, visibly name the current scope and accurately
name current-plus-next for assistive access. Remove misleading binary pressed
semantics. No extra control or mode. Three chips are deferred: they save at
most one activation but add two header controls and possible wrapping.

**Capability map:** retain cycle order, session-storage key/fallback, per-page
query ownership, selected-member versus actor distinction, Work capture defaults,
guided capture's deliberate return to Household and retention resets.
No global scope provider or backend viewer-policy rewrite.

**Counterexample:** unavailable storage, member switch, remount/navigation,
empty Work view, narrow headers and enlarged DE/EN text. A scope selection
changes neither authentication nor private-reflection consent.

## S07: Backlog search matches remain behind their outer disclosure

**Origin:** AUD-08. **Type:** source-observed navigation inconsistency.
**Impact:** medium for the affected search. **Cost:** small.

**Before:** Search Projects for a backlog item -> expand the generic backlog
section -> open the match. Quiet/terminal matches already auto-reveal.

Evidence:
`apps/web/src/pages/ProjectsPage.tsx:198-201,306-349`;
`apps/web/src/pages/ProjectsPage.test.tsx:130-150,870,985-1005`.

**After:** Reuse search-reveal behavior for matching backlog items. Retain normal
no-search collapse, manual disclosure, grouping and placement retention.
Saves one outer disclosure activation for an ungrouped match, not all nested
group interactions.

**Counterexample:** nonmatch/whitespace query, query clearing after manual
toggle, tag grouping, retained rows and focused interaction. Search must not
introduce a new persisted disclosure mode or collapse an active interaction.

## S08: Discussion differs from established row keyboard behavior

**Origin:** INT-07. **Type:** source-observed parity gap. **Impact:** medium for
shortcut users. **Cost:** small.

**Before:** Standard rows have Tab/button access, but Discussion omits the
shared row-navigation mount; its task section is named Inbox despite containing
nominated tasks across states. This is not total keyboard inaccessibility.

Evidence:
`apps/web/src/pages/DiscussionPage.tsx:1-55`, especially `:48`;
`apps/web/src/lib/useWorkItemKeyboardNav.ts:57-70`;
`apps/web/src/pages/InboxPage.tsx:50-51`.

**After:** Mount `WorkItemKeyboardNavMount` once under the existing interaction
scope and use "Aufgaben / Tasks". Keep ordinary keyboard/touch access and
input/modal shortcut suppression. No new shortcuts or Discussion domain model.

**Counterexample:** mixed project/task list, empty section, collapsed descendants,
nomination removal during retention and shortcuts inside text/modal controls.
Viewing, editing and completing must not clear nomination.

## S09: Status display and activation conventions disagree

**Origin:** INT-03. **Type:** design-convention conflict, not a proven usability
defect. **Impact:** potential medium clarity benefit. **Cost:** small design
investigation; no tap saving claimed.

Current detail badges are buttons and a learned lifecycle entry:
`apps/web/src/components/StatusBadge.tsx:20-32,58-70`;
`apps/web/src/components/TaskDetailSheet.tsx:594-595,708-727`;
`apps/web/src/pages/ProjectDetailPage.tsx:454-460,496-533`.
Existing access is tested:
`apps/web/src/components/TaskDetailSheet.test.tsx:1119`.
Descriptive read-only-badge guidance exists at `docs/architecture.md:1185-1187`;
the user preference also favors read-only status with explicit mobile-friendly
actions, never a status select.

**Disposition:** Preserve lifecycle reachability and its location while resolving
the convention deliberately. The critic rejected automatically replacing the
learned badge with a second control: the estimated two-activation chooser
journey does not become shorter. Conversely, preserving existing behavior is
not permission to ignore the read-only-display preference.

Compare accurately labelled existing action semantics against a read-only
value with an adjacent explicit trigger. Select only after resolving the
constraint and validating touch/keyboard reachability. No status dropdown,
deletion of legal transitions or hidden-only replacement.

**Counterexample:** captured classification, terminal/open transitions,
archived -> backlog restoration, criteria/open descendants, pending/stale errors.
Keep rails and header lifecycle paths until an explicit parity map justifies
any consolidation.

## S10: Proven pure duplication remains around step entry

**Origin:** ARCH-01. **Type:** maintenance simplification.
**Impact:** maintenance, not demonstrated user-effort reduction.
**Cost:** small extraction; medium contract review.

Both `TaskSplitSheet` and `ProjectTaskEntrySheet` already use `StepComposer`
and the shared domain batch operation, but duplicate ancestor/self revision
serialization:
`apps/web/src/components/TaskSplitSheet.tsx:27-32`;
`apps/web/src/components/ProjectTaskEntrySheet.tsx:21-26`.
Activation prompt construction also repeats an existing constructor:
`apps/web/src/lib/projectActivationResolution.ts:100-116,142-157`.

**After candidate:** one narrow React-free revision serializer for these two
consumers; existing prompt-constructor reuse only where boundary meaning stays
identical. Do not create a shared controller, giant sheet or new batch API.
Keep distinct preview triggers, stale-parent recovery, wording, conversion and
navigation. `apps/api/src/domain/taskStepBatch.ts:108-208` remains authoritative.

**Critical counterexample:** absent snapshot differs from a valid empty
requirement set. The constructor maps null to empty requirements, whereas a stale
refresh path preserves the prior prompt if the snapshot is missing. Do not
erase that distinction or applicable authored decisions. Existing sheet stale
paths clearing activation state require separate examination; extraction does
not fix them automatically.

No controls or user steps are removed. Expected responsibility reduction is
two identical serializers -> one and, conditionally, repeated prompt
construction -> existing constructor. Batch response-loss replay safety is
not provided by ordinary task/project creation receipts.

## D01: Capture-to-AI requires repeated authoring, but transfer is undefined

**Origin:** AUD-05 / ARCH-08. **Type:** conditional simplification, not an
established defect. **Impact:** potential medium. **Cost:** unknown.

**Before:** Quick Add -> author thought -> Verarbeiten -> blank Intake text ->
author again -> submit. The original form stays mounted; Cancel already restores
its draft. That retention is solved, not a loss bug.

Evidence:
`apps/web/src/components/QuickAdd.tsx:174-233`;
`apps/web/src/components/IntakeComposer.tsx:6-29`;
`apps/web/src/components/CaptureForm.tsx:97-103,125-143`;
`apps/web/src/components/QuickAdd.test.tsx:696-704`.

**Discovery candidate only:** a one-time editable source snapshot could remove
one repeated text-entry action, approximately six -> five actions in this
specific branch. It must not synchronize drafts, auto-generate/apply, infer
authoritative metadata or upload just because the user switches composers.

**Unresolved:** title versus title-plus-notes; raw versus selected syntax;
source content versus instructions; destination; repeated switches after Intake
edits; pending retry. Keep original capture untouched and Intake independent.
No adopted implementation until these meanings are agreed.

## Explicitly deferred alternatives

| Origin | Alternative | Why not selected now; capability retained |
| --- | --- | --- |
| INT-02 | Three direct scope chips | Extra header controls/height without device evidence; labelled cycle retains all scopes |
| INT-04 | Clickable Week date chips and unplanned Plan button | Potential planner entry reduction from two activations to one, but new drag/focus regions; existing detail planning remains |
| INT-05 | Ordinary drag-handle click opens Move sheet | Adds event-order rules to drag/arrow control; retain searchable Move and all drag/arrow routes; examine accurate handle naming/instructions first |
| INT-08 | AI intent select -> chips | Default path unchanged; more visible targets; native select remains a supported accessible choice |
| ARCH-03 | Shared backend viewer/lane resolver | Concrete duplication, but privacy-sensitive and no necessary direct UX gain; keep route policies unchanged |
| ARCH-01 initial | Shared batch action/controller | Pure reuse is sufficient first; preserve two focused sheets and shared backend |

Move-handle evidence:
`apps/web/src/components/TaskRow.tsx:370-397`;
`apps/web/src/components/TaskOutline.drag.test.tsx:330-340,380`.
AI-intent evidence:
`apps/web/src/components/WorkClarificationSheet.tsx:44-53`.
Backend resolver duplication:
`apps/api/src/routes/views.ts:123-139,170-184,202-219,283-300`.

## Coverage and deliberate no-change decisions

"No additional finding" is not a clean bill of health. Sources/tests were
sampled; runtime and deployed services were not exercised.

| Family | Coverage | Result / representative evidence |
| --- | --- | --- |
| Quick Add/contextual capture | Deep source and contract inspection | D01 and shared recovery; `QuickAdd.tsx:37-233`, `CaptureForm.tsx:96-244` |
| Guided capture | Source and draft/gesture contracts | No additional finding; `GuidedCapturePage.tsx:19-234` |
| Share/material/calendar conflict | Source and contract sampling | No additional finding; `SharePage.tsx:145-217,246-638` |
| AI intake/refinement | Entry/return/recovery inspected; engine sampled | Preserve reviewed Apply and handoff; `IntakeReviewPage.tsx:150-210` |
| Inbox/Today/Waiting | Core command, projection and planning inspection | S03-S06; `agendaSelection.ts:68-150`, `TaskPlanningSheet.tsx:91-255` |
| Week | Deep state, command and contract inspection | S01-S02, S04, S06; `WeekPage.tsx:65-559`, `weekAgenda.ts:33-180` |
| Review/cleanup | Queue/return, confirmation and error contracts | S03-S04; no additional cleanup finding; `ReviewPage.tsx:57-250`, `CleanupRoundPage.tsx:34-285` |
| Projects/All/detail/outlines | Core paths inspected; complete conversion/move internals limited | S03, S06-S07, S09-S10; `ProjectsPage.tsx:44-392`, `AllPage.tsx:31-151`, `TaskOutline.tsx:53-115` |
| Goals/interventions/coach | Source and contract sampling; evidence-editor depth limited | Preserve manual/private journal and explicit acceptance; `GoalsPage.tsx:94-248,300-455`, `InterventionAssessSheet.tsx:61-78` |
| Reflection | Export and consent contracts inspected | No new finding; `ReflectionStartPage.tsx:14-203` |
| Discussion/activity/digest | Read and interaction paths inspected | S04 sibling disposition and S08; `DiscussionPage.tsx:15-54`, `ActivityPage.tsx:30-112` |
| More/settings/household | Composition inspected; full admin/tag depth limited | No preference-only redesign; `MorePage.tsx:21-270` |
| HA/MCP/Paperless/PWA/proxy | Reachability and contract sampling | Deployed usability unverified; `HomeAssistantPage.tsx:51-220`, `McpPage.tsx:11-154`, `App.tsx:103-123` |

Component/page names without a prefix in this table are under
`apps/web/src/components` or `apps/web/src/pages`; API projections are under
`apps/api/src/domain`.

Do not reopen already-solved work: immediate capture, retained capture on AI
Cancel, created-item Open, explicit authored Save/Cancel, compact shared
planning, modal isolation, Review return focus, AI reviewed application, fresh
reflection privacy consent and caller-owned ordinary creation retry identity.
Do not add universal editors, form/workflow engines, URL-sync dependencies,
automatic acknowledgements, new settings or a merged date concept.

## Documentation drift is not a UI requirement

ARCH-04 identified conflicting historical descriptions:
`docs/workflow.md:185-201,224-229` describes an older project handoff;
`docs/architecture.md:2232-2241` describes its removal.
Current source opens the project after creation/conversion and explicit batch
entry uses project focus navigation:
`apps/web/src/lib/useWorkItemCommands.ts:500-502`;
`apps/web/src/pages/ProjectDetailPage.tsx:787`.

Other stale descriptions include `TaskQuickActionSheet`
(`docs/architecture.md:1345`) and a removed detail-section companion
(`docs/architecture.md:1841-1843`;
`apps/web/src/components/WorkItemDetailSection.tsx:9-12`).

This audit records the corrected baseline; it does not edit those documents,
restore removed UI or infer that current behavior is always the desired design.
A future targeted documentation correction should reconcile confirmed
capabilities. Status-display conventions remain an explicit decision in S09.
