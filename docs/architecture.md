# Machbar — Architecture

## Commitment-driven project activation

`apps/api/src/domain/commitmentTransition.ts` owns the pure, UI-independent
decision for commitment and activation transitions. It receives an explicit
snapshot (including the source and effective target state, project/ancestor
chain, drivers, readiness, and date boundary), an intent, and explicit user
decisions. It returns a concrete plan, missing decisions, or a conflict; it
does not read the database, clock, or transport.

`apps/api/src/domain/commitmentActivation.ts` adapts transaction-current
project/task state and `projectReadiness.ts` into that snapshot, then applies
the resulting activation and optional user-authored next action in the same
transaction. Task/project CRUD and explicit activate/reopen lifecycle commands
share this evaluation and write executor. HTTP, MCP, and Intake continue to
enter through those canonical mutations. When decisions are missing, the
server returns their requirements and revisions. Focused editors preserve
their drafts and retry; the web only presents requirements and collects the
decisions.

Open captured or Someday actions become actionable only when they receive an
execution commitment: a plan, deadline, or execution reminder. A project
deadline can trigger project activation, but is never itself a progress path.
Missing drivers or a concrete next action return structured decisions before
the source mutation is committed.

Revisit dates remain reconsideration, not execution commitments. Adding a
reminder while a revisit is present does not promote the task. Healthy waits
and future revisits retain their readiness meaning. Project activation does
not bypass task blockers or future-date agenda eligibility.

## AI clarification and reviewed application

`canBreakDownTask` in the shared intake contract owns target eligibility for
both the structure menu and API: recurring actions and captured actions nested
under tasks or projects cannot start proposals. Apply selects only the enabled
reserved root. After a recoverable Apply failure, review refreshes the recovered
job revision before allowing another edit.

`task.refine` and `story.refine` open the shared `WorkClarificationSheet` through
their canonical workflow hosts. Its default is general improvement; next
action and structure are available for both roles. For eligible tasks,
“In kleinere Schritte aufteilen” reuses the existing
`POST /api/intake/task/:taskId` proposal contract. The selected action and
optional focus are kept in one entry flow instead of separate AI launchers.
The endpoint checks viewer access and open-action eligibility, then creates an
ordinary intake job bound to the task, storing its subtree snapshot and
instructions.

Generation reuses Home Assistant `intake_analyze` and the structured intake plan.
Intake, breakdown, and cleanup-round prompts share actionability, sizing, and
finite-outcome guidance from `aiWorkGuidance.ts`, plus household AI context.
Source notes and existing children are data, not instructions. No web research
is assumed.

The smaller-steps proposal contains one reserved `existing-task` root and zero
or more immediate action steps. Review supports title/notes edits and a
task/project choice for the original root; children use the existing proposal
editors. Existing children remain untouched. Calendar events, references, and
deeper nesting are rejected.

Apply rechecks visibility and the persisted subtree snapshot, then edits or
converts the original and appends accepted steps through canonical domain
functions in one transaction. Conversion preserves the ID, uses existing
restrictions, and creates a backlog project. Conversion retains and clears
fields according to the usual role-conversion rules. Failed transactions return
the proposal to editable state; repeated Apply cannot duplicate steps.
Regeneration refreshes source context and the snapshot, requiring a new review.

Typed refinement changes can also set or clear a task's scheduled date,
deadline, revisit instant, and reminders. Omitted fields preserve existing
values; provider null-envelope placeholders are removed before proposal
validation, while explicit date clears and an empty reminder list remain
reviewable user-selected changes. New actions use canonical task creation
defaults. The review displays current and proposed planning values, uses the
household timezone for revisit and reminder editing, and commits those values
with the other accepted changes. Execution commitments run through the shared
activation requirement/decision continuation in the same transaction; a
revisit alone remains a reconsideration point rather than execution work.

For task-to-project refinement, an accepted `update_task` targeting the
converted task may edit only title and/or notes. The conversion runs first;
the canonical `updateProject` mutation then applies those text fields using the
new project revision. The shared selected-change validator rejects task-only
planning, waiting, movement, cancellation, or dependency operations on the
same item, along with duplicate title/notes writes, before the transaction
starts mutating work.

## Goals and advisory coach proposals

Goals and interventions are an owner-scoped journal, not work-item roles.
Manual writes and accepted coach proposals share the domain mutations in
`apps/api/src/domain/goals.ts`; no `goal_id` is added to work items and goals
remain outside Review.

The two Home Assistant requests are advisory. `goal_suggest` stores intervention
proposals and `goal_assess` stores a review proposal on the reverse-request row.
The web polls those existing request resources with a bounded cadence, presents
the result for editing, and applies it only through the explicit accept
endpoint. Suggestion acceptance creates one coach-sourced intervention.
Assessment acceptance uses the same assessment-authoring path as the manual
sheet. A missing Home Assistant connection or AI Task only disables the coach
assist; manual goal and assessment workflows remain available.

This document is the technical deep dive for contributors. For product
concepts, start with the [household workflow](workflow.md). For operating the
application, see [deployment](deployment.md) and
[status and limitations](status-and-limitations.md).

For normative contributor and coding-agent rules, canonical implementation
paths, and required architecture checks, see
[Architecture rules](architecture-rules.md).

## 1. Package Boundaries

```
machbar/                         ← npm workspace root
├── apps/
│   ├── api/                     ← @machbar/api   — Fastify HTTP server + SQLite
│   └── web/                     ← @machbar/web   — Vite + React SPA
└── packages/
    └── shared/                  ← @machbar/shared — shared TypeScript types
```

| Package | Role | External surface |
|---------|------|-----------------|
| `@machbar/shared` | Domain types, status/inheritance enums, i18n strings | Imported by both `api` and `web`; no runtime deps |
| `@machbar/api` | REST API + static file serving + SQLite access | `PORT` / HTTP; reads `DATA_DIR` and optionally calls Paperless-ngx |
| `@machbar/web` | React SPA | Built at compile time; served as static assets by the API |

The API serves the compiled frontend from `apps/web/dist/` as static files, so **a single process/port handles both the API and the UI** in production.

---

## Guided capture (no AI required)

`/capture/guided`, linked from Inbox and More, presents an open-ended reflection
deck over five thematic groups and sixteen life areas. `guidedCapture.ts` owns
the catalog and pure selection/rotation helpers; German and English catalogs
provide three distinct, optional questions per area, keyed by stable prompt IDs.
The editorial perspectives draw on personal-project elicitation, retrieval cues,
and cognitive household labor; these are not validated survey items.
`GuidedCapturePage` owns navigation (`?area=` remains linkable), in-memory drafts
keyed by card identity, and ephemeral saved-thought feedback.
It composes the canonical `CaptureForm` in `thought` mode: literal text, captured
status, creator recorded but no owner assigned, and no date/project/category
inference. The existing task-create endpoint persists each entry immediately and
the ordinary Inbox handles subsequent clarification. There is no new backend
persistence, classification, AI dependency, or backlog.

Selection draws one card lazily at the history frontier (a one-card batch).
Each cycle covers every area once, choosing randomly among unseen areas and
preferring a different thematic group from the previous card whenever possible.
Cycles continue seamlessly, with no finish screen, count, progress, or batch UI.
Each area exhausts its unused prompt IDs before rotating again; pool boundaries
avoid an immediate question repeat when alternatives exist. Back/Next traverses
existing card/question identities before generating anything. Picker/direct-link
jumps reuse a retained card for a visited area; unseen choices append at the
frontier without discarding forward history. Back then follows deck order (the
preceding generated card), not a separate picker/browser history. Invalid area
links, including the former `area=done`, are ignored.

Version-1 local storage is keyed per member and holds at most 48 card identities,
the current index, area coverage, and per-area prompt rotation. Reload/return
restores that card/history; a direct link may select another retained area.
Anonymous visits work without persistence. Malformed/unsupported state or removed
card area/prompt IDs safely start a fresh deck; stale rotation IDs are filtered.
Wording/locale changes resolve existing prompt IDs against the current catalog.
Drafts and captured text are never written to local storage. Ordinary in-memory
history is bounded to 48 recent cards; draft-bearing older cards remain reachable
until saved/cleared, without expanding permanent storage. If such an older card
is outside the stored window, reload resumes at the oldest stored card. Only
saved thoughts survive leaving; Exit asks before discarding unsaved drafts,
including a submitted thought whose save has not yet succeeded.

Left/right card swipes call the same Next/Back navigation using
`useHorizontalSwipe` and leaving the controlled thought form mounted. Cards
follow horizontal drags; successful navigation slides an inert, aria-hidden
snapshot of the outgoing card offscreen while the live incoming card enters
from the opposite edge. Buttons and picker jumps use the same
directional paging. The snapshot has no IDs or React lifecycle; only one capture
form remains live. Superseded/unmounted transitions cancel their animations and
remove the snapshot. Insufficient gestures spring back without paging. Reduced
motion (or missing Web Animations support) switches areas immediately.
`touch-action: pan-y` preserves scrolling, vertical starts cancel navigation,
and interactive controls do not start swipes. Saving locks the capture input and
submit button, not browsing, swipes, the picker, or Exit. The shared swipe
primitive suppresses only trailing pointer clicks, never keyboard activation.
The question-led reflection cards use catalog group tones and motion gated by
`prefers-reduced-motion`.
Saved-thought notes are local presentation grouped by area, never another backlog.
Thought mode skips metadata requests/syntax suggestions and omits destination and
reset controls. Save failures keep the draft for retry; success refocuses an empty
input only if the submitted card is still current. A save resolves against its
original card, even after navigation; failure retains that card's draft/error for
retry, never attaching it to another area. Other app navigation and browser
history/unload are not intercepted: leaving can
discard feedback, but a route change does not cancel the existing create request.
Persistence is performed by the task-create endpoint before `onCaptured` supplies
local feedback; no unload handler can guarantee completion. Returning via the page's
Inbox links switches Work scope to Household so captured household thoughts remain
visible.

## 2. AI intake (“Verarbeiten”)

AI intake is a clarification adapter, not a second task system, calendar
system, or AI assistant. A person starts **Verarbeiten** from Quick Add or the
share target. Machbar stores a short-lived intake job and asks the paired Home
Assistant integration to run the configured AI Task entity:

Quick Add opens the title composer immediately. Photo, file, and **Verarbeiten**
remain secondary actions from that composer. Switching to AI intake keeps the
task draft mounted; cancelling intake returns to the same draft. Successful
task capture resets the composer and shows the created item with an **Öffnen**
command routed through `useWorkItemCommands()`.

```text
Quick Add / SharePage
  └─ POST /api/intake (text and/or files)
       ├─ intake_jobs + intake_attachments
       ├─ <DATA_DIR>/intake/<job>/<attachment>
       └─ reverse request: intake_analyze
            └─ HA worker → configured ai_task.* entity → IntakePlan
                 └─ review at /intake/:id
                      └─ human edits and POST /api/intake/:id/apply
                           ├─ normal Machbar project/task creation primitives
                           └─ reverse request: calendar_create
                                └─ configured writable calendar entity
```

The paired Machbar custom integration must be upgraded together with the
server. Protocol version **2** is required; there is no v1 compatibility
path. Home Assistant must have a configured, attachment-capable `ai_task.*`
entity for image/PDF intake and a writable `calendar.*` entity. Both are
selected in the integration's options flow. An uploaded `.txt` file
(`text/plain`) is decoded as UTF-8 by Machbar and appended to the AI Task
source text as `SOURCE FILE: <filename>` followed by a delimited text block;
it is not sent as a binary AI Task attachment. Images and PDFs remain
attachments. Intake accepts up to five
files of supported image, PDF, and `text/plain` MIME types, each at most
25 MB. Invalid UTF-8 text files are rejected, and the combined typed text and
decoded text-file content is limited to 20,000 characters. Machbar does not
store an AI-provider credential, OpenAI key, Google credential, or Home
Assistant access token.

### Contract and execution

`@machbar/shared` owns the dependency-free `IntakePlan`/`IntakeDraft` contract
and the shared invariant checks. `intakePlanIssues()` validates the model
proposal (including the single key namespace, dates, hierarchy, references,
and legal fields); `buildDraftFromPlan()` resolves owner names to household
members and assumes a 60-minute end for a timed event when the source omitted
one; `intakeDraftIssues()` validates the human-editable proposal before save
and Apply. Boundary adapters use the focused shared input-normalization helpers
to repair compact AI representations before strict structural and semantic
validation; canonical mutations remain strict. API Zod schemas provide
structural validation around the same contract.

### Shared household AI context

The optional household AI context is durable background information, not an
editable system prompt. `household_ai_context` stores one shared household
resource with a household description, long-term direction, and optional
suggestion guidance. `GET/PUT /api/settings/ai-context` trims and length-limits
plain text, converts blank fields to `null`, and keeps Machbar's schemas,
validation, safety rules, and deterministic workflow rules authoritative.

`apps/api/src/aiContext.ts` renders the context section once for both Intake
and Aufräumrunde prompts. Empty fields produce no heading; populated fields
are inserted as background context before source/item data. The web editor is
available from **Mehr → KI-Kontext** and uses explicit Save/Clear editing
without exposing the feature as a prompt editor.

The reverse bridge is deliberately narrow. It has exactly three request kinds:
`intake_analyze`, `cleanup_round_analyze` (the Aufräumrunde, see §8), and
`calendar_create`. Requests use long-polling, leases, and
bounded retries; the bridge is not arbitrary Home Assistant RPC. The AI phase
never mutates Machbar or the calendar. Only the human Apply command creates
Machbar work, using `createProject()`, `createTask()`, and
`createChildTask()` so normal hierarchy, activity, status, and contribution
semantics remain in force.

### Curated activity digest

The Today page's **Seit deinem letzten Besuch** card is a curated projection
over the existing transactional `activity_events` history, not a second event
log or a replacement for the chronological Activity page. `apps/api/src/activity/digest.ts`
loads a fixed event high-water mark, filters private `work`-scope history,
reduces intermediate changes by stable work-item identity, and applies explicit
P1–P5 classification and aggregation rules. It returns language-neutral
semantic entries; the web layer owns wording and locale-specific formatting.

Each member has a durable `member_activity_digest_state` cursor. First use
starts at the current event maximum, requests do not acknowledge anything,
and the explicit acknowledgement endpoint advances the cursor monotonically
through the digest snapshot. Activity metadata keeps privacy-safe before/after
state and stable affected-item/project context so later moves, edits, or
deletions do not require reconstructing history from current hierarchy alone.

### Persistence, expiry, and idempotency

