# Reimplementation context

## Superseding decision: server-confirmed simplification

On 2026-11-09 the user explicitly approved simpler interaction guarantees after
the second Query pilot failed its correctness and size gates. The rejected pilot
is preserved locally at `279b12ba`; documentation-only PR #265 records its
net +697 runtime lines and projected completed growth. It is not a foundation
to patch or ship.

The new implementation starts from merged main `2e923f23`, not that pilot:

- Wait for mutation confirmation; show pending/errors without optimistic DTOs.
- Invalidate and refetch whole view/endpoint responses instead of patching every
  embedded copy or building a normalized client graph.
- Let rows regroup/disappear on fresh results; delete timed holds and leases.
- Preserve authored drafts during ordinary refreshes/network failures.
- End focused workflows on access loss, discard choices, and reopen fresh.
- Reload stale compound prerequisites and require explicit reconfirmation.
- Permit one pending domain command per work item in this client.
- Keep authorization, transactional writes, revision checks and identity isolation.

Native Query owns the generic read facade's values and execution. Bootstrap
identity and independent explicit polling are not silently claimed as migrated.
Correctness and measured source reduction remain separate acceptance checks.
The history below preserves earlier investigation; requirements for recovery
across access revocation and timed placement are deliberately superseded.

### Implementation contract and acceptance matrix

The observable contract was established before changing production behavior.
The implementation replaces machinery rather than layering another recovery
protocol over it:

1. Replace optimistic/retained actions with server-confirmed commands and a
   shared per-item pending gate, including hierarchy moves and refinement.
2. Replace the generic custom read runner with native Query, retaining the
   existing localized read interface and invalidation transport.
3. End denied editor openings and reset stale compound decisions; retain
   authored text across ordinary outages and harmless refreshes.
4. Verify the complete application, both browser projects and actual provider
   identity replacement before publishing.

| Observable invariant | Counterexamples and boundary evidence |
| --- | --- |
| Pending commands do not predict domain state | Metadata, completion, refinement and moves retain the old projection until an authoritative read; failed commands do not need rollback |
| One pending task command is shared across entry points | Metadata-before-move and move-before-metadata; outline and destination picker use the same canonical task action |
| Successful writes cannot publish a pre-write read | Held read completes before/after invalidation; canceled results cannot replace the post-write projection |
| External events cannot starve the initial read | Initial and trailing reads, repeated invalidators, and removed/replaced same-key Query objects |
| Ordinary outages retain useful data and authored drafts | Network failure, explicit retry, stale refresh and cancellation; no new timed row holds |
| Denial removes protected controls and choices | Read denial and private mutation denial, including when a later GET would still succeed; notice dismissal and explicit fresh reopening |
| Stale compound decisions require another explicit commit | Changed requirements, including equal target revisions with changed surrounding graph; no automatic command replay |
| Another identity cannot receive old values or callbacks | Provider retirement and delayed reads; real App mount tree, not just provider-rich component fixtures |

The integration pass exposed tests that mocked away the production read
provider or assumed synchronous custom-runner notifications. Those fixtures now
use the real provider and explicitly advance native notification timers; the
scheduler was not replaced. Intake mock response queues are reset between tests
so an early failure cannot contaminate later scenarios. Tag management and share
conflict handling also had redundant local reload plus global invalidation:
they now rely on the single global refresh, while explicit read retry remains.

The measured application-source delta against
`2e923f23` is **+1118 / -2589, net -1471 lines across 67 runtime files**,
including newly added source and excluding tests/test support. Test source is
separate: **+3165 / -2666, net +499 lines across 52 test files**, including
architecture-contract and browser tests. Deleted retention
tests describe deliberately removed guarantees; replacement tests cover the
approved server-confirmed behavior. These counts do not measure dependency
implementation size or establish correctness.

The first full verifier failed during integration; it is not acceptance
evidence. The final frozen implementation, including the independent and
Copilot review corrections below, passed:

- `bash scripts/verify.sh`: architecture, shared build, all typechecks,
  1,418 API tests, 1,905 web tests, production build and Python
  (159 passed, 1 skipped).
