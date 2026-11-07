# Bounded implementation brief

The user approved these bounded second-pass slices on 2026-11-06. The original
proposal and its guardrails are preserved below; the implementation record is
at the end. The [first-pass bug plan](../implementation-plan.md) remains separate,
deferred and intact.

## Proposed slices

| Slice | Actual change | Do not bundle |
| --- | --- | --- |
| F1 | Quick Add: existing Create first/full-width, existing secondary actions below | Capture-to-AI text transfer, removed media modes, shared thought/Share behavior changes |
| F2 | Move existing project batch-entry button beside task summary; consistent Add tasks wording | Universal note demotion, duplicate button, setup wizard or activation shortcut |
| F3a | Move eligible add-wait entry from general options to planning metadata | Ownership changes, new waiting eligibility or lifecycle rules |
| F3b | Place existing revisit summary/Edit before follow-up Save | Second date editor, new planner mode, merged/generalized Save |
| F4 | One secondary captured-task Add subtasks launcher; existing manual-first naming/order | Four primary shape choices, default project conversion or compulsory AI |
| F5 | Whitelisted identical Details intent deduplication and reason-specific hierarchy | Removal of repair/completion/lifecycle decisions |

F1, F2, F3 and F5 are independently reviewable directions. F4 shares capture/
detail space with F3a and localization with F2: coordinate files, not domain
semantics. No backend refactor, dependency, setting, schema or endpoint change
is justified. Use existing commands, hosts, composers and actions.

## Critic and capability review outcomes

The critic accepted F1 and a narrowly secondary F4, reduced F3 to summary/link
ordering, and rejected universal note demotion in favor of moving F2's launcher.
The independent reviewer accepted these directions, with two bounded plan
conditions:

1. **F5 equivalence:** whitelist only self-target `review_task`/`review_project`
   and prove identical intent/focus/return. Otherwise retain both controls.
   Never infer equivalence from label/category alone.
2. **Launcher safety:** F2 retains completed/archived visibility and pending
   guards; F4 retains applicable pending/unsaved-content guards. Preserve
   close/return focus to the moved/new opener or its safe fallback. If parity
   cannot be preserved simply, keep the original route/placement.

These conditions are explicit in this brief; implementation and proposed
layouts remain unverified. Advisory acceptance of a direction is not UI
implementation acceptance or user approval.

## Proportional acceptance journeys

Focus first on successful work and capability reachability. Existing error,
privacy and concurrency guarantees are guardrails, not a second bug backlog.

| Journey | What must remain true | Evidence needed after implementation |
| --- | --- | --- |
| Title-only and media-first capture | Same simple submission/reset/Open; all camera/fallback/file/crop/AI alternatives visible; Cancel creates nothing | Actual desktop/mobile layout and success paths; existing capture contracts |
| Shared capture callers | Guided thoughts remain literal/unassigned; Share create/append and drafts unchanged | Existing caller tests plus relevant browser smoke |
| Empty, context-rich and nested project | Obvious Add tasks without burying context; long-outline alternatives reachable; no terminal authoring; same batch/start decisions | Short/long mobile and desktop pages, guards, opener/return focus |
| Known task steps | Task remains task by default; optional conversion explicit; existing children and multirow drafts preserved; first batch atomic | Existing composer/batch/activation contracts and shortcut round trip |
| Start/maintain waiting | Assignment separate; existing eligibility; no lost prerequisite or end-without-outcome path | Detail/planning reachability and existing command contracts |
| Continue/end follow-up | Outcome and changed date still save together; general planning drafts not silently committed; one date editor | Existing follow-up/history contract and visible control/return order |
| Routine/repair/completion Review | Only identical self-review inspection collapses; repairs/guards/acknowledgement/return remain | Reason/action matrix and browser repair/detail return |

Do not remove semantically necessary choices to improve a count. Keep authored
Edit/Save/Cancel, immediate atomic edits and compound confirmations, DE/EN,
visible touch/keyboard/assistive paths, focus restoration, reduced motion,
HashRouter and proxy/PWA contracts. Do not add shortcuts as the only route.

Use narrow existing tests first. An eventual visible implementation needs
`bash scripts/verify.sh` and `npm run build && npm run test:e2e`, plus actual
layout/focus evidence for the changed surfaces. Physical soft keyboards and
screen readers need their own checks; headless emulation is not evidence of
them.

