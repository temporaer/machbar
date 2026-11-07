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
