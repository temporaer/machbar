# Goals & Interventions — a lightweight AI coach

> Status: the manual journal, Today focus, advisory coach and recurring backing
> are implemented. The follow-up delivery is tracked in #213, with #212 as the
> product source of truth. Its checkpoint, evidence and owner-only requirements
> supersede older lifecycle and backing assumptions below.

### Owner-only access and task placement (#213, Phase 1)

Every public goal/intervention endpoint requires a resolved member and checks
ownership before reads or writes, including coach requests and proposals. OIDC
identity wins over the activity actor; actor selection is supported only in the
existing authentication-disabled household deployment. Anonymous access cannot
read private goals. MCP uses its credential's fixed member; Home Assistant is
only the already authenticated request worker, not a goal-access credential.

Generated ordinary tasks store an internal durable `privacyOwnerMemberId`,
independent of `scope`: personal goals use household placement in the owner's
Mine view, work goals use Work. Household overview omits private tasks. The
privacy owner survives keep, movement, role conversion and deletion snapshots;
children inherit it. It is not a new task type or a public task privacy editor.
SQL inheritance/preservation constraints protect canonical task writers alike.
Graph projections, HTTP direct-ID access, activity/digest/reflection and reminder
recipients respect this boundary; private tasks never award shared points.
Migration 0026 changes only proven backing tasks with known goal owners and
their descendants, retaining task identities and recurrence history. Existing
unowned journal data is preserved but requires deliberate owner repair before
public access; it is never assigned to an arbitrary household member.

## 1. Motivation and horizon framing

machbar is strong at the ground floor of GTD — captures, next actions,
projects as outcomes, Heute, Wochenplanung, Wartet, Review. It has
deliberately *no* machinery for the higher horizons: no "areas of focus" to
groom, no goal hierarchy, no quarterly OKRs. That omission is intentional and
is restated throughout `docs/workflow.md`: the system should surface the next
honest thing to do, not ask the user to maintain a second pyramid of
aspirations.

The cost of that omission is a familiar gap: day-to-day execution and
long-term intent drift apart. A person can close a hundred tasks in a month
and still not know whether they moved toward "learn piano" or toward "do more
thinking work and less reactive work." Those are not projects — they have no
done state, no acceptance criteria, no finish line. They are **durable
intentions**, and the honest unit of progress against them is not a task but a
**deliberate experiment over a bounded period**.

This feature adds exactly that unit, and nothing heavier:

- A **Goal** is a durable, free-text intention.
- An **Intervention** is a single time-boxed behavioral experiment aimed at a
  goal.
- A lightweight **coach** (the paired Home Assistant AI Task) proposes
  well-formed interventions and, at the revisit date, reflects on what the
  recorded activity actually shows.

The connection between a goal and the day-to-day is **emergent**, inferred by
the coach from activity machbar already records, plus one small standing
presence in Heute. There is never a manual link from a task to a goal.

## 2. Non-goals

These boundaries are load-bearing. A reviewer should reject any later change
that violates them.

- **No epics, no new hierarchy.** A goal is not a work item, not a project,
  not a parent of tasks. It is not a `role` on `work_items`
(`apps/api/src/db/schema.ts:512` defines `role` as `task | story` only) and
  must never become one. Goals live in their own small tables and reference
  work items only loosely and optionally.
- **No per-task linking, ever.** The user does not tag tasks with goals, does
  not file tasks under a goal, and does not maintain a mapping. Relevance is
  inferred semantically at assessment time.
- **No grooming burden.** Goals accumulate interventions passively. There is
  no backlog of goal-work to refine, no stuck-goal detection, no required
  cadence. A goal with no running intervention is simply dormant, not debt.
- **Counting is the floor, not the point.** A frequency count ("4 of 7 days")
  is the cheapest signal, not the purpose. The intelligence lives in choosing
  the right *kind* of intervention, in the diagnostic reflection, and in
  adapting the next experiment — not in collapsing every goal into a habit
  tracker.
- **The coach proposes; the user disposes.** Consistent with every other AI
  surface in machbar (intake Verarbeiten, Klärungsrunde), nothing is created
  or applied until the user accepts. See §7.
- **The coach is strictly user-triggered.** Both the suggest and assess passes
  run *only* on an explicit user request, never automatically and never from a
  background job, mirroring the Klärungsrunde's human-triggered, one-at-a-time
  posture. Nothing about a goal or intervention runs an AI call unless the user
  asks for it. See §7.
- **Graceful degradation.** With no Home Assistant AI Task configured, goals
  and interventions still work as a manual journal; only the suggest/assess
  automation is unavailable. See §7.

## 3. Concepts

### Goal

