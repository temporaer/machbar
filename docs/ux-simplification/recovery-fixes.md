# Deferred recovery fixes

This implements first-pass findings S01, S03 and S04 after the everyday-flow
changes in #252. The original audit remains unchanged. S02 revisit-clock policy
is excluded; #253 and #254 are separate, subsequent stacked fixes.

## Observable contract

| Finding | Required outcome | Counterexamples |
| --- | --- | --- |
| S01 Week ownership | Fresh reads own membership and derived fields; one failed write cannot roll back another item or a newer revision. | Different-task overlap, remote edit plus stale failure, pre-acknowledgement reads arriving before/after write acceptance, disappearance and role conversion. |
| S01 query lifetime | Old callbacks cannot repopulate a different member/scope/window or a later A-to-B-to-A opening. | Delayed failure/success after navigation, same selection reached again, cancelled or stale drag. |
| S01 continued editing | A pending move blocks a second preview; an accepted move remains editable through failed refresh. | Accepted placement differs from stale base; second failed move preserves the first accepted placement; new pending moves survive another confirmation's qualifying read; acknowledgements qualify independently. |
| S03 focused recovery | ID-only commands have named loading/error/retry/close; usable editors retain drafts and decisions. | Initial versus background failure, delayed retry, completion with metadata but no task tree, withdrawal awaiting real detail. |
| S03 opening/focus | Old callbacks cannot close a new same-target opening; only foreground sheets own focus. | Reopen before React renders, loading-to-editor handoff, absent/disabled opener, nested sheet, later opening versus queued restoration, disappearing retry control. |
| S04 read recovery | Named failures stay visible through retry, without hiding populated or empty views. | Same-query delayed retries, query switches, All's independent tags/tasks/projects, Review's independent issue/project/task lookups. |
| Shared boundary | Read retry performs only the failed query's GET; it never saves drafts, acknowledges Review, or changes dates/history. | Retained filters and drafts, unchanged serialized revisions/planning fields, no mutation calls on recovery. |
| Confirmed input | Actual canonical server receipts survive failed saves and visual release without certifying optimistic input. | Non-retaining follow-up after a Week move, no prior Week move, stale in-flight read, changed wait description, failed next move, expired visual hold. |
| Receipt lifetime | Identity/target ownership prevents stale or inaccessible snapshots from becoming fallback input. | A-to-B-to-A late success/failure, authentication host remount, nested inspection/queue expiry, old methods/lease disposal, StrictMode replay, target GET 401/403/404 versus network/503, write denial versus source read loss, real project detail versus metadata, authoritative child membership/revisions. |

## Implementation

- Week replaces copied agendas and whole-snapshot rollback with narrow,
  selection-lifetime/task/operation-qualified date intents. Higher revisions and
  successful-read membership win. Fetcher-start acknowledgement provenance
  releases confirmed feedback only after a successful post-acknowledgement read.
  Drag placement uses the displayed card, while mutation input and identity use
  authoritative/canonical data. Existing actions remain the only mutation path.
- `useAsync` retains same-query errors during retries. `ReadErrorState` is a
  presentation wrapper over `ErrorState`, with named copy and the resource's own
  retry. Today, Inbox, Waiting, Projects, All, Review, Discussion and Week reuse
  it; independent resource failures do not hide unrelated results.
- Existing workflow hosts own recovery and pass optional status/opener/suspension
  through existing sheets. Usable editors remain mounted. Project completion and
  commitment withdrawal require real detail instead of an invented empty tree.
  Existing workflow contexts synchronously own opening identity and guarded
  callbacks. `BottomSheet` retains isolation and eligible foreground focus,
  including when retry feedback disappears.

No new API, dependency, persistence model, fetching layer, settings or product
workflow is introduced. German/English copy and architecture documentation are
updated; existing dates, lifecycle decisions and mutation semantics are retained.

## Regression evidence

The new host cases rejected invisible recovery on the faulty source. Corrected
pending/accepted late-read cases both reject an equivalent mutation that clears
local date intents on every successful read; that temporary mutation was
restored. Same-target provider tests rejected stale unguarded closes.

Additional omission cases assert absence before settlement and successful read
re-inclusion. Pending and confirmed higher-revision **date** cases both reject
removing revision precedence; their later successful reread is deliberately
held to avoid false proof through early reconciliation. The two-item/new-pending
sequence rejects applying one acknowledgement threshold to all confirmations.

Implementation testing also found and reproduced two introduced hazards:
confirmed placement accidentally acting as a drag lock, and removal of focused
retry status leaving focus outside the dialog. Their focused regressions reject
the faulty implementations and are retained.

Three older Week fixtures now return actual serialized revisit fields, revisions
and task titles and update their subsequent authoritative read. These are
verification corrections, not new product semantics. An earlier late-read
fixture failure during unknown-member setup is not counted as regression proof.

Copilot review expanded the accepted-move sequence: a failed later move clears
shared value retention, and external-wait actions deliberately do not retain
values. Both sequences initially reused revision 1 instead of the accepted
revision 2. Two new regressions reject that source before the fix. Confirmed
commands retain the accepted task receipt for subsequent canonical command
input, preferring higher authoritative revisions without replacing read-owned
membership or derived display fields. The real browser case also executes a
successful third move after the failed second move while refreshes still fail.