`intake_jobs`, `intake_attachments`, and `home_assistant_requests` are
operational state for one intake. Uploaded files are kept below
`<DATA_DIR>/intake` and the job, request rows, and files expire after **24
hours**; cleanup removes them automatically. This is temporary review state,
not durable household history. Source retention is optional and is offered
only for file-based intakes when Paperless-ngx is configured; **Original als
Material behalten** uploads those files to Paperless, never the text-only
source.

Calendar creation is idempotent by a `machbar-ref:<correlation-id>` marker in
the event description. The HA adapter searches that marker, creates at most
one event, and retries UID recovery after creation; it never matches by title
or time. Recovered events are recorded in `external_work_item_refs` with
source `home_assistant_calendar` and external ID
`<calendarEntityId>:<uid>`. These are provenance references, not lifecycle
links: they are intentionally distinct from `external_task_links`, and there
is no calendar lifecycle synchronization.

### Intake states and errors

The review page distinguishes `queued`, `analyzing`, `analysis_failed`,
`ready`, `applying`, `applied`, and `partially_applied`. Typical actionable
errors are:

While an intake is `queued`, `workerOnline=false` is shown as a temporary
offline hint rather than a separate failure state.

| Area | Error codes |
|------|-------------|
| Connection/readiness | `home_assistant_not_connected`, `home_assistant_protocol_outdated`, `ai_task_not_configured`, `ai_task_attachments_unsupported`, `calendar_not_configured`, `calendar_not_writable` |
| AI analysis | `ai_task_failed`, `ai_task_invalid_response`, `intake_attachment_download_failed` |
| Calendar execution | `calendar_create_failed`, `calendar_uid_not_recovered`, `home_assistant_request_lease_lost`, `home_assistant_request_exhausted` |
| Input and review | `intake_input_required`, `intake_file_rejected`, `intake_file_too_large`, `intake_too_many_files`, `intake_draft_invalid`, `stale_write_conflict`, `intake_state_conflict` |
| Lifecycle/retention | `intake_not_found`, `intake_expired`, `intake_apply_partial`, `intake_source_retention_failed` |

External systems remain authoritative for their domains: Home Assistant
chooses and runs the AI provider and owns the calendar event; Machbar owns the
review and the resulting household work.

## Historical reflection export

`GET /api/reflection/briefing` remains the sole source for historical reflection
facts. `ReflectionStartPage` selects its reporting window and scope, previews
the complete content, and only then enables native share, clipboard, or file
export. Household scope is the default. A scope containing private work shows
the selected data and requires explicit consent before export. The coaching
instruction is localized frontend content and is packaged separately from the
deterministic briefing; Machbar does not contact an AI provider. The wrap-up
requested from an external coach is only a human-readable draft in this phase,
not a defined import protocol.

## 3. SQLite Data Model — Hierarchy and Inheritance

### Entity hierarchy

```
Member   Tag
  │        │
  │        └─────────────────────┐
  ▼                              ▼
WorkItem(role=story) ─── WorkItem(role=task)
          │                         │
          ├── nested story          ├── nested task
          ├── AcceptanceCriterion   ├── Dependency (taskId → dependsOnTaskId)
          └── child tasks/stories   └── ExternalWait (one-to-one by taskId)
```

- **Members** are the people who use the app. Every WorkItem can be assigned an
  owner (`ownerMemberId`).
- **WorkItems are one physical hierarchy.** `work_items.role = 'task'` means
  executable work; `role = 'story'` means an outcome planned through child
  progress. Stories may contain stories and/or tasks at arbitrary depth.
- **Besprechen is a shared nomination.** The `discussion_requested` boolean
  lives on `work_items` for both roles and is changed only through the
  canonical task/project update mutations. `GET /api/discussion` projects
  only viewer-visible work; the More page reuses the normal task/project row
  workflows. The flag does not affect status, agenda, review acknowledgement,
  or any other work property.
- **Projects are the story UI/API adapter.** The German UI may still call a
  story a “Projekt”. A story has one responsible person, optional
  due/scheduled dates, free-form `notes`, and an ordered
  **“Erledigt, wenn …”** checklist.
- **Story notes and completion criteria are separate.** `work_items.notes`
  stores context, constraints, links, phone numbers, decisions, and
  background. `work_item_acceptance_criteria` stores structured, individually
  checkable, position-ordered completion rows. Neither replaces the other.
- **Attachments remain notes, not database entities.** A Markdown target such
  as `paperless:4711` is an opaque reference to a document stored by the
  optional Paperless-ngx integration. Machbar stores no attachment bytes or
  authenticated Paperless URL; direct Paperless UI links are generated at
  render time from the configured public base URL.
- **Tasks** are WorkItems whose nearest ancestor story is exposed as the legacy
  `Task.projectId`; their immediate parent task, if any, is exposed as
  `Task.parentTaskId`. Both are derived from `work_items.parent_id` rather than
  stored as separate columns. Each task carries optional household effort
  (`S | M | L | XL`); effort guides splitting and sorting only and never
  changes eligibility or workflow.
- **Tags** are many-to-many with WorkItems via `work_item_tags`. Every tag has a
  persisted colour; newly created names map deterministically onto the
  application palette, so colours do not change between clients or renders.
- **Scope** (`work_items.scope`, `"household" | "work"`, default
  `"household"`) separates household work from a member's own work tasks.
  Unlike owner/tags, scope is not a per-task inheritance override: only the
  root of a subtree can set it, and it cascades unconditionally to every
  descendant; a non-root `scope` in a create/update input is ignored. Work
  items are strictly owner-only (never returned to any other member, in any
  list/search/dashboard/aggregate) and never mixed with household items in
  the same view. Work items never contribute to points/gamification. See
  `docs/architecture-rules.md`'s "Task/project `scope` and the `Graph.load`
  viewer contract" section for the enforcement mechanism.

### Inheritance chains

Two kinds of values cascade down the task tree:

| Field | Resolved as `effective*` |
|-------|--------------------------|
| `ownerMemberId` | First non-null value walking up: task → parent task/story → … → nearest story |
| tags | Union of ancestor tags minus any `excludedTagIds` on the task |
| physical contexts | Nearest explicit task set, otherwise parent/project set |

`inheritanceMode` (values: `inherit` | `explicit` | `none`) overrides the cascade:

- `inherit` — use the nearest ancestor's value (default)
- `explicit` — override with the task's own value and stop propagation
- `none` — explicitly clear the value (no further upward lookup)

The resolved values are exposed as `effectiveOwnerId`, `effectiveTags`,
`inheritedTags`, and `effectiveContexts` on `Task`. `inheritedTags` is the
ancestor/project union *before this task's own exclusions are applied*, so the
UI can keep inherited tags visible and reversible even while they are currently
excluded from `effectiveTags`. Physical contexts are Home Assistant-owned
entities rather than a tag kind.

Tag selection is a reusable compact chip picker in both task and project
editors. Every flexible, non-exclusive tag has one primary kind: Bereich,
Person, or Normal. The picker creates a missing tag with the
kind of its active section and selects it immediately. Inherited task tags
remain separately excludable rather than being converted into explicit task
tags. `TagManager` exposes kind and grouping metadata under **Mehr**;
`DELETE /api/tags/:id` relies on the shared WorkItem join tables' `ON DELETE CASCADE`
constraints, so deleting a tag removes its associations without deleting
stories or tasks.

Projects compute effective tags as their explicit tags plus the effective tags
used by descendant tasks. Bereich grouping selects one primary area per
project: pinned effective area, explicit project area, then the area used by
the most open descendant tasks. Hidden grouping tags never become headers,
and projects without a qualifying area appear under **Ohne Bereich**.

---

## 4. Compiled / Resolved Views

The API computes several derived fields before returning tasks to the client:

| Field | Computed as |
|-------|-------------|
| `effectiveOwnerId` / `effectiveOwnerSource` | Walk parent chain; source ∈ `{task, parent, project, none}` |
| `inheritedTags` | Ancestor/project tag union before this task's own exclusions |
| `effectiveTags` | `inheritedTags` minus excluded IDs, plus this task's explicit tags |
| `effectiveAreaTags` / `effectiveActorTags` | Kind-filtered views of `effectiveTags` |
| `explicitContexts` / `inheritedContexts` / `effectiveContexts` | Stable physical-context requirements |
| `explicitTags` | Tags directly on this task |
| `externalWait` | Nullable unresolved external blocker with a required non-empty reason; its optional follow-up is represented by the work item's `revisitAt` |
| `blocked` | `true` for actionable tasks with an external wait or any unresolved dependency |
| `executable` | `true` only for actionable, unblocked tasks |
| `blockers` | Structured external/dependency blocker summaries |
| `nextBlockerAttentionDate` | Earliest derived attention date through unresolved blocker branches; never persisted or copied to the dependent task |
| `children` | Direct sub-tasks (recursive to arbitrary depth) |
| `dependencies` | Outgoing dependency edges with their resolution state |

`GET /api/tasks/:id` (and only that single-task detail endpoint — never list
or tree responses) additionally attaches `ancestors: WorkItemAncestor[]`, the
complete outermost-first chain of containing projects and parent tasks
(`Graph.taskAncestorsFor()`). Projects carry the analogous chain of containing
parent projects (`role: "story"`) via `Graph`'s private `ancestorsFor()`. Both
share the `WorkItemAncestor = { id, role: "story" | "task", title }` shape from
`@machbar/shared`, and both are rendered by the one generic
`apps/web/src/components/WorkItemBreadcrumbs.tsx` above the detail title —
task detail and project detail do not maintain separate breadcrumb
implementations.

Projects additionally carry:

| Field | Computed as |
|-------|-------------|
| `availableActions` | Workflow transitions legal for the current status (see §6) — the single source of truth for which buttons the UI renders |
| `activationReadiness` | Canonical driver, executable-progress, and healthy-future-waiting evaluation used by activation UI |
| `notes` | Free-form project context, independent from completion criteria |
| `acceptanceCriteria` | Ordered “Erledigt, wenn …” rows with `checked` state |
| `openCount` / `doneCount` | Task rollups |
| `nextAction` | First actionable, unblocked, *leaf* task in canonical outline order — a task with any open (not `done`/`cancelled`) child is a container and is skipped in favor of its subtree |
| `stuckReason` | Diagnosis for `active` projects only (see §6) |

These views are **read-only projections** — they are not stored in SQLite; they are assembled per-request.

The **Heute** agenda is also query-derived. Its primary sections contain work
explicitly scheduled for today or earlier, overdue work, work due today,
soon-due work, and directly externally waiting tasks whose Wiedervorlage is due.
It is member-scoped by default (including shared/unassigned work), while the
explicit `scope=all` query returns the same compiled buckets for the complete
household. The frontend exposes that distinction as a session-scoped
**Meine | Alle** header toggle.
Executable standalone work without a `scheduledDate` falls through to the
secondary `shared` / `unscheduled` buckets. Ordinary unscheduled project work
enters those buckets only through the canonical selector in
`agendaSelection.ts`/`nextActionRepo.ts`: member scope chooses the first
candidate effectively owned by the member or shared, while household scope
preserves at most one candidate per independent effective-owner/shared lane.
`nextActionRepo.ts`'s depth-first pre-order (sibling `position` order at every
level) treats an otherwise-eligible task with any open (not `done`/`cancelled`)
child as a **container**, not a candidate — it never competes with its own
children. Pre-order therefore naturally descends into the subtree and selects
the first eligible leaf; a blocked/waiting parent never hides an eligible
child, and a parent becomes a candidate again once every child is terminal.
This is decided once, centrally, in the repository query, so `Graph`, Today,
Week/unplanned, and project readiness all agree without any consumer
special-casing it. A
real task deadline or planning date remains an execution signal even when that
task is not the structural next action. The first matching bucket wins, so a
task never appears twice. Future-scheduled work, captured work,
completed/cancelled work, unavailable-context work, and blocked work without a
reached revisit stay out.

Task execution availability is an independent nullable `availabilityRule` weekly
JSON field. The planning sheet offers Anytime, Business hours, or Outside business
hours; the constrained window is Monday–Friday 09:00 inclusive to 17:00 exclusive
in the household IANA timezone. `taskAvailability.ts` evaluates an explicit instant
with Temporal without database or clock access. Today passes one instant through
`agendaSelection.ts` and `agenda.ts`: project next-action selection, planned rows,
ordinary reached revisits, shared/unplanned work, and embedded execution suggestions
respect the window. Deadline attention and reached external waits retain their
existing precedence. Null preserves existing behavior; Week, inventory, completion,
structural executability, and blocker diagnoses do not evaluate the window.
Boundaries are evaluated on reads through Today's existing visible refresh interval;
they never mutate dates, revisions, or activity. Planning edits use the same atomic
save/cancel and field-level conflict merge as the other planning fields, independently
of Plan/Wiedervorlage exclusion.

The **Week planning** view is another read-only WorkItem projection:
`apps/api/src/domain/weekAgenda.ts` builds `/api/agenda/week` from `Graph` into
one compact rolling `today..today+6` list with chips, plus an **Ohne Planung**
unplanned pool. It is a rolling attention horizon, not an ISO/calendar week or
an hourly calendar, and does not persist a planning model of its own. Week uses
`agendaSelection.ts` for ownership, executable available work, and
project next-action lane selection. Dated task attention (`scheduledDate`,
`dueDate`, or direct `externalWait.revisitDate`) can surface from any open
story, including backlog stories, because an explicit calendar date is a
planning commitment for that task. The **Ohne Planung** pool remains
stricter: it contains standalone work and selected next actions from active
projects only. Week deliberately disables current physical-context availability
when filling that planning pool: Week plans across places; Today answers what is
actionable where the household is now. Unlike a plain exact-date projection,
Week now carries unfinished attention forward the same way Today does: each
item's applicable source dates are clamped to today when they have passed,
and the item is placed on the earliest clamped date, so overdue attention
shows up under today's column instead of disappearing off the front of the
window. The stored source date is never mutated by this projection. The week
still uses one compact day list with chips rather than separate day or wait
sections.

There are three distinct source attention dates for a card:
- task `scheduledDate` = intended work date;
- `dueDate` = deadline or constraint;
- `revisitAt` = follow-up or decision instant, including the follow-up for a
  direct external wait.
`revisitAt` is stored as an ISO timestamp and projected into the household
timezone for date-based views. It is not a separate task status or workflow
store.

