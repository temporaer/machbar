# Machbar

> **Das ist machbar.**

Machbar is a lightweight, multi-user task system for households and other small
groups, built around one central question: **what can actually be done next?**
Tasks and projects can be shared, owned, delegated, or simply visible to
everyone without turning everyday coordination into project management.

It combines frictionless capture with explicit refinement of larger projects, a
focused Today view, waiting and dependency handling, and just enough structure
for context, areas, deadlines, and responsibility. The goal is to turn the messy
stream of household obligations, errands, ideas, and multi-step projects into a
small set of clear next actions—while keeping individual work and shared
responsibilities visible without constant manual grooming.

![Machbar's mobile Today view](docs/images/today-mobile.png)

## More than a shared checklist

A shopping item is easy. Organizing a holiday, repairing a room, handling an
insurance claim, or keeping up with recurring maintenance is not. Real life has
unclear requests, hand-offs, dependencies, deadlines, and things that cannot
continue until somebody else responds.

Machbar does not ask you to keep rearranging one giant list. It understands the
difference between captured work, something actionable, a project with several
steps, and work that is intentionally waiting.

### Capture now, clarify when ready

Get an obligation out of your head before deciding exactly what it means. The
Inbox is a short refinement queue: turn a capture into a concrete action, place
it in a project, delegate it, or set it aside deliberately.

### See what is genuinely actionable

Today brings together planned and due work, reached follow-ups, and the next
useful step from active projects. Personal and household-wide views keep
individual focus without hiding shared responsibilities.

### Give projects direction

A project connects a desired outcome with the path toward it. Keep possible
projects in the backlog, define what “done” means when that helps, and start
only when there is a real next step or an intentional wait.

### Treat waiting as part of the work

Tasks can wait on another task, a person, a company, an event, or a delivery.
Add a revisit date and Machbar brings the item back when attention is useful,
instead of leaving it to disappear in a note or clutter Today too early.

### Review decisions, not everything

Review contains work that needs judgment: clarify it, continue it, park it, or
finish it. Healthy work stays out of the way, while **All** keeps the complete
inventory searchable whenever you need it.

### Keep useful structure lightweight

Use owners, areas, contexts, tags, deadlines, dependencies, and completion
criteria where they improve a decision. Recurring tasks can schedule their next
occurrence from actual completion, which works well for maintenance that never
happens on a perfect calendar.

## For people who enjoy systems—but do not want to manage one

Machbar borrows practical ideas from GTD, org-mode, and lightweight agile
planning: capture, next actions, explicit waiting, project outcomes, and regular
reconsideration. It turns those ideas into a few everyday views rather than a
methodology your household has to learn.

It is a good fit when:

- shared lists have become noisy but full project-management software feels
  absurd;
- household projects often have several steps, unclear ownership, or external
  dependencies;
- you want a trusted Today view instead of repeatedly scanning every list;
- most interaction happens from a phone;
- privacy and control of the data matter.

![Machbar's mobile Projects view in dark mode](docs/images/projects-mobile.png)

## Built for everyday use

Machbar is mobile-first, installable as a PWA, and available in German and
English with light and dark modes. Supported desktop and mobile browsers can
receive standards-based Web Push notifications on each opted-in device, even
without an open Machbar window. Supported Android browsers can also capture
text and links directly from the share sheet.

It is private and self-hosted: one small service and one persistent SQLite
database, with optional Pocket ID authentication. No hosted account or external
database is required.

## Run it yourself in minutes

Requirements: Docker with the Compose plugin.

```bash
git clone https://github.com/temporaer/machbar.git
cd machbar
docker compose up --build -d
```

Open `http://localhost:3000`, create the first household member, and start
capturing work. Data lives in the persistent `machbar-data` volume.

Machbar is young, opinionated software. Read
[Status and limitations](docs/status-and-limitations.md) before relying on it
for a particular deployment.

## Documentation

- [Getting started](docs/getting-started.md)
- [Household workflow](docs/workflow.md)
- [Deployment and configuration](docs/deployment.md)
- [Development](docs/development.md)
- [Architecture](docs/architecture.md)
- [Home Assistant](docs/home-assistant.md)
- [Status and limitations](docs/status-and-limitations.md)
