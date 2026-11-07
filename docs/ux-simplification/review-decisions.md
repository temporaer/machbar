# Review decisions and open questions

This is the synthesis of five specialized read-only agents, not a vote to
authorize implementation. [Findings](findings.md) contain evidence; the
[implementation plan](implementation-plan.md) contains acceptance scenarios.

## Investigation and challenge

| Role | Contribution | Advisory outcome |
| --- | --- | --- |
| `ux-auditor` | Broad capability/coverage baseline and eight AUD findings, deep daily-workflow and Week/recovery inspection | Revise: usable baseline; no runtime proof |
| `interaction-designer` | Independent INT proposals, then reconciliation against the common AUD baseline | Revise: smaller options selected; conditional options separated |
| `architecture-analyst` | Concrete canonical-path duplication and read/state traces; reconciled priorities | Revise: recovery first, pure reuse instead of controller |
| `simplification-critic` | Challenged actual reconciled proposals, no-change options and complexity budget | Revise overall; clock and transfer decisions blocked |
| `ux-regression-reviewer` | Independent capability map, event/error/lifecycle matrix and acceptance gaps | Revise overall; guarded low-risk directions accepted, no implementation accepted |

The first three investigations were parallel and independent. Designer/analyst
follow-ups used the same auditor baseline before critique. Critique preceded
independent regression review. The coordinator wrote these documents; agents
did not edit files or operate the application.

## Reconciled decisions

| Proposal | Critic challenge | Resolution / remaining condition |
| --- | --- | --- |
| Week query ownership | Keying render alone does not protect late rollback; same-query overlap also matters | S01 explicitly covers drag/errors/read/write/rollback and newest accepted state |
| Revisit clock | Midnight fixture cannot choose semantics; helpers differ on unchanged-date precision | S02 blocked on clock/precision/DST policy, not silently "fixed" by helper choice |
| Host loading UI | Replacing a retained editor can destroy drafts/focus; late response can reopen closed UI | S03 distinguishes usable retained content and absent required detail; lifecycle contract required |
| Refresh banner | One generic Retry can misattribute Review's resource failure or repeat unrelated work | S04 enumerates reads/retries; adds Discussion sibling disposition |
| Three scope chips | One fewer activation can cost two visible targets and header height | Keep labelled existing cycle first; chips deferred |
| Clarification/revisit copy | Extra confirmation would add ceremony without solving wording | S05 changes wording only; immediate explicit commands remain |
| Backlog search | "Auto-open everything" can interfere with manual/focused disclosures | S07 reuses outer search reveal only, with query-clear/focus scenarios |
| Discussion shortcuts | Missing j/k is not total keyboard inaccessibility | S08 reuses one existing mount; preserves native keyboard and nomination semantics |
| Read-only status replacement | Moving learned trigger adds a control and saves no activation | S09 preserves reachability and records unresolved display/trigger preference conflict |
| Capture prefill | "Literal text" hides title/notes/syntax/instruction/destination decisions | D01 discovery only; no adopted transfer or synchronized drafts |
| Move-handle tap | One control would own drag, arrow and destination behavior with added hidden event rules | No behavioral change now; examine naming/instructions; all existing move paths retained |
| Direct Week planner chips | Baseline already has non-gesture detail planning; more drag/focus regions | Defer until correctness and device evidence justify controls |
| AI intent chips | Default path unchanged; native select already usable | Keep select; preference not proven simplification |
| Shared step-batch controller | Editor and backend already shared; controller risks generalizing distinct semantics | S10 narrow serializer and conditional constructor reuse only |
| Backend viewer resolver | Duplication exists but privacy risk exceeds demonstrated direct UX gain | Defer; no route/auth/Graph-policy change |
| Stale documentation | Removed handoff is not a capability to restore | Correct baseline within audit only; targeted product-doc correction later |

## Complexity budget

Estimates compare the named journey, not whole-product usability. Do not combine
controls, clicks and states into one score.

| Direction | Visible controls | Activations / navigation | States / responsibility |
| --- | --- | --- | --- |
| S01-S02 correctness | Unchanged | One drag stays one drag | Consistent query/operation and date contracts; no new domain concept |
| S03 host recovery | Happy path unchanged; absent-target failure gains Retry/Close | Successful closed-rail launch remains about two activations | Existing read state becomes visible; one foreground modal; no new fetch layer |
| S04 list recovery | Happy path unchanged; one Retry per failed resource | Explicit recovery decision replaces unspecified recovery | Existing retained-data failure exposed; retries stay reads |
| S05 wording | Unchanged | Unchanged | Fewer misleading interpretations; no confirmation/state added |
| S06 labelled cycle | One -> one per header | Target selection remains one or two | Current state visible; three scopes and storage unchanged |
| S07 search | Unchanged | One outer disclosure removed for a matching ungrouped backlog item | Existing reveal rule reused; no persisted mode |
| S08 Discussion | Unchanged | Touch unchanged; shortcut effort not quantified | One existing mount, no new navigation model |
| S09 status | Undecided; no control increase assumed | Existing chooser about two activations | Display/trigger convention must be resolved; legal operations unchanged |
| S10 pure reuse | Unchanged | Unchanged | Identical serializers two -> one; constructor reuse only with preserved absence meaning |
| D01 candidate | Unchanged, conditional | Relevant authored branch approximately six -> five actions | One defined snapshot, not synchronization; not adopted |

## Decisions required before implementation

1. **S02 date movement:** preserve or normalize existing local clock? What is
   unchanged-date precision? How are DST overlap/gap handled? Resolve existing
   command semantics without introducing a setting or deleting other callers.
2. **S01 operation order:** what values/membership win after overlapping edits,
   refresh and rollback within one identity? Cross-query qualification alone is
   insufficient.
3. **S03 usable content:** when is retained target data sufficient, especially
   completion requiring detail? Define close/reopen/suspend transitions and focus.
4. **S04 resource inventory:** which exact query failed and which read does Retry
   repeat? Include Discussion or explicitly document its deferral; no blanket
   application-wide recovery claim.
5. **S09 display convention:** reconcile read-only status preference with the
   currently learned clickable entry without hiding lifecycle actions.
6. **S10 snapshots:** preserve unavailable versus valid empty requirements and
   applicable authored choices. Extraction must not silently repair or worsen
   existing stale-recovery behavior.
7. **D01 transfer meaning:** decide source fields, syntax representation,
   destination and repeated-switch behavior before adopting prefill.

These are bounded design/contract questions for the affected slice, not grounds
for an application redesign. No-change remains valid for discovery-only work.

## Hard exclusions and evidence gaps

No feature removal or new feature/setup/setting/dependency/framework is included.
Do not collapse lifecycle, waiting, dates or compiled views; remove confirmations,
privacy checks or activation decisions; autosave authored text; auto-apply AI;
or replace backend-derived facts with client approximations.

No sensitive regression was reproduced during this audit. Core source findings
must be tested before fixes. Baseline verifier results do not prove them false
or establish proposed fixes. No browser/device/user results were supplied.
Sampled secondary workflows and deployed authentication, push, HA, Paperless,
screen readers, physical keyboards and installed PWA behavior remain explicitly
unverified. These limits prevent implementation acceptance, not completion of
the documentation-only audit.