A durable, personal intention expressed as free text, e.g. *"learn piano"* or
*"do more long-term / thinking work and less reactive short-horizon work."* A
goal has a status of `active` or `concluded` and an owner. It is **always
owner-scoped per-user** — every goal has an `owner_member_id` set on creation
and is never household-shared in v1; this is a firm decision, not an open
question, because goals are introspective. Ownership is **decoupled** from the
goal's `area` (`personal | work`, default `personal`): `area` does not change
who can see the goal (only the owner does), it only decides *where the Heute
focus strip surfaces it* (§6). (Household-visible goals are a conceivable
far-future extension, out of scope
here.)

A goal is the **arc**: it accumulates many interventions over time, and the
sequence of interventions plus their assessments *is* the record of progress.
A goal never "completes"; the user concludes it when it is no longer a live
intention.

### Intervention

A single, time-boxed behavioral experiment belonging to exactly one goal. It
has a **period** (`startDate` → `revisitDate`), a **type** drawn from a
portfolio (below), a one-line behavioral commitment, and a lifecycle. Its
*stored* status only distinguishes an active experiment from one
concluded-early or superseded (`active | concluded`); the user-facing
`running → finished (unreviewed) → reviewed` progression is **derived** from
the revisit date and whether an assessment exists, not stored (see §4 and §5).

Multiple interventions may belong to a goal and may overlap. Overlap is
permitted rather than encouraged: the coach and UI softly nudge toward a small
*total* concurrent behavior-change load across all goals (§5, §7.1), which in
the common case lands at one running intervention per goal with the rest as
history.

The portfolio of types — the coach picks the one that fits where the goal
currently is, not always a habit:

| Type | Shape | Example signal it leaves |
| --- | --- | --- |
| `frequency_habit` | Repeat a small action on N of M days | recurring hit/miss, or finite completions clustered in time |
| `obstacle_removal` | One-off change that removes friction | a single completed task this week |
| `commitment_stake` | A light public/social commitment | a scheduled/dated item, later a completion |
| `exploration_step` | A learning or scouting step | a completed one-off ("book trial lesson") |
| `composition_ratio` | Shift the *mix* of work, not add work | the semantic split of completed items over the period |

Counting completions is the floor signal for several of these; the chosen
*type* is the first place the intelligence shows up.

### Coach

The coach is **not a service machbar hosts**. machbar is not an AI provider;
it calls a paired Home Assistant `ai_task.*` entity, exactly as intake and the
Klärungsrunde do (`docs/home-assistant.md:41-72`, `docs/mcp.md`). The coach
has two jobs:

1. **Suggest** (§7.1): given a goal — at creation, or when an intervention
   concludes — propose 1–2 well-formed, time-boxed interventions chosen from
   the portfolio.
2. **Assess** (§7.2): at the revisit date, read the goal text plus the
   whole-period activity digest, **semantically** classify which recorded
   activity is relevant (pure classification from titles/notes — no new
   tagging, zero setup), and return a **qualitative achievement band** plus an
   after-action-review (AAR) rationale that *shows which items it counted*.
   Then suggest the next move (continue / adjust / conclude).

## 4. Data model

Three new tables, consistent with `schema.ts` conventions: integer
autoincrement PKs, ISO-8601 text timestamps defaulted via
`strftime('%Y-%m-%dT%H:%M:%fZ','now')`, owner references to `members` with
`onDelete: "set null"`, text enums, and a monotonic `revision` for
optimistic concurrency (the same pattern `work_items` uses at
`schema.ts:506`). Calendar fields are strict `YYYY-MM-DD` text, matching
`dueDate`/`scheduledDate` on work items (`schema.ts:549-551`).

Column sketches (illustrative, not DDL):

### `goals`

| Column | Type | Notes |
| --- | --- | --- |
| `id` | integer PK | |
| `revision` | integer, default 1 | optimistic concurrency, cf. `work_items.revision` |
| `owner_member_id` | integer → `members.id`, set null | always set on create; goals are owner-scoped per-user, never household-shared in v1 (§3) |
| `area` | text enum `personal \| work` default `personal` | decoupled from ownership; only decides Heute placement (§6) — not visibility |
| `title` | text | the free-text intention |
| `notes` | text default `""` | optional elaboration |
| `status` | text enum `active \| concluded` default `active` | |
| `concluded_at` | text nullable | ISO timestamp |
| `created_by_member_id` | integer → `members.id`, set null | |
| `created_at` / `updated_at` | text ISO, defaulted | |

### `interventions`

