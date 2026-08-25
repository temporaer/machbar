# Machbar — Architecture

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
               │
               └── Dependency (taskId → dependsOnTaskId)
```

- **Members** are the people who use the app. Every task and project can be assigned an owner (`ownerMemberId`).
- **Projects are user stories.** A project has a single owner — the **driver** — an optional due/scheduled date, and an ordered list of **acceptance criteria**.
- **Acceptance criteria** (`project_acceptance_criteria`) are structured, individually checkable, position-ordered rows. They replace the former free-text `projects.description` column.
- **Tasks** belong to at most one project and at most one parent task (forming a tree of arbitrary depth). Each task carries an optional **size** estimate (`S | M | L | XL`).
- **Tags** are many-to-many with both projects and tasks.

### Inheritance chains

Three fields cascade down the task tree:

| Field | Resolved as `effective*` |
|-------|--------------------------|
| `ownerMemberId` | First non-null value walking up: task → parent task → … → project |
| `context` | Same traversal; controlled by `contextInheritanceMode` |
| tags | Union of ancestor tags minus any `excludedTagIds` on the task |

`inheritanceMode` (values: `inherit` | `explicit` | `none`) overrides the cascade:

- `inherit` — use the nearest ancestor's value (default)
- `explicit` — override with the task's own value and stop propagation
- `none` — explicitly clear the value (no further upward lookup)

The resolved values are exposed as `effectiveOwnerId`, `effectiveContext`, and `effectiveTags` on the `Task` type in `@machbar/shared`.

---

## 3. Compiled / Resolved Views

The API computes several derived fields before returning tasks to the client:

| Field | Computed as |
|-------|-------------|
| `effectiveOwnerId` / `effectiveOwnerSource` | Walk parent chain; source ∈ `{task, parent, project, none}` |
| `effectiveContext` / `effectiveContextSource` | Same |
| `effectiveTags` | Ancestor tag union minus excluded IDs |
| `explicitTags` | Tags directly on this task |
| `blocked` | `true` if any dependency is unresolved (`Dependency.resolved = false`) |
| `children` | Direct sub-tasks (recursive to arbitrary depth) |
| `dependencies` | Outgoing dependency edges with their resolution state |

Projects additionally carry:

| Field | Computed as |
|-------|-------------|
| `availableActions` | Workflow transitions legal for the current status (see §6) — the single source of truth for which buttons the UI renders |
| `acceptanceCriteria` | Ordered criteria rows with `checked` state |
| `openCount` / `doneCount` | Task rollups |
| `nextAction` | First actionable, unblocked task |
| `stuckReason` | Diagnosis for `active` projects only (see §6) |

These views are **read-only projections** — they are not stored in SQLite; they are assembled per-request.

---

## 4. Transaction Rules

- Every write that touches more than one table (e.g. creating a task + adding tags) uses an explicit SQLite transaction.
- Hierarchy moves, dependency changes, and multi-table metadata writes are performed inside the same transaction as the originating write.
- SQLite's WAL mode is enabled (`PRAGMA journal_mode=WAL`) so reads do not block concurrent writes.
- The database file lives in `DATA_DIR` (default `/data`). The path is `${DATA_DIR}/${DATABASE_FILE}`.

---

## 5. Base Path and Ingress

The `BASE_PATH` environment variable (default `/`) tells the server where static UI routes are mounted:

- The **API** remains at relative `api/...` URLs so Home Assistant Ingress can proxy it.
- The **frontend** uses relative assets and API URLs so the same build works behind a non-root proxy path.

No frontend rebuild is required for a Home Assistant Ingress path.

### Home Assistant Ingress

Home Assistant strips the dynamic Ingress prefix while proxying to the add-on. Machbar therefore listens at `/` internally and uses relative browser URLs.

---

## 6. Status Lifecycle

### Tasks

```
inbox ──► actionable ──► done
  │            │
  │            ├──► waiting ──► actionable
  │            └──► someday ──► actionable
  └──► cancelled
