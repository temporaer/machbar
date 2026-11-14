# Coding agents

Read [`docs/architecture-rules.md`](docs/architecture-rules.md) before making
behavioral changes.

## UX simplification team

### Mission and scope

The five specialized agents in `.github/agents/` have one exclusive mission:
**simplify and streamline Machbar without adding features, preserving existing
capabilities by default**. Only explicitly approved product-contract reductions
may depart from capability preservation, as scoped below. This charter governs
all five roles' preservation and parity requirements; the repository-wide coding
and verification rules below remain in force.

Simplification means less effort, fewer unnecessary decisions, clearer existing
actions, and less implementation duplication. Fewer controls or lines of code
alone are not evidence of improvement. Reorganizing existing controls or removing
duplicate entry points must keep the outcomes required by the approved contract
discoverable and accessible to their existing users.

### Explicitly approved capability trade-offs

Without explicit user/product-owner approval, preserve all supported capabilities,
interaction modalities, and user outcomes. A request to refactor, clean up, or
simplify alone is not permission to remove functionality.

The user/product owner may explicitly approve removing or narrowing specific
lower-value capabilities for a documented, material UX or maintenance benefit.
Before implementation, record in the issue, PR, or handoff:

- The approval source (link or exact user instruction) and its bounded scope.
- The capability being given up, before/after behavior, and how users accomplish
  the remaining core intent.
- Expected complexity savings, trade-offs, newly defined behavioral invariants,
  and tests to add, update, or retire for the revised contract.

That approval changes the product contract only within its stated scope; all
other capabilities retain full preservation requirements. Do not retain obsolete
behavior behind compatibility layers or recreate equivalent hidden complexity.
Review against the approved revised contract, not automatic parity with removed
behavior. Reuse traceable approval without asking the user to reapprove the same
trade-off; seek approval only for additional or unclear scope. Approval never
waives the unconditional safeguards below.

### Roles and boundaries

| Agent | Mandate | Required contribution |
| --- | --- | --- |
| `ux-auditor` | Identify friction and inconsistencies in existing workflows. | Reproducible current journey, evidence, capability inventory, prioritized friction findings. |
| `interaction-designer` | Improve consistency, discoverability, and interaction patterns. | Before/after journey using existing capabilities and canonical interaction primitives. |
| `simplification-critic` | Aggressively challenge unnecessary UI complexity and redundant interactions. | Smallest viable alternative, complexity budget, capability-loss and hidden-effort objections. |
| `architecture-analyst` | Simplify frontend architecture and supporting backend logic. | Current canonical path, concrete consolidation opportunities, callers and contracts affected. |
| `ux-regression-reviewer` | Evaluate proposals and subsequent changes for regressions and unintended complexity. | Independent review against the approved contract (full capability parity by default), counterexample matrix, blockers and evidence gaps. |

All five profiles allow only `read` and `search`. They cannot edit files, execute
commands, mutate browser/application state, publish GitHub changes, or spawn
agents. They return findings and proposals in the conversation, not new planning
files. Tool allowlists restrict access, not every possible side effect; the
read-only mandate also applies to any unexpected tool availability.

A user or coordinating assistant assigns bounded work and supplies handoffs,
diffs, screenshots, or test results when needed. Missing runtime access must be
reported as an evidence gap, never replaced by claims of browser verification.
The team does not automatically run or authorize implementation.

### Non-negotiable constraints

- Read this file, `docs/architecture-rules.md`, `docs/workflow.md`, and relevant
  sections of `docs/architecture.md` before making recommendations.
- Preserve every existing supported user outcome, legal lifecycle transition,
  input modality, access boundary, integration contract, and data/history
  guarantee unless specifically covered by an explicitly approved capability
  trade-off above. Inventory impacted capabilities before proposing fewer surfaces.
- Authorization, privacy, data integrity, accessibility, canonical state/mutation
  ownership, correct persistence/conflict handling, and no silent data loss are
  unconditional. `docs/architecture-rules.md` remains normative. Draft exit
  behavior must be explicit and safe: offer Save/Discard/Stay where applicable;
  failed saves must not silently discard drafts or proceed as though saved.
- No new product features, required setup, settings, dependencies, automation,
  domain concepts, or generic frameworks disguised as simplification.
- Preserve mobile/touch, keyboard and assistive access, focus restoration,
  reduced motion, German/English copy, and existing PWA/proxy routing contracts.
  Do not hide a capability behind gestures or shortcuts alone.
- Preserve editing contracts: atomic properties commit on selection, authored
  text has Edit/Save/Cancel, and compound domain commands commit atomically.
  Do not remove semantic confirmation, privacy checks, or activation decisions
  just to reduce click counts.
- Reuse canonical commands, workflow hosts, pickers, editors and mutation paths.
  Backend authority for derived workflow facts, revision checks, transactions,
  retry identity, invalidation and retention must not move into presentation.
- Simplify supporting backend logic only when directly justified by the existing
  UX or duplication being addressed. No unrelated redesign or schema cleanup.
