# Machbar

> **Das ist machbar.** — A GTD-style task manager for families and small teams.

Machbar helps you collect, clarify, and organise work as **user stories** (projects) with acceptance criteria, a single accountable **driver**, estimated tasks, typed tag inheritance, and a shared agenda view. Built with React/Vite + Fastify + SQLite; runs as a single process or container with zero external service dependencies.

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

### Pocket ID / OpenID Connect

Machbar can require Pocket ID authentication at its direct HTTPS origin. Create
an OIDC client in Pocket ID with:

- redirect URI: `https://machbar.example.com/api/auth/callback`
- scopes: `openid profile email`
- response type: authorization code
- PKCE: S256

Then configure all required OIDC variables together:

```dotenv
OIDC_ISSUER_URL=https://pocketid.example.com
OIDC_CLIENT_ID=replace-with-client-id
OIDC_CLIENT_SECRET=replace-with-client-secret
OIDC_PUBLIC_URL=https://machbar.example.com
OIDC_SESSION_TTL_DAYS=30
```

With these variables set, every API except health and the login endpoints
requires a Pocket ID-backed Machbar session. The browser receives only a
30-day opaque `Secure`, `HttpOnly`, `SameSite=Lax` cookie; provider tokens and
the client secret remain server-side. Leaving all OIDC variables unset keeps
the existing local “Wer bist du?” identity flow. A partial configuration is a
startup error rather than an unauthenticated fallback.

On first login, Machbar links the validated Pocket ID subject to one unlinked
member with the exact same display name. If the full name differs, a unique
case-insensitive match between Pocket ID's `preferred_username` and an existing
member name is accepted (for example `hannes` → `Hannes`); otherwise Machbar
creates a member. Later logins synchronize that member's name from Pocket ID.
OIDC-linked members remain assignment targets but can no longer be renamed or
deleted inside Machbar. Access to the client should be restricted to the
desired trusted household users/groups in Pocket ID. Name/username adoption is
a one-time migration convenience and assumes those allowed users cannot
impersonate each other's identity fields in Pocket ID; the immutable OIDC
subject is authoritative after linking.

The direct OIDC origin must be HTTPS and must exactly match `OIDC_PUBLIC_URL`.
OIDC cookies are origin-bound, so a separately hosted Home Assistant Ingress
origin cannot share this login session; use Machbar's configured direct origin
when OIDC is enabled.

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
| `OIDC_ISSUER_URL` | unset | Pocket ID issuer URL; enables OIDC only when all required OIDC variables are present |
| `OIDC_CLIENT_ID` | unset | Pocket ID client ID |
| `OIDC_CLIENT_SECRET` | unset | Pocket ID client secret; keep only in runtime secrets / `.env` |
| `OIDC_PUBLIC_URL` | unset | Exact external HTTPS origin used for callback, cookies, redirects, and origin checks |
| `OIDC_SESSION_TTL_DAYS` | `30` | Local Machbar session duration, from 1 to 365 days |

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
>
> **`0003_colored_default_tags`** adds a stable colour to every existing tag and inserts the standard household/person tags (`Lars`, `Lea`, `Jonas`, `Hannes`, `Sarah`, `Schule`, `Kita`, `Urlaub`, `Haus`, `Garten`) without replacing existing data.
>
> **`0004_oidc_authentication`** adds separate identity, one-time login-flow,
> and hashed-session tables. It does not rebuild `members`, projects, or tasks.
>
> **`0005_capture_persistence`** adds `tasks.needs_clarification` without
> rebuilding `tasks`, marks legacy `inbox` rows for clarification, and converts
> their workflow status to `actionable`.

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
- Ownership and typed-tag **inheritance chains**
- Compiled/resolved view fields (`effectiveOwnerId`, `effectiveTags`, `effectiveAreaTags`, `blocked`, `availableActions`, …)
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

### Projekte tab — swipe the whole workflow (`/projekte`)

The main **Projekte** tab lists stories of *every* status and offers the same gestures as Backlog Review — the complete Scrum workflow, one thumb:

| Gesture / control | Effect |
|-------------------|--------|
| **Swipe right** (or the round button on the left of the row) | The next workflow step for that status: Backlog → **Aktivieren**, Aktiv → **Abschließen**, Abgeschlossen → **Wieder öffnen**, Archiviert → **Aktivieren** |
| **Swipe left** or the **⋯** button | Chip strip: compact icon buttons for *Verantwortlich*, *Akzeptanzkriterien*, *Planen*, *Bearbeiten* plus the remaining legal transitions as named text chips (e.g. *In Backlog zurücklegen*, *Archivieren*) |
| **Tap the row** | Opens the story page, exactly as before |

