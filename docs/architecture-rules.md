# Architecture rules

This is Machbar's normative architecture document. It defines stable contributor
rules and canonical implementation paths. For design details and product
internals, see [Architecture](architecture.md).

Read this document before significant behavioral changes. When implementation
and this document disagree, either fix the implementation or deliberately
update this document in the same pull request.

## Search before adding

Before introducing a component, hook, action, mutation helper, API endpoint,
domain command, picker, editor, gesture, or persistence abstraction, search for
the same conceptual operation.

Extend, reuse, or consolidate an existing implementation by default. A parallel
implementation requires a concrete explanation of why the canonical path
cannot express the required semantics.

## Editing contracts

Classify an interaction before implementing it.

### Atomic property

Selection commits immediately. Owner, driver, tags, dates, and other simple
metadata use this contract. Do not add an extra Save step around one selection.

### Authored content

Text a person composes uses explicit Edit, Save, and Cancel. Titles, notes, and
criterion text use this contract. Cancel must not persist a draft.

### Domain command

The command itself commits. Complete, cancel, reopen, activate, archive,
external-wait resolution, and hierarchy movement use this contract. A guard may
collect additional information only when required by domain semantics.

## Mutation architecture

One domain operation has one canonical mutation path.

Different UI contexts may use different presentation, navigation, and
optimistic projections. They must not independently implement the same domain
mutation, revision handling, conflict behavior, or refresh policy.

Presentation components call domain actions or commands. Those actions call API
transport:

```text
pages / components
        |
        v
domain actions / commands
        |
        v
API transport
```

Presentation-only wrappers may differ when they do not duplicate mutation
semantics. Shared optimistic mutations should use `useRetainedMutations` where
its retention and conflict behavior fit.

### Task mutations

`taskMutations.ts` owns pure revision-safe task metadata execution and owner
assignment semantics. `useTaskActions.ts` owns normal task optimistic
projection, lifecycle commands, external-wait commands, and Review
acknowledgement.

Screens needing a distinct optimistic projection may call the pure task
mutation functions, as the optional Review planning tools do. They must not reproduce the raw
`api.updateTask` contract.

### Project mutations

`useProjectActions.ts` owns project metadata updates and lifecycle commands,
including Review acknowledgement, revision handling, optimistic retention, and
confirmed overlays.
Presentation code must not reproduce those raw API calls.

`SharePage` is an explicit exception for its unique conflict-aware share/import
workflow. This exception is not precedent for ordinary project or task editing.

### Task hierarchy

`POST /api/tasks/:id/move` is the sole hierarchy mutation. Reorder, indent,
outdent, reparent, and cross-project movement are destination calculations, not
separate backend commands.

`taskTreeMove.ts` owns pure geometry and tree projection.
`useOutlineOrganize.tsx` owns outline execution and rollback.
`MoveTaskSheet.tsx` owns explicit destination moves. `QuickAdd.tsx` may use the
same move command for post-create project correction.

Adding another direct move caller requires an explicit checker exception and an
explanation of why an existing move surface cannot own the behavior.

### Dependency direction

Pure domain semantics live in React-free modules. A non-hook `.ts` helper under
`apps/web/src/lib` must not import from a `use*.ts` or `use*.tsx` module.
Move shared semantics out of the hook instead.

Presentation may import hooks, their providers, constants, and types. It must
import lower-case domain helpers from React-free modules rather than from hook
modules. Hooks may compose other hooks. Tests may import hooks to exercise
behavior.

## Canonical primitive registry

| Need | Canonical primitive or path |
|------|-----------------------------|
| Retained optimistic mutation | `apps/web/src/lib/useRetainedMutations.ts` |
| Pure task metadata semantics | `apps/web/src/lib/taskMutations.ts` |
| Task metadata and lifecycle actions | `apps/web/src/lib/useTaskActions.ts` |
| External-wait actions | `apps/web/src/lib/useTaskActions.ts` |
| Project next-action selection | `apps/api/src/repo/nextActionRepo.ts` and `Graph` |
| Derived review diagnosis | `apps/api/src/domain/reviewItems.ts` |
| Review decisions | `apps/web/src/lib/useProjectActions.ts` and `apps/web/src/lib/useTaskActions.ts` |
| Exhaustive inventory filtering | `apps/web/src/lib/allInventory.ts` |
| Refinement sizing semantics | `apps/web/src/lib/refinementHelpers.ts` |
| Refinement optimistic projection | `apps/web/src/lib/useRefinementActions.ts` |
| Project metadata and lifecycle actions | `apps/web/src/lib/useProjectActions.ts` |
| Task hierarchy planning | `apps/web/src/lib/taskTreeMove.ts` |
| Task hierarchy execution | `apps/web/src/lib/useOutlineOrganize.tsx` and `api.moveTask` |
| Household member selection | `apps/web/src/components/MemberSelectionSheet.tsx` |
| Single-task composition | `apps/web/src/components/InlineTaskComposer.tsx` |
| Acceptance criteria editing | `apps/web/src/components/AcceptanceCriteriaEditor.tsx` |
| Destination selection | `apps/web/src/components/DestinationPicker.tsx` |
| Horizontal row swipe | `apps/web/src/lib/useHorizontalSwipe.ts` |
| Paperless document access | `apps/api/src/integrations/paperless/` and `apps/api/src/routes/paperless.ts` |
| Markdown attachment references and projections | `apps/web/src/lib/paperlessAttachments.ts`, `apps/web/src/components/MarkdownAttachmentSheet.tsx`, and `apps/web/src/components/MarkdownEditor.tsx` |
| Memory-bounded photo cropping | `apps/web/src/components/ImageCropSheet.tsx` |
| Incoming file-share staging | `apps/web/public/sw.js` and `apps/web/src/lib/pendingShareTarget.ts` |

Before introducing another primitive for one of these needs, update this table
and explain why the existing primitive is insufficient.

## Deletion and deprecation

A feature or refactor is not complete once its new behavior works. Inspect
adjacent implementations and delete or consolidate paths, wrappers, exports,
tests, and documentation made redundant.

Prefer deleting obsolete internal APIs. The frontend and backend ship together,
so internal compatibility does not automatically outweigh simplification.

If an old API must temporarily remain, mark it `@deprecated`, name its canonical
replacement, and add a narrow architecture-check exception for existing callers.
Do not add new callers.

## Abstraction threshold

Do not introduce generic form engines, command buses, workflow engines,
repository layers, giant configurable sheet components, or a framework solely
for architecture enforcement.

A new abstraction should normally have at least two concrete consumers and make
both simpler. Prefer obvious names that future contributors will search for,
such as task actions, project actions, task move, external wait, member
selection, horizontal swipe, and task composer.

## Tests

Prefer tests of user-visible behavior, domain invariants, concurrency behavior,
and useful architecture contracts.

Do not freeze today's internal call graph when a behavioral assertion protects
the contract. For example, test that owner assignment has identical semantics
from normal task UI and Review planning tools, not that a component invokes one named hook.

The architecture checker itself uses structural tests for rules that are
intentionally about source boundaries.

## Documentation and review

`docs/architecture-rules.md` is normative. `docs/architecture.md` is the
descriptive deep reference. Any pull request that adds, replaces, renames, or
removes an architectural primitive must update both relevant documentation and
the registry in the same change.

Run `npm run architecture` before typecheck, tests, and build. The checker
protects selected mechanical boundaries; the pull request template makes
semantic reuse, deletion, endpoint need, and documentation decisions visible.
