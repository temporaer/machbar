# Machbar — Architecture

This document is the technical deep dive for contributors. For product
concepts, start with the [household workflow](workflow.md). For operating the
application, see [deployment](deployment.md) and
[status and limitations](status-and-limitations.md).

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
| `@machbar/api` | REST API + static file serving + SQLite access | `PORT` / HTTP; reads `DATA_DIR` from the file system |
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

`inheritanceMode` (values: `inherit` | `explicit` | `none`) overrides the cascade:

- `inherit` — use the nearest ancestor's value (default)
- `explicit` — override with the task's own value and stop propagation
- `none` — explicitly clear the value (no further upward lookup)

The resolved values are exposed as `effectiveOwnerId` and `effectiveTags` on
the `Task` type in `@machbar/shared`. Typed projections
`effectiveAreaTags`, `effectiveActorTags`, and `effectiveContextTags` are
filtered from the same inherited tag set; they do not implement separate
inheritance rules.

Tag selection is a reusable compact chip picker in both task and project
editors. Every flexible, non-exclusive tag has one primary kind: Bereich,
Person, Kontext, or Normal. The picker creates a missing tag with the
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
| `effectiveAreaTags` / `effectiveActorTags` / `effectiveContextTags` | Kind-filtered views of `effectiveTags` |
| `explicitTags` | Tags directly on this task |
| `externalWait` | Nullable unresolved external blocker; row presence blocks even when its description is empty |
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
| `notes` | Free-form project context, independent from completion criteria |
| `acceptanceCriteria` | Ordered “Erledigt, wenn …” rows with `checked` state |
| `openCount` / `doneCount` | Task rollups |
| `nextAction` | First actionable, unblocked task |
| `stuckReason` | Diagnosis for `active` projects only (see §6) |

These views are **read-only projections** — they are not stored in SQLite; they are assembled per-request.

The **Heute** agenda is also query-derived. Its primary sections contain work
explicitly scheduled for today or earlier, overdue work, work due today,
soon-due work, and blocked tasks whose own Wiedervorlage is due.
It is member-scoped by default (including shared/unassigned work), while the
explicit `scope=all` query returns the same compiled buckets for the complete
household. The frontend exposes that distinction as a session-scoped
**Meine | Alle** header toggle.
Executable work without a `scheduledDate` falls through to the secondary
`shared` / `unscheduled` buckets and is rendered in the visibly separate
**Weitere machbare Aufgaben** section. A future deadline does not hide an
otherwise executable task: once it enters the three-day due-soon window, the
earlier due bucket wins without duplication. Future-scheduled work, captured
work, completed/cancelled work, and blocked work without a reached revisit
stay out.

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
- Hierarchy moves, dependency changes, and multi-table metadata writes are performed inside the same transaction as the originating write.
- External waits use revision-aware `PUT /api/tasks/:id/external-wait` and
  `DELETE /api/tasks/:id/external-wait` resources. Starting/updating a wait can
  change its description and the task's revisit date atomically; resolving it
  deletes the relation and clears that date in the same transaction.
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

## 5. Base Path and Ingress

The `BASE_PATH` environment variable (default `/`) tells the server where static UI routes are mounted:

- The **API** remains at relative `api/...` URLs so Home Assistant Ingress can proxy it.
- The **frontend** uses relative assets and API URLs so the same build works behind a non-root proxy path.

No frontend rebuild is required for a Home Assistant Ingress path.

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

### Home Assistant Ingress

Home Assistant strips the dynamic Ingress prefix while proxying to the add-on. Machbar therefore listens at `/` internally and uses relative browser URLs.

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

Waiting is deliberately not a task status. `task_external_waits` stores an
optional description in a one-to-one row whose presence means the actionable
task has an unresolved external blocker. `task_dependencies` stores real task
prerequisites. Blocking and executability are derived from both sources, and
current create/update/status APIs accept only the five statuses above.

For an executable task, `scheduledDate` is its planned work date. For a
blocked task, the same field is its Wiedervorlage. Resolving an external wait
clears that revisit date by default so it does not silently become a work
schedule. Resolving a task dependency never clears the dependent task's own
date.

Tasks in `done` or `cancelled` are retained in the database and visible in search/history views.

### Projects

`ProjectStatus`: `backlog → active → completed`, with `archived` reachable from — and escapable back to — `backlog`.

```
backlog ──activate──► active ──complete──► completed
   ▲   │                 │                    │
   │   │                 └─return_to_backlog──┘ (reopen)
   │   └──archive──► archived ──unarchive──► backlog
   └──────────────────────────────────────────┘
```

