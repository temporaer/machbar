# Machbar

> **Das ist machbar.** — A GTD-style task manager for families and small teams.

Machbar helps you collect, clarify, and organise work as **user stories** (projects) with acceptance criteria, a single accountable **driver**, estimated tasks, per-member context, tag inheritance, and a shared agenda view. Built with React/Vite + Fastify + SQLite; runs as a single process or container with zero external service dependencies.

---

## Table of Contents

1. [Local Development](#1-local-development)
2. [Standalone npm (production)](#2-standalone-npm-production)
3. [Docker (single container)](#3-docker-single-container)
4. [Docker Compose](#4-docker-compose)
5. [Reverse Proxy](#5-reverse-proxy)
6. [Home Assistant Add-on](#6-home-assistant-add-on)
7. [Environment Variables](#7-environment-variables)
8. [Database — Migrations & Seeding](#8-database--migrations--seeding)
9. [Architecture](#9-architecture)
10. [Workflow — User Stories, Backlog Review & Refinement](#10-workflow--user-stories-backlog-review--refinement)
11. [Known Limitations & Future Work](#11-known-limitations--future-work)
12. [Future Home Assistant Integration](#12-future-home-assistant-integration)

---

## 1. Local Development

### Prerequisites

- Node.js ≥ 22
- npm ≥ 10

### Setup

```bash
git clone https://github.com/temporaer/machbar
cd machbar
npm install
cp .env.example .env   # edit as needed
```

### Start dev servers

```bash
npm run dev
```

This starts the Fastify API (with watch/reload) and the Vite dev server concurrently. Open the Vite URL shown in the terminal; it proxies API requests to Fastify.

### Useful dev commands

| Command | What it does |
|---------|-------------|
| `npm run dev` | API + Vite dev servers (hot reload) |
| `npm run build` | Full production build of all workspaces |
| `npm run typecheck` | TypeScript check across all packages |
| `npm run test` | Unit tests (all workspaces) |
| `npm run test:e2e` | Reserved for the deferred Playwright end-to-end suite |
| `npm run db:migrate` | Apply pending schema migrations |
| `npm run db:seed` | Populate the database with sample data |

---

## 2. Standalone npm (production)

Build once, then run the compiled API which also serves the compiled frontend:

```bash
npm run build
npm run db:migrate

# Optional: seed with sample members / projects
SEED_DATABASE=true npm run db:seed

npm run start
```

The server listens on `HOST:PORT` (defaults: `0.0.0.0:3000`). Open `http://localhost:3000` in a browser.

To persist data in a specific location:

```bash
DATA_DIR=/var/lib/machbar npm run start
```

---

## 3. Docker (single container)

### Build

```bash
docker build -t machbar .
```

> **Requirement:** `package-lock.json` must be committed to the repository; the build uses `npm ci` for reproducible installs.

### Run

```bash
docker run -d \
  --name machbar \
  -p 3000:3000 \
  -v machbar-data:/data \
  -e SEED_DATABASE=true \
  machbar
```

The `/data` volume persists the SQLite database across container restarts and upgrades.

### Upgrade

```bash
docker build -t machbar .
docker stop machbar && docker rm machbar
docker run -d --name machbar -p 3000:3000 -v machbar-data:/data machbar
# Migrations run automatically on startup
```

### Health check

The API exposes `GET /api/health` returning HTTP 2xx. The container's built-in `HEALTHCHECK` polls this endpoint every 30 s. Check status with:

```bash
docker inspect --format='{{.State.Health.Status}}' machbar
```

---

## 4. Docker Compose

```bash
# First run — build image and start with sample data
SEED_DATABASE=true docker compose up --build -d

# Subsequent starts
docker compose up -d

# View logs
docker compose logs -f

# Stop and remove containers (data volume is preserved)
docker compose down
```

The named volume `machbar-data` is created automatically and survives `docker compose down`. To also remove data:

```bash
docker compose down -v
```

### Customise the host port

Set `MACHBAR_PORT` in a `.env` file next to `compose.yml`:

```dotenv
MACHBAR_PORT=8080
```

---

## 5. Reverse Proxy

### nginx

```nginx
location / {
    proxy_pass         http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header   Host $host;
    proxy_set_header   Upgrade $http_upgrade;
    proxy_set_header   Connection "upgrade";
    proxy_set_header   X-Real-IP $remote_addr;
    proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header   X-Forwarded-Proto $scheme;
}
```

### Caddy

```caddy
machbar.example.com {
    reverse_proxy localhost:3000
}
```

### Traefik (Docker label)

```yaml
labels:
  - "traefik.enable=true"
  - "traefik.http.routers.machbar.rule=Host(`machbar.example.com`)"
  - "traefik.http.services.machbar.loadbalancer.server.port=3000"
```

### Sub-path deployment

If a reverse proxy preserves a non-root prefix (for example `/tasks/`), set
`BASE_PATH=/tasks` at runtime. The frontend uses relative assets and hash-based
routing, so no rebuild is required. Home Assistant strips its Ingress prefix
before forwarding requests and therefore keeps `BASE_PATH=/`.

---

## 6. Home Assistant Add-on

### How it works

The HA add-on runs Machbar in a supervised Docker container. Data is stored in `/data` (HA's persistent add-on storage). The UI is accessible via **HA Ingress** — no port forwarding required.

### Installation

#### Option A — Local add-on (development)

1. Copy (or symlink) the `home-assistant/` directory to your HA config directory:

   ```
   /config/addons/machbar/
   ├── config.yaml
   ├── build.yaml
   ├── Dockerfile
   └── run.sh
   ```

2. Because the Dockerfile requires the full source tree, build the image manually first and tag it `local/machbar`:

   ```bash
   # From the repo root
   docker build -f home-assistant/Dockerfile -t local/machbar .
   ```

3. In `home-assistant/config.yaml`, set:
   ```yaml
   image: "local/machbar"
   ```

4. In HA → **Settings → Add-ons → Add-on Store → ⋮ → Check for updates**, then install *Machbar*.

#### Option B — Add-on repository (recommended for distribution)

Publish the repository to GitHub (or a public git host) and add the URL in HA:

**Settings → Add-ons → Add-on Store → ⋮ → Repositories** → paste the repo URL.

For CI to build and push arch-specific images, configure a workflow that runs:

```bash
docker buildx build \
  --platform linux/amd64,linux/arm64,linux/arm/v7 \
  -f home-assistant/Dockerfile \
  -t ghcr.io/temporaer/machbar:VERSION \
  --push .
```

Then set `image` in `config.yaml`:

```yaml
image: "ghcr.io/temporaer/machbar/{arch}-{version}"
```

### Add-on options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `seed_database` | bool | `false` | Populate with sample members/projects on first start |

### Ingress

Machbar appears as a side-panel entry (*Machbar*) in HA's navigation. Home
Assistant proxies and strips the dynamic Ingress path, so no manual
`BASE_PATH` configuration is required.

To expose a direct port (e.g. for access outside HA), enable the port in **Add-on → Configuration**:

```yaml
ports:
  3000/tcp: 3000
```

---

## 7. Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | TCP port the HTTP server listens on |
| `HOST` | `0.0.0.0` | Bind address (`127.0.0.1` for localhost-only) |
| `DATA_DIR` | `./data` (dev) / `/data` (Docker) | Directory for the SQLite database file |
| `DATABASE_FILE` | `machbar.db` | SQLite filename inside `DATA_DIR` |
| `BASE_PATH` | `/` | URL prefix; set to `/sub/path` for sub-path deployments |
| `SEED_DATABASE` | `false` | Run `db:seed` automatically on startup when `true` |
| `NODE_ENV` | `development` | Set to `production` in Docker/deployed environments |

Copy `.env.example` to `.env` for local development.

---

## 8. Database — Migrations & Seeding

### Migrations

Migrations are applied automatically every time the container starts (via `docker-entrypoint.sh`). For manual runs:

```bash
npm run db:migrate
```

Migrations are idempotent — running them more than once is safe.

> **`0002_project_acceptance_criteria_task_size`** rebuilds the `projects` table: it drops the free-text `description` column (copying every non-empty description into the story's first acceptance criterion), defaults `status` to `backlog`, and adds `tasks.size`. No projects, tasks, tags, or dependencies are lost.

To rehearse a migration against production data, always work on a **copy**:

```bash
sqlite3 data/machbar.db ".backup /absolute/path/to/copy/machbar.db"
DATA_DIR=/absolute/path/to/copy npm run db:migrate
```

> Use an **absolute** `DATA_DIR`: the script runs with `apps/api` as its working directory, so a relative path would resolve there.

### Seeding

Seeding creates a small set of sample members, tags, and projects. It is intended for first-run setup and demos only.

```bash
# One-time seed
npm run db:seed

# Or via environment variable (Docker)
docker run ... -e SEED_DATABASE=true machbar
```

### Backup

Back up the database by copying the SQLite file:

```bash
# Docker volume
docker run --rm -v machbar-data:/data -v $(pwd):/backup alpine \
  cp /data/machbar.db /backup/machbar-$(date +%Y%m%d).db

# Compose
docker compose exec machbar sh -c 'cp $DATA_DIR/$DATABASE_FILE /tmp/backup.db'
```

For live backups without stopping the server, use SQLite's `.backup` command or `sqlite3 machbar.db ".backup backup.db"`.

---

## 9. Architecture

See **[docs/architecture.md](docs/architecture.md)** for:

- Monorepo package boundaries (`@machbar/api`, `@machbar/web`, `@machbar/shared`)
- SQLite entity hierarchy: Members → Projects → Tasks → Sub-tasks
- Ownership/context/tag **inheritance chains** and `inheritanceMode`
- Compiled/resolved view fields (`effectiveOwnerId`, `effectiveTags`, `blocked`, `availableActions`, …)
- The project workflow state machine, driver invariant, and stuck detection
- Web interaction patterns (optimistic retention, focused quick sheets)
- Transaction rules, WAL mode, and the acceptance-criteria migration
- `BASE_PATH` and HA Ingress handling

---

## 10. Workflow — User Stories, Backlog Review & Refinement

### Projects are user stories

A project is a **user story**: a title, an ordered list of **acceptance criteria**, and exactly one **driver** (the accountable person). Stories move through three states:

```
backlog  ──activate──►  active  ──complete──►  completed
```

`archived` is reachable from `backlog` and can be un-archived back into it. Every project response carries `availableActions`, so the UI only ever offers legal transitions. Status is changed **only** through the workflow endpoints — a plain `PATCH` that tries to set `status` is rejected.

Nothing auto-completes a story. When every task of an `active` story is done or cancelled, the story is flagged with the stuck reason **`completion_review`**: a prompt for a human to either complete it or add the work that is still missing.

A story whose open tasks are **all waiting** is normally flagged `only_waiting` — but not if at least one of those waiting tasks has a **Wiedervorlage** (scheduled revisit date). Setting a revisit is an explicit decision about when to look again, so the story counts as deliberately parked rather than forgotten. Past, today's and future dates all count.

### The driver invariant

Every story that has left the backlog must have a driver:

- Activating a story without a driver fails; the UI asks for one inline and activates in the same step.
- The driver of an `active` or `completed` story cannot be cleared — only reassigned. To leave a story unassigned, return it to the backlog first.

### Acceptance criteria

The old free-text project description was replaced by structured, individually checkable, reorderable criteria. Existing descriptions are **not lost**: migration `0002` copies each one into the story's first acceptance criterion.

### Task sizing

Tasks carry an optional size estimate — `S`, `M`, `L`, `XL`, or unestimated.

### Backlog Review — *Mehr → Backlog Review* (`/mehr/backlog`)

Groom the backlog without leaving the list. Each story row offers targeted popups:

| Action | Effect |
|--------|--------|
| **Verantwortlich** | Pick the driver |
| **Akzeptanzkriterien** | Add/edit/check/reorder criteria in place |
| **Planen** | Set due / scheduled dates |
| **Aktivieren** | Move to `active` (asks for a driver if none is set) |
| **Bearbeiten** | Open the full story page (the only action that navigates away) |
| **Archivieren** | Park the story |

### Refinement — *Mehr → Refinement* (`/mehr/refinement`)

An **owner × size matrix** over all open tasks. Tap a cell to filter the list below, then:

- **Size** a task by cycling `S → M → L → XL → unestimated`.
- **Assign** a task through a focused owner popup — assignment never drags you into the full task detail sheet.

### Interaction notes

- **Retained rows stay actionable.** After completing a task it stays visible, crossed out, for a few seconds. It is only disabled while the request is in flight; once the request completes the row is interactive again, so a second swipe immediately reopens it.
- **Focused quick sheets.** Owner, dates, tags, criteria and driver each have their own small sheet. Full detail pages are reserved for deliberate deep edits.
- **Assignment is a tap, not a dropdown.** Since a household has at most a handful of members, every assignment popup shows all of them as chips — including an explicit *Gemeinsam / offen* (tasks) or *Niemand zugewiesen* (stories) chip wherever leaving it unassigned is allowed. The current choice stays highlighted while you pick.
- **Waiting follow-ups are append-only.** Logging a follow-up on a `waiting` task appends to its notes under a generated header — `[dd.mm.yy, hh:mm · Name]` — so the history stays intact and attributable. Setting a **Wiedervorlage** in the same sheet also clears the story's `only_waiting` flag.
- **Refiling searches.** *Ablegen* / *Verschieben* lists every target project or parent task with a search box on top: type any part of a project or task title (the owning project counts too) and the list filters as you type. With an empty box the five destinations you used most recently come first under *Zuletzt verwendet*, everything else under *Alle Ziele*. Recents live in the browser only and are dropped automatically when a destination no longer applies.

---

## 11. Known Limitations & Future Work

| Area | Current state | Planned |
|------|--------------|---------|
| **Multi-user auth** | None — all members share a single URL; identity is a per-session selection | JWT or session-based auth per member |
| **Real-time sync** | Full page reload required to see changes from other members | WebSocket or SSE push |
| **Recurrence** | `recurrenceRule` field is stored (RFC 5545 format) | Automatic task regeneration on completion |
| **Reminders** | `reminderAt` field is stored | Push notifications / HA notification service |
| **Browser E2E coverage** | Playwright deferred from the v0 pass | Add phone-viewport and Ingress-path scenarios |
| **Multi-instance / HA** | Single writer (SQLite); safe for home use | Postgres adapter for multi-instance setups |
| **Mobile** | Responsive but no PWA manifest | PWA / home-screen install |
| **Offline** | Requires connectivity | Service Worker caching |
| **i18n** | German only (`de` strings in `@machbar/shared`) | Additional locales |

---

## 12. Future Home Assistant Integration

Machbar can be extended to emit HA entities and respond to HA service calls. Below are illustrative examples of what a future HA integration could look like.

### Sensor entities (read)

```yaml
# Example: expose a member's open task count as a sensor
sensor:
  - platform: rest
    name: "Machbar – Open tasks (Alice)"
    resource: http://localhost:3000/api/members/1/stats
    value_template: "{{ value_json.openCount }}"
    unit_of_measurement: tasks
    scan_interval: 300

  - platform: rest
    name: "Machbar – Overdue tasks"
    resource: http://localhost:3000/api/agenda
    value_template: "{{ value_json.overdue | length }}"
    unit_of_measurement: tasks
```

### Automation triggers

```yaml
# Send a notification when a task becomes overdue
automation:
  - alias: "Machbar overdue task alert"
    trigger:
      - platform: numeric_state
        entity_id: sensor.machbar_overdue_tasks
        above: 0
    action:
      - service: notify.mobile_app_phone
        data:
          title: "Machbar"
          message: "You have {{ states('sensor.machbar_overdue_tasks') }} overdue task(s)."
```

### Service calls (write)

```yaml
# Example REST command to mark a task as done from an HA script
rest_command:
  machbar_complete_task:
    url: "http://localhost:3000/api/tasks/{{ task_id }}/status"
    method: PATCH
    content_type: "application/json"
    payload: '{"status": "done"}'
```

These integrations are illustrative. A dedicated HA integration (custom component) would provide proper entity registration, authentication, and real-time state via WebSocket.