- `npm run build && npm run test:e2e`: production rebuild and 50 desktop/mobile
  Chromium cases, including real-App read and refinement-continuation retirement,
  authored-write/criterion denial, canceled catalog-read callbacks and
  superseded dependency search, submitted split-draft consumption across
  identity replacement and stale-deadline read retry.
- `git diff --check`: passed.

Verification used Node.js 22 and the existing Python test environment. These
results do not prove physical touch/keyboard, assistive-technology,
non-Chromium or live integration behavior.

### Acceptance review and correction

The simplification critic accepted the bounded design: the two small helpers
have real consumers and the removed coordination is not recreated elsewhere.
The source reduction is maintenance evidence, not proof of fewer taps or
faster everyday use. Intake/refinement proposal generation remains a separate
job with local pending state; the shared task gate covers domain mutations,
including refinement-list edits and moves.

The independent regression review found a missed identity ordering: production
identity replacement unmounts workflow hosts, leaving render-updated opening
refs frozen. A held refinement success could then navigate the replacement
identity to the old opening's intake job. This is a client continuation defect,
not evidence of an authorization bypass. Both hosts now retire their guards
synchronously on unmount, including StrictMode lifecycle replay; task denial
handling observes the same guard.

Four focused tests rejected the old task/project refinement and move
continuations. Both real-App browser refinement scenarios also rejected the
previously built faulty bundle: after identity replacement, releasing the held
POST navigated to the old intake URL. These browser tests use the production
App/provider tree and real member/item reads; only the held successful intake
response is supplied by the test. They do not establish Home Assistant
integration or intake persistence behavior.

The independent follow-up accepted resolution of this specific blocker after
reviewing both guards, StrictMode replacement behavior and the supplied
red/green evidence. No remaining causal scenario was identified for the
post-unmount continuation defect. This was a bounded correction review, not
proof that every asynchronous workflow or physical device was audited.

### Copilot review: expand the failure class

The first current-head Copilot review of #266 reported four actionable issues.
The merge is gated on their correction and a clean re-review, not just green CI:

- Task and project title/notes writes can be denied while a subsequent GET is
  still authorized. Read-denial cleanup is not sufficient: the current authored
  editor must end and discard its draft on mutation denial independently.
  Ordinary write outages must still retain it; obsolete openings cannot discard
  a replacement draft.
- Query cancellation excludes returned values, but cannot undo callbacks already
  executed inside a fetcher. A canceled old GET that later fails with denial
  must not end a current editor after its replacement read succeeds. Qualify
  fetcher-side failure callbacks with the native signal, not another generation
  store. Current, uncanceled denial still ends the editor.
- Outline movement already uses the shared task action. Its separate error map
  duplicated that owner and could hide the failure of a later completion or
  metadata edit, or survive a later success. Remove the duplicate map instead of
  merely reversing error precedence. All row failures and dismissal use the
  canonical task-action error state.

The counterexamples distinguish mutation failure from read failure, callback
execution from result publication, and failure-to-failure from failure-to-success
ordering. These are additions to the original matrix, not a return to the
rejected optimistic or restoration guarantees.

The four new real-App browser scenarios rejected the pre-review built bundle:
task/project denied title writes left their inputs open after an authorized
GET, and canceled tag-catalog denials closed the replacement editor. All four
then passed on rebuilt corrected source in both browser projects. The title
cases also preserve a subsequent ordinary-outage draft; the catalog cases
confirm the tag was persisted through the real canonical mutation. Unit
counterexamples cover both authored fields, 401/403/404, live read denials,
obsolete openings and move-failure ordering. The browser denials are supplied
serialized responses, not evidence that the server changed authorization.

The second review confirmed those four corrections but identified two sibling
paths omitted from that pass. Criterion text is a separate authored editor:
denied add/update commands must discard its draft even when the item GET remains
authorized, without discarding ordinary-outage or replacement-opening drafts.
Dependency search is an imperative read outside the seven fetcher wrappers:
an older search's denial after a newer success must not end the current
planning draft. Its empty-query, live-denial and replacement-query exits need
the same native read cancellation contract, not another generation store.