| Column | Type | Notes |
| --- | --- | --- |
| `id` | integer PK | |
| `revision` | integer, default 1 | |
| `goal_id` | integer → `goals.id`, `onDelete: "cascade"` | belongs to one goal |
| `type` | text enum (the five portfolio types) | |
| `commitment` | text | the one-line behavioral statement (if-then phrased, §7.1) |
| `rationale` | text default `""` | why this move, why now (from the coach or the user) |
| `start_date` | text `YYYY-MM-DD` | |
| `revisit_date` | text `YYYY-MM-DD` | end of the period = the end of the digest window passed to the assess pass; drives Today surfacing |
| `status` | text enum `active \| concluded` default `active` | **only** distinguishes a live experiment from one concluded-early or superseded; `running`/`finished`/`reviewed` are *not* stored (see below and §5) |
| `concluded_at` | text nullable | ISO timestamp, set when concluded early/superseded |
| `backing_task_id` | integer → `work_items.id`, `onDelete: "set null"`, nullable | optional recurring/check-in task, §8 |
| `source` | text enum `coach \| manual` | provenance |
| `created_at` / `updated_at` | text ISO, defaulted | |

Notes:

- **The running-vs-finished-vs-reviewed state is derived, not stored.** An
  `active` intervention is *running* while, in the household timezone,
  `today < revisit_date`; it is *finished / unreviewed* once
  `today >= revisit_date` and no `intervention_assessments` row exists yet; it
  is *reviewed* once an assessment row exists. This is computed lazily at read
  time — no cron, no stored transition — reusing the briefing's calendar-date
  handling (`localDate` + the household `timezone` setting, `briefing.ts:17-21`
  and `validTimezone`/`briefing.ts:23-26`). `revisit_date` is simply the end of
  the digest window handed to the assess pass (§7.3). The stored `status`
  exists only so a user can end an experiment early or let a successor
  supersede it.
- `backing_task_id` is a *loose, optional* pointer used only for
  frequency-type interventions that the user chose to back with a recurring
  task (§8). It is **not** the per-task link that §2 forbids: it points at most
  at one check-in task created *by* the intervention, never at arbitrary user
  work, and the goal↔activity relevance inference does not depend on it.
- There is no `goal_id` on `work_items` and no join table between work items
  and goals. That absence is deliberate.

### `intervention_assessments`

History, not a single current value — a goal is an arc, so each review is kept
(§3). This is the audit trail that lets the user sanity-check the coach's fuzzy
calls over time.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | integer PK | |
| `intervention_id` | integer → `interventions.id`, `onDelete: "cascade"` | |
| `assessed_at` | text ISO | |
| `band` | text enum `no_evidence \| attempted_partial \| mostly_achieved \| achieved \| exceeded` | qualitative, never a % |
| `rationale_md` | text | the AAR: what was counted, what was inferred, caveats |
| `digest_window_start` / `digest_window_end` | text `YYYY-MM-DD` | the period assessed |
| `counted_item_ids_json` | text JSON | the work-item ids the coach said were relevant, so the UI can show them for sanity-checking |
| `source` | text enum `coach \| manual` | a user may self-assess when no AI is configured |
| `created_at` | text ISO, defaulted | |

The assessment never writes a number. The `band` plus `rationale_md` plus the
shown counted items are the whole output. This mirrors the reflection
briefing's refusal to treat `updatedAt` as proof of progress
(`docs/workflow.md:11-18`, `briefing.ts` evidence notes).

## 5. Lifecycle and state machine

### Goal

```
active ──(user concludes)──▶ concluded
concluded ──(user reopens)──▶ active   (reopening is allowed)
```

A goal is created with a title; optionally the user asks the coach to run a
suggest pass (§7.1) proposing its first intervention. A goal with no running
intervention is dormant, not stuck — Review never touches it (§2).

### Intervention

Only `active | concluded` is stored. The *running / finished / reviewed*
labels below are **derived** at read time from `revisit_date` and whether an
assessment row exists (§4); there is no stored transition and no cron.

```
 stored status:  active ───────────────────────────▶ concluded
                   │  (user ends early / a successor supersedes it)

 derived view of an `active` intervention (household-timezone calendar):

   today < revisit_date          running (unreviewed)
            │
            ▼  (revisit_date reached; no assessment row yet)
   today >= revisit_date         finished / unreviewed
            │                         │
            │ (within 7 days:         │ (user runs assess: accept the coach's
            │  review CTA in Heute)   ▼  band, or self-assess → assessment row)
            │                      reviewed
            ▼  (7 days after revisit_date, still no assessment)
   leaves Heute; stays unreviewed and reviewable only from the Goals page
```

- **running:** the live experiment (stored `active`, `today < revisit_date`).
  Appears every day in Heute as a slim standing presence (§6).