`availableProjectWorkflowActions()` in `apps/api/src/domain/mutations.ts` is the **single source of truth** for legal transitions and is surfaced on every project response as `availableActions`. Rules:

- `PATCH /api/projects/:id` **refuses status changes** — status only moves through the dedicated workflow endpoints (`/activate`, `/complete`, `/return-to-backlog`, `/archive`, `/unarchive`).
- Nothing auto-completes a story; completion is always an explicit human decision.
- `DELETE /api/projects/:id` permanently removes the project, its tag links,
  and its “Erledigt, wenn …” rows. Existing tasks are preserved and detached
  (`tasks.project_id = NULL`) by the foreign key's `ON DELETE SET NULL`.

### Responsible-person invariant

Every non-`backlog` project must have a responsible person (`ownerMemberId`):

- `POST /api/projects/:id/activate` fails with `project_driver_required`
  unless the project already has a responsible person or one is supplied
  inline (`{"ownerMemberId": n}`).
- `PATCH /api/projects/:id` with `ownerMemberId: null` fails with
  `project_driver_locked` unless the project is in `backlog`. Reassigning to a
  different member is always allowed. Individual task ownership remains
  independent.

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
| `followup_due` | An external wait's Wiedervorlage is today or in the past |
| `blocked_without_clear_path` | A dependency path ends in captured/someday/non-operational work, a missing task, or a corrupt cycle |
| `unassigned_actionable` | A project has a healthy actionable path but actionable work lacks an effective owner |
| *(healthy)* | At least one meaningful path reaches executable work or an intentional future external-wait revisit |

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

## 7. Projektklärung, Aufgabenklärung und Klärungsbedarf

The two routes under **Mehr** keep their technical paths for compatibility,
but their product model is lightweight household clarification rather than
backlog grooming.

`apps/api/src/domain/refinementIssues.ts` is the central service for project
and task diagnostics. It returns typed issue codes, severity, German
label/explanation, and one suggested repair action. The same result enriches
project rows and powers the default **Klärungsbedarf** queue at
`GET /api/refinement/issues`. It also computes readiness for inactive/active
projects: responsible person, clear “Erledigt, wenn …” outcome, an executable
next action, coherent waiting follow-ups, and no urgent issue. Readiness is
guidance, not a wizard or a second workflow state.

### Project clarification — `/more/backlog`

Lists technically `backlog` projects as **Später / noch nicht aktiv**
(`BacklogReviewPage` → `ProjectStoryRow`, compact variant). Every mutation
flows through `useProjectWorkflowActions`, preserving optimistic retention.

Row gestures/chips open **targeted popups** rather than navigating away:

| Chip | Opens |
|------|-------|
| Verantwortlich | `AssignDriverSheet` |
| Erledigt, wenn … | `StoryCriteriaSheet` (wraps `AcceptanceCriteriaEditor`) |
| Planen | `PlanDatesSheet` |
| Bearbeiten | Full project detail page (deliberately the only navigation) |
| Archivieren | Direct action |

**Aktiv machen** (`api.activateProject`) surfaces the responsible-person
requirement inline.

### Projects tab — `/projects`

`ProjectsPage` renders the same `ProjectStoryRow` (card variant) for projects
of every status. Compact issue badges make missing clarification visible
without opening a separate planning screen.

- **Right swipe / primary button** runs the status-appropriate next step: `backlog → aktivieren`, `active → abschließen`, `completed → wieder öffnen`, `archived → aktivieren`. The button (`.story-row-primary`, `aria-label` = the action) is the explicit non-gesture equivalent and stays available on touch.
- **Left swipe / ⋯** reveals the chip strip: the targeted popups above plus every *remaining* legal transition from the row's `availableActions` (e.g. `In Backlog zurücklegen`, `Archivieren`).
- The candidate action is always intersected with `availableActions`; `lib/projectWorkflow.ts` mirrors the backend's `workflowActionsByStatus` map (and is reused by the test fixtures) so the UI never offers an illegal step.
- Activating a story without a driver opens `AssignDriverSheet` first and then activates **atomically** via `activateProject(id, { ownerMemberId })`.
- Every row shows its status; inside the retention window the same badge shows what just happened (`Aktiviert`, `Abgeschlossen`, `Wieder geöffnet`, `Zurück im Backlog`, `Archiviert`).

#### Filtering and ordering the list

