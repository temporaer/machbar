# Goals and interventions delivery

The original manual journal, Today focus, advisory coach and recurring backing
have shipped. [#212](https://github.com/temporaer/machbar/issues/212) supplies the
product decisions for the follow-up;
[#213](https://github.com/temporaer/machbar/issues/213) defines the seven dependent
phases implemented on branch `codex/213-intervention-evidence` in
[PR #214](https://github.com/temporaer/machbar/pull/214).

The user requested one branch and a commit per phase, with focused fix commits.
Manual authoring remains usable throughout; no AI result creates work before
explicit acceptance. The PR carries the current verification evidence.

| Phase | Delivered behavior | Canonical implementation |
|---|---|---|
| 1 | Owner-only journal access; task privacy independent of personal/work placement; proven backing migration | Existing goal guards, `Graph.load`, `privacy_owner_member_id`, migration 0026 |
| 2 | Immutable prospective observation plans; reference-date reports; revision-aware corrections | Shared observation contracts, `interventionObservations.ts`, migration 0027 |
| 3 | Manual plan editing, answerable Today questions, recent missed reports and correction history | Existing intervention form, Today focus, goal actions; shared draft editor/report card |
| 4 | Atomic, idempotent creation of ordinary scheduled, recurring and one-off tasks; durable provenance | Existing backing command and canonical task commands, migration 0028 |
| 5 | Deterministic review evidence; actual target windows; checkpoint continue/adjust/stop | `interventionEvidence.ts` extends reflection; canonical assessment mutation, migration 0029 |
| 6 | At most one tailored clarification; editable complete proposals; atomic acceptance | Existing coach requests, proposal polling, shared plan/task editors and HA adapter |
| 7 | Coach consumes the same evidence; accepted observation citations; optional lighter reporting/reminders | Existing coach assessment and manual checkpoint transitions, migration 0030 |

See [the current specification](goals-and-interventions.md) for ownership,
calendar/coverage semantics, supported schedules, migration behavior, and Home
Assistant release requirements. Earlier implementation plans remain available in
git history; their automatic-expiry and frequency-only backing assumptions are
superseded.

Verification follows `AGENTS.md`: architecture first, relevant behavioral and
concurrency tests, workspace typechecks/tests/build, and Python integration tests
through `bash scripts/verify.sh`. The managed environment needs local networking
for Home Assistant's session fixture; the documented sandbox skips remain in
place for Node tests that explicitly require network access. No application or
AI server is needed for verification.