From these task dates, `projectWeekAttention` (in `@machbar/shared`, reused by both the
backend projection and the frontend's optimistic drag/clear recompute)
derives one explicit `attentionDate` + `placement` per item: the earliest
applicable candidate date, clamped forward to today when it is in the past.
Ties between candidates landing on the same clamped date break
`scheduled > revisit > due`, but a genuinely earlier due date still wins the
placement over a later scheduled/revisit date - a due-driven `attentionDate`
is never silently deprioritized just because a scheduled or revisit date also
exists. A direct external wait considers its revisit date and due date (not
its scheduled date, since a schedule is not a meaningful planning signal for a
blocked task); waiting tasks never enter the unplanned pool merely because
they are blocked. Dependency blocker attention, through
`nextBlockerAttentionDate`, is derived metadata only and is not treated as
Week revisit placement. **Ohne Planung** is derived from
the same current available-work selection as Heute's `shared` and
`unscheduled` buckets: standalone executable work and selected project next
actions only, never unscheduled stories/projects, waiting work, dependency
blocked work, captured work, someday/backlog work, or already scheduled work.
Current physical context does not remove a task from Week's planning pool.
Dragging a task card edits whichever date is responsible for its *current*
placement, not simply its task-vs-project role: a `scheduled` card changes
`scheduledDate`; a `revisit` card changes `revisitAt`. A `due`-placement
card is never movable by generic drag - its deadline is a hard constraint, so
day-column drop is rejected for it instead. Clearing a `scheduled`/`revisit`
date (including via the **Ohne Planung** drop) recomputes placement rather
than assuming `unplanned`: if an in-week due (or revisit) date still applies,
the item lands there instead. `workItem.setDeadline` remains the semantic
deadline command for surfaces that offer due-date editing. Project `revisitAt`
is not a Week placement field when it is a backlog-only
Wiedervorlage, edited through `story.defer` and surfaced in Review when reached.
Active projects have no project-level Wiedervorlage. Project dates never
propagate to descendants.

Active projects have a separate compiled `projects` bucket. A project enters
Heute seven local calendar days before its `dueDate`; a backlog project's
`revisitAt` is a Wiedervorlage and does not surface active project attention.
Reached backlog Wiedervorlagen surface in Review for an activation/defer/archive
decision. Project dates never become task dates.

---

## 5. Transaction Rules

- Every write that touches more than one table (e.g. creating a task + adding tags) uses an explicit SQLite transaction.
- Every structural task change uses revision-safe
  `POST /api/tasks/:id/move`. Reordering, indenting, outdenting, reparenting,
  and cross-project subtree moves are client-side destination calculations,
  not separate domain commands. The transaction validates the rendered
  revision, prevents cycles and recurring parents, cascades project changes
  through descendants, and normalizes both affected sibling groups.
- `POST /api/tasks/:id/convert-to-story` and
  `POST /api/projects/:id/convert-to-task` atomically reclassify a root
  `captured` task as a story (or the reverse), reusing the same numeric id
  (see §9) so activity history, tags, contexts, and notifications survive
  untouched. Task → project conversion preserves task-only work plans,
  reminders, external waits, recurrence history and dependencies by moving
  them to a retained action step, with optional per-dependency assignment to
  an existing open action. It preserves the project deadline and existing
  children. Reverse conversion retains task descendants, the existing task
  identity, tags/contexts, planning dates, external waits, reminders,
  recurrence state, occurrence history, and criteria. Criteria remain
  editable/checkable on the converted task and task completion rejects any
  unchecked criterion; unsupported nested-project, archived-status, and
  conflicting work-plan/revisit mappings roll back without changing the
  project.
- External waits use revision-aware `PUT /api/tasks/:id/external-wait` and
  `DELETE /api/tasks/:id/external-wait` resources. Starting/updating a wait can
  change its description and its own revisit date atomically; resolving it
  deletes the relation while preserving the task's independent work plan.
- `POST /api/tasks/:id/external-wait/follow-up` atomically appends the
  attributed note and either continues or resolves the wait; the UI never
  composes that workflow from multiple requests.
- SQLite's WAL mode is enabled (`PRAGMA journal_mode=WAL`) so reads do not block concurrent writes.
- Tasks and projects carry monotonic revisions. Metadata PATCHes compare the client's rendered revision inside the write transaction and reject stale saves with HTTP 409.
- The database file lives in `DATA_DIR` (default `/data`). The path is `${DATA_DIR}/${DATABASE_FILE}`.

After a successful mutating API response commits, the single application
process publishes a coarse invalidation through an authenticated SSE stream.
Each browser tab identifies its own writes so their echo does not interrupt
local optimistic-retention UI. Other tabs/devices refetch through the existing
frontend refresh bus. `useAsync` treats these same-query refetches as
stale-while-revalidate: successful data remains rendered, `loading` stays
false, and background failures do not replace the page with its foreground
error state. Dependency changes start a new logical query generation and hide
old-query data immediately. Each logical query generation allows one in-flight
request; additional invalidations queue one trailing revalidation and do not
cancel the pending result, so initial loading can settle. Generation checks and
effect cancellation prevent stale or unmounted requests from committing.
Remote SSE, focus, visibility, online, and disconnected-poll invalidations use
a leading/trailing one-second cadence, including a final refresh after a burst.
Explicit mutation refreshes remain immediate; hidden-tab polling and visible
eligibility timers retain their existing behavior.

For temporary incident tracing, set `sessionStorage["machbar:refresh-debug"] =
"1"` in the affected browser tab. Console diagnostics contain only refresh
reason, monotonic time, version, and SSE lifecycle (never change-event payloads
or work-item content). Correlate these with the server's successful write-route
access logs to distinguish remote writes, reconnects, browser events, and local
mutations. Remove the key to disable tracing. Home Assistant context and sync
POSTs currently notify even when their semantic content is unchanged; suppression
requires verifying both domain changes and freshness/liveness transitions.
No external pub/sub is required under the supported single-process deployment
model.

---

## 6. Base Path and integrations

The `BASE_PATH` environment variable (default `/`) tells the server where static UI routes are mounted:

- The **API** remains at absolute `/api/...` browser URLs.
- The **frontend** uses relative assets and hash routing so the same build works behind a non-root proxy path.

No frontend rebuild is required for a proxy sub-path.

### OIDC authentication

OIDC is an optional runtime mode configured by issuer, client ID/secret, and
one explicit public HTTPS origin. All required variables must be present or
startup fails; with none present, local development retains the browser-local
member picker.

The Fastify server performs Authorization Code exchange with PKCE, state, and
nonce. One-time auth flows are stored briefly in `oidc_auth_flows`, with the
state stored only as a SHA-256 hash. After validating the Pocket ID token and
UserInfo response, Machbar discards all provider tokens and maps the stable
`(issuer, sub)` pair in `member_oidc_identities`. The optional standard
`picture` claim is retained only when it is an HTTP(S) URL on the configured
issuer origin. The browser loads that image directly from Pocket ID; Machbar
does not proxy or cache it.

An exact, unlinked member name is adopted on first login. If the display name
does not match, a unique case-insensitive `preferred_username` → member-name
match is accepted; otherwise a member is created. Names are synchronized from
Pocket ID on later logins, as is the optional picture URL, but the subject
mapping never changes. Collisions fail rather than rebinding a member.
Assignment-only members without an OIDC identity remain supported and use the
initials/color avatar fallback.

Machbar creates its own random opaque 30-day session. Only the SHA-256 token
hash is stored in `auth_sessions`; the raw value exists solely in the
`__Host-machbar-session` Secure/HttpOnly/SameSite=Lax cookie. Ordinary API
routes require that session, and unsafe methods additionally require an exact
same-origin `Origin` header. Health and login bootstrap routes remain public.
The authenticated member overrides caller-supplied creator and default Heute
identity fields. An explicit `scope=all` may broaden the Today read projection,
but never changes mutation attribution. Normal household owner assignment
remains collaborative rather than becoming a per-record ACL.

### Home Assistant

The HACS integration exchanges a short-lived pairing code for a hashed,
revocable machine credential, then pushes versioned complete snapshots. Machine
routes use Bearer authentication and cannot substitute for browser sessions.
`Graph` resolves stable requirements; Today and Waiting alone evaluate
member-specific availability. Unknown or telemetry older than 30 minutes fails
open and never changes structural blocker or project-health derivations.

### Copilot / MCP

The remote MCP endpoint is mounted at `/api/mcp` inside the Fastify process
using the official TypeScript MCP SDK's stateless Streamable HTTP transport.
It is not a second service or workspace package.

An OIDC-authenticated member creates a named, revocable agent credential in the
web UI. Only the SHA-256 token hash is stored in `mcp_agents`; the raw token is
shown once and then sent as an `Authorization: Bearer` header. Every credential
is permanently bound to its creator and to either the `household` or `work`
scope. Tool handlers enforce that boundary before reads and mutations.

When `MCP_OAUTH_ENABLED=true`, the same endpoint also accepts delegated Pocket
ID API access tokens. Machbar validates the JWT signature through the
discovered JWKS, configured issuer, exact `/api/mcp` audience, expiry, and
fixed `machbar:mcp:household` scope, then maps the immutable `(issuer, sub)`
pair to an already-linked member. OAuth is household-only and never provisions
or updates a member; work access remains limited to explicit agent
credentials. `apps/api/src/auth/routes.ts` is the common credential boundary,
while `apps/api/src/mcp/tools.ts` remains independent of the credential
mechanism.

Protected-resource metadata is permanent resource-server behavior. The
Machbar authorization-server metadata and `/api/mcp/oauth/authorize` route are
temporary Home Assistant compatibility code: current Home Assistant omits the
RFC 8707 `resource` authorization parameter, so the stateless route injects
Machbar's canonical resource and redirects to Pocket ID. Pocket ID remains the
direct token endpoint; Machbar never proxies or stores Home Assistant client
secrets, authorization codes, or refresh tokens.

`apps/api/src/mcp/tools.ts` is an adapter over the same graph projections,
domain commands, revision checks, and transaction boundaries used by REST
routes. MCP must not become a second mutation architecture.

---

## 7. Status Lifecycle

### Tasks

```
captured ──► actionable ──► done
                 │
                 ├──► someday ──► actionable
                 └──► cancelled
```

`TaskStatus` is `captured | actionable | someday | done | cancelled`.
`captured` identifies unclassified work and appears in **Eingang**. The stored
`needs_clarification` flag is independent: a task can remain active, scheduled,
or waiting while it is explicitly queued for another clarification pass.
Clarifying a flagged active task clears only the flag; clarifying a captured
task also promotes it to actionable. The separate `clarification_revisit_date`
defers only the clarification queue; ordinary `revisit_at`, scheduled work,
reminders, external waits, and lifecycle are unchanged. Agenda eligibility for
a re-clarified task follows the same execution-commitment rules as other work.
Project and child creation can start as already clarified actionable work.
Captured tasks stay visible in project trees but are excluded from Heute,
next-action selection, and blocker classification.

Waiting is deliberately not a task status. `task_external_waits` stores a
required non-empty reason in a one-to-one row whose presence means the actionable
task has an unresolved external blocker. `task_dependencies` stores real task
prerequisites. Blocking and executability are derived from both sources, and
current create/update/status APIs accept only the five statuses above.
The Waiting API includes only actionable tasks with their own
`task_external_waits` row. Dependency-only blockers stay visible in project
context instead of duplicating the external wait at the end of their chain.

`Task.scheduledDate` is always a planned work date.
`ExternalWait.revisitDate` is always the date on which a blocked task should
return for attention. A task may retain both dates while waiting; only the
revisit can surface blocked work in Today. Resolving either kind of blocker
never clears the task's work plan.

Tasks in `done` or `cancelled` are retained in the database and visible in search/history views.

### Projects

`ProjectStatus`: `backlog → active → completed`, with `archived` reachable
from any non-archived state. Completed work reopens to active. `backlog` is
the one reversible "later" state; `archived` is terminal retirement and only
returns through `backlog`, so the same driver/progress-path checks apply
before it can be active again.

```
backlog ──activate──► active ──complete──► completed
   ▲                    │           reopen ─────┘
   └────return──────────┘
   ▲
   │ return_to_backlog
   │
archived ◄──archive── (backlog | active | completed)
```

`availableProjectWorkflowActions()` in `apps/api/src/domain/storyWorkflow.ts` is the **single source of truth** for legal transitions and is surfaced on every project response as `availableActions`. Rules:

- `PATCH /api/projects/:id` **refuses status changes** — status only moves
  through the dedicated workflow endpoints (`/activate`, `/complete`,
  `/reopen`, `/return-to-backlog`, `/archive`).
- Nothing auto-completes a story; completion is always an explicit human decision.
- Acceptance criteria are optional on projects and converted action tasks.
  When none exist, completion is allowed; when one or more exist, every
  remaining criterion must be checked first. Project criteria remain attached
  through Project → Task conversion and use the same editor/check API after
  conversion.
- `completeProject()` accepts revision-bound criterion checks and open-task
  branch dispositions as one decision set. It validates that set before using
  the canonical task cancel/move commands and completing the project inside
  the enclosing transaction. Missing choices, stale descendants, or failed
  criteria roll the whole operation back; the focused sheet does not persist
  choices before confirmation.
- `completeTask()` applies any completion-time criterion checks in the same
  transaction as the existing task lifecycle transition. With no missing
  criteria, ordinary completion remains a direct action. Task criteria
  retained through project conversion continue to be enforced by the same
  completion guard.
- Returning a project to backlog does not silently withdraw execution
  commitments. The command checks project deadlines and descendant plans,
  recurrence and reminders. When explicitly requested, it revision-checks the
  descendant tasks and clears those commitments atomically with parking while
  preserving wait and revisit information.
- Task Planning is also the focused editor for prerequisite relationships.
  External waiting remains separate state: ending a wait removes only the
  external-wait row and revisit date, leaving dependency edges in place.
  Follow-up outcome text and the continue/end decision are written by one
  revision-checked domain operation. Dependency add/remove requests carry the
  task revision and use the existing cycle and task-kind guards.
- `archived` only exposes `return_to_backlog`; there is no `archived → active`
  transition. Reactivating an archived project always goes through backlog
  first.
- `DELETE /api/projects/:id` permanently removes the project, its tag links,
  and its “Erledigt, wenn …” rows. Existing tasks are preserved and detached
  (`tasks.project_id = NULL`) by the foreign key's `ON DELETE SET NULL`.

### Responsible-person invariant

Every active project must have a responsible person (`ownerMemberId`) and
either executable progress or an intentional healthy future-waiting path:

- `POST /api/projects/:id/activate` fails with `project_driver_required`
  unless the project already has a responsible person or one is supplied
  inline (`{"ownerMemberId": n}`).
- Activation and reopening also fail when the project has neither a canonical
  executable candidate nor a healthy blocker path with future attention. Every
  project response exposes that exact domain evaluation as
  `activationReadiness`, so focused UI collects only the missing driver or next
  step instead of approximating readiness from display fields.
- `PATCH /api/projects/:id` with `ownerMemberId: null` fails with
  `project_driver_locked` unless the project is in `backlog`. Reassigning to a
  different member is always allowed. Individual task ownership remains
  independent.
- Member deletion fails with `member_active_projects_conflict` while that
  person still drives an active project. The project must be reassigned or
  returned to backlog first.

Quick project capture creates backlog work and preserves the selected driver.
Its handoff may add a first action, but Start remains explicit. Active
task-to-story conversion is subject to the same invariant; role conversion
preserves the task identity, compatible metadata, and descendants rather than
manufacturing readiness.

The conversion sheet creates a backlog project first. Its Activate choice and
the captured-project handoff's Start button dispatch `story.activate`, so
`ProjectWorkflowHost` collects a missing driver with the existing member picker.
Selection assigns the driver and activates atomically when a progress path is
ready; otherwise the lifecycle continuation guides the user to plan the next
action without bypassing activation readiness.

Legacy rows migrated from before the invariant may still be `active` without a
responsible person; the clarification service flags them urgently.

### Stuck detection

`Graph` and the canonical cycle-safe analyzer in
`apps/api/src/domain/blockers.ts` classify **`active` projects only** (backlog
stories are not "stuck" — they are simply not started).

| Reason | Condition |
|--------|-----------|
| `no_next_action` | No healthy actionable path exists and no more specific blocker diagnosis explains it (including an empty project or open work that is only captured/someday) |
| `completion_review` | Project has tasks but **zero open** ones — everything is `done`/`cancelled`, so the story is ready to be completed or extended |
| `waiting_without_followup` | An external blocker path has no Wiedervorlage |
| `blocked_without_clear_path` | A dependency path ends in captured/someday/non-operational work, a missing task, or a corrupt cycle |
| *(healthy)* | At least one meaningful path reaches executable work or an intentional external wait with a revisit |

`completion_review` is a distinct classification from the other three
reasons: a project with no remaining open tasks is **not** stuck — it is
healthy and simply ready for a completion decision. The backend still reports
it through `stuckReason` (Review needs to surface it as maintenance work), but
the frontend's `apps/web/src/lib/projectListFilter.ts` maps it to its own
`"active-review"` presentation classification (sorted with active work, styled
with a distinct accent) rather than folding it into `"active-stuck"`.
`ProjectStuckNotice`/`ProjectStoryRow`/`ProjectAgendaRow` all branch on this
same distinction to avoid framing "ready to complete" as a blocked project.

A reached external-wait revisit remains a task-level attention signal and
returns to Today. It does not make an otherwise valid waiting project
structurally stuck.

Shared tasks without an effective owner are valid actionable work. They do not
make their project structurally stuck.

Dependency chains are deliberately **not** defects by themselves. A sequence
such as `Angebot → Termin → Arbeit → Rechnung → Bezahlen` is healthy while
every unresolved branch leads back to a task that can be done now or to work
intentionally parked with a future Wiedervorlage. An external wait without a
future revisit, captured blocker, someday task, or any other branch without a
progression anchor produces a specific waiting reason or
`blocked_without_clear_path` and may keep the project stuck. Open tasks in
completed/archived projects are not valid progression anchors. More specific
issues remain attached to the terminal blocker so the repair action points at
the cause rather than every downstream task.
Once all blockers close, normal next-action or completion-review semantics
take over.

### Entering successive tasks

`StepComposer` is the shared authored step-entry component used for inline
successors, task splitting, and the post-conversion project handoff. Inline
**Nächsten Schritt danach hinzufügen** still creates one actionable sibling at
the same outline level and makes it depend on its source task;
`POST /api/tasks/:id/successors` performs creation and dependency insertion in
one SQLite transaction. It may include the optional plan or deadline collected
by the shared composer.

Task splitting and project handoff submit every filled row in one request to
`domain/taskStepBatch.ts`. The domain operation checks the selected parent or
project revision and the full containing project chain, creates all tasks,
classifies an Inbox parent with its first child, and runs the Phase 1
commitment evaluator before commit. Missing driver/progress decisions roll back
the complete batch; the UI keeps its rows and renders the server requirements
for an explicit retry. A requested captured-task conversion invokes the
existing guarded role-conversion implementation inside the same transaction.
Undated children do not activate Someday/backlog work. Existing outline
reordering still uses `useOutlineOrganize` and the canonical task move API.

The task row rail offers **Aufteilen** (`task.split`) for ready actions.
Movement remains in task details and the existing structure workflow.
The row does not reproduce task creation or movement semantics.

Outline position (likely work order) and dependencies (genuinely blocked
work) remain distinct: a project's ordinary task list needs neither a
sequence-entry bulk feature nor automatic dependencies between adjacent
outline rows, since Today already derives the next useful project action
from outline order and eligibility.

---

## 8. Review and exhaustive inventory

### Derived Review — `/more/review`

`apps/api/src/domain/reviewItems.ts` is the single deterministic maintenance
projection. It derives compact project/task diagnoses from the graph and an
injected calendar date; there is no Review table or workflow status.

Review contains structural decisions: missing project driver or progress path,
due-without-plan, malformed waiting, broken blocker paths, XL work without
breakdown, completion review, and age-based reconsideration. It also flags
semantic contradictions between a project's own dates/status and its child
tasks: a backlog project already carrying genuinely executable/actionable open
work (an intentionally scheduled or due child-task date alone is not flagged —
those task dates are allowed planning signals that Week surfaces); a task
scheduled or due before its project's Wiedervorlage (`scheduledDate`); a
project whose deadline precedes its own Wiedervorlage; and a completed/archived
project that still has open child tasks (a repair signal for legacy/corrupt or
externally-created data — normal completion no longer creates this state, since
completion asks the driver to resolve remaining open tasks first). It
deliberately excludes valid shared tasks, absent optional acceptance criteria,
Inbox captures, reached follow-ups, and past planning dates already owned by
Today. More's badge is the exact number of current derived items.

Nullable `projects.reviewed_at` and `tasks.reviewed_at` record only explicit
"keep active/parked/later" decisions. Opening an item never acknowledges it,
and acknowledgement advances the entity revision without changing
`updated_at`. Ordinary edits naturally postpone review because age uses the
latest meaningful update or acknowledgement. Active and backlog project age
also considers descendant activity. The fixed calendar-day leases are 14 days
for active projects, 30 for backlog projects, and 90 for standalone Someday
tasks. Healthy future waiting suppresses generic active inactivity.

Review decisions execute through `useProjectActions` and `useTaskActions`.
Expected revisions, optimistic retention, stale conflicts, and refresh remain
inside those canonical hooks. Focused repair reuses project/task detail,
`TaskOwnerSheet`, `MemberSelectionSheet`, `StepComposer`, and
`AcceptanceCriteriaEditor`. The owner/effort matrix and sizing list remain
available as optional secondary planning tools rather than a separate
Refinement workflow.

### Aufräumrunde — `/more/cleanup-round`

The Aufräumrunde is an on-demand, advisory planning-clarity pass over semantic
work-item quality. It does not replace Review/Stuck Detection's mechanical
workflow hygiene: Review knows owners, dates, waits, blockers, next actions,
stuck reasons, status, and review age; the Aufräumrunde asks a Home Assistant
AI Task whether a few sampled items preserve enough intent, outcome, and
decision structure for a tired human to resume them without reconstructing the
plan from memory.

- **Sampling** (`apps/api/src/cleanupRound/sampler.ts`) selects, not
  diagnoses: up to five open tasks (captured/actionable/someday action tasks in
  no or an open project) and active/backlog projects visible to the viewer,
  excluding items reviewed in the last seven days and items already in an open
  round. Weighted randomness favours staleness, notes, children, and vague
  titles, caps two items per project/parent cluster, and mixes tasks with
  projects when possible.
- **Contract** (`packages/shared/src/cleanupRound.ts`): each sampled item is
  sent as a `CleanupItemContext` with mechanical facts as context only. The AI
  must not report missing owner/due/scheduled/revisit dates, stale age,
  blocked state, or graph next-action gaps as findings; those belong to
  Review/Stuck Detection. It instead looks for unclear intent, hidden
  decisions, vague outcomes, wrong shape, weak uncertainty-reducing slices,
  incident follow-up, and admin target ambiguity. A sparse `planningContext`
  adds only relevant open/waiting/done children, the current next action, and
  non-empty project acceptance criteria, bounded for the Home Assistant AI
  Task; empty/default/null fields and the context itself are omitted when
  there is no useful evidence. This lets the AI avoid duplicating existing
  plans or completed work without receiving the whole graph. The AI returns
  one `CleanupTriageResult` per item from closed proposal, resolution surface,
  inferred work type, and flow vocabularies. Work type and uphill/downhill are
  reasoning lenses and are never persisted on tasks or projects.
- **Validation** (`validate.ts`) normalizes strings and enums, trims excessive
  text, rejects unknown targets, type mismatches, duplicates, and malformed
  entries as warnings, and keeps raw and validated responses separately. All
  valid → `ready`; some → `partial`; none → `failed`. Retry re-analyzes only
  `failed` items, keeps accepted (`ready`) cards and the round summary, and
  feeds validation issues back into the prompt; a round that still holds
  accepted cards stays `partial` even when the retry fails. Failed items stay
  reserved from new rounds while their round is open. The Home Assistant
  structure only enforces the response envelope; this validator is the strict
  boundary: the Home Assistant result fields are optional and nullable, so an
  incomplete entry reaches this validator and becomes one `schema_invalid`
  warning (the round turns `partial`) instead of failing the whole response.
- **Persistence**: `cleanup_rounds` and `cleanup_round_items` are temporary
  operational state (24-hour expiry, purged with intake jobs); a
  `home_assistant_requests` row belongs to either an intake job or a round.
- **Resolution**: AI results never mutate work items by themselves; every
  change needs an explicit user confirmation. “Hinten anstellen” reuses the
  canonical Review acknowledgement (`reviewedAt`) and is the only action that
  sets it. “Einschätzung ausblenden” only dismisses the card. The pure mapping
  in `apps/web/src/lib/cleanupRound.ts` turns each surface into one of:
  - a **micro-flow** (`CleanupMicroFlow`) for text-shaped surfaces. The card
    shows the AI suggestion as an editable answer; the button opens
    `CleanupRoundActionSheet`, which loads the current item and shows the
    target plus the exact title/text before anything is written. Confirming
    sends one request to a narrow action endpoint,
    `POST /api/cleanup-rounds/:id/items/:itemId/actions/<action>`
    (`apps/api/src/cleanupRound/actions.ts`). In one transaction it checks
    that the round is open and the card is open and `ready`; that the action
    fits the card's stored `resolutionSurface` (`rename` ← `rename_item`;
    `create-task` ← `create_decision_task`/`create_first_slice`/
    `create_followup`; `add-done-when` ← `edit_done_when`; `clarify-admin` ←
    `clarify_admin_target`; otherwise `cleanup_round_action_surface_mismatch`,
    and a missing or unreadable stored result is rejected); and that the
    target still exists with the card's type. It then calls the canonical domain
    function and dismisses the card (never `reviewedAt`). Either the item
    improves and the card disappears, or nothing changes; the page renders the
    returned round:
    - `rename` (rename_item): `updateTask` / `updateProject` with the loaded
      `expectedRevision`, so stale writes are rejected;
    - `create-task` (decision, first slice, follow-up): `createChildTask`
      under a task, or `createTask` with `projectId` in a project, with the
      normal owner/context/tag inheritance;
    - `add-done-when`: `addCriterion` for a project; for a task, the
      `appendTaskNotes` notes append of the `Erledigt, wenn: …` block;
    - `clarify-admin`: a rename to `suggestedTitle` and/or a notes append with
      the recipient/document details, both previewed and editable; at least
      one must change, and `expectedRevision` is checked before either write.
  - an existing `useWorkItemCommands()` workflow where Machbar has no specific
    change to offer: `task.convertToProject` (choose_shape → project; its sheet
    is already the confirmation), `task.plan`/`story.defer` (rhythm/revisit,
    no date prefilled), `task.structure`/`story.structure` (“Öffnen und
    strukturieren”), and “Öffnen und als Information prüfen” for reference
    suggestions. There is no canonical action → reference conversion
    (`makeTaskAction` only promotes references), so Machbar does not add a
    parallel one.
  - no extra button, when the surface only reaches the plain item view that
    the card's own “Öffnen” already covers.

  There is no generic “apply AI result” endpoint: each action endpoint accepts
  only its own strict payload and reuses the canonical domain function inside
  the card-resolution transaction. Failed items
  stay visible as cards with open and hide; a single failed item carries its
  own retry, while several failed items share one banner retry.