`lib/projectListFilter.ts` is a pure `filterAndSortProjects(projects, { query, scope, currentMemberId })`, unit-tested on its own and called once per render by `ProjectsPage`:

- **Search** folds diacritics (`NFD` + combining-mark strip) and lower-cases both sides, then substring-matches the title **and** every `acceptanceCriteria[].text`. The list endpoint already returns criteria (`Graph.load`), so no extra request is needed.
- **Scope** is `mine` by default — the selected member's stories plus `ownerMemberId === null`. With no identity selected there is no "mine", so it collapses to unassigned-only rather than to everything. `all` disables the filter.
- **Sort buckets**, in order: active & healthy, active & `stuckReason`, backlog, completed, archived; ties break on `position`, then `title.localeCompare(…, "de")`, then `id`, so the order is stable across reloads and retentions.
- Active/backlog rows form the primary list. Completed and archived rows keep
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

### Pointer capture only after a real drag

`ProjectStoryRow` and `TaskRow` call `setPointerCapture` from `pointermove`, once the drag passes the 8 px slop — never from `pointerdown`. A captured container also receives the *compatibility mouse events* of everything inside it, which silently swallowed mouse clicks on the row buttons and the detail link (touch taps were unaffected). A drag additionally sets a one-shot `swallowNextClick` flag, reset on the next `pointerdown`, so the click the browser synthesises after a swipe never navigates while a later tap still does.

The outline's structural drag is a *separate* gesture and deliberately uses window-level listeners instead of pointer capture (the pointer leaves the handle immediately), with `touch-action: none` on the handle so the browser does not claim the vertical component. The handle's `pointerdown` stops propagation, so a structural drag and a swipe can never run at once; and the row's long-press timer is only armed where structural editing is actually offered, so a long press in a compiled view no longer cancels the swipe it belongs to.

Because that drag takes no pointer capture, the click the browser synthesises on release is *not* retargeted. A long press therefore arms `TaskRow`'s `swallowNextClick` too, so finishing a move on the row it started on does not also open the detail sheet; the flag is one-shot and cleared by the next `pointerdown`. The mirror-image case lives in `useOutlineOrganize`: it swallows the handle's own post-drag click only when the session actually started on a handle (`DragSession.fromHandle`), otherwise a long-press drag would eat the user's next, unrelated tap on some handle.

### Task clarification — `/more/refinement`

`RefinementPage` defaults to **Klärungsbedarf** cards grouped by operational
defect: needs clarification, no responsibility, waiting without follow-up,
follow-up due, blocked, due without a plan, XL without children, or ready to
complete. Tapping the single suggested action opens an existing focused task
sheet or the project detail. The interaction is repair-one-thing-at-a-time,
not a mandatory multi-step wizard.

The owner × effort matrix remains collapsed as a secondary view, backed by
`GET /api/refinement/owners` and `GET /api/refinement/tasks`.

`RefinementTaskRow` supports:

- **Effort** — swipe or tap cycles `S → M → L → XL → (none)` via
  `useRefinementActions.cycleSize`/`setSize`/`clearSize`. `XL` with no open
  child produces `too_large_without_children` and suggests adding a child.
- **Assignment** — the *Zuweisen* chip opens `AssignOwnerSheet` (a focused popup), **not** the full task detail sheet. `useRefinementActions.assignOwner` optimistically retains the row and rethrows on failure so the still-open sheet renders the error.

`useRefinementActions` deliberately defines its own `REFINEMENT_RETENTION_MS` instead of depending on `useTaskActions` internals.

---

## 8. Web Interaction Patterns

### Optimistic retention

`useTaskActions.runTransition` sets `busyId` before a mutation and clears it in `finally`. `retain()` keeps the optimistic snapshot for `RETENTION_MS` (4 s) and defers the global `bump()` until the window elapses — an immediate bump would unmount the very `TaskOutline` holding the retained state.

Consequence, and it is intentional: **a retained row is disabled only while the request is in flight, and becomes fully actionable again as soon as the request resolves** — while still displayed crossed-out inside its retention window. That lets a user immediately swipe the just-completed row again to reopen it (`erledigt → wieder offen`).

### Focused quick sheets

Interactions target one field at a time instead of opening the full detail sheet:

