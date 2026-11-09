# UX simplification audit

**Date:** 2026-11-06

**Source baseline:** `53610842`

**Scope:** audit and proposed implementation only; no application changes.

## Recommended strategy

Make existing work easier to trust, find and operate before changing the shape
of the interface. Preserve the capture -> clarify -> execute -> wait -> review
loop, its compiled views and its existing capabilities.

The strongest opportunities are not a navigation redesign: they are visible
read recovery, correctly scoped Week state, accurate action wording and
consistent access to existing operations. Canonical commands, focused workflow
hosts, shared planning, retained mutations and backend-derived workflow facts
already provide a strong foundation. Do not replace them.

Three investigators independently inspected workflows, interactions and
architecture in parallel. The designer and analyst then reconciled against
the auditor's common capability baseline. The simplification critic challenged
the reconciled proposals; the regression reviewer independently evaluated the
result. Their overall advisory verdict is **revise**, with revisit-clock
semantics and capture-to-AI transfer blocked pending decisions. That is a
proposal verdict, not an incomplete audit or permission to implement.

## Priorities

Impact and cost are qualitative estimates, not measured usage or delivery
promises. **Small** means a bounded presentation/copy/helper change; **medium**
means multiple consumers or consequential async/contract testing. Small source
changes can still have high verification cost.

| Priority | Slice | Expected impact | Cost | Disposition |
| --- | --- | --- | --- | --- |
| P0 | S01: qualify Week state and recovery by query and operation | High: prevent cards and rollback from representing the wrong selection | Medium | Define response-order contracts; then implement separately |
| P0 | S02: align revisit projection and commit | High: avoid an unexplained clock change after moving a date | Decision first; likely medium | Blocked on clock/precision/DST contract |
| P1 | S03: show focused-workflow loading and read recovery | High: requested actions have an observable recovery path | Medium | Refine modal/draft/focus contract |
| P1 | S04: surface retained-list refresh failures | High: retained data is not mistaken for a successful refresh | Medium across callers | Inventory resources and retries |
| P1 | S05: distinguish clarification and reconsideration actions | Medium: labels describe existing effects | Small | Ready for design |
| P1 | S06: label the current three-way scope accurately | Medium across five views: less interpretation and better accessible semantics | Small; optional reuse is small-medium | Prefer labelled cycle, not more controls |
| P1 | S08: Discussion keyboard and section-label parity | Medium for established shortcut users | Small | Reuse existing navigation primitive |
| P2 | S07: reveal backlog search matches | Medium for the affected search journey | Small | Reuse existing search-reveal behavior |
| P2 | S09: reconcile status display and action affordance | Potential clarity benefit; no demonstrated tap saving | Small design investigation | Preserve reachability; resolve badge convention conflict |
| P2 | S10: remove proven pure-helper duplication | Maintenance benefit, no direct user-effort saving claimed | Small extraction; medium contract review | No new controller/framework |
| Discovery | D01: authored capture -> AI input handoff | Potential removal of repeated text entry | Unknown until semantics agreed | Discovery only; no adopted change |

P0 is correctness risk, not the largest presumed audience. P1 recovery applies
across core journeys; its higher cost is justified by completion/recovery
impact. Small wording and keyboard changes can proceed independently once
approved. Search and maintenance work should not delay correctness repair.

## Documents

- [Findings and capability baseline](findings.md): source evidence, current and
  proposed journeys, protected outcomes, coverage and limitations.
- [Implementation plan](implementation-plan.md): bounded slices, dependencies,
  acceptance scenarios and verification requirements.
- [Review decisions](review-decisions.md): critic challenges, reconciliations,
  rejected alternatives and unresolved decisions.
- [Reimplementation context](reimplementation-context.md): lessons from the
  subsequent recovery effort and the 2026-11-08 decision to restart from merged
  #252. Preserves regression evidence and rejected approaches, with a narrow
  backend/Activation tranche; the original audit above remains unchanged.

## Evidence limits

This is a comprehensive **source-based breadth audit**, not exhaustive runtime
or usability verification. Daily workflows and Week/recovery paths received
deeper investigation; secondary editors, administration and integrations were
sampled. Each finding distinguishes source behavior from inferred user impact.
No live household data was accessed. No user-frequency, satisfaction or
task-time measurements were collected.

Existing tests were inspected by investigators. Repository verification run by
the coordinator is recorded in the implementation plan; a passing baseline does
not reproduce these findings or prove their proposed fixes. There was no
browser, screen-reader, physical-keyboard or deployed-service exercise.

No product feature, dependency, required setup, persistent setting, endpoint,
schema or application behavior is added by these documents. Implementation
requires explicit approval and a contract-first verification assignment.
