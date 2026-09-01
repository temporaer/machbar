# Status and limitations

Machbar is a young, opinionated application. This page distinguishes current
behavior from possible future work.

## Available today

- shared household members and per-browser identity selection;
- optional Pocket ID authentication at a direct HTTPS origin;
- capture, clarification, Today, Waiting, project, search, and review views;
- nested tasks, dependencies, responsibility inheritance, typed tags, dates,
  follow-ups, Markdown notes, acceptance criteria, and task effort;
- stuck-project and refinement guidance;
- installable PWA behavior and Android text/URL share target;
- standards-based Web Push for supported desktop and mobile browsers/PWAs;
- outbound Web Share with clipboard fallback;
- single-process/container deployment with SQLite;
- reverse-proxy, URL sub-path, and Home Assistant Ingress support.

## Current limitations

### Language and URLs

The interface supports German and English, while public documentation remains
English. Language and appearance preferences are local to each browser rather
than household-member account settings.

Frontend hash routes use English identifiers in both display languages.
German routes used by older versions are not retained as aliases, so old
bookmarks and shared deep links may need to be recreated.

### Connectivity and synchronization

Machbar requires connectivity to its server. The service worker enables PWA
installation but does not cache application data for offline use.

Connected browsers receive coarse change notifications through server-sent
events and refetch their current views. Returning to the app or reconnecting
also refreshes immediately; while the event stream is unavailable, a visible
client polls every two minutes as a recovery fallback. Same-query background
revalidation keeps the last successful data rendered without re-entering the
foreground loading or error layout. Changing a query's dependencies still
starts a foreground load so data from the previous query is never presented
as the new result.

Task and project metadata saves include a monotonic entity revision. If another
client changed the entity first, Machbar rejects the stale save, reloads the
latest version, and keeps the local draft for review and an explicit retry.
This is conflict detection rather than collaborative field-level merging.

### Deployment model

SQLite is used as a single local database file. Run one Machbar application
instance against that file. The design is appropriate for a small household
deployment, not horizontal scaling or a highly available multi-instance
service.

Backups are file/database operations managed by the operator.

### Recurrence, reminders, and notifications

Recurring task completion advances the next occurrence. Explicit task
`reminderAt` values can produce server-triggered Web Push notifications when
the installation has VAPID configured and the member opted in in that browser.
Each browser or installed PWA has an independent subscription, and delivery
fans out to every subscription for the member. Notifications are shown by the
service worker without requiring an open Machbar tab; clicking one opens or
focuses the relevant task or project. Assignments by another person can also
produce Push notifications.

Machbar does not currently provide a notification inbox, comments, mentions,
ordinary due-date notifications, or a daily digest. Push availability depends
on HTTPS, service-worker support, and the browser/operating system.

### Sharing

The incoming PWA share target accepts text and URLs. File and attachment
sharing is not supported. Web Share and PWA share-target availability depend
on browser and operating-system support.

### Authentication

Without Pocket ID, selecting a household member is not authentication. Anyone
who can reach the instance can choose a local identity.

With Pocket ID enabled, authentication applies to Machbar’s configured direct
origin. Home Assistant Ingress is a different origin and cannot reuse the
same cookie.

### Home Assistant

The repository contains add-on development files, but no published and tested
one-click add-on repository or native Home Assistant integration.

### Browser coverage

Most automated coverage is unit/component level. The repository has a
Playwright configuration, but broad phone-viewport, reverse-proxy, Ingress,
and browser-specific PWA coverage is not yet established.

## Possible future work

Potential directions include:

- additional interface languages;
- live client updates;
- offline caching and synchronization;
- broader reminder schedules and notification preferences;
- file share targets;
- a published Home Assistant add-on and a supported native integration;
- conversion between a captured task and a multi-step project.

These are directions, not release commitments.