- **finished / unreviewed:** derived once `today >= revisit_date` (household
  timezone) and no assessment row exists. Surfaces in Heute as a review/score
  action (§6) for **7 days** after `revisit_date`; after that it leaves Heute
  and remains reviewable only from the Goals page. It is never auto-assessed or
  auto-concluded — it simply stays unreviewed until the user acts.
- **reviewed:** an `intervention_assessments` row exists. The intervention
  drops off Heute. The assess pass the user runs also proposes the next move,
  which the user accepts (creating a successor intervention) or declines
  (leaving the goal dormant, or concluding it).

Overlap is permitted but not encouraged: starting a new intervention does not
require concluding the current one, so a goal may briefly have two running
interventions. The coach and UI instead nudge toward a small *total* concurrent
load across all goals (§7.1), rather than imposing a per-goal cap.

## 6. Today and Review integration

The defining behavior: **a running intervention is a daily touchpoint, not a
task to complete.** This is the concrete mechanism that connects high-level
goals to the day-to-day, and it is why interventions appear in Heute even
though ordinary Review deliberately does not add work to Heute
(`docs/workflow.md:319-337`: "Review age never adds work to Today").

Heute today is a derived projection combining planned work, deadlines, reached
follow-ups, standalone work, and each project's next action
(`docs/workflow.md:203-218`; assembled via `agendaSelection.ts` /
`compiledViewProjection.ts`). Interventions add **one new, visually distinct
section** to that projection — a standing-focus strip, not a task row.

**Heute placement by area.** Because `area` is decoupled from ownership
(§3/§4), it alone decides which of the viewer's own Heute views shows the
strip, and the strip is always owner-scoped to the viewer:

- A **personal-area** goal's intervention appears only in the owner's
  **personal (non-work) Heute** (the "mine" view).
- A **work-area** goal's intervention appears only in the owner's **work
  Heute** (the "work" view).
- **Neither appears in the shared household overview** (the "all" view) — goals
  are per-user and never surfaced to other members in v1.

Within the matching view the section behaves as follows:

- **Running intervention → its own slim Heute section.** Rendered separately
  from actionable task sections (`compiledViewProjection.pruneProjectForCompiledView`
  governs task sections; the intervention strip is a sibling section, not a
  task candidate). It shows the goal title, the one-line commitment, the
  period progress ("day 6 of 14"), and — if backed by a recurring task (§8) —
  the current hit/miss tally. It is a glanceable reminder of the current focus;
  it is **not** completable and does not consume a task slot.
- **Finished + unreviewed intervention → a review/score action in Heute, for
  7 days.** A single call to action ("Rückblick auf dein Experiment"), which
  opens the assess flow (§7.2). This is intentional Heute presence, distinct
  from the Review queue. It stays in Heute for **7 days** after `revisit_date`;
  beyond that it leaves Heute (to avoid becoming Heute-debt) and remains
  reviewable only from the Goals page, still unreviewed — never auto-assessed
  or auto-concluded.
- **Reviewed intervention → drops off Heute entirely.**

**Relationship to the Review queue** (`apps/api/src/domain/reviewItems.ts`,
`docs/workflow.md:319`): interventions do **not** join the derived Review
queue. Review is for organized *work* whose structure needs a decision
(driverless active projects, waits without revisit, review-age items). An
intervention's "finished" state is a goal-reflection prompt the user *wants* in
Heute, not maintenance debt. Keeping the two surfaces separate preserves the
invariant that Review is not Heute debt while honoring the user's explicit wish
that intervention reviews appear in Heute. A long-ignored finished intervention
falls back to a quieter surface automatically: after 7 days it leaves Heute for
the Goals page (§5, §6), so it can never accumulate as Heute-debt.

## 7. The coach: two AI passes

Both passes follow machbar's established **proposal-not-applied** flow, modeled
directly on the Klärungsrunde (`apps/api/src/cleanupRound/jobs.ts`,
`apps/api/src/routes/cleanupRounds.ts`, `schema.ts:324-373`), which is
described as "AI coaching … Results are advisory and never mutate work items by
themselves" (`schema.ts:318-321`). Concretely:

1. The user explicitly triggers a pass — there is no automatic or background
   trigger (create goal → user asks to suggest; at/after the revisit date the
   user runs assess). See the "strictly user-triggered" non-goal in §2.
2. machbar enqueues a `home_assistant_requests` row
   (`schema.ts:226-264`) of a new `kind` (e.g. `goal_suggest`,
   `goal_assess`), paired with the active Home Assistant AI Task.
3. The AI returns a typed proposal that is **stored, not applied**. The user
   reviews it, edits it, and explicitly accepts before any `interventions` or
   `intervention_assessments` row is written.