- Only steps the backend actually allows for the current status are offered.
- Activating a story without a driver asks for one first and activates in the same step.
- Every row shows its **status**; right after a transition the badge briefly shows what happened (*Aktiviert*, *Abgeschlossen*, *Wieder geöffnet*, *Zurück im Backlog*, *Archiviert*) and stays actionable, so a workflow can be cycled straight away.
- **The status is never a dropdown.** It is a read-only badge everywhere — on the row, on the story page and in the *Bearbeiten* sheet — and only changes through the named transition buttons/chips that are legal right now.

**Finding the story you mean.** The tab has a search box and two scope chips above the list:

| Control | Effect |
|---------|--------|
| **Search** (*Titel oder Akzeptanzkriterium suchen …*) | Substring match over the story title **and** every acceptance-criterion text, case-insensitive and diacritic-tolerant (`cafe` finds *Café*) |
| **Meine & offen** (default) | The selected member's own stories plus every story with no driver — nothing anyone could still pick up is hidden. With no member selected yet, this shows the unassigned ones |
| **Alle** | Every story, regardless of driver |

The list is split in workflow order: **active/actionable and active/stuck → healthy waiting → backlog → completed/archived**. Healthy waiting is deliberately narrow: the story is still `active`, but has neither a next action nor a stuck reason. It gets a counted *Wartet* section and a calm blue hourglass without changing its stored status or legal workflow actions; completed and archived stories remain together in the folded terminal section. Optional tag grouping is applied independently inside each workflow section. Within each classification, order is deterministic — stored position, then title, then id — never fetch order. If stories exist but none match, the list says *Keine Projekte für Suche/Filter.* — distinct from *Keine Projekte vorhanden.*

**Reading a row at a glance.** Each list classification has its own colour — a left-edge stripe, the status badge and the primary button all share it: neutral slate for backlog (nothing achieved yet, so deliberately not green), green for actionable active work, calm blue plus an hourglass for healthy waiting, **warning amber for an active story that is stuck**, a muted green for completed, grey for archived. Every row shows one progress bar only — task completion, exposed as a real `progressbar` with `2/4`-style value text. The acceptance-criteria *count* stays in the meta line; its separate, unlabelled bar was removed as visual noise (the criteria bar still exists on the story page and in the criteria editor, where it is labelled).

### Project outline — drag to organise (`/projekte/:id`)

A story's task outline is edited **in place**, without a global "sort mode" and without a control panel repeated under every row. Each row carries exactly one structural control, the ⠿ handle on its left:

| Gesture / control | Effect |
|-------------------|--------|
| **Drag the handle** (or **long-press the row** on touch) | Move the task: vertically to reorder, sideways to change level. An insertion line shows the exact drop slot and level while dragging; the dragged row previews its projected indent |
| **Escape** / lifting the finger outside | Cancels — nothing is mutated |
| **Arrow keys on the focused handle** | ↑/↓ reorder, →/← indent/outdent. The pointer-free equivalent of dragging, and focus follows the row as it moves |
| **Activate the handle** (tap/click/Enter) | Selects the task and opens the single *Sortier-Werkzeuge* toolbar at the bottom: ↑ ↓ → ← plus **Ablegen** |
| **Ablegen** | The searchable refile sheet, for destinations that are nowhere near on screen (another project and/or another parent task) |

