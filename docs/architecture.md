# Machbar — Architecture

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

## 2. SQLite Data Model — Hierarchy and Inheritance

### Entity hierarchy

```
Member   Tag
  │        │
  │        └─────────────────────┐
  ▼                              ▼
Project ──── Task ──── SubTask (Task.parentTaskId)
               ├── Dependency (taskId → dependsOnTaskId)
               └── ExternalWait (one-to-one by taskId)
```

- **Members** are the people who use the app. Every task and project can be assigned an owner (`ownerMemberId`).
- **Projects are household projects or plans.** A project has one responsible
  person, optional due/scheduled dates, free-form `notes`, and an ordered
  **“Erledigt, wenn …”** checklist.
- **Project notes and completion criteria are separate.** `projects.notes`
  stores context, constraints, links, phone numbers, decisions, and
  background. `project_acceptance_criteria` stores structured, individually
  checkable, position-ordered completion rows. Neither replaces the other.
- **Attachments remain notes, not database entities.** A Markdown target such
  as `paperless:4711` is an opaque reference to a document stored by the
  optional Paperless-ngx integration. Machbar stores no attachment bytes or
  authenticated Paperless URL.
- **Tasks** belong to at most one project and at most one parent task (forming
  a tree of arbitrary depth). Each task carries optional household effort
  (`S | M | L | XL`); effort guides splitting and sorting only and never
  changes eligibility or workflow.
- **Tags** are many-to-many with both projects and tasks. Every tag has a
  persisted colour; newly created names map deterministically onto the
  application palette, so colours do not change between clients or renders.

### Inheritance chains

Two kinds of values cascade down the task tree:

| Field | Resolved as `effective*` |
|-------|--------------------------|
| `ownerMemberId` | First non-null value walking up: task → parent task → … → project |
| tags | Union of ancestor tags minus any `excludedTagIds` on the task |
| physical contexts | Nearest explicit task set, otherwise parent/project set |

`inheritanceMode` (values: `inherit` | `explicit` | `none`) overrides the cascade:

- `inherit` — use the nearest ancestor's value (default)
- `explicit` — override with the task's own value and stop propagation
- `none` — explicitly clear the value (no further upward lookup)

The resolved values are exposed as `effectiveOwnerId`, `effectiveTags`, and
`effectiveContexts` on `Task`. Physical contexts are Home Assistant-owned
entities rather than a tag kind.

Tag selection is a reusable compact chip picker in both task and project
editors. Every flexible, non-exclusive tag has one primary kind: Bereich,
Person, or Normal. The picker creates a missing tag with the
kind of its active section and selects it immediately. Inherited task tags
remain separately excludable rather than being converted into explicit task
tags. `TagManager` exposes kind and grouping metadata under **Mehr**;
`DELETE /api/tags/:id` relies on the three join tables' `ON DELETE CASCADE`
constraints, so deleting a tag removes its associations without deleting
projects or tasks.

Projects compute effective tags as their explicit tags plus the effective tags
used by descendant tasks. Bereich grouping selects one primary area per
project: pinned effective area, explicit project area, then the area used by
the most open descendant tasks. Hidden grouping tags never become headers,
and projects without a qualifying area appear under **Ohne Bereich**.

---

## 3. Compiled / Resolved Views

The API computes several derived fields before returning tasks to the client:

| Field | Computed as |
|-------|-------------|
| `effectiveOwnerId` / `effectiveOwnerSource` | Walk parent chain; source ∈ `{task, parent, project, none}` |
| `effectiveTags` | Ancestor tag union minus excluded IDs |
| `effectiveAreaTags` / `effectiveActorTags` | Kind-filtered views of `effectiveTags` |
| `explicitContexts` / `inheritedContexts` / `effectiveContexts` | Stable physical-context requirements |
| `explicitTags` | Tags directly on this task |
| `externalWait` | Nullable unresolved external blocker with a required non-empty reason and optional independent `revisitDate` |
| `blocked` | `true` for actionable tasks with an external wait or any unresolved dependency |
| `executable` | `true` only for actionable, unblocked tasks |
| `blockers` | Structured external/dependency blocker summaries |
| `nextBlockerAttentionDate` | Earliest derived attention date through unresolved blocker branches; never persisted or copied to the dependent task |
| `children` | Direct sub-tasks (recursive to arbitrary depth) |
| `dependencies` | Outgoing dependency edges with their resolution state |