4. **Graceful degradation.** If Home Assistant is not connected or no AI Task
   is usable, the trigger fails with the same guard the Klärungsrunde uses
   (`cleanupRound/jobs.ts:49-63`: `home_assistant_not_connected`,
   `ai_task_not_configured`). Goals/interventions remain fully usable as a
   manual journal: the user can author an intervention's commitment by hand and
   self-assess (`source: "manual"`).

The two prompts below are *sketches* — the authoritative behavioral principles
to bake in, not final wording. They are deliberately research-grounded so the
coach proposes behavior-change experiments that actually work, rather than
restated wishes.

### 7.1 Suggest prompt (sketch)

**Role.** *"You are machbar's behavior-change coach. Given a durable goal and a
short digest of what the person has recently been doing, propose 1–2
well-formed, time-boxed interventions. Return a typed JSON proposal; nothing is
applied until the user accepts."*

**Principles to embed:**

- **Behavior, not outcome.** Each intervention is a *process* commitment, not a
  restated outcome. "Practise 10 minutes" — not "get good at piano."
- **Implementation intentions (if-then).** Phrase the commitment as a cue +
  action: *"After my morning coffee, I play piano for 10 minutes."*
  (Gollwitzer & Sheeran 2006 meta-analysis, median *d* ≈ 0.65.)
- **Specific, challenging, committed, fed-back** (Locke & Latham 2002). Aim for
  ~50–70 % self-rated confidence — a stretch, not trivial, not a long-shot
  (the Goldilocks / flow band).
- **Single behavior per intervention.** Self-regulatory capacity is limited, so
  each intervention commits to one behavior. The same limit applies across the
  *whole* person, not per goal: concentrating on one behavior change at a time
  beats juggling many, so the coach softly nudges toward a small *total*
  concurrent load — ideally one, at most two running interventions across all
  goals combined — rather than capping interventions per goal. Overlap stays
  technically permitted (§5); the nudge is advisory, and in practice it usually
  settles at one running intervention per goal without a rigid rule.
- **Rate, not perfection.** Prefer frequency targets like *"4 of 7 days"* over
  *"every day, no exceptions,"* which invites all-or-nothing /
  what-the-hell collapse after the first miss.
- **Startable today, anchored to a routine.** Small enough to begin now, pinned
  to an existing habit (Fogg Tiny Habits — flag this as practitioner evidence,
  not an RCT result). Optionally fold in WOOP's obstacle step
  (Oettingen): name the likeliest obstacle and a pre-planned response.
- **Duration.** Default ~2 weeks. Use 1 week for fast, simple signal; 3–4 weeks
  for complex, low-frequency, or already-showing-signal behaviors. A quarter is
  the horizon of the *goal*, never of a single intervention.
- **Portfolio choice.** Pick the type (§3) that fits where the goal is — an
  obstacle-removal or exploration step may beat a habit when the real blocker
  is friction or uncertainty. Do not default to a daily habit.
- **Observable trace.** Only propose behaviors that will leave a trace in
  machbar's recorded activity (a completable action, a recurring check-in, or
  completions the assess pass can semantically recognize). If a behavior would
  leave no trace, say so and prefer one that does, or mark it
  self-report-only.

**Input the pass receives:** the goal title + notes; a compact recent digest
(reusing the briefing builder, §7.3); and, for a follow-up suggest, the prior
intervention and its assessment. Keep it compact, as the Klärungsrunde does
with `planningContext` (`docs/workflow.md:356-362`).

**Output (stored, not applied):** 1–2 proposed interventions, each with
`type`, if-then `commitment`, `rationale`, suggested `start_date` /
`revisit_date`, and an optional "back this with a recurring check-in?" offer
for `frequency_habit` (§8).

### 7.2 Assess prompt (sketch)

**Role.** *"You are machbar's after-action-review coach. The person committed
to a behavior for a period. Read the goal, the commitment, and the full-period
activity digest. Decide which recorded activity is plausibly relevant to this
goal — by meaning, from titles and notes — and judge how the committed behavior
actually went. Return a qualitative band and a blame-free, forward-looking
rationale that names the specific items you counted and is explicit about what
you could not see. Never output a percentage."*

**Principles to embed:**

- **Pure semantic classification.** Decide relevance from item titles/notes.
  No new tags, no setup, no per-task linking (§2).
- **Qualitative band, always paired with an AAR.** One of
  `no_evidence | attempted_partial | mostly_achieved | achieved | exceeded`,
  *always* accompanied by a rationale that cites the specific observed signals
  and states inference limits. Never a false-precision number.
- **Show your work.** List the items counted (returned as
  `counted_item_ids_json`) so the user can sanity-check the fuzzy calls and
  overrule them.
- **Blame-free, forward-looking, honest about limits.** Report the *pattern*
  ("practised 2 of 14 days, clustered late-evening when tired"), not a verdict.
  Be explicit that it tracks the **committed behavior and reflection**, while
  the true outcome ("can you actually play piano?") remains the user's
  judgment.