Criterion mutations now discard current add/edit drafts on denial; task detail
also revalidates the still-readable item. React keyed lifetimes retire obsolete
editor callbacks. Auditing adjacent authoring found the same omission in note
append and saved-notes attachment commands: these now discard/close on denied
writes, retain ordinary-outage drafts and cannot close a replacement opening.
Project criterion hosts were already guarded. Draft-only Markdown insertion
and Paperless upload/search authorization are separate from task/project write
denial; this does not claim an audit of those integration permissions.

Dependency search now uses the existing native read facade, keyed by query,
task and suspension state. Tests distinguish older-denial/newer-success,
cleared/whitespace queries, pending supersession, live 401/403/404, replacement
openings and explicit selection. Both new real-App browser cases reject the
pre-correction bundle at the intended invariant: criterion text remains editable
after denial/authorized refresh, or the obsolete search removes the current
planning draft. Initial selector/setup failures were corrected before recording
that sensitivity evidence.

Command-bound planning previews/conflict reads remain imperative. An advisory
source inspection noted an unchecked success continuation after a held planning
preview, but same-identity replacement reachability and an unintended write
were not reproduced; pending controls, identity retirement and revisions retain
their existing guards. This is a separate unverified concern, not a confirmed
regression from search cancellation or evidence of complete preview coverage.
The merge remains gated on another current-head Copilot review and CI.

The third review identified three more independent lifecycle/recovery gaps.
The verification contract distinguishes:

- Confirmed split success after identity retirement must consume only its
  still-matching submitted storage draft; newer drafts and failed submissions
  survive, and retired UI/navigation never resumes.
- Deadline stale-save recovery must retain the selected date, discard stale
  activation choices and expose a GET-only retry after offline/server failure.
  Repeated read failure stays recoverable; even an empty requirements result
  needs an explicit fresh-revision Save, never an automatic write replay.
- Successful writes after a consumer sheet closes still invalidate their
  captured refresh scope. Consumer unmount is not identity retirement:
  replacement identities must not receive the old write's UI or invalidation.

The split draft now carries a per-record identity so a newer draft with
identical text survives confirmed-success cleanup; legacy session arrays remain
readable. The old bundle failed the real-App test with already-created steps
still in session storage after the identity switch. The corrected test also
switches back, reopens the existing split workflow and observes a blank composer
with exactly the two already-created children in SQLite.

Deadline retry reloads only requirements and preserves the selected date;
fresh decisions and the current revision need another explicit Save. Tests
also cover repeated GET failure, absent activation requirements and the sibling
unchanged-date retry dead end after an ordinary write outage. The old bundle
failed the real-App stale/offline scenario at the absent retry control.

The shared mutation runner now invalidates its captured owner regardless of
consumer mounting, retaining local-state guards. Real-Query Goals tests
distinguish sheet closure from identity replacement. An adjacent, reachable
close/reopen ordering also exposed an old success closing the replacement
intervention sheet; its callback is now retired on unmount. No backend command
or successful return contract changed.

The fourth review requested human assessment of another confirmed-success
invalidation omission: criterion add/update/remove/reorder checked consumer
mounting before invalidating. The criterion check command already conformed.
The same guard ordering also existed in task-to-project conversion,
project-to-task conversion and project movement. All four writers now
invalidate their captured scope before the opening guard; local callbacks,
navigation and destination memory remain guarded.

Real-Query counterexamples keep an underlying read mounted, close the pending
writer and then confirm success. Four of five criterion cases and all three
conversion/move cases rejected the old ordering; all eight pass after the
correction. Their mutation responses are supplied test data, not evidence of
backend persistence. Existing scope-retirement tests distinguish a closed
consumer from an identity-retired provider. This extends the successful-write
matrix without adding another invalidation owner or weakening identity isolation.

## Decision and baseline

On 2026-11-08 the user approved preserving the previous effort and restarting
implementation from current GitHub `main`. This is a restart of implementation,
not of the investigation or the everyday-flow simplifications.

The starting commit is `ac6f57512e964fdb3fe7a155bc0a20a93085e57a`, the merge of
#252. It already contains the approved everyday capture, planning and Review
flows. The old local `main` still pointed to the earlier production baseline;
use the actual remote main, not that stale local reference.

Preserve the original [audit](README.md), [findings](findings.md),
[review decisions](review-decisions.md) and [flow-pass artifacts](flow-pass/README.md).
They are evidence and a backlog, not authorization to fix everything at once.