- Distinguish observed defects, inferred risks, and preferences. Cite repository
  paths/lines or supplied runtime evidence; do not invent user research or metrics.

### Collaboration process

1. **Scope and baseline:** The coordinator selects one existing workflow and
   constraints. `ux-auditor` inventories its capabilities, entry/exit paths,
   friction, and baseline steps/decisions. Relevant alternate paths stay in scope.
   Record any existing explicit approval and the before/after contract above;
   separate approved reductions from capabilities that must remain unchanged.
2. **Parallel proposals:** `interaction-designer` and `architecture-analyst`
   receive the same baseline and independently propose the smallest changes.
   They identify reusable primitives, expected gains, and affected contracts.
3. **Adversarial simplification:** `simplification-critic` challenges both
   proposals, including a no-change option. Every additional control, disclosure,
   state, abstraction, or hidden step needs a concrete justification.
4. **Independent regression review:** `ux-regression-reviewer` compares the
   reconciled proposal with the approved contract (full parity by default) and
   defines risk-relevant scenarios and changed test coverage before implementation.
   Approved removals alone are not regressions. Open blockers and unapproved
   capability disagreements return to the coordinator; agreement by majority is
   not a substitute for evidence.
5. **Approval and implementation:** The coordinator presents the smallest
   plan consistent with that contract and unresolved uncertainty to the user.
   Reuse existing explicit trade-off approval; request approval for any new or
   unclear reduction rather than reopening settled decisions. Only an
   explicitly approved implementation assignment may change application code,
   using a separately authorized coding agent or assistant, not these profiles.
6. **Acceptance review:** After authorized implementation and verification, the
   coordinator supplies the diff and results to `ux-regression-reviewer` and
   `simplification-critic`. They revisit the capability matrix as revised by
   explicit approval and the complexity budget, separating approved removals,
   pre-existing defects, and introduced regressions.

Use the minimum relevant agents for a bounded assignment; independent proposal
work may run in parallel, but critique and regression review need their inputs.
Profiles alone do not create a scheduler, fleet, or automatic multi-agent loop.

Every handoff includes the workflow and finding IDs, evidence, current capabilities,
before/after steps and decisions, proposed canonical path, affected callers,
tradeoffs and their approval sources, counterexamples, and unresolved questions.
Label counts as measured or estimated. Return `accept`, `revise`, or `blocked`
with reasons; an advisory acceptance is not permission to implement.

### Acceptance criteria

A simplification proposal or implementation is acceptable only when:

- Each affected existing capability maps to a reachable after-state and a
  validation scenario, including alternate entry points and relevant lifecycle
  states, or to a specifically approved removal/narrowing with traceable scope,
  before/after behavior, remaining core intent, and material benefit. No feature
  additions or unapproved capability losses are bundled into the work.
- Evidence shows reduced effort, inconsistency, or maintenance duplication
  without shifting equal or greater complexity into hidden navigation, memory,
  error recovery, accessibility, or backend/client coordination.
- Controls and interaction contracts remain consistent and discoverable;
  cancellation, draft retention/exit, pending/error feedback, stale recovery, and
  relevant save/refresh/interaction orderings satisfy the approved contract and
  unconditional safeguards.
- Canonical architecture is preserved. Any consolidation identifies redundant
  implementations to remove and all affected callers; changed architectural
  primitives require the registry and architecture documentation updates.
- The critic and regression reviewer have no unresolved unapproved capability-loss
  or correctness blockers. Tests cover the revised invariants and remaining
  capabilities; obsolete expectations are updated or retired only within the
  approved scope, not retained as compatibility requirements. Remaining evidence
  gaps are explicit; unobserved browser/device behavior is not reported as verified.
- An implementation has contract-first evidence and passes the verification
  requirements below, including desktop/mobile browser checks for visible
  changes. The user has approved the implementation scope.

For the initial team-configuration assignment, acceptance means five valid
profiles with explicit tool allowlists and role-specific criteria, this charter,
preserved existing guidance, and no application-code changes. It does not imply
that any UX proposal has been audited, implemented, or browser-verified.

## Search before adding

Before adding a component, hook, action, mutation helper, API endpoint, domain
command, picker, editor, gesture, or persistence abstraction, search for the
same conceptual operation. Extend, reuse, or consolidate the existing
implementation by default. A parallel path needs a concrete reason the
canonical path cannot express the required semantics.

## Preserve the architecture

- One domain operation has one canonical mutation path. UI contexts may differ
  in presentation, navigation, and optimistic projection, not domain semantics.
- Keep pure domain helpers outside React hooks. Presentation depends on actions;
  actions depend on API transport.
- A refactor is not complete when the new path works. Delete or consolidate
  adjacent implementations, wrappers, exports, and docs made redundant.
- Do not preserve internal compatibility paths without a current caller or
  deployment need.
- Avoid speculative form engines, command buses, workflow engines, repository
  layers, giant configurable sheets, and abstractions with one real consumer.
  A shared abstraction should normally simplify at least two concrete callers.
- If a PR adds, replaces, renames, or removes an architectural primitive,
  update the canonical registry and architecture documentation in the same PR.