- **Myth-busting on request.** If habit-formation timelines come up, do not
  repeat "21 days to form a habit" (a myth); cite Lally et al. 2010 (~66-day
  median, 18–254 day range).
- **Then suggest the next move:** continue (same experiment), adjust (a
  modified successor), or conclude (the goal is served, or no longer live).

**Input:** goal title/notes; the intervention commitment + type + period; the
full-period digest (§7.3), including recurring hit/miss if the intervention was
backed (§8); the finite completions and administrative/planning split the
digest already computes.

**Output (stored, not applied):** a proposed `intervention_assessments` row
(band + rationale + counted item ids) **plus** a proposed next intervention,
all awaiting user acceptance.

### 7.3 Reusing the digest builder

The assess pass must not invent a new activity reader. machbar already has a
windowed digest builder,
`buildReflectionBriefing` in `apps/api/src/reflection/briefing.ts`, which over
a date window computes:

- **finite completions** vs **administrative/planning events** vs **recurring
  hit/miss** (`isOutcome` at `briefing.ts:92-96`, `adminKinds` at
  `briefing.ts:91`, `recurringWork` assembled from `taskRecurrenceOccurrences`
  at `briefing.ts:195-201`);
- postponements, inactive-work classification, and explicit evidence-limitation
  notes (`briefing.ts` `evidence` block), which model exactly the
  "honest about limits" tone the assess pass needs.

The assess pass should **reuse or extend** this builder for the intervention's
period (`start_date`→`revisit_date`) rather than reading `activity_events` /
`contribution_events` / `task_recurrence_occurrences` directly. The semantic
relevance classification is then applied *on top of* the digest's already-typed
item facts (`ReflectionWorkItemFact`, `packages/shared/src/index.ts:452`;
assembled in `briefing.ts:27-35`). This keeps one
canonical activity-digest path.

## 8. Optional recurring-task backing

For `frequency_habit` interventions **only**, the coach may optionally offer to
back the intervention with a recurring task / check-in — one tap to accept.
machbar already has recurring tasks with hit/miss occurrences
(`task_recurrence_occurrences`, `schema.ts:668-692`; `repeat_after_days` /
`allowed_deviation_days` on `work_items`, `schema.ts:570-571`) and the briefing
already aggregates them into crisp hit/miss tallies (`briefing.ts:195-201`).

When accepted:

- A recurring check-in task is created through the **canonical** task-creation
  path (the same one behind `machbar_create_task` and the web task actions —
  not a parallel mutation), and its id is stored in
  `interventions.backing_task_id`.
- That recurring task **is** the Heute presence for the running intervention
  (§6): instead of a soft inferred strip, the user gets a real, completable
  daily/periodic check-in that records hit/miss.
- The assess pass then has crisp hit/miss signal instead of soft semantic
  inference for that intervention.

When **not** accepted, or for non-frequency types, the intervention either
backs onto a normal one-off task/check-in (e.g. obstacle-removal → a single
completable task this week) or stays **purely emergent**, with relevance
inferred from the digest at assess time.

**Design caution (explicitly from the design conversation):** recurring-backing
is *one optional instrument*, the signal floor — not the model. If *every*
intervention collapsed to "recurring task + count," the feature would degrade
into a dumb habit tracker. The intelligence must stay in (a) choosing the right
intervention *type*, (b) the diagnostic AAR reflection, and (c) adapting the
next intervention. The spec therefore frames backing as a convenience for one
type, never the default or the point.

**Cleanup on conclude (decided).** When an intervention with a
`backing_task_id` concludes or is superseded, machbar asks the user — in a
single keep/stop prompt — whether to keep or stop that recurring check-in, and
the prompt **defaults to stop**. Silent deletion would be wrong (the habit may
have standing value beyond the experiment), but a silently orphaned recurring
check-in is equally surprising; a one-tap prompt defaulting to stop resolves
both. If the user keeps the task, `backing_task_id` is simply cleared (the task
lives on as ordinary recurring work); if stopped, the task is ended through the
canonical task path, never a parallel mutation.

## 9. API endpoints and MCP tools

New REST endpoints (shapes follow the Klärungsrunde router,
`apps/api/src/routes/cleanupRounds.ts`, and the typed
parse-schema → domain-mutation → transaction flow described in the repo
architecture notes):

Goals:

- `POST /api/goals` — create a goal (optionally kicks off a suggest pass).
- `GET /api/goals` / `GET /api/goals/:id` — list / read (with interventions and
  assessment history).
