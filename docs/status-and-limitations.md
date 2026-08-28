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
- outbound Web Share with clipboard fallback;
- single-process/container deployment with SQLite;
- reverse-proxy, URL sub-path, and Home Assistant Ingress support.

## Current limitations

### Language

The application interface, server-generated user messages, date vocabulary,
and much of the test suite are German. Public documentation is English, but
the app is not yet bilingual.

### Connectivity and synchronization

Machbar requires connectivity to its server. The service worker enables PWA
installation but does not cache application data for offline use.

Changes made in one browser are not pushed live to other clients through
WebSockets or server-sent events. Another browser may need a reload to see
them.

### Deployment model

SQLite is used as a single local database file. Run one Machbar application
instance against that file. The design is appropriate for a small household
deployment, not horizontal scaling or a highly available multi-instance
service.

Backups are file/database operations managed by the operator.

### Recurrence, reminders, and notifications

The data model contains recurrence and reminder fields, but Machbar does not
currently regenerate recurring tasks or deliver reminder notifications.

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

- German/English localization;
- live client updates;
- offline caching and synchronization;
- recurrence processing and notification delivery;
- file share targets;
- a published Home Assistant add-on and a supported native integration;
- conversion between a captured task and a multi-step project.

These are directions, not release commitments.