Projects additionally carry:

| Field | Computed as |
|-------|-------------|
| `availableActions` | Workflow transitions legal for the current status (see §6) — the single source of truth for which buttons the UI renders |
| `activationReadiness` | Canonical driver, executable-progress, and healthy-future-waiting evaluation used by activation UI |
| `notes` | Free-form project context, independent from completion criteria |
| `acceptanceCriteria` | Ordered “Erledigt, wenn …” rows with `checked` state |
| `openCount` / `doneCount` | Task rollups |
| `nextAction` | First actionable, unblocked task in canonical outline order |
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
`nextActionRepo.ts`: member scope chooses the first candidate effectively owned
by the member or shared, while household scope preserves at most one candidate
per independent effective-owner/shared lane. A real task deadline or planning
date remains an execution signal even when that task is not the structural next
action. The first matching bucket wins, so a task never appears twice.
Future-scheduled work, captured work, completed/cancelled work, and blocked work
without a reached revisit stay out.

Active projects have a separate compiled `projects` bucket. A project enters
Heute seven local calendar days before its `dueDate`, or once its
`scheduledDate` is reached; reached scheduling prompts persist until the
project is rescheduled or completed. A project qualifying through both dates
appears once with both reasons and its clarified next action, or its existing
stuck diagnosis when no executable next action exists. Project dates never
become task dates.

---

## 4. Transaction Rules

- Every write that touches more than one table (e.g. creating a task + adding tags) uses an explicit SQLite transaction.
- Every structural task change uses revision-safe
  `POST /api/tasks/:id/move`. Reordering, indenting, outdenting, reparenting,
  and cross-project subtree moves are client-side destination calculations,
  not separate domain commands. The transaction validates the rendered
  revision, prevents cycles and recurring parents, cascades project changes
  through descendants, and normalizes both affected sibling groups.
- `POST /api/tasks/:id/promote-to-project` atomically classifies a root
  `captured` task as an active or backlog project. It copies project-compatible
  metadata, promotes direct children to project roots, preserves deeper
  descendants, and removes the temporary capture wrapper. Captured roots cannot
  acquire task-only dependencies, waits, recurrence, reminders, or new child
  tasks before classification.
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
old-query data immediately. Request IDs and effect cancellation prevent stale
or unmounted requests from committing. No external pub/sub is required under
the supported single-process deployment model.

---

## 5. Base Path and integrations

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

---

## 6. Status Lifecycle

### Tasks

```
captured ──► actionable ──► done
                 │
                 ├──► someday ──► actionable
                 └──► cancelled
```

`TaskStatus` is `captured | actionable | someday | done | cancelled`.
`captured` is the current clarification state and appears in **Eingang**.
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
from any non-archived state. Completed work reopens to active; archived work
can either return to backlog or activate directly when ready.

```
backlog ──activate──► active ──complete──► completed
   ▲                    │           reopen ─────┘
   └────return──────────┘
   ▲
archived ──activate──► active
```

`availableProjectWorkflowActions()` in `apps/api/src/domain/mutations.ts` is the **single source of truth** for legal transitions and is surfaced on every project response as `availableActions`. Rules:

- `PATCH /api/projects/:id` **refuses status changes** — status only moves
  through the dedicated workflow endpoints (`/activate`, `/complete`,
  `/reopen`, `/return-to-backlog`, `/archive`).
