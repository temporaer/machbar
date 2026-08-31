# Machbar

> **Das ist machbar.**

Machbar is a private, self-hosted command center for household work. It turns
requests, plans, routines, and half-finished conversations into clear next
actions that somebody can actually move forward.

Use it to:

- see what matters today—for you or for the whole household;
- turn shared commitments into owned, concrete actions;
- keep multi-step projects moving when work is delegated, blocked, or waiting;
- run recurring household routines without a calendar-rule editor;
- replace scattered chat messages and overloaded shared checklists with one
  dependable system.

![Machbar's mobile Today view](docs/images/today-mobile.png)

## Household work is more than a checklist

A shopping item is easy. Organizing a holiday, repairing a room, handling an
insurance claim, or keeping up with recurring maintenance is not. Real
household work has unclear requests, several steps, hand-offs, dependencies,
deadlines, and things that cannot continue until somebody else responds.

Machbar gives that work enough structure to stay visible without turning home
life into corporate project management.

## What Machbar does differently

### A Today view that does the sorting

Machbar builds personal and household-wide Today views from planning dates,
deadlines, follow-ups, responsibility, and task state. Standalone work remains
available, while projects contribute only their next useful action instead of
dumping every open step into Today. Household mode preserves independent owner
lanes, and real dates still surface later project tasks when they matter.

### Projects with an outcome, not just a pile of tasks

Keep possible household projects in the backlog without prematurely planning
them. Starting one requires a visible driver and either a concrete progress path
or intentional future waiting. Observable “done when…” criteria are optional;
when you add them, they become a real commitment and must be checked or removed
before completion. Individual tasks can still be delegated while one person
keeps hold of the overall outcome.

### Review without a weekly-review ritual

**Review** gathers only work that needs a deliberate maintenance decision:
broken progress or waiting paths, finished projects awaiting completion, and
active, backlog, or Someday work that has genuinely gone stale. Valid shared
tasks, Inbox captures, and ordinary work already surfaced by Today do not become
fake review debt. Keeping something active, parked, or for later explicitly
resets its lightweight review lease.

### Alles means everything stays findable

Derived views can hide work on purpose; **Alles** never does. It combines
first-class project inventory with standalone tasks, search, and useful filters
across active, parked, captured, waiting, completed, and archived work. Project
details retain full outlines, while search can take you directly to a matching
nested task.

### Waiting that remains actionable

Actionable work can wait on another Machbar task or on an external person,
organization, event, or delivery without changing its workflow status. Add a
revisit date when useful; the **Waiting** view gathers blocked work, while
reached revisits return to **Today**.

### Recurring routines that adapt to real completion

For maintenance and other repeating work, schedule the next occurrence a fixed
number of days after the task is actually completed. Add an allowed deviation
to create a deadline, then see the routine's hit/miss history over time.

### Shared responsibility without losing individual focus

Assign projects and tasks where ownership is clear, leave work shared where it
is not, and switch between **Mine** and **Everyone** without changing the
person currently acting in the app.

### Gentle momentum, not a leaderboard

Machbar recognizes completions and useful planning work with lightweight
household contribution points. Recurring routines completed after their
deadline subtract a point. The goal is a shared sense of momentum, not ranking
people against each other.

### Capture from where the work appears

Capture first and clarify later. On supported Android browsers, the installable
PWA can receive text and URLs from the system share sheet and turn them into
new work or append them to an existing task or project.

## Built for everyday use

Machbar is mobile-first, with touch-sized controls, swipe shortcuts, native
sharing, and an installable PWA. The interface is available in German and
English and supports system, light, and dark appearance modes.

![Machbar's mobile Projects view in dark mode](docs/images/projects-mobile.png)

Its workflow borrows useful ideas from GTD, org-mode, and lightweight Scrum,
but exposes them as practical views—**Today**, **Inbox**, **Projects**,
**Waiting**, **Review**, and **Alles**—rather than ceremonies your household has
to learn.

## Is Machbar a good fit?

Machbar is built for households that have outgrown chat reminders and flat
shared lists, especially when:

- household projects have several steps or unclear ownership;
- work frequently pauses for another person, company, event, or delivery;
- recurring maintenance should adapt to when it was actually completed;
- most daily interaction happens from a phone;
- privacy, local control, and durable data matter more than a hosted ecosystem.

It is intentionally not a general team collaboration platform, personal
knowledge base, or enterprise project tracker.

## Run it yourself in minutes

Requirements: Docker with the Compose plugin.

```bash
git clone https://github.com/temporaer/machbar.git
cd machbar
docker compose up --build -d
```

Open `http://localhost:3000`, create the first household member, and start
capturing work. Your SQLite database lives in the persistent `machbar-data`
volume and survives container restarts.

See [Getting started](docs/getting-started.md) for first-use orientation and
[Deployment](docs/deployment.md) for upgrades, backups, reverse proxies,
configuration, and Pocket ID.

## Simple self-hosting

- One Docker container or standalone Node.js process
- React/Vite frontend and Fastify API served together
- One persistent SQLite database; no separate database server
- Optional Pocket ID authentication through OpenID Connect
- Reverse-proxy, sub-path, and Home Assistant Ingress support
- Automatic database migrations on startup

## Current status

Machbar is usable software, but it remains a young, opinionated project:

- connected clients receive live invalidation updates through server-sent
  events, with focus/reconnect refresh and a disconnected polling fallback;
- the app requires network access to the Machbar server; installing the PWA
  does not provide offline task access;
- fixed-day-after-completion recurrence is supported, but calendar patterns
  such as “every second Monday” and notification delivery are not;
- SQLite is intended for one running Machbar instance, which is a good fit for
  a home deployment but not a horizontally scaled service;
- the Home Assistant add-on files are currently development packaging, not a
  published one-click add-on repository.

Read [Status and limitations](docs/status-and-limitations.md) before relying on
Machbar for a particular deployment.

## Documentation

- [Getting started](docs/getting-started.md)
- [Household workflow](docs/workflow.md)
- [Deployment and configuration](docs/deployment.md)
- [Development](docs/development.md)
- [Architecture](docs/architecture.md)
- [Home Assistant](docs/home-assistant.md)
- [Status and limitations](docs/status-and-limitations.md)
