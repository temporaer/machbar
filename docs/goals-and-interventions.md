# Goals and interventions

The manual journal, Today focus, ordinary task backing and advisory goal coach
are implemented. Product decisions are tracked in
[#212](https://github.com/temporaer/machbar/issues/212); the seven-phase follow-up
is [#213](https://github.com/temporaer/machbar/issues/213), delivered in
[PR #214](https://github.com/temporaer/machbar/pull/214).

Goals express durable intentions without creating another task hierarchy.
An intervention is a small behavioral experiment with a commitment, rationale,
start date and review checkpoint. A checkpoint is an opportunity to reconsider
feasibility and perceived benefit, not automatic expiry or a promise of habit
formation. Existing journal records and manual assessments remain usable without
Home Assistant or AI. Nothing calls AI or creates/cleans up work automatically.

## Ownership and placement

The goal owner owns its interventions, proposals, questions, reports, assessments
and evidence. HTTP direct-ID operations and lists use the same existing
`assertGoalAccessible`/`assertInterventionAccessible` guards as MCP. Coach requests
require a concrete matching owner. Anonymous access cannot read private goals.
With OIDC, authenticated identity wins over request actor fields; in the existing
authentication-disabled deployment, explicit member selection is trusted. An actor
header is not an alternate identity when OIDC is enabled. MCP credentials carry a
fixed member. Home Assistant only processes authenticated leased requests.

Personal/work area controls placement independently of privacy. Generated tasks
use ordinary `work_items` with an internal durable `privacyOwnerMemberId`:
personal tasks have household placement in their owner's Mine view; work tasks
appear in Work. Household overview omits private tasks. Graph projections,
direct-ID task/project mutations, activity/digest/reflection and reminder
recipients respect the privacy owner. Private work never awards shared points.
Destination references are checked before writes. Private subtrees may be nested
only within the same private owner's hierarchy or moved to top level, keeping
shared-container lifecycle cascades outside the private boundary. Children
inherit privacy; movement, role conversion, keeping useful work and
activity deletion snapshots preserve it. This is not a new task type or a public
privacy editor.

Migration 0026 reclassifies only proven backing references with known goal owners
and their descendants, retaining task identities and recurrence history.
Unrelated tasks are untouched. Unowned old journal data is preserved but needs
deliberate owner repair before public access; no arbitrary member is assigned.

## Evidence plans and historical meaning

An intervention may use:

- Existing ordinary task/activity evidence, without a duplicate daily question.
- A brief daily self-report for a behavior that tasks cannot establish.
- End-of-period reflection where quantitative tracking is not useful.

A daily plan records its question, day/night reference, reporting-day offset,
availability time in the snapshotted household timezone, applicability of “no
opportunity,” and an optional simple successful-days target. Same-day reporting
starts after the declared window closes. A night report becomes answerable the
following day and refers to the preceding night. There is no event/sensor
scheduling framework or natural-language commitment evaluator.

Plan versions are immutable snapshots of commitment, wording, timing, target and
timezone. An initial plan starts today or on a future intervention start date;
replacements apply tomorrow. Another replacement for the same effective date
conflicts rather than rewriting issued history. Start dates with observation
history cannot be changed retrospectively. Existing records receive no inferred
plans, targets or answers. Migration 0027 adds empty plan/report tables.

Reports are separate from tasks and unique per intervention/reference date.
Revision zero creates; corrections require the current revision. Reports retain
both reference date and original submission time, plus last correction time.
A late report still uses the plan that applied to its reference day.

`met`, `not_met`, explicit `unknown`, and applicable `no_opportunity` remain
separate. Absence of a row is missing evidence. No opportunity is appropriate for
a response requiring a trigger; a trigger-free avoidance window is not silently
classified that way. Negative reporting is a successful submission, not unfinished
work. Daily timing compares local calendar dates and wall-clock times across DST.

Calendar-week targets mean Monday–Sunday. Fixed seven-day targets require an
explicit anchor defining consecutive non-overlapping periods. Supported targets
count explicit successful days. Unknown, missing and no opportunity remain
visible rather than becoming failures. Partial and plan-version-split periods
are marked and never receive a fabricated proportional target. Unsupported
commitments retain qualitative review.

## Manual collection and Today

The existing intervention form edits commitment, rationale, dates, standing
reminder visibility and evidence plan. Journal changes and prospective plan
snapshots commit atomically. Editing an old journal entry does not silently add
an observation plan. New manual interventions default visibly to period-end
reflection; no AI is required.

Today distinguishes the standing behavioral reminder from a reporting question.
Questions appear only once answerable, show their actual reference date and link
to the goal. The latest unanswered question per intervention appears in Today;
Goals offers seven recent missed periods and paged recorded history for
correction. Notes are optional. Missed reports never accumulate as overdue tasks
and are never backfilled automatically. Both German and English catalogs are
supported. Task-only evidence asks no daily question.

The standing review reminder may demote after seven days; the behavior, tasks and
reporting remain active until deliberately changed. Review remains available on
Goals. Switching away from daily reporting ends reporting prompts prospectively,
including reminders about older unanswered questions, while preserving records.

## Ordinary task backing

All intervention types may create ordinary one-off, scheduled or recurring tasks.
Goals remain outside the hierarchy. Provenance is bounded to work the intervention
created; arbitrary manual task-to-goal tagging is not supported.

The existing backing command accepts up to eight task drafts per acceptance and
at most sixteen created tasks per intervention. Users review/edit dates, recurrence
and reminders before creation. Stable proposal-local task keys make lost-response
retries idempotent. Creation and association are atomic through
`createTaskInTransaction`, with no parallel task mutation path.

Existing scheduling expressiveness is preserved. Recurrence is after completion,
not fixed-weekday calendar recurrence. Tuesday and Thursday at 19:00 can be
represented as separate dated ordinary tasks with the appropriate reminders.
The editor explains supported alternatives rather than silently substituting a
schedule or introducing a recurrence engine. A practice task may coexist with a
distinct phone-avoidance observation; completing practice does not prove avoidance
or the broader goal “learn piano.”

Migration 0028 converts existing singular backing pointers into durable
`intervention_tasks` provenance without recreating tasks or occurrences. Original
IDs/titles remain available after task deletion. Editing, cancelling or deleting
a task does not fabricate success. Stop uses canonical cancellation for all
remaining open generated tasks; keep leaves useful work running with privacy and
history intact. Completed/cancelled/deleted tasks are handled without an invented
completion. The singular pointer remains only a compact presentation summary.

## Shared evidence and continuous review

`buildInterventionEvidence` is the deterministic manual/coach evidence builder.
It extends `buildReflectionBriefing`, combining plan versions, explicit reports,
generated-work provenance and the existing finite-completion/recurrence split.
It does not create another activity reader. Task administration is not behavioral
progress. Task facts and observation facts stay separate; counts are not added
across different measurements. Existing accessible activity is context for review,
not automatic proof of relevance or goal attainment.

Review shows counts and coverage without collapsing met, not met, unknown, no
opportunity and missing. Supported targets are evaluated in their actual windows,
not by pooling a fortnight into a weekly claim. Users can inspect both created-task
results and the underlying historical briefing. Adherence and perceived benefit
are separate questions. Optional obstacle context helps interpretation but does
not establish causes.

Assessments snapshot the reviewed evidence, interpretation, task/observation
citations and user reflection. Late reports or later plan edits do not rewrite a
recorded assessment's evidence. Checkpoint transitions require the current revision
and a stable review key; repeated acceptance returns the recorded transition.

- Continue unchanged advances the review window/checkpoint without duplicating
  tasks, plans or history.
- Adjust changes commitment, evidence collection or standing reminder visibility
  prospectively, preserving earlier attribution.
- Stop explicitly keeps or stops remaining generated work through existing
  lifecycle commands.

An assessment alone no longer permanently marks active behavior reviewed. Stored
lifecycle remains active/concluded; running/finished/reviewed presentation is
derived. Migration 0029 adds checkpoint and accepted-evidence fields while
retaining old assessments.

## Advisory coach

Goal capture stays title plus optional context. Suggestions may ask one tailored
question if its answer would materially change the recommendation; otherwise they
propose directly. Follow-up references the owned question request and carries the
answer. It must then propose rather than continue questioning. No general chat
platform or automatic request chain exists.

Guidance considers capability, opportunity and motivation, actual obstacles, cue
suitability, friction removal, achievable behavior, executable avoidance alternatives
and proportionate evidence. Rationale expresses a tentative mechanism the user can
correct. If–then wording is useful when a recognizable cue precedes the relevant
decision; it is not mandatory. Universal effect-size and confidence-percentage
claims have been removed.

Version-2 proposals include commitment, rationale, dates, supported evidence plan
and optional concrete task drafts. Unsupported fields, references and schedules are
rejected. The web reuses manual draft editors. Explicit acceptance atomically calls
canonical intervention, plan and task commands and records the accepted intervention
on the request, preventing duplicate work on retry. Relevant clarification context
is retained in rationale.

Coach review consumes the same deterministic evidence snapshot plus optional benefit
and obstacle reflection. It does not reconstruct hard facts from prose. Observation
and task citations must come from the snapshot. Sparse evidence is described
honestly; absent reports do not imply motives or behavioral failure. Guidance
distinguishes high adherence/low benefit from low adherence/high benefit, absent
cues and sustainable success. Continue/adjust/stop remain unapplied proposals.
Accepted review reuses the manual checkpoint transition and preserves its snapshot.

Useful behavior can continue with less administration: switch daily reporting to
period-end reflection or task evidence, and disable the standing reminder while
retaining useful tasks. Ordinary task reminder edits still use ordinary task
planning. There are no streak resets, permanent reporting requirements or dormant
goal debt. Migration 0030 retains observation citations and reminder visibility.

## Transport, compatibility and release

HTTP and MCP share the canonical journal, observation, evidence and review commands.
Observation/history access extends the existing goal routes:
`GET/PUT /api/interventions/:id/observations`,
`PUT /api/interventions/:id/observation-plan`, and
`GET /api/interventions/:id/evidence`. Existing suggest/assess and explicit accept
endpoints retain the leased Home Assistant request worker. New payloads use
`contractVersion: 2`; reverse-request protocol remains version 3.

Old stored/in-flight suggestions remain readable. A suggestion missing an evidence
plan needs explicit user selection before acceptance. Old assessments remain usable;
new requests require typed decisions and observation citations. An outdated adapter's
incomplete new result fails safely; manual authoring/review remains available.
Install Home Assistant component **0.7.0** through HACS and restart Home Assistant
to load the new Python adapter. Server and integration versions are independent.

## Research context and boundaries

The product decisions in #212 cite the Consensus Sleep Diary (Carney et al., 2012),
daily/event-report adherence findings (Hultgren et al., 2020; Burke et al., 2017),
COM-B (Michie et al., 2011), implementation intentions (Gollwitzer & Sheeran, 2006),
progress monitoring (Harkin et al., 2016), and variable habit-formation timescales
(Lally et al., 2010). These inform timing and reasoning; they do not validate Machbar
or support causal claims about an individual experiment.

Out of scope: goal/project hierarchies, arbitrary manual goal tagging, general
questionnaire/chat/workflow engines, sensors, arbitrary rule evaluation, automatic
causal inference, public accountability defaults and gamified streak mechanics.