### First implementation tranche

1. Extract the two small backend fixes for #253 and #254 independently of the
   recovery/Query branch.
2. Reimplement **Activation only**, proving the smallest editor recovery boundary.
3. Verify each change, then publish small reviewable PRs.

Do not bundle Week, Planning, Deadline, Conversion, other editor recovery, or
TanStack Query into the Activation slice. Query migration is a separate decision
with an explicit existing owner and code to delete. Unrelated findings remain
backlog items.

## What is preserved

The previous native stack and its worktrees must not be reset, overwritten or
deleted:

| Source | Preserved reference | Use |
| --- | --- | --- |
| Recovery and project Query attempt, #256 | `fix/deferred-ux-recovery`, `7c27ff12` | Failure scenarios, existing tests, implementation history; not the new foundation |
| Previous recovery checkpoint | `9bd38e50` | Pre-Query comparison and regression source |
| Reached project progress, #258 | `fix/reached-task-revisits`, `f0523a59` | Small domain fix and serialized container regressions; final correction is local |
| Schedule precedence, #261 | `fix/today-revisit-schedule`, `cece65ed` | Small eligibility fix, REST/MCP/calendar/browser regressions |
| Latest uncommitted editor attempts | Original working tree and session patch/checkpoints | Preserve for diagnosis; neither accepted nor safe to bulk transplant |

The old branches are a **fix bank**, not a patch to cherry-pick wholesale.
Their dependencies, contracts and tests must be checked against the fresh baseline.
No merge or deployment of the old recovery branch was completed.

The final paused Activation experiment did demonstrate two focused red-to-green
cases: expired controls are removed during denial, and recovery with no previous
prompt no longer dereferences `targetRevision`. It deliberately dropped the new
same-DOM-node requirement across revocation while preserving strict privacy and
draft assertions. The whole old working tree still has Planning privacy failures
and nullable-task type errors; this focused result is not a shippable baseline.

### Measurements, not success claims

Published #256 changed 94 files versus actual main: `+9443 / -912` total lines.
Runtime source under `apps/*/src` and `packages/*/src`, excluding tests and test
support, was `+2522 / -793`, net **+1729**. Later uncommitted attempts added more.

The project Query stage did consolidate fetched/confirmed project ownership,
but added **338 runtime lines** versus its pre-Query snapshot. The next rejected
editor-retention attempt added **111** more. Passing tests and real deletions
did not establish net simplification.

Record runtime, tests and documentation separately. Correctness and reduction
are separate acceptance measures; do not claim one from the other.

## Target structure

- Backend domain rules and read projections remain authoritative.
- One canonical owner manages fetched/confirmed state for a resource. Do not
  build a second client domain graph or add another fetched-state fallback.
- Canonical actions own mutations, revisions and reconciliation. Components
  do not implement alternate raw mutation paths.
- Existing editor state owns authored drafts, choices, conflicts and disclosures.
  The logical opening owns identity and lifetime.
- Current server authority can become **null without ending the opening**.
  Retaining drafts does not grant read or command authority.
- Later Query adoption must replace existing ownership, not wrap the same
  recovery machinery in a new store.

