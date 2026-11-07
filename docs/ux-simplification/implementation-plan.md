# Proposed implementation plan

**Approval boundary:** this is a plan, not an implementation assignment.
Application code, normative architecture and existing product documentation are
unchanged. See [findings](findings.md) and [review decisions](review-decisions.md).

## Observable invariants

Establish these before choosing implementation branches:

1. A list's cards, controls, errors and allowed operations describe the same
   logical selection. Old requests cannot replace a newer selection or accepted
   state. Same-selection optimism remains useful and eventually reconciles.
2. Read failure is visible and recoverable without presenting fabricated empty
   work, discarding usable data, repeating writes or acknowledging anything.
3. Opening, retrying, closing and nesting an editor preserves target identity,
   authored drafts and focus ownership. At most one modal is foreground.
4. Date operations have one agreed visible and persisted meaning. Schedule,
   deadline, reconsideration and wait reason remain distinct. Invalid local time
   cannot silently clear a value.
5. Existing outcomes remain discoverable for touch, standard keyboard, existing
   shortcuts and assistive access. No capability moves behind gestures alone.
6. Atomic properties, authored Save/Cancel and compound domain commands retain
   their existing commit boundaries. Backend authorization, revisions,
   transactions, history, notifications and retry identity remain authoritative.

## Sequence and independent work

| Phase | Bounded work | True prerequisites | Exit |
| --- | --- | --- | --- |
| 0 | Approve slices; reproduce S01-S04; decide S02; inventory S04 resources | None; do not edit behavior before the relevant contract | Reproductions, decisions and proportional matrices |
| 1A | S01 Week state ownership | S01 identity/event-order contract | Sensitive cross-query and same-query sequences |
| 1B | S02 timing repair | Explicit clock/precision/DST decision | Projection, transport and persistence agree |
| 1C | S03 focused-host recovery | Usable-target/modal contract | Read/retry/close plus retained-draft/focus acceptance |
| 1D | S04 caller recovery | Resource/error inventory | Nonblocking resource-specific recovery |
| 2 | S05 wording, S06 scope, S08 Discussion, S07 search | Approval and their own scenarios; not Phase 1 completion in general | Preserved outcomes and browser evidence |
| 3 | S09 status decision; S10 pure duplication | S09 convention resolution; S10 absence/empty contract | Narrow accepted design/refactor only |
| Discovery | D01 capture handoff; deferred controls | Evidence and explicit semantics, not schedule pressure | Adopt, revise or retain no change |

These are not a serial queue. S01 and S02 can have separate contracts, but both
touch Week; implement in isolated branches or coordinate integration rather
than concurrent edits to the same file. S03/S04 share recovery conventions, not
a need for a new abstraction. S05/S06 may touch the same localization files;
integrate deliberately. Small independent copy/access fixes need not wait for
an unrelated medium refactor.

No special fleet or workflow engine is proposed for implementation.

## Slice boundaries and acceptance

### S01: Week query and operation ownership

- Scope: `WeekPage` optimistic agenda, drag state, response/error handling and
  rollback. Preserve `useAsync`, action APIs and backend projection.
- Define identity from all existing query dependencies, including member,
  scope and window. Do not retain old cards across a new identity.
- Define same-identity ordering: an earlier rejected operation cannot restore
  its snapshot over a later accepted edit or authoritative refresh. Avoid
  replacing the entire agenda as a shortcut for one item's rollback.
- Inventory handlers, pending reads, late success, late failure, reset, navigation
  away/back and refresh exits. Keep localization and error ownership accurate.
- Stop if the fix requires a generic optimistic-data framework; prefer the
  narrow existing pattern and action reconciliation.

### S02: One revisit date-change contract

- First record the decision: existing clock preserved or deliberately normalized,
  same-date precision, DST overlap choice and gap rejection.
- Reuse `taskRevisitForLocalDate` if its semantics match that decision in both
  projection and execution. Audit ordinary/waiting/story command callers;
  Week's task-only drag does not define the whole command contract.
- Preserve explicit clearing; reject invalid date-time resolution before
  transport. Do not use a null fallback that means "clear".
- Keep ordinary task update and external-wait actions canonical. No endpoint,
  setting, time chooser, calendar arithmetic or new persistence abstraction.

### S03: Existing hosts own read recovery

- Enumerate absent data, usable retained target, insufficient completion detail,
  background read error, deleted/inaccessible source and suspended draft.
- Absent usable target: existing loading/error/retry/close UI. Retained usable
  editor: keep it mounted and surface background failure non-destructively.
- Retry preserves intent. Close invalidates the opening lifetime, not the
  underlying user's data; a late response must not reopen it.
- Test modal transition focus and stable opener fallback separately from query
  success. Reusing an error component is not proof of correct orchestration.

### S04: Resource-specific refresh recovery