- Nothing auto-completes a story; completion is always an explicit human decision.
- Acceptance criteria are optional. When none exist, completion is allowed;
  when one or more exist, every remaining criterion must be checked first.
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
task-to-project promotion is subject to the same invariant; promotion preserves
captured content and descendants rather than manufacturing readiness.

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
| `unassigned_actionable` | A project has a healthy actionable path but actionable work lacks an effective owner |
| *(healthy)* | At least one meaningful path reaches executable work or an intentional external wait with a revisit |

A reached external-wait revisit remains a task-level attention signal and
returns to Today. It does not make an otherwise valid waiting project
structurally stuck.

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

### Entering task sequences

Sequence entry has two lightweight surfaces:

- **Ablauf hinzufügen** on a project accepts one title per line. The API
  creates top-level actionable tasks in that order and links each later task
  to its predecessor.
- **Nächsten Schritt danach hinzufügen** on a task creates one actionable
  sibling at the same outline level and makes it depend on the source task.

`POST /api/projects/:id/task-sequence` and
`POST /api/tasks/:id/successors` perform creation and dependency insertion in
one SQLite transaction. A failed request therefore never leaves a partial
chain. The entry surfaces intentionally collect titles only; existing focused
actions handle external waits, dependencies, Wiedervorlage, ownership, notes,
and dates.

---

## 7. Review and exhaustive inventory

### Derived Review — `/more/review`

`apps/api/src/domain/reviewItems.ts` is the single deterministic maintenance
projection. It derives compact project/task diagnoses from the graph and an
injected calendar date; there is no Review table or workflow status.

Review contains structural decisions: missing project driver or progress path,
due-without-plan, malformed waiting, broken blocker paths, XL work without
breakdown, completion review, and age-based reconsideration. It deliberately
excludes valid shared tasks, absent optional acceptance criteria, Inbox
captures, reached follow-ups, and past planning dates already owned by Today.
More's badge is the exact number of current derived items.

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
`MemberSelectionSheet`, `InlineTaskComposer`, and
`AcceptanceCriteriaEditor`. The owner/effort matrix and sizing list remain
available as optional secondary planning tools rather than a separate
Refinement workflow.

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
completed, and archived projects. Backlog inventory remains available through
Alles and appears in Review only when it has a real reconsideration reason; a
row just returned to backlog may remain on Projects only for its optimistic
retention window.

- **Right swipe / primary button** runs the status-appropriate next step: `active → abschließen`, `completed → wieder öffnen`, `archived → aktivieren`. Backlog activation is offered from Review, Alles, and project detail where applicable. The button (`.story-row-primary`, `aria-label` = the action) is the explicit non-gesture equivalent and stays available on touch.
- **Left swipe / ⋯** reveals the chip strip: the targeted popups above plus every *remaining* legal transition from the row's `availableActions` (e.g. `In Backlog zurücklegen`, `Archivieren`).
- The candidate action is always intersected with `availableActions`; `lib/projectWorkflow.ts` mirrors the backend's `workflowActionsByStatus` map (and is reused by the test fixtures) so the UI never offers an illegal step.
- Activation requires a driver plus an executable progress path or intentional
  healthy future wait. Focused preflight opens `MemberSelectionSheet` or the
  existing task composer for the missing decision and then uses the canonical
  project action.
- Every row shows its status; inside the retention window the same badge shows what just happened (`Aktiviert`, `Abgeschlossen`, `Wieder geöffnet`, `Zurück im Backlog`, `Archiviert`).

#### Filtering and ordering the list

`lib/projectListFilter.ts` is a pure `filterAndSortProjects(projects, { query, scope, currentMemberId })`, unit-tested on its own and called once per render by `ProjectsPage`:

- **Search** folds diacritics (`NFD` + combining-mark strip) and lower-cases both sides, then substring-matches the title **and** every `acceptanceCriteria[].text`. The list endpoint already returns criteria (`Graph.load`), so no extra request is needed.
- **Scope** is `mine` by default — the selected member's stories plus `ownerMemberId === null`. With no identity selected there is no "mine", so it collapses to unassigned-only rather than to everything. `all` disables the filter.
- **Sort buckets**, in order: active & healthy, active & `stuckReason`, completed, archived; ties break on `position`, then `title.localeCompare(…, "de")`, then `id`, so the order is stable across reloads and retentions.
- Active rows form the primary list. Completed and archived rows keep
  that same deterministic order inside the folded **Abgeschlossen &
  archiviert** section. A non-empty search reveals matching terminal
  rows automatically.