The More entry appears only when the Home Assistant AI Task is ready. Older
Home Assistant components answer the new request kind with
`unsupported_request`, so the round fails visibly instead of hanging.

### Alles — `/more/all`

Alles evolves the existing Search implementation. It composes `getProjects()`
with `searchTasks()` and `SearchFilterBar`; it does not introduce another
storage or indexing model. With no filters, every non-deleted project is a
first-class entry and standalone task trees cover all lifecycle/blocker states.
Project descendants are reached through project detail rather than duplicated
beside the project. Active search/filtering may return a matching nested task
directly and searches project title/notes as well as tasks.

### Projects tab — `/projects`

`ProjectsPage` renders the same `ProjectStoryRow` (card variant) for active,
backlog, completed, and archived projects. Active stories stay primary, backlog
stories render in their own visible but collapsed-by-default **Später / noch
nicht aktiv** section, and completed/archived stories remain folded.

- **Right swipe / primary button** runs the status-appropriate next step: only `active → abschließen` and `backlog → aktivieren` have a primary/forward action. Completed and archived projects are terminal and offer no primary swipe — reopening and restoring are deliberate actions from the status rail instead, never the one-tap default. Backlog activation is also offered from Review, Alles, and project detail where applicable. The button (`.story-row-primary`, `aria-label` = the action, or the disabled generic "Workflow-Schritt" glyph for terminal statuses) is the explicit non-gesture equivalent and stays available on touch.
- **Left swipe / ⋯** asks what should happen next with the item, revealing up to three contextual interventions in one horizontal row. Lifecycle transitions remain in the separate right-swipe rail.
- The candidate action is always intersected with `availableActions`; `lib/projectWorkflow.ts` mirrors the backend's `workflowActionsByStatus` map (and is reused by the test fixtures) so the UI never offers an illegal step. `archived` only ever offers `return_to_backlog`; there is no direct `archived → active` shortcut anywhere in the UI.
- Activation requires a driver plus an executable progress path or intentional
  healthy future wait. Focused preflight opens `MemberSelectionSheet` or the
  existing task composer for the missing decision and then uses the canonical
  project action.