- Moves are **optimistic**: the outline reorders immediately and the server is asked afterwards. A rejected move (e.g. a hierarchy cycle) puts the tree back and shows *Verschieben fehlgeschlagen* plus the server's German reason on that row — nothing else on the page is reset.
- Dropping a task into a **collapsed** parent expands that parent, so the moved row never disappears.
- Screen readers get a live announcement of the current drop target while dragging (*„Unter ‚X'· Position 2"*).
- Structural editing is offered **only in a project's own outline**, where the rows on screen are the complete, stored sibling group. Compiled views (Heute, Eingang, Suche) show a filtered slice of unrelated tasks, so a position read off the screen there would be meaningless — refiling stays available in those views through the task detail sheet's *Ablegen* pickers.

**Adding a subtask without leaving the row.** The chip strip (swipe left or **⋯**) has a **+ Teilaufgabe hinzufügen** chip. It opens a one-field composer directly beneath the task — not the full detail sheet. Enter or *Speichern* creates the child, expands the parent if it was collapsed, refreshes and hands focus back into the row; *Abbrechen* and <kbd>Esc</kbd> never call the API. A failed create keeps the composer open with the typed title and a visible error, and a double submit cannot fire a second request.

### Refinement — *Mehr → Refinement* (`/mehr/refinement`)

An **owner × size matrix** over all open tasks. Tap a cell to filter the list below, then:

- **Size** a task by cycling `S → M → L → XL → unestimated`.
- **Assign** a task through a focused owner popup — assignment never drags you into the full task detail sheet.

### Interaction notes

- **Retained rows stay actionable.** After completing a task it stays visible, crossed out, for a few seconds. It is only disabled while the request is in flight; once the request completes the row is interactive again, so a second swipe immediately reopens it.
- **Capture and workflow are separate.** Global Quick Add creates a *Machbar*
  task marked **Zu klären**; project Quick Add and inline child creation start
  clarified. **Eingang** lists the clarification flag rather than a status.
  Captured tasks remain visible inside projects but stay out of Heute and
  next-action selection. Their first right-swipe clears **Zu klären**; explicit
  workflow choices and *Speichern & nächste klären* do the same, while
  metadata edits and refiling do not.
- **Project dates surface once, not on every task.** Heute shows a dedicated
  project card from seven days before a project deadline and from a reached
  project scheduling date onward. Scheduling prompts remain until the project
  is rescheduled or completed. The card shows its clarified next action or
  repair guidance; task rows show the project deadline as relative context
  such as *in 2 Wochen* or *3 Tage überfällig*. No project date is copied into
  a task's own date fields.
- **Focused quick sheets.** Owner, dates, tags, criteria and driver each have their own small sheet. Full detail pages are reserved for deliberate deep edits.
- **Tags are compact, typed, and reusable.** Project and task editors group the available coloured chips into Bereich, Person, Kontext, and Normal. Creating a tag in a section assigns that primary kind automatically. Project tags flow down the task tree unless a task excludes them. Projects are grouped once by a deterministic primary Bereich. The global catalogue can change kind/grouping/order or delete tags under **Mehr › Tags verwalten**; deletion removes only tag associations, never their projects or tasks.
- **Assignment is a tap, not a dropdown.** Since a household has at most a handful of members, every assignment popup shows all of them as chips — including an explicit *Gemeinsam / offen* (tasks) or *Niemand zugewiesen* (stories) chip wherever leaving it unassigned is allowed. The current choice stays highlighted while you pick.
- **Waiting follow-ups are append-only.** Logging a follow-up on a `waiting` task appends to its notes under a generated header — `[dd.mm.yy, hh:mm · Name]` — so the history stays intact and attributable. Setting a **Wiedervorlage** in the same sheet also clears the story's `only_waiting` flag.
- **Notes are free-form Markdown.** Task rows show a compact rendered preview; task and project details show GFM-style headings, emphasis, lists, links, strikethrough and task lists. Normal newlines stay visible, and HTTP(S), `mailto:`, `tel:` and `sms:` links are explicitly allowed while unsafe schemes and raw HTML are blocked. Editing remains a textarea with small mobile buttons for bullets, checkboxes, bold and links.
- **Machbar participates in system sharing.** An installed Android PWA accepts shared titles, text and URLs at its dedicated share screen. The existing Capture choices create a new Inbox/Machbar task or project, while recent, Today and searched tasks/projects accept a one-tap append to their existing free-text notes. Files and attachments are not accepted.
- **Tasks and projects can be shared out.** The native Web Share sheet receives readable plain text (including project task hierarchy) plus a deep link to the same Machbar deployment. Task deep links open the existing detail sheet; recipients must have access to the instance, including OIDC access where enabled. Browsers without Web Share copy the same content and URL to the clipboard.
- **Waiting uses normal task rows.** The Wartet view is one flat, deterministically ordered outline with `Wartet auf: …` inside each row. Right-swipe always means *Wieder machbar* in this view; *Nachhaken* remains a focused action in the compact icon strip.
- **Projectless tasks can be filed in place.** Their project icon opens the same searchable picker with recent destinations used by task refiling, and moves the complete subtree into the chosen project.
- **Stuck guidance sits with the work.** A stuck project shows a prominent reason and process-specific repair step directly above its editable task outline, so a **Zu klären** task can be clarified without leaving the project.
- **Refiling searches.** *Ablegen* / *Verschieben* lists every target project or parent task with a search box on top: type any part of a project or task title (the owning project counts too) and the list filters as you type. With an empty box the five destinations you used most recently come first under *Zuletzt verwendet*, everything else under *Alle Ziele*. Recents live in the browser only and are dropped automatically when a destination no longer applies. It is reached from the outline's selected-task toolbar (*Ablegen*) and from the task detail sheet, so no structural move ever requires a gesture.
- **Structure is dragged, not configured.** The task outline has no organize mode: one ⠿ handle per row, one insertion line, one toolbar for the selected task — with arrow keys on the handle as the full pointer-free equivalent. See *Project outline* above.

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
| **Mobile** | Responsive installable PWA with Android text/URL share target | Offline caching and file share targets |
| **Offline** | Requires connectivity | Service Worker caching |
| **i18n** | German only (`de` strings in `@machbar/shared`) | Additional locales |
| **Capture shape conversion** | Undecided Eingang captures are tasks; task/project conversion is not yet available | **Zum Projekt machen** for structured tasks; **Als einzelne Aufgabe behandeln** for simple projects |

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