- Filtering runs **before** sorting, and retained (optimistic) rows are merged into the same input list, so a retained row obeys the current search/scope and can never render twice next to its refetched counterpart.
- `ProjectsPage` distinguishes *no stories at all* (`noProjects`) from *nothing matches* (`noMatchingProjects`) by testing the unfiltered list first.

#### Status accents and a single progress bar

`statusAccent(story)` collapses status + `stuckReason` into five values — `backlog | active | stuck | completed | archived` — and every colour-carrying element keys off that one class (`.story-row-accent-*`, `.story-row-status-badge--*`, `.story-row-primary--*`, and the primary swipe background). An `active` story with a `stuckReason` therefore reads as a warning, not as healthy progress, and `backlog` is deliberately not green.

The four targeted actions render as icon-only 44 px buttons (`.story-row-chip-icon`) with inline, `aria-hidden`/`focusable="false"` SVG glyphs; the German `aria-label` **and** `title` carry the accessible name, so nothing is conveyed by the glyph alone. Workflow transitions stay labelled text chips.

The row shows **one** progress bar — task completion, marked up as a real `role="progressbar"` with `aria-valuenow/min/max` and `aria-valuetext` (`2/4`). The second, unlabelled criteria bar was removed from the row; the criteria *count* stays in the meta line, and `.criteria-progress` still serves the labelled bars on `ProjectDetailPage` and in `AcceptanceCriteriaEditor`.

### Status is a badge, transitions are buttons

No surface offers the project status as a `<select>`. `ProjectStoryRow`, `ProjectDetailPage` and `ProjectEditSheet` all render the status as a read-only badge (`projectStatusLabels`, plus an `.sr-only` "Status:" prefix on the row) and expose the change itself as thumb-sized, explicitly named buttons for exactly the transitions in `availableActions` — the sheet groups them in a `role="group"` labelled by its status field. Tests assert the absence of a status combobox, so a dropdown cannot creep back in.

### One headless horizontal-swipe primitive

`useHorizontalSwipe` owns drag distance, the 8 px slop, delayed pointer
capture, clamping, thresholds, cancellation, and one-shot click suppression
for `TaskRow`, `ProjectStoryRow`, and `RefinementTaskRow`. It captures from
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
- **Assignment** — the *Zuweisen* chip opens `MemberSelectionSheet`, **not** the full task detail sheet. `useRefinementActions.assignOwner` optimistically retains the row and rethrows on failure so the still-open sheet renders the error.

Task metadata execution and owner-assignment semantics live in the non-React
`lib/taskMutations.ts`. `useTaskActions` and `useRefinementActions` both use
that revision-safe executor, but deliberately keep separate optimistic
projections: normal task lists retain a `Task`, while the planning tools retain their
owner × effort row so regrouping waits until the retention window elapses.

---

## 8. Web Interaction Patterns

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
`useProjectActions`. `ProjectEditSheet` is the sole project-notes editor,
including the notes-focused entry from `ProjectDetailPage`.

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

`useRetainedMutations` tracks in-flight entity IDs. Retained mutations keep an
optimistic snapshot for `RETENTION_MS` (4 s) and defer the global `bump()` until
the window elapses — an immediate bump could unmount the list holding the
retained state. Project metadata instead bumps immediately and keeps its
confirmed overlay without a timer until the authoritative project collection
reaches that revision; a slow or failed refresh therefore cannot expose stale
controls. Non-retained external-wait commands bump when the confirmed result
arrives.