Initial inventory must enumerate every actual `useAsync` result, reload function
and error placement in the affected caller, not only the page name:

| Caller set | Required disposition |
| --- | --- |
| Today, Inbox, Week, Waiting, Projects, All | Present the relevant primary-list `refreshError`; distinguish auxiliary failures if present |
| Review | Enumerate its three queried resources and provide correctly attributed retries; never acknowledge through retry |
| Discussion | Include its ignored list `refreshError` as the identified sibling omission |
| ActivityDigest | Preserve the existing working pattern; do not replace or duplicate it |
| Remaining secondary callers | Inventory when the slice begins; explicitly include/defer each omission, not an app-wide parity claim |

Use the existing serialized invalidation/query mechanism. Keep initial errors,
empty results, mutation failures and background failures distinct. Alerts must
not steal focus or repeatedly announce every revalidation. Recovery must not
repeat writes, clear flags or create acknowledgements.

### S05-S08: Small existing-intent improvements

- **S05:** update actual-effect wording in both locales, including accessible
  names. Captured classification is not organized-task acknowledgement.
  Revisit copy must not imply activation.
- **S06:** show current scope on the existing cycle. Preserve the five callers'
  local query/persistence behavior and Work creation defaults; no global
  provider. A shared control/hook is optional only if it removes concrete
  duplication without changing state ownership. Keep `todayScope` canonical.
- **S07:** apply existing outer search-reveal behavior to backlog. Preserve
  grouping, manual disclosure and interaction retention. Query clearing must
  not unexpectedly remove the focused interaction.
- **S08:** reuse the keyboard navigation mount under Discussion's existing scope
  and reuse Tasks copy. Do not enable structural commands in a compiled view or
  change nomination's independent lifetime.

### S09-S10: Resolve convention, then remove only proven duplication

- **S09:** compare status display/action options against the read-only-display
  preference and the currently reachable badge entry. No silent choice between
  those constraints; no dropdown. Preserve action location, legal transitions,
  rails/header alternatives and accessible expanded state.
- **S10a:** preserve exact revision-array contents/order in a narrow React-free
  serializer used by task and project step sheets.
- **S10b:** reuse prompt construction only after proving absent snapshot, valid
  empty requirements, retained authored decisions and failed refresh remain
  different where necessary. Separate existing recovery defects from extraction.
- Preserve role-specific sheets, preview triggers, conversion/navigation,
  `StepComposer`, backend batch transactions and draft isolation.
- If an architectural primitive changes in a future implementation, update
  `docs/architecture-rules.md`, its registry and `docs/architecture.md` then.
  None changes in this audit.

### Discovery boundaries

**D01:** decide exact capture-to-Intake source fields and repeated-switch meaning
before designing transfer. Preserve literal versus selected syntax, authored
notes, independent AI text, material/scope, cancellation and creation intent.
No continuous synchronization, automatic generation/apply/upload or draft store.

**Keep deferred:** direct Week planners, AI chips, extra scope chips, Move-handle
sheet activation and backend viewer normalization. Their existing supported
routes remain; no deletion or hidden migration is implied.

## Contract-first counterexample matrix

These are required scenarios, **not executed results**. Choose the lowest layer
that observes the invariant, then add browser evidence for actual UI boundaries.
Avoid unrelated Cartesian products.

| Slice / invariant | Counterexamples and entry/error paths | Expected visible/persisted effects | Layer |
| --- | --- | --- | --- |
| S01 query identity | Scope/member/window switch during read/drag/write; Work -> Household; unknown identity; late success/failure; leave/return | No previous-query cards, drag target or error under new controls; original request attribution unchanged | Deferred-promise component sequences; real app/browser |
| S01 event order | Earlier failure after later accepted edit; refresh before/after response; unrelated task edit; pending invalidations | Fresh values/membership win; unique rows; same-query optimism and eventual reconciliation | Sensitive sequence tests; browser convergence |
| S02 date intent | Ordinary/waiting timed revisit; unchanged date with seconds; clear; multiple timezones; DST gap/overlap; story caller | Preview/request/refreshed value follow agreed policy; invalidity rejects before transport; schedule/deadline/wait history unchanged | Pure time tests; real web/API persistence contract; browser drag vs detail |
| S03 read recovery | Rail, shortcut, detail, Review; slow/error/deleted/inaccessible target; retained target; missing completion detail | Visible pending/error/retry/close when needed; no fake data; retained draft remains; reads/retries write nothing | Host tests; serialized read errors; production mount-tree browser |
| S03 modal lifetime | Close before response; reopen same target; planner -> prerequisite -> workflow; opener disappears | No resurrection/draft reset; one foreground modal; stable focus and eventual lease release | Context sequences; desktop/mobile browser focus |
| S04 resource recovery | Initial/background/empty; read plus mutation error; each Review query; retry during pending read | Correct resource retried; retained list readable; no writes/acknowledgement/focus steal; only resolved error clears | Hook/page tests; browser offline and announcement exercise |
| S05 meaning | Queue entry, committed flagged task, captured classification; backlog revisit future/past/clear | Actual-effect DE/EN text; same dates/status/acknowledgement; no confirmation added | Semantic component/localization tests; assistive/wrapping check |
| S06 scope | Five pages; cycle/remount/navigation; unavailable storage; member != actor; empty Work | Accurate current/next semantics; persistence/defaults unchanged; no identity or consent change | Existing scope/caller tests; actual-provider desktop/mobile |
| S07 search | Match/nonmatch/whitespace; grouped/ungrouped; manual toggle; clear during focused/retained interaction | Outer matches revealed; no duplicate rows/new persisted mode; safe focus; normal collapse | Filter/placement/component sequences; browser |
| S08-S09 reachability | Discussion mixed roles/terminal nominees; retention; inputs/modals; badge choices/guards/captured exceptions | Existing touch/Tab/Enter/shortcuts reachable; nomination independent; legal commands retained | Component/command tests; real-app keyboard/touch |
| S10 boundaries | Revision order; missing snapshot vs valid empty; stale/failed refresh; authored decisions; member-specific drafts | Identical serialization; unavailable != ready; draft/decision preservation; rollback-only preview and atomic commit | Pure parity; existing activation transport/persistence/privacy matrix |
| D01 transfer, if adopted | Title/notes/raw/selected syntax; destination/file; repeated switch; AI edits; pending/cancel/retry | Original capture untouched; AI independent; explicit Generate/Apply; no implicit side effects | Decision first, then capture/intake and real retry/browser contracts |

