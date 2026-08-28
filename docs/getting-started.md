# Getting started

This guide takes an empty Machbar installation from startup to its first
household tasks. For production configuration, upgrades, and backups, see
[Deployment](deployment.md).

## Start Machbar

The shortest supported route is to build and run the included Compose service:

```bash
git clone https://github.com/temporaer/machbar.git
cd machbar
docker compose up --build -d
```

Open `http://localhost:3000`.

The container serves the web app and API on the same port. Its SQLite database
is stored in the `machbar-data` Docker volume and survives
`docker compose down`.

To use another host port, create `.env` next to `compose.yml`:

```dotenv
MACHBAR_PORT=8080
```

Then open `http://localhost:8080`.

## Create the household

Without OpenID Connect, Machbar uses a lightweight local identity model:

1. Create the first person when the identity screen appears.
2. Add the other household members under **Mehr** → **Personen verwalten**.
3. Select the person currently using the browser.

The selected person controls the personal Today view and records who made a
change. It is not authentication: everyone who can reach the instance can
select a local member. Configure [Pocket ID](deployment.md#pocket-id-openid-connect)
when access to the direct deployment must require a login.

## Learn the main views

Machbar supports German and English. On first use it follows a supported
browser language and otherwise starts in German. Change the language and
System/Light/Dark appearance in the **Settings** section under **More**; both
choices apply to this browser.

| View | German label | Purpose |
|------|--------------|---------|
| **Today** | **Heute** | Work surfaced for the selected person from planning dates, due dates, responsibility, follow-ups, and project attention |
| **Inbox** | **Eingang** | Captured items that still need clarification |
| **Projects** | **Projekte** | Household outcomes, their tasks, driver, progress, and workflow state |
| **Waiting** | **Wartet** | Tasks paused for another person, organization, event, or delivery |
| **More** | **Mehr** | Search, stuck projects, project clarification, task refinement, activity, tags, people, and settings |

## Add the first work

Use the global add button and choose the shape that matches what you know:

- **Machbar** creates a concrete next action that can appear in Today.
- **Projekt** creates an outcome that can be broken into steps and completion
  criteria.
- Submitting an undecided capture files it in **Eingang** for later
  clarification.

For a useful first project:

1. Name the outcome, such as “Summer holiday is booked”.
2. Add “Erledigt, wenn …” criteria that make completion observable.
3. Assign one driver who keeps the overview.
4. Add at least one concrete next action.
5. Move external dependencies to Waiting and set a follow-up date when needed.

The [Household workflow](workflow.md) explains the model without requiring
prior knowledge of GTD, org-mode, or Scrum.

## Install the PWA

Use the browser’s install action to add Machbar to the home screen. In a
supported Android browser, installed Machbar is also available as a target in
the system share sheet for incoming text and URLs.

PWA installation does not make the app offline-capable. The browser must still
reach the Machbar server.

## Stop or inspect the service

```bash
docker compose logs -f
docker compose down
```

Do not add `-v` to `docker compose down` unless you intentionally want to
remove the named data volume.