- Completion is intercepted centrally by `lifecyclePrerequisite()` in
  `lib/projectWorkflow.ts`, not by special-casing individual buttons: unchecked
  acceptance criteria open `CompleteWithCriteriaSheet` (the focused checklist,
  never the structural `StoryCriteriaSheet`/`editOutcome` editor), and — once
  criteria are satisfied or absent — remaining open child tasks open
  `CompleteWithOpenTasksSheet`, which lets the driver cancel or move each one
  (reusing `useTaskActions().requestCancel` and the canonical
  `task.changeProject` command) before the primary "Projekt abschließen"
  action becomes enabled. Every entry point still dispatches the same semantic
  `story.complete` command.
- Task completion with retained criteria is resolved centrally in
  `useWorkItemCommands()`: unchecked criteria open the shared
  `CompleteWithCriteriaSheet`, then dispatch the same `task.toggleDone`
  command after the criteria are checked. The API independently validates
  criteria inside the canonical task completion transaction.
- Every row shows its status; inside the retention window the same badge shows what just happened (`Aktiviert`, `Abgeschlossen`, `Wieder geöffnet`, `Zurück im Backlog`, `Archiviert`).

#### Filtering and ordering the list

`lib/projectListFilter.ts` is a pure `filterAndSortProjects(projects, { query, scope, currentMemberId })`, unit-tested on its own and called once per render by `ProjectsPage`:

- **Search** folds diacritics (`NFD` + combining-mark strip) and lower-cases both sides, then substring-matches the title **and** every `acceptanceCriteria[].text`. The list endpoint already returns criteria (`Graph.load`), so no extra request is needed.
- **Scope** is `mine` by default — the selected member's stories plus `ownerMemberId === null`. With no identity selected there is no "mine", so it collapses to unassigned-only rather than to everything. `all` disables the filter. A third state, `work`, shows only the current member's own `scope: "work"` items (household items are excluded); `nextAgendaScope` in `apps/web/src/lib/todayScope.ts` defines the shared Mine → Household → Work cycle order and is reused by `TodayPage`, `WeekPage`, `ProjectsPage`, `WaitingPage`, and `InboxPage`.
- **Sort buckets**, in order: active & healthy, active & ready-to-complete
  (`completion_review`), active & `stuckReason`, active with a future-scheduled
  next action, active waiting, backlog, completed, archived; ties break on
  `position`, then `title.localeCompare(…, "de")`, then `id`, so the order is
  stable across reloads and retentions.
- Active rows form the primary list. Backlog rows form a visible **Später /
  noch nicht aktiv** disclosure that starts closed by default. Completed and
  archived rows keep that same deterministic order inside the folded
  **Abgeschlossen & archiviert** section. A non-empty search reveals matching
  terminal rows automatically.
- Filtering runs **before** sorting, and retained (optimistic) rows are merged into the same input list, so a retained row obeys the current search/scope and can never render twice next to its refetched counterpart.
- `ProjectsPage` distinguishes *no stories at all* (`noProjects`) from *nothing matches* (`noMatchingProjects`) by testing the unfiltered list first.

#### Status accents and a single progress bar

`statusAccent(story)` collapses status + `stuckReason` into six values — `backlog | active | review | stuck | completed | archived` — and every colour-carrying element keys off that one class (`.story-row-accent-*`, `.story-row-status-badge--*`, `.story-row-primary--*`, and the primary swipe background). An `active` story with a `stuckReason` therefore reads as a warning, not as healthy progress, except `completion_review`, which renders as the distinct `review` accent — ready to complete, not stuck — and `backlog` is deliberately not green.

The four targeted actions render as icon-only 44 px buttons (`.story-row-chip-icon`) with inline, `aria-hidden`/`focusable="false"` SVG glyphs; the German `aria-label` **and** `title` carry the accessible name, so nothing is conveyed by the glyph alone. Workflow transitions stay labelled text chips.

The row shows **one** progress bar — task completion, marked up as a real `role="progressbar"` with `aria-valuenow/min/max` and `aria-valuetext` (`2/4`). Acceptance-criteria progress is core outcome content instead: `ProjectDetailPage` renders a visible **Ergebnis** checklist with its `done/total` count, direct check/uncheck, and an explicit `story.editOutcome` entry into the structural editor.

### Status is a badge, transitions are buttons

No surface offers the project status as a `<select>`. `ProjectStoryRow` and `ProjectDetailPage` both render the status as a read-only badge (`projectStatusLabels`, plus an `.sr-only` "Status:" prefix on the row) and expose the change itself as thumb-sized, explicitly named buttons for exactly the transitions in `availableActions`, grouped in a `role="group"` labelled `Status`. Both reach them through `story.lifecycle` and map the chosen action onto its `story.*` command with the shared `storyWorkflowCommand()` in `commands.ts`. Tests assert the absence of a status combobox, so a dropdown cannot creep back in.

### One headless horizontal-swipe primitive

`useHorizontalSwipe` owns drag distance, the 8 px slop, delayed pointer
capture, horizontal/vertical intent, clamping, thresholds, cancellation, and
one-shot click suppression for `TaskRow`, `ProjectStoryRow`, `RefinementTaskRow`,
and guided capture cards. Callers can opt out of interactive-control starts.
Disabling the hook cancels an in-flight gesture. It captures from
`pointermove` only after a real drag, never from `pointerdown`, so ordinary taps
and mouse clicks inside rows remain reliable. Labels, backgrounds, actions,
and swipe-coach policy stay local to each row.

The outline's structural drag is a *separate* gesture and deliberately uses
window-level listeners instead of pointer capture. The handle's `pointerdown`
stops propagation, and TaskRow cancels horizontal swipe when its hierarchy
long press becomes real, so the two mechanics never run at once.

`useOutlineOrganize` separately suppresses the handle click synthesized after a
real structural drag. Both suppression paths are one-shot and reset for the
next independent pointer sequence.

### Optional planning tools

The owner × effort matrix remains a collapsed secondary view inside Review,
backed by `GET /api/refinement/owners` and `GET /api/refinement/tasks`.

`RefinementTaskRow` supports:

- **Effort** — `lib/refinementHelpers.ts` defines the pure
  `S → M → L → XL → (none)` cycle; swipe and tap execute it through
  `useRefinementActions.cycleSize`/`setSize`/`clearSize`. `XL` with no open
  child produces `too_large_without_children` and suggests adding a child.
- **Assignment** — the *Zuweisen* chip opens `TaskOwnerSheet` with the
  `TaskOwnerChoiceGroup`, **not** the full task detail sheet. The owner picker
  keeps the three persistence semantics distinct without exposing raw
  `inherit` / `explicit` / `none` storage terms: inherited owner (when one
  exists), deliberate shared/unassigned, or an explicit member. Standalone
  tasks omit a meaningless inherit option. `useRefinementActions.assignOwner`
  optimistically retains the row and rethrows on failure so the still-open
  sheet renders the error.

Task metadata execution and owner-assignment semantics live in the non-React
`lib/taskMutations.ts`. `useTaskActions` and `useRefinementActions` both use
that revision-safe executor, but deliberately keep separate optimistic
projections: normal task lists retain a `Task`, while the planning tools retain their
owner × effort row so regrouping waits until the retention window elapses.

---

## 9. Web Interaction Patterns

### Three editing contracts

Editing surfaces follow three explicit contracts:

1. **Discrete properties** such as owner, tags, dates, and lifecycle transitions
   save immediately after one deliberate choice.
2. **Authored content** such as titles and notes uses an explicit edit state
   with Save/Cancel; drafts are never persisted by closing a sheet.
3. **Compound workflows** such as external-wait follow-up and task hierarchy
   movement map to one atomic backend command.

Focused sheets may own drafts and user intent, but not a second mutation
implementation. Task metadata and external-wait execution flow through
`useTaskActions`; project metadata and lifecycle changes flow through
`useProjectActions`. `ProjectDetailPage` is the sole project-notes editor.

### One canonical mutation path

Shared domain semantics live in small explicit modules rather than a generic
repository or command bus. `taskMutations.ts` owns revision-safe task metadata
execution and owner assignment semantics. React action hooks add the optimistic
projection appropriate to their view. `useRetainedMutations` supplies common
per-entity pending state, localized errors, stale-conflict refresh, confirmed
result handling, and optional retention.

Presentation components call those paths instead of rebuilding revision,
refresh, and error handling. Unique workflows such as SharePage's append/date
conflict behavior stay local because they do not duplicate an established
action contract.

### Optimistic retention

`useRetainedMutations` separates confirmed/optimistic values from `holdingIds`.
Task and project controllers opt into immediate refresh on success. Their
confirmed overlays outlive the four-second display window and are reconciled
by revision, preventing stale reads from restoring old controls. Query owners
feed raw flattened task responses into reconciliation, including project
details, task details and Waiting; projected row props are never authoritative. The window
starts after confirmation; failures roll back without a pending expiry.
Refinement's existing matrix projection still uses delayed refresh.

`useRetainedPlacement` owns view-local placement, not domain state. Today,
Inbox, Waiting, discussion, inventory, project groups and task outlines retain observed
rows (including their ancestor path) at their old position while holdingIds
contains them. This keeps the last item and its section mounted during an
immediate refresh, suppresses copies in destination buckets, and resets on
explicit filter/identity changes. Rows removed from structural outlines do
not become drag targets.

`useRetentionInteraction` leases the display window while row menus,
workflows, details, keyboard focus or pointer gestures are active. The last
lease's release provides at least two seconds of orientation time. Pointer
focus alone does not hold a row indefinitely. Only an in-flight request
disables mutation controls; retained rows remain readable and actionable.

### Focused quick sheets

Interactions target one field at a time instead of opening the full detail sheet:

| Component | Purpose |
|-----------|---------|
| `TaskQuickActionSheet` | Focused task schedule or notes editing; execution is supplied by `useTaskActions` |
| `TaskOwnerSheet` | Focused task-owner chooser that preserves inherit / explicit / none semantics without exposing storage terminology |
| `TaskOwnerChoiceGroup` | Task-owner chips for inherited owner, shared/unassigned, and explicit members |
| `MemberSelectionSheet` | Reusable household-member picker for project-driver and other non-inheritable member choices |
| `MemberChoiceGroup` | The tap-chip choice group rendered by assignment surfaces |
| `AcceptanceCriteriaEditor` | Reusable ordered criteria editor, rendered by `StoryCriteriaSheet` and the task-detail criteria disclosure |
| `StoryCriteriaSheet` | Targeted criteria popup for a story row |
| `CompleteWithCriteriaSheet` | Focused project/task completion continuation when criteria remain unchecked: shares the `AcceptanceCriteriaChecklist` and commits the canonical completion command after the user checks all criteria |
| `CompleteWithOpenTasksSheet` | Focused `story.complete` continuation when criteria are satisfied/absent but open child tasks remain: lets the driver cancel or move each task (reusing `useTaskActions().requestCancel` and `task.changeProject`) and commits the same completion transition once no open tasks remain |
| `ProjectDeferSheet` | Canonical backlog-project Wiedervorlage (`scheduledDate`) editor |
| `ProjectDeadlineSheet` | Project deadline (`dueDate`) only |
| `TaskPlanningSheet` | Owns the shared scheduled/recurrence/reminders/waiting/revisit/deadline draft; composes the draft-only `TaskRemindersEditor` and delegates one revision-safe atomic update, pending state, errors, and refresh to `useTaskActions` |
| `DestinationPicker` | Searchable refile destination list with recents (see below) |

Assignment surfaces read members from `useIdentity`, so tests mounting them
must wrap in `IdentityProvider` and mock `api.getMembers`.

### Assignment pickers are tap chips, not selects

A household has at most ~5 members, so every focused assignment popup renders the full choice set as chips through `MemberChoiceGroup`:

- No native `<select>` overlay stacked on top of a bottom sheet, and one tap instead of open-scroll-confirm.
- A `role="group"` labelled via `aria-labelledby` (`Zuständig` / `Verantwortlich`), with each chip reporting `aria-pressed` — selection is never conveyed by colour alone.
- An explicit "nobody" chip (`Gemeinsam / offen` for tasks, `Niemand zugewiesen` for stories) where clearing is legal. Driver activation omits it because the API rejects activating without a driver.
- Chips keep a ~44 px touch target (`.choice-chip`) and wrap rather than scroll.

`TaskDetailSheet` is no longer an inspector and owns no scalar-property
editor at all. It reads as a document: authored title and notes with explicit
Edit/Save/Cancel, a compact meta row of *current* values, and the two real
collections (subtasks, dependencies) as disclosures, followed by
`Weitere Aktionen`, `Organisation`, activity and deletion.

Every scalar value in the meta row is a button that dispatches the same
semantic command as the fixed rail and keyboard — owner, planning, waiting,
recurrence, priority, tags and contexts. Unset rare properties render nothing;
only owner, planning and waiting keep a lightweight `+ …` affordance. Status
shows as a clickable badge that toggles its own inline lifecycle chooser
(`task.lifecycle`), not a `Weitere Aktionen` tile. Movement (`task.changeProject`),
split (`task.split`), and convert-to-project (`task.convertToProject`) live in
the existing `Struktur` workflow, also available in details, and successor creation is the
contextual "+" in organizable outlines — none of them duplicate into
`Weitere Aktionen`, which now holds only genuinely uncommon actions with no
other affordance (priority/recurrence when unset, the additional-next-action
toggle).

Focused task workflows may derive optional structured suggestions from the
task title through the React-free `lib/captionHints.ts` primitive. It retains
source and removal spans, resolves German/English calendar phrases against the
task's original `createdAt`, and ranks matches only against known members,
tags, and active Home Assistant contexts. `CaptionHintSuggestions` renders at
most three matches inside the existing plan, owner, tag, context, or start-wait
sheet; there is no parsing dialog and capture syntax is unchanged.

Suggestion acceptance remains part of the owning workflow. Planning stages
accepted spans until **Fertig**; owner, tag, and context acceptance sends the
structured field plus cleaned title through the existing revision-safe task
PATCH. Ignoring or cancelling is inert, and cleanup never creates an empty
title. Starting an external wait is the deliberate exception: its person/text
and follow-up-date hints only fill the existing local draft and preserve the
title, because the dedicated wait command remains one backend operation and is
not expanded with unrelated title metadata.