Consequence, and it is intentional: **a retained row is disabled only while the request is in flight, and becomes fully actionable again as soon as the request resolves** — while still displayed crossed-out inside its retention window. That lets a user immediately swipe the just-completed row again to reopen it (`erledigt → wieder offen`).

### Focused quick sheets

Interactions target one field at a time instead of opening the full detail sheet:

| Component | Purpose |
|-----------|---------|
| `TaskQuickActionSheet` | Focused task schedule or notes editing; execution is supplied by `useTaskActions` |
| `MemberSelectionSheet` | Reusable task-owner/project-driver picker, including assign-and-activate intent |
| `MemberChoiceGroup` | The tap-chip choice group rendered by assignment surfaces |
| `AcceptanceCriteriaEditor` | Reusable ordered criteria editor; shared by `ProjectEditSheet` and `StoryCriteriaSheet` |
| `StoryCriteriaSheet` | Targeted criteria popup for a story row |
| `PlanDatesSheet` | Due/scheduled dates only |
| `WaitingFollowUpSheet` | Owns follow-up drafts; delegates the atomic command, pending state, errors, and refresh to `useTaskActions` |
| `DestinationPicker` | Searchable refile destination list with recents (see below) |

Assignment surfaces read members from `useIdentity`, so tests mounting them
must wrap in `IdentityProvider` and mock `api.getMembers`.

### Assignment pickers are tap chips, not selects

A household has at most ~5 members, so every focused assignment popup renders the full choice set as chips through `MemberChoiceGroup`:

- No native `<select>` overlay stacked on top of a bottom sheet, and one tap instead of open-scroll-confirm.
- A `role="group"` labelled via `aria-labelledby` (`Zuständig` / `Verantwortlich`), with each chip reporting `aria-pressed` — selection is never conveyed by colour alone.
- An explicit "nobody" chip (`Gemeinsam / offen` for tasks, `Niemand zugewiesen` for stories) where clearing is legal. Driver activation omits it because the API rejects activating without a driver.
- Chips keep a ~44 px touch target (`.choice-chip`) and wrap rather than scroll.

The **full** editors (`TaskDetailSheet`, `ProjectEditSheet`) keep their selects:
they are multi-field forms reached by a deliberate "Bearbeiten"/"Mehr" tap,
not one-decision popups. `TaskDetailSheet` groups always-visible task,
planning, content, blocker, and subtask sections; recurrence, organization,
activity, and deletion use accessible disclosures, with active recurrence
opened automatically. Filters (`SearchFilterBar`) and settings (`MorePage`)
are likewise unaffected.

### Outline structure editing: drag, keyboard, one toolbar

The old global "Sortiermodus" and its seven-button panel under *every* row are gone. Structural editing now lives in three files:

| Module | Responsibility |
|--------|----------------|
| `lib/taskTreeMove.ts` | Pure, React-free geometry and tree maths: `slotFromPointer`, `projectDrop`, `locateTask`, `planMove`, `applyMove`, `outlineRootGroup`. Unit-tested on its own |
| `lib/useOutlineOrganize.tsx` | The drag session, the equivalent keyboard/toolbar moves, the optimistic tree and its rollback; publishes an `OutlineOrganizeValue` through context |
| `components/TaskOrganizeBar.tsx` | The single selected-task toolbar (↑ ↓ → ← plus `Ablegen`) |

`TaskRow` renders exactly one structural control — the ⠿ handle. Pressing it starts a drag (a row long-press is the touch shortcut into the same drag); activating it selects the task and shows the toolbar; arrow keys on the focused handle move the task directly. `consumeDragClick()` swallows the click a real drag ends with, so a drag never also toggles the selection.

**Projection.** Rows register themselves (`registerRow`) so the rendered — i.e. currently *visible*, non-collapsed — tree becomes a flat ordered list. The list and its rects are snapshotted once when the drag starts (rows do not move while dragging). `projectDrop` bounds the target depth by the neighbours: at most one level deeper than the row above, never shallower than the row below. All traversals in `taskTreeMove.ts` are iterative and identity-preserving, so a 30-level outline neither blows the stack nor re-renders untouched branches.