Prefer behavioral, invariant, and concurrency tests over tests that freeze an
internal call graph. Run `npm run architecture` before the normal typecheck,
tests, and build.

## Design verification before implementation

For behavioral changes, establish the verification contract before editing
production code. Keep it proportional: a short working note or the PR validation
section is enough; no separate plan document is required.

- State observable invariants from the product rules and canonical operation,
  independently of the proposed implementation. Describe what must remain true
  for the user, stored state, visibility and side effects.
- Map the relevant entry/exit paths and counterexamples first. Include early
  validation/stale errors, read/preview/commit/replay paths, and affected callers
  or representations. A guard on the normal write path does not protect another
  error builder or read projection automatically.
- Choose risk-relevant combinations using the scenario guide in
  [`docs/loop-engineering.md`](docs/loop-engineering.md#contract-first-verification).
  Test alternate event/retry orders and logical identities, not only the order
  or data shape used by the implementation. Avoid unrelated Cartesian products.
- For regressions and high-risk behavior, add the counterexample before the fix
  and demonstrate its failure against the faulty code. For new behavior, use
  explicit positive/negative invariants. Restore any temporary mutations before
  running final checks. Do not weaken expectations to make the chosen design pass.
- Use the lowest layer that can observe the invariant, with real persistence or
  serialized API/error contracts where the boundary matters. Audit what mocks
  and test wrappers supply that the production caller must supply itself;
  provider-rich component fixtures cannot validate the real app mount tree.
- After implementation, compare the tests with the approved contract (including
  explicitly authorized revisions, if any) and inspect sibling callers/early
  returns for the same failure class. On review feedback,
  add the missing dimension to the relevant matrix rather than patching only the
  reported line. Record relevant remaining gaps explicitly.
- Report evidence at its actual scope: one reproduced regression passing proves
  that scenario. A green suite/test count or a coverage percentage does not prove
  that the whole failure class is covered. Distinguish pre-existing application
  defects from defects introduced by the proposed fix and from test-only changes.

## Running the loop

This repository is set up for an autonomous verify-until-green agent loop.

- Verify everything with a single command: `bash scripts/verify.sh`. It runs the
  Node checks (`npm run verify`: architecture, shared build, typecheck, tests,
  build) followed by `python -m pytest`. No external server is needed; cross-runtime tests start their own isolated API.
- Dependencies are installed once by `scripts/codex-setup.sh` during the
  network-enabled setup phase; the loop itself runs offline.
- Network/loopback tests are skipped under `CODEX_SANDBOX_NETWORK_DISABLED` and
  are covered by CI instead; do not try to make them pass in the sandbox.
- Definition of Done: all of `scripts/verify.sh` passes AND a PR is open.
- Before calling a behavioral change verified, identify the failure class and
  cover it at the lowest suitable level. Extend the existing authorization,
  transport-contract or event-sequence matrix when the changed behavior fits
  one. Do not substitute a happy-path mock for a server contract test.
- For a regression, demonstrate that the test rejects the old bug (on the
  faulty revision or with a small, temporary equivalent mutation), then restore
  the production code and verify green. Record the evidence in the PR. For new
  behavior without a faulty revision, state the invariant and negative case.
- Changes to work-item preview routes require owner/other/unknown viewer cases,
  the relevant household/work/durable-private scopes, and no-write/no-notify
  assertions. New error shapes must reach the real web client/decision adapter.
- Changes to retention or reconciliation require relevant save/refresh/interaction
  orderings, uniqueness, authoritative values/membership and eventual release.
  Keep browser-only visibility/focus checks separate; API/jsdom success is not
  evidence of CSS layout or a physical keyboard working.
- Browser-visible changes also require `npm run build && npm run test:e2e`
  (desktop/mobile Chromium). Do not rely solely on provider-rich component test
  wrappers to prove the real app mount tree works. The browser CI job runs in
  parallel and saves failure traces.
- Always run the verifier before finishing. Do not declare work complete on an
  unverified or red tree.
- Iteration cap: if the verifier is still failing after a few focused attempts
  (about three), stop and ask a human rather than continuing to loop.
- When review comments arrive, address them, re-run `bash scripts/verify.sh`,
  and only then re-request review.

The review-to-fix loop is handled off the shelf rather than by a repo-owned
workflow; see [`docs/loop-engineering.md`](docs/loop-engineering.md) for the
recommended options (Codex cloud auto-review plus `@codex fix it`, this app's
Agent merge, or a GitHub App such as CodeRabbit or Qodo Merge).

### Review rules

For the Codex PR reviewer:

- Enforce [`docs/architecture-rules.md`](docs/architecture-rules.md).
- Flag parallel or duplicate mutation paths for the same domain operation.
- Flag speculative abstractions with only a single real consumer.
- Prefer behavioral and invariant tests over tests that freeze an internal
  call graph.
- Challenge the scenario selection as well as the code. Compare tests with the
  stated invariants, look for omitted entry/error paths and identity/order/lifecycle
  combinations, and flag fixtures that supply production prerequisites silently.