`ProjectDetailPage` is the same shape for stories, and `ProjectEditSheet` is
gone. The page edits only its authored title and notes in place; driver,
dates, tags and contexts are meta-row values that dispatch
`story.assignDriver`/`story.defer`/`story.deadline`/`story.tags`/`story.contexts`, and the
driver avatar itself is also directly clickable for the same
`story.assignDriver` shortcut.
Outcome is visible **Ergebnis** content: `AcceptanceCriteriaChecklist` shares
the direct `useCriterionCheck` mutation with `AcceptanceCriteriaEditor`, while
the explicit `story.editOutcome` action is the sole route for changing
criterion structure — reachable both from the row rail's `Struktur` sheet and
from the contextual icon button next to the outcome section. Its genuine
non-property commands (there are none left once `story.planWork`/
`story.defer` moved into the fixed rail) mean the page's own `Weitere
Aktionen`/`ActionTileGrid` section is gone entirely; `ActionTileGrid` is now
used only by `TaskDetailSheet`'s trimmed `Weitere Aktionen`.
Deleting the sheet also deleted its private copies of
activation-driver, activation-progress and completion-criteria prerequisite
handling, which `resolveStoryPrerequisite()` already decides once. Review
repair links (`?focus=driver|completion|outcome`) dispatch those same
commands rather than scrolling a form to a field. Filters
(`SearchFilterBar`) are unaffected; settings (`MorePage`) no longer has a
rail-favorites configuration section since the rail is fixed.

### Outline structure editing: drag and keyboard

The old global "Sortiermodus" and its seven-button panel under *every* row — and later, the intermediate single selected-task toolbar — are gone. Structural editing now lives in two files:

| Module | Responsibility |
|--------|----------------|
| `lib/taskTreeMove.ts` | Pure, React-free geometry and tree maths: `slotFromPointer`, `projectDrop`, `locateTask`, `planMove`, `applyMove`, `outlineRootGroup`. Unit-tested on its own |
| `lib/useOutlineOrganize.tsx` | The drag session, the equivalent keyboard moves, the optimistic tree and its rollback; publishes an `OutlineOrganizeValue` through context |

`TaskRow` renders exactly one structural control — the ⠿ handle. Pressing it starts a drag (a row long-press is the touch shortcut into the same drag); arrow keys on the focused handle move the task directly, and `Alt+ArrowUp/Down/Left/Right` moves the interaction scope's active task the same way from anywhere in the row (`lib/useWorkItemKeyboardNav.ts`). A plain click/tap on the handle opens no separate mode. `consumeDragClick()` swallows the click a real drag ends with, so a drag never also fires a stray click.

**Projection.** Rows register themselves (`registerRow`) so the rendered — i.e. currently *visible*, non-collapsed — tree becomes a flat ordered list. The list and its rects are snapshotted once when the drag starts (rows do not move while dragging). `projectDrop` bounds the target depth by the neighbours: at most one level deeper than the row above, never shallower than the row below. All traversals in `taskTreeMove.ts` are iterative and identity-preserving, so a 30-level outline neither blows the stack nor re-renders untouched branches.

**Command mapping.** `planMove` returns either no-op or one concrete
destination (`parentTaskId`, optional root `projectId`, `position`, and the
rendered `expectedRevision`). `useOutlineOrganize` always sends that destination
to `POST /api/tasks/:id/move`; indent/outdent are geometry, not API operations.
`targetIndex` is always counted inside the destination sibling group excluding
the moved task, matching the backend contract.

**Optimism and rollback.** `applyMove` renumbers `position` in both affected groups the same way the server's `reindexGroup` does, otherwise the position-sorted render would snap straight back. Position normalization is group bookkeeping and does not advance sibling revisions; the explicitly moved task advances exactly once, so the optimistic tree can carry its deterministic next revision and safely accept another move immediately. The override survives unrelated older refresh responses and drops only when authoritative data reaches that revision. A rejected move restores the previous tree **in place** and shows `Verschieben fehlgeschlagen` plus the server message on that row. A stale rejection refreshes authoritative data and blocks only that stale task until its revision advances; other hierarchy edits remain available.

**Where it is offered.** `TaskOutline` takes an explicit `organizable` prop and only `ProjectDetailPage` passes it: `GET /api/projects/:id` returns `graph.rootsByProject`, the complete stored sibling group. Compiled views (`TodayPage`, `InboxPage`, `AllPage`) show a filtered slice of tasks from unrelated groups, where a position read off the screen would be applied to the *full* group on the server and silently shuffle rows the user never saw. `outlineRootGroup` is then applied on top as a structural second guard (all roots must share `parentTaskId` **and** `projectId`). Retention ghosts are rendered outside the organize provider, so they get no handle and never shift a drop index.

### Compact descendant presentation (Today)

`TaskOutline`'s `compactDescendants` prop is a presentation-only mode, not a
different data path. `TodayPage` passes it on every `TaskOutline` it mounts;
`ProjectDetailPage` never sets it, so the full outline is unchanged there.

`TaskRow` derives its own compactness as `depth > 0 && compactDescendants`: the
root row of any Today card always keeps its full metadata stack (tags, notes,
attachment preview, next-action badge, scheduled/revisit/project-due chips),
while every nested descendant renders only the title, its status control, and
the high-value signals (owner, due date, waiting/blocked) — this keeps
execution context legible without duplicating Project Detail's authoring view.

Entirely-terminal descendant subtrees (a `done`/`cancelled` task whose own
children are all likewise entirely terminal) collapse behind an inline
"N erledigt anzeigen" affordance instead of rendering by default; expanding it
reveals them inline and it can be collapsed again. The prune is recursive but
never hides a path to open work: a terminal task with a still-open descendant
stays visible so that descendant remains reachable. A task currently held by
`useTaskActions`'s `retained` map is always exempt from the prune, so a
just-completed child stays visible through its existing retention window
instead of vanishing straight into the summary. The parent's `done/total`
progress count is always computed against the full, unpruned `children` array.

**Details that are easy to get wrong, and are covered by tests:**

- Window `pointermove`/`up`/`cancel`/`keydown` listeners are installed through *stable* dispatchers that forward to a ref, so a re-render mid-drag cannot leave a stale listener attached.
- The `mounted` ref is re-asserted **on mount**, not only cleared on unmount — React `StrictMode` mounts, unmounts and remounts every effect in development, and a one-way flag would leave every later move without refresh, without rollback and permanently "busy".
- Re-parenting unmounts and remounts the row, which would drop keyboard focus; the hook remembers the row and restores focus to its handle once the new DOM node exists (one attempt only, so it can never steal focus later).
- Dropping into a **collapsed** parent would hide the moved row, so the hook publishes an `expandRequest` the addressed row reacts to (collapse state is per row).
- A drag is announced through a `role="status"` live region, since the gesture has no meaning for assistive tech.

`MoveTaskSheet` always renders both the project and parent destination pickers
in one step — there is no separate `parent`-only mode, since a project-only
move is not representable in the `work_items.parentId`-only hierarchy anyway,
and the combined shape is a strict superset. It is opened from
`task.changeProject`, dispatched from the `Struktur` workflow
(`TaskStructureSheet`), available in task details and clarification rails via `TaskWorkflowHost`:

- **Search** is an always-visible filter over the candidate list, matched case-insensitively (`toLocaleLowerCase`, so German umlauts fold correctly) as a substring of `title + subtitle`. For parent-task candidates the subtitle is the owning project's title, so typing a project name finds its tasks.
- **Recents** (`lib/recentDestinations.ts`) are shown first while the query is empty, in a `Zuletzt verwendet` group, with the remaining candidates under `Alle Ziele`. Once a query is typed the grouping collapses to plain results.
- Recents are stored in `localStorage` under `machbar:recent-destinations:{project,parent}` — separate lists, most-recent-first, de-duplicated, capped at `MAX_RECENT_DESTINATIONS` (5). They are written only after a move the API **accepted**, and a corrupt/unavailable entry degrades to "no recents" rather than failing.
- `pickRecent()` filters recents against the *current* candidate list at read time instead of pruning storage, because a destination can be unavailable in one picker (excluded as the moved task's own subtree) yet perfectly valid in the next.

The picker only selects. Every submit sends a concrete `{ projectId,
parentTaskId }` pair to `moveTask`; the moved task's own subtree is still
excluded from parent candidates
client-side, and hierarchy/cycle validation stays server-side
(`wouldCreateHierarchyCycle` / `wouldCreateDependencyCycle` in
`apps/api/src/repo/treeRepo.ts` and `dependencyRepo.ts`).

### External-wait planning

The shared `TaskPlanningSheet` owns the local draft for the waiting reason,
waiting start/end, revisit, scheduled date, and deadline. Opening cards,
editing text, selecting dates, and ending or undoing a wait are local-only;
the footer commits the complete draft once through `useTaskActions.update()`
and the canonical revision-safe task update mutation. Direct wait resolution
outside planning remains an immediate domain command.

Ending a wait in the shared draft does not silently discard a scheduled date or
revisit. The API applies the existing lifecycle rules in the same transaction,
and the UI blocks invalid date combinations before commit while preserving the
draft for correction.

Task reminders and recurrence use this same planning draft and commit. The
reusable `TaskRemindersEditor` only edits reminder inputs; it does not write to
the API. Recurrence interval and its first scheduled date are collected
together. The canonical task update derives each subsequent occurrence from
the prior completion, and the initial inclusive deadline from that first date
plus the allowed deviation. Turning recurrence on is an execution commitment,
so it uses the same explicit project activation requirements as other planning
commitments. A future first date remains outside Today until it becomes
eligible. A stale-write retry rebases untouched fields onto the current task
snapshot; when the same field changed both locally and on the server, the user
chooses which value to retain before retrying. An open custom-reminder editor
is included in the outer planning save and invalid dates block that commit.

The obsolete `TaskAvailabilitySheet` and `TaskPlanSheet` compatibility wrappers
were removed; availability entry, DST and caption-hint coverage exercise
`TaskPlanningSheet` directly.

Planning starts with compact value summaries and small add actions. The expanded
sections are presentation state; collapsed date/reminder controls remain mounted
to retain authored text and pending inputs. Reminder control IDs are scoped to
each editor instance so retained and foreground forms cannot collide. Direct targets expand only their
editor, scroll and focus it. Invalid input and same-field conflicts reveal their
section, and unfinished reminder input cannot be collapsed. Recurrence stays
inside the planned-date section. The execution window remains the existing
household-timezone business-hours preset and independent local draft.

Waiting and the overview both read the same revisit date/time draft. The waiting
summary opens the single revisit editor, so conversion, DST validation and
conflict decisions cannot diverge between contexts. Selecting a date retains
the existing plan/revisit replacement semantics; changing editor visibility
never clears a value.

Prerequisite titles dispatch `task.open`; removal remains a separate explicit
dependency commit, as does recording a wait follow-up. Unresolved prerequisites
appear first; resolved links are behind an explicit disclosure. The workflow
context retains each nested planning workflow during detail inspection. Both
`task.open` and task-role `workItem.open` suspend the foreground planner.
The host keeps each component mounted in its original slot and suspends
its `BottomSheet` registration, allowing the normal task detail and any focused
operation launched there to occupy the foreground. Closing detail restores the
most recent planning workflow and, where applicable, the prior detail/queue snapshot using
`TaskDetailProvider`'s existing handoff methods. No planning state is serialized
or committed for navigation, and no separate prerequisite viewer is introduced.

### Paperless-backed Markdown attachments

`apps/api/src/integrations/paperless/` is the only code that knows Paperless
authentication, generated OpenAPI response shapes, or upstream paths. Focused
Fastify routes under `/api/integrations/paperless/documents` expose upload,
search, thumbnail, preview, and download through Machbar's existing session and
Origin protection. `/api/integrations/paperless/status` exposes only whether
Paperless is configured and the public document UI base URL, never the API
token. `PAPERLESS_URL` and `PAPERLESS_API_TOKEN` are optional as a pair;
ordinary task/project behavior has no Paperless dependency.

`apps/web/src/lib/paperlessAttachments.ts` is the canonical conversion from a
browser `File` or existing Paperless result to Markdown and the canonical
projection back from Markdown into ordered attachment references. Images become
`![name](paperless:id)` and other documents become `[name](paperless:id)`.
The same projection feeds detail attachment strips, attachment-aware notes
summaries, and the single subdued thumbnail shown by shared task rows. No
attachment metadata is persisted outside notes.

`MarkdownAttachmentSheet` owns camera/file/search resolution and supports both
cursor insertion in an authored notes draft and immediate append through
`useTaskActions`/`useProjectActions`. Once a file upload resolves, a failed
notes mutation retries the resolved Markdown reference rather than uploading
the bytes again. `MarkdownNotes` maps only valid positive IDs to same-origin
Machbar binary routes and keeps its existing scheme allowlist for all other
links. Thumbnail responses use a short private browser cache; previews and
downloads remain mediated authenticated routes. `PaperlessAttachmentStrip`
keeps those Machbar routes as the primary action and adds a secondary direct
Paperless-ngx document-detail link for metadata/archive editing.

Global material capture starts in `QuickAdd` but keeps the selected browser
`File` local. `CaptureForm.prepareNotes` uploads immediately before its task
create call, so abandoning capture before commit creates no Paperless document.
Successful uploads are retained across create retries. Capture always creates
a task; project promotion remains the separate `task.convertToProject`
workflow. `CaptureForm` is also the sole frontend application point for Machbar short
syntax and its compact metadata modifiers. `apps/web/src/lib/captureSyntax.ts`
owns React-free lexical detection,
explicit entity-token resolution, date/size token resolution, title stripping,
and structured metadata assembly. Unknown entity-looking text remains ordinary
title text: short syntax can select existing members, tags, physical contexts,
and stories/projects, but it never creates them or guesses by fuzzy match.
New camera images can optionally pass through the shared `ImageCropSheet`
before that upload. Camera capture itself uses a resolution-bounded
`getUserMedia` stream so Android does not need to return a full-resolution
photo through its memory-intensive external camera intent. A hidden file input
remains only as a fallback when direct camera access is unavailable. Cropping
is explicitly requested rather than automatic:
an authenticated, no-store preparation endpoint uses Sharp to rotate and
resize the image within 1280 × 1280 before the phone decodes it. The sheet
renders only that bounded source through `react-image-crop`, providing
touch-native draggable edges and corners plus keyboard resizing. Applying a
crop creates a local JPEG that follows the normal
deferred Paperless upload path; choosing the original leaves the source file
untouched. The API serializes image preparation and rejects inputs above 64
megapixels so concurrent or pathological decodes cannot multiply server memory
use.

The installed PWA's POST share target is deliberately separate from API upload.
`apps/web/public/sw.js` stages title, text, URL, and files in IndexedDB, then
opens the existing `SharePage` with an opaque pending ID. The ID remains in the
OIDC `returnTo` URL, and `pendingShareTarget.ts` removes the staged payload only
after SharePage has created or updated its selected destination. The service
worker never forwards the operating-system POST or bypasses API authentication.

---

## 10. WorkItem projection and interaction architecture

Tasks and projects/stories now share one physical `work_items` table (see
§2). The public API remains role-specific for compatibility, but the storage,
recursive tree traversal, shared lifecycle vocabulary, tags, contexts, and
acceptance-criteria ownership are all WorkItem-based.

**Unified storage.** `work_items` (`apps/api/src/db/schema.ts`) stores both
roles. `role = 'task'` is executable work; `role = 'story'` is a planned
outcome. `parent_id` is the single hierarchy edge, so tasks can contain tasks,
stories can contain stories, and stories can contain tasks at arbitrary depth.
`apps/api/src/repo/treeRepo.ts` owns the recursive CTEs that derive legacy
adapter fields such as `Task.projectId` (nearest ancestor story) and
`Task.parentTaskId` (immediate parent task).

**Shared lifecycle and archival.** `work_items.status` stores the common
`captured | backlog | active | done | cancelled` lifecycle. Task API responses
translate `active` → `actionable` and `backlog` → `someday`; story responses
translate `done` → `completed`. Archival is orthogonal: `archived_at` marks a
shelved story and the story API exposes `status: "archived"` for the existing
frontend workflow labels while preserving the underlying lifecycle.

**WorkItem read projection.** `apps/api/src/domain/workItem.ts` maps a
`TaskRecord`/`ProjectRecord` (from `graph.ts`) onto one shared shape:
`role: "task" | "story"`, the shared lifecycle vocabulary, role-specific label
derivation (`task+active → actionable`, `task+backlog → someday`,
`story+done → completed`), and ordered recursive `children` containing nested
stories and tasks.

**Identity-preserving role conversion.** `convertTaskToStory` /
`convertStoryToTask` (`apps/api/src/domain/roleConversion.ts`) replace the old,
identity-destroying `promoteTaskToProject`: converting a task to a story
(or back) reuses the same numeric id (enabled by the shared identity
above) and re-points `activity_events`/`notification_events`/
`contribution_events` in place, so activity history, tags, and contexts
survive the conversion instead of starting fresh. A root standalone task may
become a story while keeping its descendants and content. Its task-only
commitments are remapped transactionally to a preserved action step; explicit
physical-context bindings, recurrence-derived deadlines, and execution windows
stay on that step. Even a window-only source retains an action, but the window
never creates an execution commitment or activates the project. Project rows
clear the task-only window; reverse conversion preserves child-specific windows
without restoring a window on the container or introducing inheritance.
The source revisit date continues to mean intentional deferral even when an
absolute reminder is also present. The conversion sheet can map both outgoing
dependencies and visible tasks that wait on the source, including to nested
open action descendants; the graph projection omits incoming edges whose
dependent item is not visible to the current viewer. Active commitments and
explicit activation use the shared project-readiness transition, and the
conversion transaction rolls back if the required driver, path, mapping, or
revision is missing. Reverse conversion (story → task) remains conservative
while retaining all task children and acceptance criteria on the same row.
When a backlog project becomes a Someday task, unplanned actionable descendants
are parked with it; dated, reminded, recurring, explicitly selected next-action,
and externally waiting descendants retain their existing operational state.
Completed tasks retain the project's recorded `completed_at`, even when its
title or notes changed after completion.
The converted action task exposes the criteria in its detail and completion
sheet, edits/checks them through the shared work-item criteria domain, and
cannot complete with an unchecked criterion. Nested projects, archived
projects, recurrence with children, and conflicting schedule/revisit mappings
are rejected atomically. Routes:
`POST /api/tasks/:id/convert-to-story`, `POST /api/projects/:id/convert-to-task`.
The web workflow is opened by `story.convertToTask`; its review identifies
which child tasks and criteria will remain. It keeps title and notes drafts on
revision conflicts and calls the canonical conversion endpoint only after
explicit acceptance.

**Semantic commands.** `apps/web/src/lib/commands.ts` defines a pure,
React-free `WorkItemCommand` union (`task.*`, `story.*`, `outline.*`,
`navigate.*`, `capture.open`) — one vocabulary of user intent that mouse
clicks, swipes, row buttons, and keyboard shortcuts all dispatch into
identically. `apps/web/src/lib/useWorkItemCommands.ts` is the one dispatch
surface: it routes `task.*` into the existing `useTaskActions()`, `story.*`
into `useProjectActions()`, `task.open` into `useTaskDetail()`, and
`outline.collapse`/`outline.expand` into the interaction scope's collapse
state. `outline.moveUp/moveDown/indent/outdent` are deliberately **not**
generic here — they dispatch directly against the specific
`useOutlineOrganize()` instance that owns the rendered sibling group (via
the scope's registered `moveBy`), because only that instance can enforce
the compiled-view structural-safety invariant below.
Date commands are semantic too: `workItem.schedule` changes only a task's
`scheduledDate`, `workItem.setDeadline` changes only `dueDate`, and
`workItem.setRevisitDate` changes only a task's `externalWait.revisitDate`.
Project Wiedervorlage never routes through Week; it uses `story.defer`.
`capture.open` invokes the opener registered by the scoped `QuickAdd`.

**Command descriptors.** `apps/web/src/lib/commandRegistry.ts` is the
React-independent descriptor layer for labels, groups, keys, and availability.
It does not execute commands; `useWorkItemCommands()` remains the execution
path. The descriptor registry derives keyboard help and `g` prefix hints, so
shortcut documentation is not maintained as a second handwritten table.
`Ctrl/Cmd+K` command palette UI is intentionally deferred until it can reuse
the same descriptors without introducing a separate combobox/action framework.

**Interaction scopes and the logical active item.**
`apps/web/src/lib/interactionScope.tsx`'s `InteractionScopeProvider` is
mounted once per navigable surface (Today, Inbox, All, a project/story
outline, Waiting, Week). It holds one logical "active WorkItem" plus role
metadata that survives DOM focus changes (editing a field, opening a sheet),
replacing the
outline's previous private selection state; `canReorder`/`canReparent`
flags that only a mounted, `organizable` `TaskOutline` sets to `true` —
compiled views (Today, Inbox, Waiting, All) never do, because their
visible sibling set is not the complete stored sibling group (see §8's
outline section); and per-WorkItem-id collapse state, since folding is
now a structural interaction capability rather than private `TaskRow`
state.

**Keyboard navigation.** `apps/web/src/lib/useWorkItemKeyboardNav.ts`
(mounted per page as `<WorkItemKeyboardNavMount />`, inside that page's
scope) reads `[data-workitem-id]` elements in live DOM order for `j/k`
traversal — this single mechanism naturally skips collapsed (unmounted)
subtrees and spans multiple `TaskOutline`/`ProjectStoryRow` mounts on one
page without a separate registry — and dispatches `outline.collapse`/
`outline.expand` (`h`/`l`) and structural moves (`Alt`+arrows) through the
scope's registered `moveBy`. `apps/web/src/lib/useGlobalNavigationKeys.ts`
(mounted once, above the route table, since a page-scoped provider can't
be read from an ancestor) handles the scope-independent `g`-prefix
navigation sequence and returns descriptor-derived prefix choices for the
which-key hint. `?` opens the scoped `CommandHelpSheet`, `c` dispatches
`capture.open`, and semantic task shortcuts dispatch `task.plan`,
`task.waitingLifecycle`, `task.assignOwner`, and `task.open` (opening the task
detail directly) when the logical active item is a task. These bindings
are independent of the fixed action rail's presentation. Both keyboard hooks
suppress themselves via one shared
`shouldSuppressGlobalShortcuts()` (`apps/web/src/lib/keyboardShortcuts.ts`)
while editing text, or while a `BottomSheet`/modal is open.

**Command rails.** Left swipe means “What should happen next with this item?”
`workItemRail.ts` owns pure, deterministic task/project selection and typed
semantic command descriptors; the shared vocabulary is localized once in
`railLabels`/`railAccessibleLabels`. `WorkItemActionRail.tsx` renders one
non-wrapping row of zero to three buttons, with one prominent action when
attention warrants it. Full accessible names and titles accompany short visible
labels; narrow buttons use ellipsis and retain 44px height. The kebab remains
available on mobile and keyboard, including when no intervention is selected.
An empty rail explains that no intervention is currently needed and directs
people to row-tap details and right-swipe status; it creates no synthetic action.

Task precedence is terminal/reference → no intervention; captured or needing
clarification → explicit clarification acknowledgement, clarification deferral, structure;
external wait → follow-up and planning; dependency-blocked → first unresolved
prerequisite and planning (planning alone if no dependency target is available).
Ready Today revisit prompts offer start today, availability and planning;
Someday offers planning alone; otherwise ready actions offer planning, splitting
and starting an external wait (recurring actions remain leaves and omit splitting). A follow-up opens `task.waitingLifecycle`, the
existing waiting card inside `TaskPlanningSheet`, focused on the follow-up outcome.
Saving that outcome calls the canonical `followUpExternalWait` action to record
feedback and continue or resolve the wait. Ending a wait stays within that workflow.
The rail never offers generic lifecycle changes. Explicit `task.setClarification` (`requested: false`)
acknowledgement delegates to `useTaskActions.clarify`: it clears the clarification
flag and revisit date, classifies captured work as actionable, and preserves the
status of already actionable or Someday work. AI assistance remains a separate
`task.refine` command available through structure and details. Ordinary
clarification flags and discussion nomination remain editable in details.

Backlog projects offer activation timing through the existing `story.defer`
revisit workflow, outcome criteria and structure. Stuck projects offer next-step
planning, outcome criteria and structure in stable order. Completion-review
projects offer outcome/criteria review only (`story.editOutcome`), leaving
completion on the right. Healthy and deferred projects do not repeat their
embedded next action. Active-waiting projects deliberately have no intervention:
waiting is an aggregate and no project-level follow-up/edit-wait command exists;
the underlying tasks own it. Completed/archived projects have no interventions.
Deadline, note and movement shortcuts are absent. The unused shape chooser and
its command/workflow were removed; reference promotion remains in details and
project conversion remains in the existing structure workflow. Discussion nomination is in
task/project details, with existing indicators still visible on rows.

Both rows focus the kebab before dispatch and close the rail so focused sheets
restore focus to a connected opener. Busy disabling and the shared one-open-rail
interaction scope remain authoritative.
The separate status/lifecycle rail (swipe right, `*-row-lifecycle`) is
unchanged and, for tasks, now also carries the waiting
(`task.waitingLifecycle`) affordance into the shared planning sheet.
Contextual successor creation
(a small "+" reading "Aufgabe danach hinzufügen") appears only inside the
two `organizable` `TaskOutline` mounts (project detail's own outline, the
split sheet's subtree editor) via `InlineSuccessorComposer`, not in
compiled views where sibling order isn't visible. Owner/driver avatars in
`TaskRow`/`ProjectStoryRow` are directly clickable shortcuts to
`task.assignOwner`/`story.assignDriver`.
`InteractionScopeProvider` owns the open rail identity and closes other rails
when a new row is opened or the user taps elsewhere.

**Readable detail projections.** Task and project details remain separate
because their domain content differs, but they present current scalar values
as direct actions, omit empty optional metadata, and keep substantive
collections as readable sections. Semantic transformations continue through
the shared command/action paths and focused sheets.

AI refinement launched from `TaskDetailSheet` keeps the existing
`IntakeReviewPage` as the sole job/status/review surface. After a successful
job start, `TaskDetailProvider` suspends the mounted detail sheet without
clearing its text draft, focus or clarification queue. The route carries a
typed return snapshot; leaving the review restores the task context, while an
applied task-to-project conversion clears the obsolete task sheet and opens
the project route. Failed starts leave the launcher in place.

**Still two separate rows and two separate detail surfaces.** `TaskRow.tsx`
and `ProjectStoryRow.tsx` render as fully separate components (they now both
carry `data-workitem-id` and dispatch through the same command layer, but
not a shared JSX row). `TaskDetailSheet.tsx` (a sheet) and
`ProjectDetailPage.tsx` (a route) likewise stay separate. They now share only
`WorkItemDetailDisclosure`; `WorkItemDetailSection` is unused because neither
has always-visible field groups left to title. A full
"one universal WorkItem row"/"one unified inspector" merge is future work,
not yet attempted, given the scale of behavioral difference (swipe
semantics, chip strips, and field sets) between the task and story cases.

---

## 11. Migrations

Drizzle migrations live in `apps/api/drizzle/` and are applied on every server start.

`runMigrations` (`apps/api/src/db/migrate.ts`) wraps `migrate()` in `PRAGMA foreign_keys = OFF` / `ON`. Drizzle runs all pending migrations inside one implicit transaction, where a migration file's own pragma statements are no-ops; without the wrapper, migration `0002`'s table rebuild would cascade into dependent rows.

The current migration set starts with a squashed `0000_baseline.sql` for fresh
installs, including the preserved default tag seed data from the historical
migration chain. New migrations must be forward-only; never edit the baseline
for an already-deployed compatibility fix.

`0001_work_items_merge.sql` is the physical WorkItem cutover. It rebuilds the
identity-only `work_items` table into the unified table, copies every legacy
task/project row exactly once, maps legacy task/story statuses into the shared
stored lifecycle, moves project acceptance criteria/tags/contexts into shared
WorkItem satellite tables, repoints task-only side tables to `work_items`, and
rebuilds activity events around `entity_id`. The migration is covered by
`apps/api/tests/migration-workitems-merge.test.ts`, including status mapping,
satellite-table repointing, deletion-safe activity snapshots, and archived-story
metadata.


### Ordinary intake planning boundary

`intakeCanonicalPlanning` in the shared intake contract interprets canonical
planning for validation, incomplete-draft preparation, review, and Apply.
A present `revisitAt` wins over deprecated availability fields, including
explicit null; only an omitted canonical value permits legacy conversion.
Legacy availability overridden by explicit null is retained as source context
in review and applied notes. Actions require a choice between work date and
revisit; reminders may precede either and deadlines can coexist with revisits.
Projects support deadlines and revisits, with execution dates on child actions.
Unsupported reference planning and project execution dates remain visible
validation blockers. Canonical revisit timestamps follow the existing offset,
household-local, and DST normalization policy with explicit incomplete acceptance.

Apply continues through canonical task/project mutations. A failed transaction
with no persisted work, calendar requests, or retained source documents releases
its claim, clears the accepted draft, and returns to editable `ready` with a
safe concrete application error. Persisted results retain `partially_applied`
and the immutable accepted draft for idempotent retries. Newly tightened planning
checks are grandfathered only for matching committed work in the persisted results;
new acceptance, uncommitted work, hierarchy, reminders, and external payloads
continue to be validated. Review refreshes the
revision after failures while keeping the local edits and selections, and
focuses the visible Apply alert.


### Phase 6a: nested role conversion and project reparenting

`roleConversion.ts` remains the identity-preserving transaction for both roles.
A task below a project or task becomes a child project by changing its role,
keeping `parentId`, `position`, identity and descendant edges. Effective task
ownership/tags/contexts become explicit project values; task-only obligations
continue to use the existing retained action and dependency mappings. A nested
project containing only task descendants can become a task at the same parent
and position. A project with any project descendant remains unsupported: task
lifecycle/outline commands cannot yet represent project descendants. Archived
projects and existing recurrence/wait restrictions still reject conversion.

`structuralMoves.ts` owns the new canonical `moveProject`, exposed as
`POST /api/projects/:id/move`. Supported destinations are another visible,
same-scope project or top level. The operation appends the moved root without
rewriting siblings; descendant links, relations, obligations and ownership
stay attached. `assertHierarchySnapshot`, reused by conversion, checks complete
subtree/ancestor membership and all supplied revisions before any writes.
Source and destination ancestry are reviewed along with the source subtree.
Committed moves and nested conversions use `activateCommittedProjectChain`
inside their original transaction. That adapter walks through intervening task
parents and presents the nearest project parent to the pure commitment rules.

`story.move` dispatches only through `useWorkItemCommands` / `ProjectWorkflowHost`
to `MoveProjectSheet`. It reuses `DestinationPicker`, recents, and
`ProjectActivationDecisionFields`. Conflict keeps the destination and authored
activation choices for retry. Task details expose direct `childStories`; graph
breadcrumbs follow mixed-role parents. The obsolete standalone/nested-root
conversion blockers, duplicate post-conversion activation dispatch, and no-op
project-ID cascade were removed. Merge and compound undo remain separate slices.

Mixed-role follow-up: `treeRepo.getDirectChildren` supplies one direct-parent
sibling order for task/project creation, successors and moves. Task reindexing
includes both roles and updates revisions only when their positions change;
the moved root still increments once. This invalidates stale task metadata,
conversion and project-move snapshots after a neighboring reorder.

`nextActionRepo` traverses mixed-role descendants to identify containers.
Open projects block task ancestors from candidacy; completed, cancelled or
archived project subtrees stop traversal. Its projection supplies the same
open-project container IDs to `Graph.taskContainsOpenProject`, ordinary Today
selection (including standalone tasks) and lifecycle guards. Child projects keep
their own normal next-action lane. Task lifecycle descendant collection skips
terminal project subtrees entirely, preserving their statuses, revisions and
history while allowing the containing task to complete or cancel.


### Today execution eligibility and structural containers

The mixed-role next-action query exposes its existing `blocking_descendants`
structural fact as `Graph.taskContainsUnfinishedWork`, alongside the phase-6a
`taskContainsOpenProject` fact. Unfinished action descendants keep ancestors out
of ordinary Today suggestions regardless of their schedule, revisit, window,
blockers, clarification or parked state. References remain transparent, and
terminal project subtrees remain outside the containing task's unfinished work.
A parent with only terminal action descendants may qualify for wrap-up under
its own rules; compiling Today never completes or otherwise mutates it.

Today supplies `executionDate` to `createAgendaSelection`. Project candidate
selection and standalone execution share lifecycle, owner/scope, blocker,
context, window and date eligibility. The structural next-action order and
readiness remain unchanged; Today can choose an eligible later candidate without
making a future-scheduled project structurally stuck.

Deadline, explicit-plan and reached-revisit roots retain their attention rules,
including external-wait follow-up precedence outside execution windows. Those
roots own their projected descendants. `pruneReferenceContainers` uses Today's
full execution predicate and promotes eligible deeper work through unavailable
intermediate actions and references, retaining identity, parent IDs and sibling
order. A separately qualified attention root owns its own subtree and is not
repeated inside another attention row. Ready descendants embedded beneath an
attention root are excluded from standalone ready lanes. Ordinary execution
roots never expose deferred children. Full detail, Week and Waiting keep their
existing projection defaults; React renders the compiled result without
recomputing domain eligibility or adding a clock.

`TaskRow` preserves compiled child-array order in Today's compact mode:
promoted descendants may belong to different original parents, so comparing
their stored positions would reverse branch traversal. Original positions and
parent IDs remain intact, and full outlines still sort actual sibling groups.

`TaskOutline` owns current IDs, including nested rows, plus removed rows with an
active optimistic retention. Rows that leave without active retention lose
ownership before a later completion in another section. Today keys every
outline by the member/scope selection so ownership cannot survive a logical
selection change. Completion-triggered removal still retains the row in its
owning section for the existing retention window. This is presentation
ownership, not another eligibility rule or timer.

### Intervention-generated task privacy

`work_items.privacy_owner_member_id` is an internal durable owner-only boundary,
independent of household/work placement. `domain/goals.ts` sets it through
`createTaskInTransaction`; migration 0026 preserves it on children and moves.
`Graph.load` filters it on viewer-aware reads. Task/project HTTP boundaries
check visibility before direct-ID mutations. Activity snapshots retain privacy
for deleted work; activity, digest, reflection and notification projections
respect the same owner. Private work never earns shared contribution points.
The existing `assertGoalAccessible`/`assertInterventionAccessible` guards own
HTTP and MCP journal access; coach requests require a concrete matching owner.

### Intervention observation history

`domain/interventionObservations.ts` owns explicit immutable plan snapshots and
revision-aware daily records; HTTP and MCP share these mutations. Contracts
live in `packages/shared/src/interventionObservation.ts`; structural validation
is in `schemas.ts`. Plans are prospective, reports retain reference dates and
initial submission times, and absence is missing. This is separate from task
completion and extends the existing journal, not a reporting task subsystem.

### Manual intervention collection

`InterventionFormSheet` composes draft-only `ObservationPlanEditor`; canonical
`startIntervention`/`adjustIntervention` atomically snapshot plans alongside
journal edits. `recentInterventionReports` projects bounded answerable periods
for `agendaInterventions.ts` and the existing history endpoint.
`InterventionReportCard` is reused by Today focus and goal history, and writes
only through `useGoalActions.recordObservation`. Questions never become tasks.

### Ordinary intervention-created tasks

`domain/goals.ts::backIntervention` is the single backing mutation for all
intervention types, using canonical task creation and `intervention_tasks`
provenance with stable proposal-local keys. `InterventionTasksEditor` authors
only drafts; `InterventionTasksSheet` commits through `useGoalActions`.
The singular backing pointer is a presentation summary; provenance is durable
and retains deleted-work identity. Migration 0028 converts existing pointers.

### Intervention evidence and checkpoint decisions

`domain/interventionEvidence.ts::buildInterventionEvidence` combines versioned
reports with the canonical `buildReflectionBriefing`. Both manual and coach
reviews consume it. `goals.ts::insertAssessment` snapshots evidence and applies
explicit revision-aware continue/adjust/stop transitions transactionally; a
stable review key prevents duplicate acceptance. `InterventionEvidenceFacts`
renders method-appropriate facts and human-readable dated citations in manual, coach and historical review. Its optional selection callbacks edit assessment references only; report records and deterministic totals remain independent.

Read-only `ObservationPlanSummary` in `ObservationPlanEditor.tsx` presents the same plan wording in proposal summaries and historical evidence. Detailed proposal editors and review-window corrections use disclosure; manual review requires an explicit outcome and rationale.

### Bounded coach clarification

`goals/coach.ts` retains one question/answer on the existing reverse request,
validates complete version-2 proposals, and transactionally accepts through the
canonical journal, observation and backing commands. The web reuses
`ObservationPlanEditor` and `InterventionTasksEditor` for proposal review;
`useGoalActions` still owns polling and acceptance and supplies the UI locale. Coach instructions include household timezone, bounded owner-scoped running interventions and recent reviews for the current goal. Clarification state survives failed submissions for direct retry. HA `goal_coach.py` preserves
the same envelope; no generic conversation or automatic task creation exists.

### Evidence-based coach review and lighter continuation

Coach assessment requests snapshot `buildInterventionEvidence` and optional user
reflection. Typed task/observation references are validated against that snapshot;
accepted interpretation uses canonical `insertAssessment` checkpoint transitions.
Migration 0030 stores observation citations and independent standing-reminder
visibility. Daily collection can end prospectively while ordinary tasks continue.
The HA 0.7.4 adapter preserves these fields and requires installation plus restart.

Public task/project routes also check private destination and dependency references
before writes using `assertPrivateWorkItemAccessible`. Canonical hierarchy moves
keep private subtrees within the same owner's private hierarchy or at top level,
so shared-container lifecycle commands cannot mutate another owner's private work.

### Notes append and latest-context previews (#227)

`useTaskActions.appendNotes` and `useProjectActions.appendNotes` own web append
execution through the existing POST notes endpoints. `NotesAppend` is a shared
draft-only Markdown composer. It is disabled during full-document editing so
an unsaved correction cannot be overwritten by an append/refetch. Errors retain
the append draft; ordinary completion and lifecycle state are unaffected.

UI quick-appends use the existing external-wait `[ISO instant · author]` header.
The shared `noteMarkdown.ts` remark transform recognizes only that exact timezone-qualified convention and
`noteEntries.ts` avoids double stamping; free-form prose and code fences remain portable Markdown.
Existing API/MCP append callers retain plain-content behavior (no migration or
server contract change). `MarkdownNotes` renders recognized metadata using the
household display timezone. Full notes and tails parse the entire document with
the same GFM, hard-break and actionable-link plugins. Timestamp presentation is
a small remark transform, leaving reference definitions document-wide.
`NotesTail` derives a responsive suffix from the resolved remark-rehype tree,
retaining safe inline links and removing Paperless/image references.
Metadata is outside the two/three-line content budget. Normal action rows and
project card/agenda rows show tails; compact task descendants and compact/quiet
project inventory rows deliberately do not expand. Reference rows retain their
existing link/material presentation.

Post-completion “Add note” remains pending with #198, which is still open; it
must reuse this composer through the shared completion affordance, not a second
completion prompt. Full-document editing remains available.

### Visible ownership entry on cards (#228)

TaskRow keeps the existing `task.assignOwner` entry visible on every action row,
using effective ownership for personal/inherited avatars. MemberAvatar also
renders neutral shared/unassigned placeholders; unresolved non-null member IDs
retain an unknown-person label and question mark. Reference/material rows have
no assignment control. ProjectStoryRow offers `story.assignDriver` for driverless
backlog cards in every variant, without changing activation or inheritance.
Both controls use the existing workflow hosts/pickers/actions and stop pointer
down/click propagation so assignment cannot start row swipe/long-press actions.
Compact rows keep a reserved inline 44px target; normal cards reserve space for
the existing lower-right assignment position.

### Shared Markdown editor (CodeMirror)

`MarkdownEditor` is the single short-note editor for capture, full task/project
notes, intake editing and quick append. CodeMirror 6 owns input, composition,
selection and history; `@codemirror/lang-markdown` uses CommonMark plus GFM.
The supported Markdown commands continue lists/quotes, reset new task items to
unchecked and handle markup-aware Backspace. `nonTightLists: false` makes an
empty list item exit its level immediately. Shift+Enter inserts a plain line
break, and Tab remains available for ordinary focus navigation.

The existing toolbar and attachment flow dispatch editor transactions into the
same history. `MarkdownEditorHandle` exposes only focus, scrolling, value,
selection and transaction-backed Markdown insertion for the two detail callers; no caller imports CodeMirror. External
controlled values update the document without echoing `onChange`, preserving
bounded selection and establishing a fresh undo baseline. Hardware Shift+Enter
is forwarded through the configured CodeMirror keymap before Chrome Android
defers the event and discards its modifier; software input and IME remain
CodeMirror-owned. Save/cancel and persistence remain owned by callers. The
previous textarea keydown/beforeinput/execCommand continuation path is removed.

Callers must pass asynchronous save/mutation state explicitly through
`MarkdownEditor.disabled`; contenteditable does not inherit a disabled fieldset.
Task/project notes and Capture lock input during submission; quick append
combines its own pending state with the caller lock. Intake content edits are
synchronous draft edits inside a modal, with no asynchronous field save.

### Navigation chrome (#238)

`PageHeader` renders a heading and supplied actions. Generic page information
buttons, expandable page explanations, and their catalog entries are removed;
contextual warnings, privacy disclosures, validation, and gesture/shortcut
instructions remain with the relevant interaction.

Today exposes cleanup (when available), week planning, the existing agenda scope
toggle, and a localized search icon, in that order. Header actions retain 44px
touch targets and wrap below the heading on narrow screens or enlarged text.
Search links to the existing `/more/all` inventory; direct links still work.
`SearchFilterBar` keeps the text field first and keyboard reachable without
programmatic focus, so opening the inventory does not summon a mobile keyboard.
The redundant inventory link is removed from More; other sections keep their
existing names and grouping.

Task right-swipe dispatches `task.primaryAction`: captured tasks retain their
clarification step, open tasks use guarded completion, and done/cancelled tasks
reopen. Pointer, keyboard, and explicit buttons share the existing commands and
completion guards. The swipe settings context, options, and storage reader/writer
are removed; previously stored preferences are ignored without migration.
Left-swipe contextual rails, deep-swipe lifecycle rails, project/refinement
semantics, and mobile drag thresholds are unchanged.

### More tool grouping and reflection labels (#239)

`MorePage` composes the existing links in two ordered tool groups: Shape & plan
(capture, week, readiness-gated cleanup, goals) and Overview & review (Review,
discussion, historical reflection export, activity). Existing preferences,
household and system sections share a visual divider, with the same controls,
capability guards and tab order. No settings or route abstraction is added.
`guidedCapture` and `reflectionStart` remain the canonical localized labels for
all entry points and headings: Kopf freimachen / Clear your mind and Rückblick &
Coaching / Review & coaching. The capture deck, local factual briefing, external
handoff, preview and privacy-consent semantics are unchanged.