**Command mapping.** `planMove` returns either no-op or one concrete
destination (`parentTaskId`, optional root `projectId`, `position`, and the
rendered `expectedRevision`). `useOutlineOrganize` always sends that destination
to `POST /api/tasks/:id/move`; indent/outdent are geometry, not API operations.
`targetIndex` is always counted inside the destination sibling group excluding
the moved task, matching the backend contract.

**Optimism and rollback.** `applyMove` renumbers `position` in both affected groups the same way the server's `reindexGroup` does, otherwise the position-sorted render would snap straight back. Position normalization is group bookkeeping and does not advance sibling revisions; the explicitly moved task advances exactly once, so the optimistic tree can carry its deterministic next revision and safely accept another move immediately. The override survives unrelated older refresh responses and drops only when authoritative data reaches that revision. A rejected move restores the previous tree **in place** and shows `Verschieben fehlgeschlagen` plus the server message on that row. A stale rejection refreshes authoritative data and blocks only that stale task until its revision advances; other hierarchy edits remain available.

**Where it is offered.** `TaskOutline` takes an explicit `organizable` prop and only `ProjectDetailPage` passes it: `GET /api/projects/:id` returns `graph.rootsByProject`, the complete stored sibling group. Compiled views (`TodayPage`, `InboxPage`, `AllPage`) show a filtered slice of tasks from unrelated groups, where a position read off the screen would be applied to the *full* group on the server and silently shuffle rows the user never saw. `outlineRootGroup` is then applied on top as a structural second guard (all roots must share `parentTaskId` **and** `projectId`). Retention ghosts are rendered outside the organize provider, so they get no handle and never shift a drop index.

**Details that are easy to get wrong, and are covered by tests:**

- Window `pointermove`/`up`/`cancel`/`keydown` listeners are installed through *stable* dispatchers that forward to a ref, so a re-render mid-drag cannot leave a stale listener attached.
- The `mounted` ref is re-asserted **on mount**, not only cleared on unmount — React `StrictMode` mounts, unmounts and remounts every effect in development, and a one-way flag would leave every later move without refresh, without rollback and permanently "busy".
- Re-parenting unmounts and remounts the row, which would drop keyboard focus; the hook remembers the row and restores focus to its handle once the new DOM node exists (one attempt only, so it can never steal focus later).
- Dropping into a **collapsed** parent would hide the moved row, so the hook publishes an `expandRequest` the addressed row reacts to (collapse state is per row).
- A drag is announced through a `role="status"` live region, since the gesture has no meaning for assistive tech.

### Inline child composer

`InlineChildComposer` is the *+ Teilaufgabe hinzufügen* chip's target: a single-field form rendered directly beneath the row (its own auto-flow grid row of `.task-row`, like the chip strip), not a `BottomSheet`. It mirrors the focused quick sheets in spirit — one field, save/cancel, errors stay visible — and posts to `POST /tasks/:id/children` with the current identity as `createdByMemberId`.

`TaskRow` owns what the composer cannot: the collapsed state is local to the row, so success flips it open (the refresh bus alone would not), and focus returns to the always-mounted ⋯ button — falling back to the row's first enabled control when a mutation in flight has disabled it, so focus never lands on `<body>`. Cancel and <kbd>Esc</kbd> never touch the API; a failed create keeps the composer open with the typed title; an in-flight create disables the submit so a double click cannot create two tasks.


`MoveTaskSheet` backs all three explicit moves — `parent`, `project` and `subtree` — and renders each destination list through `DestinationPicker`. It is opened from the outline's selected-task toolbar (`Ablegen`, `subtree` mode, which offers both pickers) and from `TaskDetailSheet`:

