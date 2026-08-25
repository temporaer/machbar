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
- **Projects** group tasks. A project has a single owner and an optional due/scheduled date.
- **Tasks** belong to at most one project and at most one parent task (forming a tree of arbitrary depth).
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

```
inbox ──► actionable ──► done
  │            │
  │            ├──► waiting ──► actionable
  │            └──► someday ──► actionable
  └──► cancelled
```

`ProjectStatus`: `active → completed | archived`

Tasks in `done` or `cancelled` are retained in the database and visible in search/history views.
