# Second pass: simplify the everyday flow

**2026-11-06, baseline `53610842`.** This pass examines successful UI journeys,
not the [first pass's bug/recovery backlog](../README.md). Those artifacts remain
unchanged and are deferred, not discarded. The audit below records the baseline;
the user subsequently approved F1–F5 for implementation. See the
[implementation record](implementation-plan.md#implementation-record) for the
implemented scope and validation evidence.

## What should feel simpler

**Make the main job obvious; keep the information needed for that job together.**
Machbar does not need another navigation system, setup wizard or universal
editor. Its existing capture, planning, project and Review flows already work.
The opportunity is to make their action hierarchy and connections more natural.

Two agents independently traced successful journeys. Their proposals were
reconciled with actual synthetic-data browser walkthroughs, challenged by the
simplification critic, and independently reviewed for capability preservation.
This yielded five bounded directions rather than another technical bug list.

| Priority | Direction | Before -> proposed experience | Impact / cost estimate |
| --- | --- | --- | --- |
| 1 | F1: capture first | Create follows alternative modes -> Create first and full-width; all alternatives still visible | Modest but broad / small |
| 2 | F2: expose project authoring | Add tasks sits after Notes and Outcome -> move the same button beside the task summary | Medium for project setup / small |
| 3 | F3: make waiting coherent | Starting a wait is under general options; next revisit follows follow-up Save -> put the entry in planning and the revisit summary before Save | Medium / small for the minimum rearrangement |
| 4 | F4: direct entry for known steps | Actions -> Structure -> Split -> one secondary Add subtasks shortcut into the existing composer | Medium for multi-step captures / small-medium |
| 5 | F5: Review the decision, not duplicate inspection | Routine cards can offer equivalent Details choices -> one equivalent inspection action; reason-specific decisions remain | Small-medium / small, conditional on equivalence |

These are relative estimates, not measured usage, task times or delivery dates.
F1/F2 are cheap hierarchy changes. F3/F4 reduce category guessing or intermediate
surfaces. F5 is a smaller source-supported cleanup, not runtime-demonstrated.

## The proposed normal journeys

```text
A thought:
  + -> title -> Create -> optional Open
  No new question, mode or classification required before capture.

One action:
  Open -> plan if needed -> do -> complete
  Existing planning can establish the commitment without a separate
  classification step. Keep that working path.

Known steps:
  Open capture -> Add subtasks -> existing step composer -> submit
  Optional project treatment stays explicit, inside that composer.

An outcome:
  Open project -> Add tasks beside its summary -> existing batch composer
  -> return -> explicitly start when intended
  Notes, outcome criteria and activation decisions remain.

A follow-up:
  Outcome -> continue/end -> next-revisit summary/Edit -> Save follow-up
  One existing follow-up command, not two mandatory saves.
```

See [journey storyboards and screenshots](journeys.md) for precise before/after
arrangements, tradeoffs and no-change alternatives. See the
[implementation brief](implementation-plan.md) for slice boundaries and approval
conditions.

## What the critic prevented

- **Do not move all project notes below tasks.** Important constraints can
  legitimately precede execution. Move the authoring entry, not the context.
- **Do not add another planner mode or date editor.** The minimum waiting change
  moves the existing summary/Edit link; the actual date editor remains shared.
- **Do not present four equal primary clarification buttons.** Add subtasks is
  a secondary shortcut, with existing classifications preserved.
- **Do not restore All to More or reorganize navigation on preference alone.**
  Existing view distinctions and grouped optional tools remain.
- **Do not remove Review actions merely because their labels match.**
  Intent, target, focus and return behavior must match too.

## Evidence and limits

The coordinator exercised an isolated instance using repository seed data and
explicitly synthetic additions, never a live household database. Walkthroughs
included capture, one-action planning/completion, inactive conversion, two-task
project entry/start, and recording a follow-up with a new date.

Baseline screenshots cover German mobile Chromium at **390 x 844** and English
desktop at **1280 x 900**, including a notes-rich counterexample. They show the
current UI, **not implemented proposed layouts**. Different locale/theme captures
are evidence of those examples, not controlled visual comparisons.

This is not user research. Reading-order improvements are inferred; physical
phones, soft keyboards, screen readers and physical keyboard use were not
validated. Ordinary walkthrough success does not establish every lifecycle,
privacy or concurrency case. Implementation-specific checks and remaining gaps
are recorded separately in the implementation brief.
