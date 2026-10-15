# Goals & Interventions — phased implementation plan

The original phases below have shipped. Follow-up work is tracked by #213
(product decisions: #212), sequentially on one branch and PR as requested:
owner-only placement → observation records → Today collection → ordinary task
backing → shared manual evidence/review → coach clarification → coach review.
Each shipping phase receives its own commit and full verifier evidence.

Phase 1 introduces durable internal task privacy independently of scope; see
[the current access contract](goals-and-interventions.md#owner-only-access-and-task-placement-213-phase-1).


This is the build plan for the feature specified in
[`docs/goals-and-interventions.md`](./goals-and-interventions.md). Every phase
is grounded in that spec and cites the same real files. Section references
(§N) point at the spec.

The phases are **independently shippable** and ordered so the feature is usable
as a **manual journal before any AI exists**: Phase 0 → 1 → 2 deliver a working
goals/interventions journal with no Home Assistant dependency; Phase 3 layers on
the AI coach; Phase 4 layers on optional recurring-task backing. Nothing in 0–2
requires an AI Task to be configured — the graceful-degradation story in §2/§7
is the default state during those phases, not a fallback.

Design invariants that hold across all phases (from the spec, do not violate):

- Goals are **never** a `work_items` role and there is no `goal_id` on
  `work_items` and no join table — relevance is inferred semantically (§2, §4).
- One canonical mutation path per operation. Task creation/ending always goes
  through the canonical task path behind `machbar_create_task` / the web task
  actions, never a parallel mutation (§8).
- The coach is **strictly user-triggered**; nothing runs an AI call unless the
  user asks (§2, §7).
- `running / finished / reviewed` is **derived**, never stored; stored status
  is only `active | concluded` (§4, §5).

---

## Phase 0 — Data foundations

**Goal.** Introduce the three tables and shared types so later phases have
schema and contracts to build against. No behavior.

**Scope.**
- `apps/api/src/db/schema.ts`: add `goals`, `interventions`,
  `intervention_assessments` following the exact conventions the spec fixes in
  §4 — integer autoincrement PK,   `revision` default 1 (cf. `schema.ts:508`),
  ISO-8601 text timestamps defaulted via `strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
  owner refs to `members` with `onDelete: "set null"`, `area` enum
  `personal | work` default `personal` (decoupled from ownership; goals are
  always owner-scoped per-user), calendar fields as strict `YYYY-MM-DD`
  text (matching `dueDate`/`scheduledDate`, `schema.ts:549-551`).
  - `goals`: `id`, `revision`, `owner_member_id`, `area`, `title`, `notes`,
    `status` (`active | concluded`), `concluded_at`, `created_by_member_id`,
    `created_at`/`updated_at` (§4 `goals` table).
  - `interventions`: `id`, `revision`, `goal_id` (`onDelete: "cascade"`),
    `type` (the five portfolio types), `commitment`, `rationale`,
    `start_date`, `revisit_date`, `status` (`active | concluded`),
    `concluded_at`, `backing_task_id` (`work_items.id`, `onDelete: "set null"`,
    nullable), `source` (`coach | manual`), `created_at`/`updated_at`
    (§4 `interventions` table).
  - `intervention_assessments`: history rows (band + rationale + counted item
    ids + next-move proposal + `source`), per §4.
- Forward migration via the repo recipe: edit `schema.ts`, then
  `npx drizzle-kit generate --name add_goals_and_interventions` from `apps/api`
  (`docs/architecture.md`; the drizzle-kit memory). Commit the generated SQL,
  snapshot, and `meta/_journal.json` entry.
- `packages/shared`: add the shared DTO/enum types (goal, intervention,
  intervention type, assessment band, derived state) so API and web share one
  contract, mirroring `ReflectionWorkItemFact` at
  `packages/shared/src/index.ts:452`.

**Out of scope.** No domain mutations, no routes, no MCP tools, no UI, no
derived-state computation.

**Acceptance / how to verify.**
- `npm run build -w @machbar/shared` then `npm run typecheck` compile cleanly.
- The migration applies cleanly to a **fresh** DB (full create) and is a
  **no-op on an already-migrated** DB (drizzle's SQLite migrator compares only
  the latest applied migration's timestamp — see the baseline-squash memory), so
  `npm run db:migrate` succeeds in both states.
- **No** migration acceptance test is added: these are brand-new empty tables
  with no reshaping or backfill of existing data, and a migration test earns its
  keep only when existing data is transformed (§12, decided).

**Risk / rollback.** Lowest-risk phase. Because no other table references the
new tables yet, the migration is purely additive; rollback is dropping the three
tables. Keep FK directions as specified so Phase 4's `backing_task_id`
`set null` behaves (the pragma/FK handling in `apps/api/src/db/migrate.ts` and
its memory applies to rebuilds, not to this additive migration).

---

## Phase 1 — Domain + API + MCP (manual, no AI)

**Goal.** Full goal/intervention lifecycle through the typed
parse-schema → domain-mutation → transaction flow, plus the derived-state
computation and the manual self-assessment path — all without any AI.

**Scope.**
- Domain mutations (a new module under `apps/api/src/domain/`, pure/React-free)
  for goal CRUD, intervention start/adjust/conclude, and manual assessment,
  each wrapping an explicit `db.transaction` and honoring `expectedRevision`
  with `stale_write_conflict` inside the write transaction (repo concurrency
  convention; `AppError` + stable `ApiErrorCode`).
- REST routes mirroring the Klärungsrunde router shape
  (`apps/api/src/routes/cleanupRounds.ts`), per §9:
  - `POST /api/goals`, `GET /api/goals`, `GET /api/goals/:id`,
    `PATCH /api/goals/:id`, `POST /api/goals/:id/conclude`.
  - `POST /api/goals/:id/interventions`, `PATCH /api/interventions/:id`,
    `POST /api/interventions/:id/conclude`.
  - A **manual** assessment write endpoint (`source: "manual"`) that creates an
    `intervention_assessments` row without any AI call.
  - Lifecycle changes use **dedicated command endpoints** (`/conclude`), not a
    status PATCH — mirroring project lifecycle commands (§9).
- Derived running/finished/reviewed computation (a pure helper): `running` while
  `today < revisit_date`; `finished / unreviewed` once `today >= revisit_date`
  and no assessment row; `reviewed` once an assessment row exists — computed
  **lazily** in the household timezone reusing `briefing.ts` `localDate`
  (`briefing.ts:17-21`) and `validTimezone` (`briefing.ts:23-26`); no cron
  (§4, §5). Include the 7-day Heute-eligibility flag (`today <=
  revisit_date + 7`) here so Phase 2 only renders it.
- MCP tools registered alongside the existing ones in
  `apps/api/src/mcp/tools.ts` (e.g. `machbar_today:463`, `machbar_review:512`):
  `machbar_list_goals`, `machbar_create_goal`, `machbar_update_goal`,
  `machbar_conclude_goal`, `machbar_start_intervention`,
  `machbar_adjust_intervention`, `machbar_conclude_intervention` (§9). The
  AI-only `machbar_suggest_intervention` / `machbar_assess_intervention` tools
  arrive in Phase 3.

**Out of scope.** No Heute projection wiring, no web UI, no AI passes, no
recurring-task backing.

**Acceptance / how to verify.**
- Integration tests with `createTestContext()` drive the full manual lifecycle
  via API and via MCP: create goal → author intervention by hand → adjust →
  conclude; and create → self-assess (`source: "manual"`) → reviewed.
- Unit tests for the derived-state helper across the **timezone boundary**
  (an intervention whose `revisit_date` is "today" only in the household
  timezone) and across the **7-day window** edges (day 7 eligible, day 8 not).
- Stale-write tests: a `PATCH` with an outdated `expectedRevision` returns
  `stale_write_conflict`.

**Risk / rollback.** Behavior is additive and gated behind new endpoints/tools;
no existing surface changes. Main risk is timezone/boundary correctness in the
derived helper — covered by the boundary unit tests above. Rollback = remove the
new routes/tools/domain module (tables can stay).

---

## Phase 2 — Web surfaces (manual journal end-to-end)

**Goal.** Make the manual feature usable end-to-end in the web app with no AI
configured: a Goals page and the Heute strip + review CTA.

**Scope.**
- **Goals page** (`apps/web/src/pages/…`): lists active goals and, collapsed,
  concluded goals; each goal shows its current intervention and its assessment
  history arc (§10). From here the user creates a goal, authors/edits an
  intervention by hand, concludes, and reads past assessments with counted
  items shown. Mutations go through the existing action/`useRetainedMutations`
  pattern — no new mutation-owning surface.
- **Heute wiring**: add the running-intervention standing-focus section and the
  finished-unreviewed review CTA as a **sibling section** in the existing Heute
  projection (`agendaSelection.ts` / `compiledViewProjection.ts`), **not** a
  task candidate (§6). Placement follows the goal's `area` (§6): a personal-area
  goal surfaces only in the owner's personal Heute, a work-area goal only in
  their work Heute, and neither in the shared household overview; the section is
  always owner-scoped to the viewer. The review CTA respects the **7-day
  demotion**: shown for 7 days after `revisit_date`, then only on the Goals page
  (§5, §6) — consuming the eligibility flag computed in Phase 1.
- A Goal form **area selector** (`personal` default / `work`) authored through
  the same action pattern.
- The review/assess sheet reuses the established "review the proposal, edit or
  exclude, then explicitly accept" interaction used by intake and the
  Klärungsrunde (`docs/workflow.md:19-72`, `336-373`). In this phase it drives
  the **manual** assessment write; the AI-populated proposal arrives in Phase 3.
- Copy in both `apps/web/src/i18n/de.ts` (catalog source) and `en.ts` (§10;
  repo i18n convention).

**Out of scope.** No AI suggest/assess population, no recurring-task backing.

**Acceptance / how to verify.**
- End-to-end with **no AI Task configured**: create goal → author intervention
  by hand → see the Heute standing strip daily → after `revisit_date` see the
  review CTA in Heute → self-assess via the sheet → the assessment arc renders
  on the Goals page → after 7 days the CTA is gone from Heute but reviewable
  from the Goals page.
- The intervention strip renders as a distinct section and is **not**
  completable and does **not** consume a task slot (§6); interventions do not
  appear in the Review queue (`apps/api/src/domain/reviewItems.ts`).
- i18n: `de.ts` and `en.ts` catalogs stay shape-aligned (German is the
  deterministic test fallback).

**Risk / rollback.** The one behavioral-surface risk is touching the Heute
projection; mitigate by adding the strip as an isolated sibling section that
cannot alter task selection, and assert the existing Heute invariants still hold
(Review age never adds Heute debt, `docs/workflow.md:319-337`). Rollback = hide
the Goals route and the Heute section; API/MCP from Phase 1 remain usable.

---

## Phase 3 — Coach AI passes

**Goal.** Add the two AI passes (suggest, assess) as **proposal-not-applied**
flows paired with a Home Assistant AI Task, degrading gracefully.

**Scope.**
- New `home_assistant_requests` request `kind`s `goal_suggest` / `goal_assess`
  (existing enum at `schema.ts:239`; the row shape at `schema.ts:226-264`),
  paired exactly like intake and the Klärungsrunde
  (`apps/api/src/cleanupRound/jobs.ts`, `apps/api/src/routes/cleanupRounds.ts`).
- Endpoints (§9): `POST /api/goals/:id/suggest` and
  `POST /api/interventions/:id/assess` return a **stored, not applied** proposal;
  accept endpoints (e.g.
  `POST /api/interventions/:id/assess/:assessmentId/accept`) each perform **one
  atomic write** turning the accepted proposal into real rows. Also the
  AI-backed MCP tools `machbar_suggest_intervention` /
  `machbar_assess_intervention` (§9).
- The assess pass **reuses/extends** `buildReflectionBriefing`
  (`apps/api/src/reflection/briefing.ts`) over the intervention's period
  (`start_date`→`revisit_date`) — finite completions vs admin/planning vs
  recurring hit/miss (`isOutcome` `briefing.ts:92-96`, `adminKinds`
  `briefing.ts:91`, `recurringWork` `briefing.ts:195-201`) — and applies the
  semantic relevance classification **on top of** the typed facts
  (`ReflectionWorkItemFact`, `packages/shared/src/index.ts:452`). No new
  activity reader (§7.3).
- **Graceful degradation**: the same guards the Klärungsrunde uses —
  `home_assistant_not_connected` / `ai_task_not_configured`
  (`cleanupRound/jobs.ts:49-63`). When unavailable, the manual path from
  Phases 1–2 still works.
- Bake the §7.1 (suggest) and §7.2 (assess) research principles into the prompt
  construction: behavior-not-outcome, if-then implementation intentions
  (Gollwitzer & Sheeran 2006), specific/challenging/committed/fed-back
  (Locke & Latham 2002), single behavior with a soft **total**-load nudge,
  rate-not-perfection targets, startable/anchored (Fogg), ~2-week default
  duration, observable-trace requirement; and for assess, a qualitative band +
  AAR citing counted items with caveats, never a numeric %.

**Out of scope.** Recurring-task backing (Phase 4).

**Acceptance / how to verify.**
- Suggest and assess round-trip against a **stub AI Task**: the proposal is
  stored and visibly **not applied** until an accept endpoint runs; accept
  writes exactly one coherent row set.
- Degradation: with no AI Task, suggest/assess return
  `home_assistant_not_connected` / `ai_task_not_configured`, and the manual
  self-assessment path from Phase 2 still succeeds.
- Assess over a fixture period reproduces the digest's completion/admin/recurring
  split and surfaces the counted item ids in the AAR.

**Risk / rollback.** AI output is advisory and never mutates until accept, so the
blast radius is contained by construction (§7). Risk is prompt/classification
quality, not data integrity. Rollback = disable the suggest/assess endpoints and
AI MCP tools; the manual journal (Phases 1–2) is unaffected.

---

## Phase 4 — Optional recurring-task backing

**Goal.** For `frequency_habit` interventions only, let the user back an
intervention with a recurring check-in that becomes the Heute presence and
feeds crisp hit/miss into assess.

**Scope.**
- Populate `interventions.backing_task_id` (Phase 0 column) only for
  `frequency_habit` type (§8). The recurring check-in is created through the
  **canonical** task path (behind `machbar_create_task` / the web task actions),
  never a parallel mutation. machbar already has recurring tasks with hit/miss
  occurrences (`task_recurrence_occurrences`, `schema.ts:668-692`;
  `repeat_after_days`/`allowed_deviation_days`, `schema.ts:570-571`) aggregated
  by the briefing (`briefing.ts:195-201`).
- When backed, the recurring task **is** the Heute presence for the running
  intervention (§6, §8) — replacing the soft strip with a real completable
  check-in that records hit/miss, which the assess pass then consumes as crisp
  signal.
- **Cleanup on conclude (decided, §8).** When a backed intervention concludes or
  is superseded, present a single **keep/stop** prompt **defaulting to stop**:
  keep clears `backing_task_id` (the task lives on as ordinary recurring work);
  stop ends the task through the canonical task path.

**Out of scope.** Backing for non-frequency types (they stay emergent or back a
normal one-off task, §8). No change to the AI prompts beyond consuming hit/miss.

**Acceptance / how to verify.**
- Back a `frequency_habit` → the Heute strip shows the recurring check-in with a
  hit/miss tally → assess consumes hit/miss instead of soft inference.
- On conclude/supersede the keep/stop prompt behaves: **keep** clears the
  pointer and the recurring task survives; **stop** (the default) ends the task
  via the canonical path and no orphaned check-in remains.
- Offering backing is restricted to `frequency_habit` (never surfaced for other
  types), preserving the §8 "signal floor, not the model" caution.

**Risk / rollback.** Risk is accidentally forking the task mutation path; mitigate
by routing creation/ending exclusively through the canonical task primitives and
asserting no new task-mutation module is introduced. Rollback = stop offering
backing and treat existing `backing_task_id` tasks as ordinary recurring work.

---

## Dependency & sequencing note

```
Phase 0 ──▶ Phase 1 ──▶ Phase 2      (usable MANUAL journal, no AI required)
                           │
                           ├──▶ Phase 3  (coach AI passes; advisory)
                           └──▶ Phase 4  (optional recurring-task backing)
```

- **0 → 1 → 2** is the critical path and delivers a complete, shippable feature:
  a manual goals/interventions journal with the Heute standing strip and review
  CTA, fully functional with **no Home Assistant AI Task configured**.
- **Phase 3** layers the AI coach on top; it depends on Phase 1's endpoints and
  Phase 2's accept/review sheet, and on Phase 0's `intervention_assessments`
  table. It is independently shippable after 2.
- **Phase 4** depends on Phase 0's `backing_task_id` column and Phase 2's Heute
  strip; it is independent of Phase 3 (hit/miss backing is useful even if the AI
  passes are disabled) and can ship in either order after 2.

Deferred (not in this plan, per §12): household-shared goals, and feeding
concluded goals' assessment arcs into the historical reflection briefing.