Read the fresh baseline's normative [architecture rules](../architecture-rules.md)
and [contract-first guide](../loop-engineering.md#contract-first-verification).
Do not import the abandoned branch's architecture registry as though it described
the fresh implementation.

## The editor boundary to prove first

Activation is a compound command with explicit decisions, not an atomic metadata
picker. Preserve the supported action, driver/next-action choices, Save/Cancel,
pending/error feedback, keyboard access and original opener restoration.

### Independent invariants

1. A readable opening can collect authored choices without writing.
2. A harmless read outage retains usable content and authored choices.
3. A target read denial removes protected server content and expired requirement
   fields from DOM text, labels, attributes and serialized control values.
4. The editor owner and authored state survive denial, a failed retry and a
   successful retry. Do not satisfy nonnullable props with an old fetched DTO.
5. Retry performs the relevant GET only. No automatic mutation, activation,
   navigation, closing or requirement recertification.
6. Restored current authority supplies fresh requirements/revisions. Authored
   choices survive where they remain applicable; unavailable old requirements
   do not acquire fresh provenance merely because a read succeeded.
7. Replacing opening A with B cannot transfer A's choices to B, including cached B.
   A same-opening refresh or suspended inspection is not a new opening.
8. A response dispatched before identity/opening/read authority expires cannot
   later publish or close the current editor.

**Stable React owner is not the same requirement as stable DOM nodes.**
During an ordinary outage, usable controls/focus should remain. During read
revocation, protected controls may leave the DOM while their authored state
remains in the owner. New tests must not force hidden protected DOM just to keep
the same input node connected.

### Proportional first matrix

| Scenario | Observable result |
| --- | --- |
| Readable opening, edit, read outage | Draft retained; no write; usable feedback/Cancel |
| Readable opening, edit, denial, failed retry, restored read | Protected DOM absent while denied; draft restored; fresh requirements; GET-only recovery |
| No usable initial authority, then successful read | Recovery does not dereference a missing prompt or fabricate a project |
| Restored read followed by another qualified read | Accepted recovery provenance remains valid; old denied prompt stays expired |
| Cached A-to-B replacement | B receives only B's state; same-opening retries do not reset drafts |
| Delayed command response after opening/authority expiry | No obsolete close or publication |

Use the smallest existing tests that observe each invariant. Establish at least
the reported regression against fresh main before changing production code.
Use real API/serialized contracts where response shape matters, and real
desktop/mobile app mounting for browser-visible changes.

Callback authority must rotate at the qualified read-denial event, not only
when queued React state renders. Test command success/error after restoration
and success in the same batch as denial: a render-mirrored authority ref left
a reproduced closing race.
Read acceptance is not runner idleness: an accepted 200 followed by a queued
503 must recover the editor. Error-supplied requirements also outlive choice
edits until a new accepted GET replaces them. Keep one authored-choice owner
and preserve canonical normalization when a newer read removes a driver requirement.
Also test the opposite response order: a delayed command error must not stamp
older requirements with a newer GET's identity. The existing live read witness
qualifies publication before React renders; older or equal-revision errors leave
fresh read facts intact, while a strictly newer error can supply updated
requirements. Keep the command's own error feedback in either case.

## Mistakes not to repeat

### Hidden DOM is not data removal

The rejected attempt used `visibility:hidden` and `aria-hidden` around active
editors. Server titles, requirements, notes and input values still existed in the
DOM. An unavailable-fields mode bypassed a prior guard and permitted the same
leak. Both independent reviewers rejected it.

Do not change privacy assertions from "not in the document" to "not visible".
Check text, attributes and control values, including hidden elements.
Modal background inertness is a different accessibility concern, not a reason
to weaken revoked-data assertions.

### Draft retention is not a fetched DTO fallback

New `openingStory`/`openingTask` refs held complete fetched objects and supplied
them when current authority was null. This reintroduced ownership beside Query
and made stale server input available to rendering/commands.

Remove that pattern. Existing field-level merge baselines and consumed-object
identity witnesses have different purposes; do not rewrite them merely because
they contain server values. Classify actual authority, draft/conflict baseline
and identity witness before changing an existing primitive.

### Do not demand every mechanism at once

The old assignment combined several editors, revocation, drafts, retries,
provenance, concurrency and LOC reduction. Review repeatedly expanded the patch.
Prove one editor boundary, inspect it, and only then authorize a sibling slice.
No generic draft framework, permission bus, recovery runner or speculative
abstraction is warranted.

## Backend fixes worth extracting

### #253: reached ordinary revisits and project progress

Reached ordinary actionable/unblocked **leaf** work can provide progress. Future
revisits remain intentional pauses. Do not clear dates or emit read side effects.
Project health, canonical next action and activation readiness must agree.

The first fix exposed a container error: a reached actionable parent with only
captured/Someday open work appeared healthy although canonical `nextAction` was
null. Reuse canonical unfinished-work facts, including arbitrary depth and
embedded projects, rather than duplicating hierarchy SQL or treating every
non-null revisit as unhealthy.

Project-progress candidates and execution candidates are not interchangeable.
A reached revisit can remain non-executable until acknowledged while providing
viable progress. Audit Review's no-path repair and reflection's first
execution-eligible action, including mixed leaves; project GET alone did not
cover these consumers.

Preserved serialized regressions cover captured/Someday direct children, nested
Someday work, active embedded projects, terminal project boundaries, future
container revisits and an eligible descendant. Four real migrated-DB/API cases
rejected the incomplete fix; the final focused run passed 74 agenda cases.
Prior full-gate results do not cover the last local correction.

### #254: future work plans and reached reconsideration

A future work plan suppresses ordinary reached reconsideration in Today.
The planned day includes the work once. External-wait follow-ups and deadline
attention remain independent; blocked reconsideration is not full executability.

Reuse `agendaSelection.ts`'s scheduled-date eligibility for execution suggestions,
planned rows and ordinary revisits. Preserve scope and deeper eligible work
promoted through unavailable intermediates.

Preserved regressions cover retained rows and supported recurring creation,
REST/MCP Today, household midnight, descendant projection, unchanged SQLite
state/revisions and no notification/write side effects. The old branch's small
production change was `+10 / -6`; its exact-head Copilot review had no open issues.

## Other retained lessons, not this tranche's implementation scope

- Target-only explicit Activation/Reopen and shared-chain Deadline/compound
  decisions are different server contracts. Verify the actual baseline response;
  do not invent fields or approximate readiness in the client.
- A matching GET403/404 can rotate a read token before error handling. Report that
  operation's own error while still excluding truly obsolete responses.
- Independent catalog and destination resources need independent GET-only
  warnings/retries; a usable resource should not be refetched as collateral.
- Accepted ancestor recovery provenance must survive a later qualified target
  refresh. Original revoked opening tokens cannot replace the accepted provenance.
- Derived child membership and equal-revision facts come from actual reads.
  Confirmed metadata must not fabricate full detail or overwrite fresher children.
- Relevant save/refresh/interaction orderings, authoritative revisions and
  eventual retention release matter more than total test counts.
- Live actor A-to-B-to-A, role conversion and logical opening identity are not
  equivalent to an item ID or revision.

### Query-specific findings for a separate migration

Installed Query can resolve cached data when the last observer cancels a
signal-consuming fetch. A resolved imperative promise alone is not proof of a
fresh accepted GET and must not clear denied access.

A metadata acknowledgement is not a full GET and cannot restore denied read
authority. A failed retry must not erase an earlier denial. Revision precedence
must hold at actual cache publication, not just before an awaited fetch resolves.
Equal-revision fresh full reads must preserve fresh derived facts.

One proposed defect was **disproved**: manual metadata revision 5 survived
cancellation of held full GET revision 4 because installed Query updates its
cancellation revert state after manual success. Preserve the regression, not a
workaround for a bug that did not reproduce.

These are migration counterexamples, not a request to port the old publication
witness, epoch framework or permanent cache wholesale.

## Evidence and completion discipline

Historical session logs include `258-container-regression-red.log`,
`258-container-focused-verification.log`, `issue254-red.log`,
`issue254-siblings-red.log`, `issue254-browser.log`,
`query-luna-mobile-final-cancel-red.log`,
`query-luna-cancel-metadata-acceptance.log`, and
`query-luna-review-privacy-red2.log`. Session artifacts are not repository
dependencies. The last privacy log includes a conversion-fixture setup failure;
do not count that failure as proof of a production regression.

Select and adapt a few relevant regressions; do not bulk-import the abandoned
test suite or mocks that secretly supply missing production prerequisites.

For each fresh slice:

- State invariants and counterexamples before production edits; demonstrate red.
- Reuse canonical paths and delete the superseded local implementation.
- Run relevant focused checks, then `bash scripts/verify.sh`.
- For browser-visible changes also run `npm run build && npm run test:e2e`.
- Inspect the actual diff against the matrix; use independent review where scope
  warrants it, not another implementation pass disguised as review.
- Use the repository PR template, exact commands/results, smallest required
  version bumps and matching lock metadata.
- Measure runtime delta against actual main and name removed responsibilities.
- Stop after a few focused failed attempts and reassess the slice, rather than
  growing the assignment.

Do not claim deployed/live OIDC, physical-device, assistive/physical-keyboard,
non-Chromium, native-touch, push-provider or Home Assistant behavior from
jsdom/Chromium/loopback checks. Do not deploy an unverified tree.