- **Search** is an always-visible filter over the candidate list, matched case-insensitively (`toLocaleLowerCase`, so German umlauts fold correctly) as a substring of `title + subtitle`. For parent-task candidates the subtitle is the owning project's title, so typing a project name finds its tasks. In `parent` mode the project list is never fetched, so the title comes from the `GET /api/projects/:id` response the sheet already loads.
- **Recents** (`lib/recentDestinations.ts`) are shown first while the query is empty, in a `Zuletzt verwendet` group, with the remaining candidates under `Alle Ziele`. Once a query is typed the grouping collapses to plain results.
- Recents are stored in `localStorage` under `machbar:recent-destinations:{project,parent}` — separate lists, most-recent-first, de-duplicated, capped at `MAX_RECENT_DESTINATIONS` (5). They are written only after a move the API **accepted**, and a corrupt/unavailable entry degrades to "no recents" rather than failing.
- `pickRecent()` filters recents against the *current* candidate list at read time instead of pruning storage, because a destination can be unavailable in one picker (excluded as the moved task's own subtree) yet perfectly valid in the next.

The picker only selects. All modes send a concrete destination to `moveTask`;
the moved task's own subtree is still excluded from parent candidates
client-side, and hierarchy/cycle validation stays server-side
(`wouldCreateHierarchyCycle` / `wouldCreateDependencyCycle` in
`apps/api/src/repo/treeRepo.ts` and `dependencyRepo.ts`).

### Waiting follow-up notes

`WaitingFollowUpSheet` never rewrites history. Each entry is appended to the task's notes under a generated header:

```
[dd.mm.yy, hh:mm · Name]
<text>
```

produced by `followUpEntryHeader()`, so the log stays readable and attributable
in plain text. The same sheet updates `ExternalWait.revisitDate` and can
explicitly end the wait. Ending it removes the external-wait row and its
revisit while preserving `Task.scheduledDate`. The sheet owns only these
drafts and delegates execution to `useTaskActions.followUpExternalWait`.

### Paperless-backed Markdown attachments

`apps/api/src/integrations/paperless/` is the only code that knows Paperless
authentication, generated OpenAPI response shapes, or upstream paths. Focused
Fastify routes under `/api/integrations/paperless/documents` expose upload,
search, thumbnail, preview, and download through Machbar's existing session and
Origin protection. `PAPERLESS_URL` and `PAPERLESS_API_TOKEN` are optional as a
pair; ordinary task/project behavior has no Paperless dependency.

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
downloads remain mediated authenticated routes.

Global material capture starts in `QuickAdd` but keeps the selected browser
`File` local. `CaptureForm.prepareNotes` uploads immediately before its existing
task/project create call, so abandoning capture before commit creates no
Paperless document. Successful uploads are retained across create retries.
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

## 9. Migrations

Drizzle migrations live in `apps/api/drizzle/` and are applied on every server start.

`runMigrations` (`apps/api/src/db/migrate.ts`) wraps `migrate()` in `PRAGMA foreign_keys = OFF` / `ON`. Drizzle runs all pending migrations inside one implicit transaction, where a migration file's own pragma statements are no-ops; without the wrapper, migration `0002`'s table rebuild would cascade into dependent rows.

`0002_project_acceptance_criteria_task_size.sql`:

1. creates `project_acceptance_criteria` (+ `project_acceptance_criteria_project_idx`),
2. rebuilds `projects` — dropping `description` and defaulting `status` to `'backlog'`,
3. **copies each non-empty description into an acceptance criterion at position 0** (no data loss),
4. adds `tasks.size` + `tasks_size_idx`.

`apps/api/tests/migration-acceptance-criteria.test.ts` pins this behaviour against `tests/fixtures/pre-0002-migrations`.

`0015_external_waits.sql` introduces the external-wait relation and migrates
existing waiting tasks without changing their `scheduled_date`. The following
`0016_remove_waiting_compatibility.sql` migration removes the superseded task
column and normalizes activity status metadata to the current lifecycle
vocabulary.

`0019_external_wait_revisit_date.sql` adds the dedicated revisit field, moves
the historical scheduled date of each existing external wait into it, and
clears only those tasks' overloaded planning dates.