- `PATCH /api/goals/:id` — edit title/notes (with `expectedRevision`).
- `POST /api/goals/:id/conclude` — lifecycle command (dedicated endpoint, not a
  status PATCH — mirrors how project lifecycle uses command endpoints).

Interventions:

- `POST /api/goals/:id/interventions` — start an intervention (accepting a
  coach proposal, or authored manually).
- `PATCH /api/interventions/:id` — adjust (with `expectedRevision`).
- `POST /api/interventions/:id/conclude` — end early / conclude.

Coach passes (advisory, proposal-not-applied, HA-paired):

- `POST /api/goals/:id/suggest` — run a suggest pass; returns a stored proposal.
- `POST /api/interventions/:id/assess` — run an assess pass at the revisit date;
  returns a stored assessment + next-move proposal.
- Accept endpoints that turn an accepted proposal into real rows (one atomic
  write each), e.g. `POST /api/interventions/:id/assess/:assessmentId/accept`.

New / changed MCP tools (registered alongside the existing ones in
`apps/api/src/mcp/tools.ts`, e.g. `machbar_today:462`, `machbar_review:512`):

- `machbar_list_goals`, `machbar_create_goal`, `machbar_update_goal`,
  `machbar_conclude_goal`.
- `machbar_start_intervention`, `machbar_adjust_intervention`,
  `machbar_conclude_intervention`.
- `machbar_suggest_intervention`, `machbar_assess_intervention` (advisory;
  degrade gracefully when no AI Task).
- `machbar_today` extended to surface the running-intervention strip and any
  finished-unreviewed review action, so an MCP agent sees the same daily
  touchpoint the web Heute shows.

As with all MCP access, the credential carries a context
(`docs/mcp.md`). Because goals are always owner-scoped per-user (firm v1
decision, §3), an MCP credential only ever sees its own owner's goals,
regardless of each goal's `area`. A goal's `area` (`personal | work`) is a
property of the goal that governs Heute placement (§6); it is independent of
the credential context and never widens visibility beyond the owner.

## 10. Web surfaces

Two small additions, no new heavy page:

- **Heute strip.** The running-intervention standing-focus section and the
  finished-unreviewed review action described in §6. Visually distinct from
  task rows; glanceable; the review action opens the assess sheet.
- **Goals page.** A small page listing active (and, collapsed, concluded)
  goals. Each goal shows its current intervention and its assessment history —
  the arc. From here the user creates a goal, triggers a suggest pass, accepts
  / edits a proposed intervention, and reads past AARs with the counted items
  shown for sanity-checking. User-visible copy goes in both
  `apps/web/src/i18n/de.ts` and `en.ts`, German as the catalog source.

The assess/suggest sheets reuse the established "review the proposed diff, edit
or exclude, then explicitly accept" interaction already used by intake and the
Klärungsrunde (`docs/workflow.md:19-72`, `336-373`), rather than introducing a
new mutation-owning surface.

## 11. Worked scenarios

### 11.1 "I want to learn piano"

A goal with no obvious project and no finish line. On creation the coach's
suggest pass might propose, depending on where the person is:

- a **frequency habit** — *"After my morning coffee, play piano for 10 minutes,
  5 of 7 days,"* optionally backed by a recurring check-in (§8); or
- an **obstacle-removal** — *"The keyboard is in the closet. This week, move it
  somewhere you pass daily,"* a one-off; or
- a **commitment/stake** — *"Fumble through one song at Anna's birthday"*; or
- an **exploration step** — *"Book a trial lesson."*

Two weeks later the assess pass reads the period. Suppose it finds two
practice-shaped completions late in the evenings: band
`attempted_partial`, with an AAR like *"Recorded practice on 2 of 14 days, both
late-evening when you'd noted being tired. The morning anchor didn't fire. I'm
inferring these two items are practice from their titles — correct me if not."*
Next move: **adjust** — perhaps shrink to 5 minutes, or move the anchor earlier,
or switch to an obstacle-removal if friction is the real blocker. The coach is
explicit that it measured *effort and behavior*, not whether the person can now
play.

### 11.2 "Do more thinking / long-term work, less short-horizon reactive work"

A **composition** goal — about the *mix* of work, not any single outcome.
machbar already partially observes this mix: task `size`
(`schema.ts:556`), project linkage and story-vs-task role
(`schema.ts:512`), clarification/planning flags
(`needs_clarification`/`discussion_requested`, `schema.ts:521-525`),
scheduling horizon (`scheduledDate`/`dueDate`/`revisitAt`), and the briefing's
planning-vs-outcome event split (`isOutcome` vs `adminKinds`,
`briefing.ts:91-96`).

The coach may propose:

- an **implementation intention** — *"Monday and Thursday morning, before
  touching the inbox, spend 30 minutes advancing one long-horizon item"*; or