Re-review added an intervening successful Planning save, both with and without
a previous Week move and for ordinary/waiting tasks. All four cases rejected the
first receipt fix. Confirmed baselines now live in the existing operation ledger,
not the disposable field intent; canonical projections are observed before a new
move starts. A pre-observation read returning after the failed move must not
release the newer baseline. All four expanded cases also reject a temporary
mutation that removes that observation stamp; the mutation was restored.

Third review identified three previously missed gaps. Both retained-only
failed-Save regressions rejected the published source by losing the editor and
save error. Two actual `followUpExternalWait` cases rejected it with stale
revisions, with and without an earlier Week move. They also check that the
updated waiting description feeds later commands. The real Shell focus
regression failed on desktop/mobile Chromium when the last sheet's opener was
disabled; the production main now supplies the existing fallback target.

Canonical confirmed inputs now belong to the existing shared mutation
primitive, not another Week-only cache or a host draft snapshot. Visual
release, failure and expiry leave command inputs intact. Successful raw target
reads may upgrade them; presentation/hierarchy observers do not certify
pending values. Focused host regressions cover failed Save followed by read
recovery, optimistic-only failure, effective identity changes, typed access
denials and 503 outages. Project receipts strip task/detail collections.
Primitive cases cover revision precedence, observation before late response,
same-ID pending isolation, old lease disposal, explicit target invalidation
and StrictMode lifetime replay. These are frontend contracts; existing API
external-wait/authorization contracts and the real browser mount remain the
production boundaries, not invented success responses.

Independent review expanded the lifetime boundary. Both real authentication
host-remount cases rejected host-local ownership maps; the existing providers
now reset and guard openings, nested inspections, detail queues and handoffs.
The nested identity case also rejects a temporary mutation preserving the old
inspection stack: it resumed task 1 and private detail queue 7 in the new
identity. The obsolete-method StrictMode case rejects omitting the captured
render token by observing an actual obsolete command dispatch. Both mutations
were restored. Two child cases rejected whole-receipt selection before the pure
task projector preserved authoritative membership and higher child revisions.
Read-only snapshots now expire with the last interaction lease; command-touched
IDs retain one latest input per identity generation for offline consumers.
Weak provenance no longer holds raw project detail strongly. Task/project cases
separate write denial and source GET denial, preserve drafts through unsuccessful
revalidation, and prove read retry does not retry Save. Failed-Save cases now
continue through deliberate successful Save with recovered revision 2. Both
optimistic-only task and project inputs remain uncertified.

The final verifier exposed an introduced sibling-path regression: authoritative
child merging dropped equal-revision descendant lifecycle outcomes from parent
completion/cancellation receipts. The two existing recursive row cases rejected
that projector. Matching children now reuse the existing narrow terminal-outcome
helper rather than replacing membership or unrelated fields. Both existing
cases and the 61-case lifecycle/placement/sequence matrix pass; final full
verification is rerun after this correction.

The subsequent real browser gate caught another introduced production seam:
routes mounted with a provisional stored identity before the initial member
catalog arrived. Scope reset closed task deep links and navigated them to Today;
16 desktop/mobile journeys failed. A pending-catalog unit case rejected that
mount behavior. The existing identity gate now waits only while identity is
unresolved, retaining early rendering for a known server-bound member. All 16
previously failing real-app journeys and 38 focused host/gate/route cases pass.
Final full verification is rerun after this correction as well.

The full-suite browser drag initially failed without sending a PATCH; a read
warning alone was therefore not evidence of an accepted move. Its fixture now
waits for the selected member's successful Week query, stabilizes the read warning
before dragging, uses the card's draggable padding, and asserts the actual
successful date/revision receipt before testing the failed next move. Temporary
native-event tracing was removed. CI also rejected the single-movement drag;
the fixture uses Playwright's documented two target hovers to reliably dispatch
native `dragover`, without synthetic drag events or weakened receipt assertions.
The downloaded CI trace then isolated scrolling between mouse-down and drag
initiation. The fixture starts the native drag before target auto-scrolling and
places its long-title source after the other cards, retaining the crowded layout
instead of hiding the scrolling counterexample.
The user also verified both requested normal
drag starts and persistence after Ctrl+Shift+R; that manual observation does not
establish injected-failure recovery.

## Acceptance and delivery

The architecture analyst, interaction designer and UX auditor supplied bounded
designs. The simplification critic and independent UX regression reviewer
challenged the design and review implementation parity separately. Their
read/search-only profiles do not implement code or perform browser verification;
the coordinating assistant implements and executes checks.

The delivery gate is `bash scripts/verify.sh` followed by `npm run test:e2e`,
using Node 22 and the existing Python test environment. The browser tests mount
the real app, identity/timezone providers and isolated API/assets; transport
failures alone are injected. They cover delayed ID-only recovery, retained
planning drafts/focus, and Today read-only retry with unchanged serialized state.
Week scenarios cover clearing old-query cards/warnings during navigation, a real
persisted drag followed by failed refresh and a failed second drag, and the
desktop/mobile card Open-to-Planning path with Cancel and stacked focus.
Prerequisite inspection preserves the suspended draft and hides its warning
until return. If the original detail also failed its independent read and the
opener no longer exists, closing Planning focuses that foreground detail's
existing retry instead; recovering Planning does not retry another reader.
Final command results and independent acceptance are recorded in the PR.

Browser evidence is desktop/mobile Chromium emulation, not physical-device,
screen-reader, physical-keyboard, non-Chromium or native touch-drag verification.
Unit scenarios establish their stated cases, not exhaustive event-order coverage.
Revisit-clock/DST policy and the two separately requested date-diagnosis fixes
remain outside this recovery layer.