| Component | Purpose |
|-----------|---------|
| `TaskQuickActionSheet` | Dispatches a single task field (owner, dates, tags, …); its `owner` branch delegates to `AssignOwnerSheet` and it exports the shared `ownerAssignmentPatch()` helper |
| `AssignOwnerSheet` | Reusable owner picker (`Zuständig`, incl. `Gemeinsam / offen`); shared by `TaskQuickActionSheet` and `RefinementTaskRow` |
| `AssignDriverSheet` | Project driver picker (`Verantwortlich`) for any story row: assign-only, assign-and-activate, or reassign. `allowUnassigned` mirrors the backend invariant — only a `backlog` story may be left without a driver |
| `MemberChoiceGroup` | The tap-chip picker both assignment sheets render (see below) |
| `AcceptanceCriteriaEditor` | Reusable ordered criteria editor; shared by `ProjectEditSheet` and `StoryCriteriaSheet` |
| `StoryCriteriaSheet` | Targeted criteria popup for a story row |
| `PlanDatesSheet` | Due/scheduled dates only |
| `WaitingFollowUpSheet` | Append-only follow-up log, revisit editor, and external-wait resolution for blocked tasks |
| `DestinationPicker` | Searchable refile destination list with recents (see below) |

`AssignOwnerSheet` reads members from `useIdentity`, so any test mounting it (directly or via `TaskQuickActionSheet`/`RefinementTaskRow`) must wrap in `IdentityProvider` and mock `api.getMembers`.

`TaskQuickActionSheet` and `WaitingFollowUpSheet` are independent surfaces: the quick sheet patches a field, the follow-up sheet appends notes. They coexist on the same row without sharing state.

### Assignment pickers are tap chips, not selects

A household has at most ~5 members, so every focused assignment popup renders the full choice set as chips through `MemberChoiceGroup`:

- No native `<select>` overlay stacked on top of a bottom sheet, and one tap instead of open-scroll-confirm.
- A `role="group"` labelled via `aria-labelledby` (`Zuständig` / `Verantwortlich`), with each chip reporting `aria-pressed` — selection is never conveyed by colour alone.
- An explicit "nobody" chip (`Gemeinsam / offen` for tasks, `Niemand zugewiesen` for stories) where clearing is legal. `AssignDriverSheet` omits it in activate mode, because the API rejects activating without a driver.
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

**Endpoint mapping.** `planMove` picks the *narrowest* existing endpoint — `reorder`, `indent`, `outdent`, `changeParent`, or the general `move` — so the server keeps applying its own indent/outdent semantics and its cycle checks (`moveTask` in `apps/api/src/domain/mutations.ts` remains the single authority). `targetIndex` is always an index inside the destination sibling group *excluding* the moved task, which is exactly what the backend expects.

**Optimism and rollback.** The optimistic tree is keyed on the **identity** of the `tasks` prop: while the caller hands back the same array the locally moved tree is rendered, and the moment fresh server data arrives the override drops itself. `applyMove` renumbers `position` in both affected groups the same way the server's `reindexGroup` does, otherwise the position-sorted render would snap straight back. A rejected move restores the previous tree **in place** — no global `bump()`, which would also tear down unrelated retention state — and shows `Verschieben fehlgeschlagen` plus the server message on that row. A success bumps once so every view converges.

**Where it is offered.** `TaskOutline` takes an explicit `organizable` prop and only `ProjectDetailPage` passes it: `GET /api/projects/:id` returns `graph.rootsByProject`, the complete stored sibling group. Compiled views (`TodayPage`, `InboxPage`, `SearchPage`) show a filtered slice of tasks from unrelated groups, where a position read off the screen would be applied to the *full* group on the server and silently shuffle rows the user never saw. `outlineRootGroup` is then applied on top as a structural second guard (all roots must share `parentTaskId` **and** `projectId`). Retention ghosts are rendered outside the organize provider, so they get no handle and never shift a drop index.

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

The picker only selects. Move modes and their API calls are unchanged (`changeParent`, `moveSubtree`, `moveTask`), the moved task's own subtree is still excluded from parent candidates client-side, and **hierarchy/cycle validation stays server-side** (`wouldCreateHierarchyCycle` / `wouldCreateDependencyCycle` in `apps/api/src/repo/treeRepo.ts` and `dependencyRepo.ts`).

### Waiting follow-up notes

`WaitingFollowUpSheet` never rewrites history. Each entry is appended to the task's notes under a generated header:

```
[dd.mm.yy, hh:mm · Name]
<text>
```

produced by `followUpEntryHeader()`, so the log stays readable and attributable
in plain text. The same sheet updates the task's `scheduledDate`
(*Wiedervorlage*) and can explicitly end its external wait. Ending the wait
clears both the external-wait row and its revisit date.

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