- a **ratio target** — shift the week's completed mix toward thinking work; or
- a **structural / obstacle move** — batch quick reactive tasks, or use
  Wochenplanung (`docs/workflow.md:262-301`) to deliberately pull a
  long-horizon item into the week.

At assessment the coach semantically classifies the period's completed items
into *thinking / long-horizon* vs *reactive / short-horizon*, reports the
shifting mix, and **shows which items it put in each bucket** with caveats
("I treated these three as reactive because their titles read as quick
errands; move any you disagree with"). No percentage — a band plus the honest
split.

## 12. Resolved design decisions

All design questions from the original draft are resolved; their resolutions
live in the body:

- **Personal-only ownership + decoupled area** (firm v1) — goals are always
  owner-scoped per-user (never household-shared), and a separate `area`
  (`personal | work`, default `personal`) decides Heute placement without
  affecting visibility — §3, §4, §6.
- **Soft total-load nudge**, not a per-goal cap — §5, §7.1.
- **Derived `finished`** (stored status is only `active | concluded`) — §4, §5.
- **7-day Heute demotion** of finished-unreviewed interventions — §5, §6.
- **Strictly user-triggered** suggest/assess — §2, §7.
- **Backing-task cleanup on conclude**: a single keep/stop prompt defaulting to
  stop — §8.
- **Migration convention**: the three new tables are introduced via the repo's
  standard forward-migration recipe (edit `apps/api/src/db/schema.ts`, then
  `npx drizzle-kit generate --name …` from `apps/api`; `docs/architecture.md`,
  the drizzle-kit memory). No special acceptance test is warranted — these are
  brand-new, empty tables with no reshaping or backfill of existing data, and a
  migration test earns its keep only when existing data is transformed.

The spec is therefore complete and build-ready. Two items are explicitly
**deferred** as future possibilities, not open questions:

- **Household-shared goals.** §3 keeps goals owner-scoped for v1; a
  household-visible variant is a conceivable far-future extension.
- **Reflection-briefing integration.** §11 keeps the Goals page as the home for
  a goal's assessment arc in v1; feeding concluded goals' arcs into the
  historical reflection briefing as first-class evidence is a later option.

## Observation plans and records (#213, Phase 2)

Plans are explicit: existing task evidence, end-of-period reflection, or a daily
self-report. No plan or historical answers are inferred for existing journals.
A daily plan records its question, day/night reference, same-day closed-window
or next-day availability time, timezone snapshot, opportunity applicability,
and optional successful-days target. Night questions always refer to the prior
night. Same-day availability is the declared window closure, not a sensor rule.

Immutable plan versions snapshot commitment, wording, timing and targets. The
initial plan starts today (or a future intervention start); replacements start
tomorrow. A second replacement for the same effective day conflicts instead of
rewriting history. A plan remains active past the checkpoint while its behavior
is active. Stopped interventions accept late reports for prior reference days.

Reports are separate from tasks and unique per intervention/reference date.
Revision zero creates; corrections require the current revision. Corrections
preserve first submission time and plan attribution. `met`, `not_met`, explicit
`unknown`, and applicable `no_opportunity` are distinct; no row means missing.
Daily timing uses local calendar days and wall-clock times, including DST.

Calendar-week targets mean Monday through Sunday. Seven-day targets require a
stated anchor, defining consecutive non-overlapping seven-day windows. Success
counts only explicit met days. No opportunity is inapplicable, explicit unknown
is reported but inconclusive, and missing is unreported. Partial windows and
plan-version boundaries must be shown as partial; they do not silently prorate
a target. Unsupported prose remains qualitative. Phase 5 assembles these facts
and coverage into the shared review evidence, rather than adding a scorer here.

`GET/PUT /api/interventions/:id/observations` and
`PUT /api/interventions/:id/observation-plan` share canonical revision-aware
mutations with the three corresponding MCP tools. All require the parent goal's
owner. A negative answer successfully records a report and never creates debt.
Migration 0027 only adds empty tables; original goals and assessments survive.

## Manual observation collection (#213, Phase 3)

The existing intervention editor authors the evidence plan in the same journal
transaction. Commitment changes snapshot the ongoing plan prospectively too.
Today separates the standing reminder from reporting: only an answerable period
gets response buttons, labelled with its actual reference date and a goal link.
A next-morning question refers to yesterday's night. No AI is required.

Today shows the latest question per intervention; the goal exposes only seven
recent unanswered days plus the most recent 30 recorded reports for correction.
Older missing reports do not accumulate as tasks or overdue debt. Reporting No
is a successful submission. Notes are optional. Task-only plans ask no question.
German and English catalogs cover all controls. History preserves plan wording.