```

Tasks in `done` or `cancelled` are retained in the database and visible in search/history views.

### Projects (user stories)

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

### Driver invariant

Every non-`backlog` story must have a **driver** (`ownerMemberId`) — one accountable person:

- `POST /api/projects/:id/activate` fails with `bad_request` unless the story already has a driver or one is supplied inline (`{"ownerMemberId": n}`).
- `PATCH /api/projects/:id` with `ownerMemberId: null` fails with `conflict` unless the story is in `backlog`. Reassigning to a *different* member is always allowed.

Legacy rows migrated from before the invariant may still be `active` without a driver; the migration never rewrites status, and the UI surfaces them so a driver can be assigned.

### Stuck detection

`apps/api/src/repo/stuckRepo.ts` classifies **`active` projects only** (backlog stories are not "stuck" — they are simply not started). Priority order:

| Reason | Condition |
|--------|-----------|
| `no_next_action` | Project has no tasks at all |
| `completion_review` | Project has tasks but **zero open** ones — everything is `done`/`cancelled`, so the story is ready to be completed or extended |
| `unassigned_actionable` | Has actionable tasks with no effective owner |
| *(healthy)* | Every open task is `waiting` **and at least one carries a `scheduledDate`** — a scheduled revisit ("Wiedervorlage") is an explicit decision about when to look again, so the story is parked, not stuck. The date is **not** compared against today: past, present and future revisits all count |
| `only_waiting` | Every open task is `waiting` and **none** has a `scheduledDate` |
| `no_next_action` | No actionable task, and not the all-waiting case above |
| `blocked_dependencies` | Every actionable task is blocked by an unresolved dependency |

The healthy-revisit rule only exempts the all-waiting case. A scheduled waiting task never masks a higher- or lower-priority reason: mixed open states still yield `unassigned_actionable`, `no_next_action` or `blocked_dependencies` as before, and once the scheduled task closes, `completion_review` takes over.

---

## 7. Backlog Review and Refinement

Two dedicated Scrum-style surfaces live under **Mehr** (`MorePage`) and are routed in `App.tsx`:

### Backlog Review — `/mehr/backlog`

Lists `backlog` stories (`BacklogReviewPage` → `BacklogStoryRow`). Every mutation flows through `useBacklogReviewActions`, which reuses the optimistic **retain** pattern (`RETENTION_MS` imported from `useTaskActions` so both windows agree).

Row gestures/chips open **targeted popups** rather than navigating away:

| Chip | Opens |
|------|-------|
| Verantwortlich | `AssignDriverSheet` |
| Akzeptanzkriterien | `StoryCriteriaSheet` (wraps `AcceptanceCriteriaEditor`) |
| Planen | `PlanDatesSheet` |
| Bearbeiten | Full project detail page (deliberately the only navigation) |
| Archivieren | Direct action |

Activation (`api.activateProject`) surfaces the driver requirement inline: if no driver is set the sheet asks for one before activating.

### Refinement — `/mehr/refinement`

`RefinementPage` renders an **owner × size matrix** (`RefinementMatrix`) over open tasks, backed by `GET /api/refinement/owners` and `GET /api/refinement/tasks`. Selecting a cell filters the task list below.

`RefinementTaskRow` supports:

- **Sizing** — swipe or tap cycles `S → M → L → XL → (none)` via `useRefinementActions.cycleSize`/`setSize`/`clearSize`.
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
| `AssignDriverSheet` | Project driver picker for Backlog Review (assign-only, or assign-and-activate) |
| `MemberChoiceGroup` | The tap-chip picker both assignment sheets render (see below) |
| `AcceptanceCriteriaEditor` | Reusable ordered criteria editor; shared by `ProjectEditSheet` and `StoryCriteriaSheet` |
| `StoryCriteriaSheet` | Targeted criteria popup for a backlog row |
| `PlanDatesSheet` | Due/scheduled dates only |
| `WaitingFollowUpSheet` | Append-only follow-up log for `waiting` tasks |
| `DestinationPicker` | Searchable refile destination list with recents (see below) |

`AssignOwnerSheet` reads members from `useIdentity`, so any test mounting it (directly or via `TaskQuickActionSheet`/`RefinementTaskRow`) must wrap in `IdentityProvider` and mock `api.getMembers`.

`TaskQuickActionSheet` and `WaitingFollowUpSheet` are independent surfaces: the quick sheet patches a field, the follow-up sheet appends notes. They coexist on the same row without sharing state.

### Assignment pickers are tap chips, not selects

A household has at most ~5 members, so every focused assignment popup renders the full choice set as chips through `MemberChoiceGroup`:

- No native `<select>` overlay stacked on top of a bottom sheet, and one tap instead of open-scroll-confirm.
- A `role="group"` labelled via `aria-labelledby` (`Zuständig` / `Verantwortlich`), with each chip reporting `aria-pressed` — selection is never conveyed by colour alone.
- An explicit "nobody" chip (`Gemeinsam / offen` for tasks, `Niemand zugewiesen` for stories) where clearing is legal. `AssignDriverSheet` omits it in activate mode, because the API rejects activating without a driver.
- Chips keep a ~44 px touch target (`.choice-chip`) and wrap rather than scroll.

The **full** editors (`TaskDetailSheet`, `ProjectEditSheet`) keep their selects: they are dense multi-field forms reached by a deliberate "Bearbeiten"/"Mehr" tap, not one-decision popups. Filters (`SearchFilterBar`) and settings (`MorePage`) are likewise unaffected.

### Refiling: searchable destinations with recents

`MoveTaskSheet` backs all three organize-mode moves — `parent`, `project` and `subtree` — and renders each destination list through `DestinationPicker`:

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

produced by `followUpEntryHeader()`, so the log stays readable and attributable in plain text. The same sheet sets the task's `scheduledDate` (*Wiedervorlage*), which feeds the healthy-revisit rule in §6.

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