Authorization dimensions are necessary when a slice touches those boundaries,
not an excuse to rewrite them. Preserve owner/other/unknown viewers, household,
Work and durable privacy, differing ancestor owners, and read/preview/final-write/
replay/early-error visibility. Assert rejected writes leave stored state,
activity/outbox and notifications unchanged and hidden response fields absent.

Ordinary creation receipts do not imply batch or reload-persistent replay
guarantees. S03/S04 retries are reads and must remain reads.

## Verification gates for future authorized changes

1. Reproduce each regression before production edits. Demonstrate the test fails
   against faulty code or a small equivalent temporary mutation, then restore.
   A green baseline suite does not establish sensitivity.
2. Start with existing narrow suites. Relevant examples: Week page tests;
   `useAsync` and host/page tests; `todayScope`; Projects/Discussion/detail tests;
   `TaskSplitSheet`, `ProjectTaskEntrySheet`, activation resolution.
3. For serialized dates/decisions or persistence, extend real contracts such as
   `tests/contracts/activation.test.ts`, existing preview-permission matrices
   and `apps/api/tests/task-step-batch.test.ts`. Do not substitute canned
   component responses for the boundary being changed.
4. Run `bash scripts/verify.sh` with Node 22+ and the repository's Python test
   environment. Visible changes additionally require
   `npm run build && npm run test:e2e` for desktop/mobile Chromium.
5. Revisit the original matrix and sibling callers. Supply diff/results to the
   critic and regression reviewer. Only claim implementation acceptance after
   relevant gaps are resolved and the user-approved outcome is verified.

Browser evidence must use the production providers/routing, not just rich
fixtures. Check touch, Tab/Enter/Space, established shortcuts, focus after
placement changes, DE/EN, narrow/enlarged layouts and reduced motion.
Physical soft keyboards, screen readers, non-Chromium browsers, installed-PWA
share behavior, real OIDC/push/HA/Paperless remain separate device/service checks.
Do not present jsdom or Chromium emulation as proof of all those environments.

## Audit verification record

This doc-only audit does not reproduce or repair the source findings.

| Exact command | Result |
| --- | --- |
| `bash scripts/verify.sh` | Failed in the default Node 20 shell: installed `better-sqlite3` used the Node 22 ABI |
| `npm exec --yes --package=node@22 -- bash -c 'node --version && bash scripts/verify.sh'` | Architecture, shared build, typecheck, workspace tests and app builds passed; script then stopped because `python` was not on PATH |
| `PATH=/home/hannes/miniforge3/envs/machbar-pytest/bin:$PATH npm exec --yes --package=node@22 -- bash -c 'node --version && python --version && bash scripts/verify.sh'` | Passed: architecture, shared build, typecheck, workspace tests, app builds and Python tests; Python reported 159 passed and 1 skipped |

The final invocation uses an existing local Python environment and an isolated
Node runtime; it changes no dependency manifests. Its absolute Python path is
machine-specific, not a new contributor requirement.

New Markdown files also passed whitespace and local-link checks. The production
build reported its existing large-chunk advisory; no bundling change is proposed
from that warning alone.

No Playwright/user/device exercise was performed for this source-only audit.
No implementation, migration, package-version bump, commit, push or PR is part
of this assignment.