## No-change decisions

- Keep Today, Projects and exhaustive inventory as different jobs.
- Keep More's existing purposeful groups; no new All link or navigation reorder.
- Keep ordinary capture -> planning -> completion without a new classification
  wizard; that path worked in the walkthrough.
- Keep project notes prominent where they provide constraints before action.
- Keep project driver and task owner distinct; repeated matching names do not
  make their controls duplicates.
- Keep optional goals, guided capture, AI, reflection and cleanup optional.
- Keep existing activation, criteria, history, privacy and retry contracts.
- Defer origin-aware cleanup return and fully adjacent waiting date editing;
  neither is needed for these minimum changes.

## Audit execution record

The UI walkthrough used a loopback-only server with a separate seed database and
built baseline assets. Synthetic captures, tasks, project notes and follow-up
were confined to that database. No deployment, household data, integrations or
application code were changed.

Selected current-state screenshots are in `images/`. They are observations,
not proposed-layout mockups or user studies. Mobile examples used headless
Chromium; the approved Playwright connection supplied the desktop Review
snapshot. Locator/tool timeouts during navigation were treated as tooling/
walkthrough limitations, not app defects.

The baseline verifier passed:

```bash
PATH=/home/hannes/miniforge3/envs/machbar-pytest/bin:$PATH \
  npm exec --yes --package=node@22 -- bash scripts/verify.sh
```

Architecture, shared build, typecheck, workspace tests, app builds and Python
tests passed; Python reported 159 passed and 1 skipped. The Python path is an
existing machine-local environment, not a new contributor requirement.
Whitespace/local-link checks and hash checks preserving the original four
Markdown files also passed. Baseline verification does not validate unimplemented
layouts.

The temporary browsers/server were closed and the disposable database removed.
Only second-pass documents/screenshots are added; application code and the
original audit remain unchanged.

## Implementation record

F1–F5 reuse the existing commands, workflow hosts, drafts and mutations. No API,
schema, dependency or domain-lifecycle change is included. The root/web patch
versions are bumped; both languages reuse existing labels and obsolete
Structure-only label keys are removed.

The acceptance matrix adds real-app desktop/mobile journeys for capture
hierarchy, summary-level project batch entry, captured-task subtask entry,
waiting/follow-up order and Review inspection/return. Baseline screenshots in
this folder remain historical evidence, not screenshots of the implementation.

Three parallel general-purpose coding agents implemented capture, project entry
and task-flow slices; the coordinator implemented Review and integrated the
changes. The specialized UX profiles remained read-only. Independent
`simplification-critic` and `ux-regression-reviewer` acceptance reviews found no
introduced capability-loss, correctness or unnecessary-complexity blockers.
Their only outstanding condition was the final verification gate, now passed.

Final validation:

```bash
PATH=/home/hannes/miniforge3/envs/machbar-pytest/bin:$PATH \
  npm exec --yes --package=node@22 -- \
  bash -c 'bash scripts/verify.sh && npm run test:e2e'
```

**Passed:** architecture, shared build, all typechecks, workspace tests, app
builds, Python tests and both Chromium projects. The web suite reported 1,796
passed; Python reported 159 passed and 1 skipped; browser tests reported 24
passed. A standalone `npm exec --yes --package=node@22 -- npm run build` also
passed. Generated browser screenshots cover capture hierarchy, project entry,
secondary subtask entry and follow-up order.

Prechange presentation checks rejected the old order/reachability and the four
equivalent task/project inspection cases. Intermediate failures were test-only
assumptions: invalid Testing Library options, obsolete sibling labels, a generic
dialog locator rebinding to its parent, a past-deadline fixture triggering
activation, and the compatibility-only `externalWait.revisitDate` field. The
real follow-up check uses authoritative `Task.revisitAt` and household-local
calendar conversion; no domain behavior was altered to satisfy these tests.

The browser routine Review card alone uses a typed age-trigger projection
fixture over the real API response. Its project, repair, inspection/return and
no-acknowledgement checks are real; backend age/persistence remains covered by
the existing API tests. Physical phones, soft keyboards, screen readers and
user studies remain outside this evidence. Original first-pass hashes and
audit-local links/fences/whitespace were checked; the earlier bug backlog is
still deferred.
