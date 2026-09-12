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

### Focused workflows

One intent has one semantic command, and one semantic command has one focused
workflow. A rail, keyboard shortcut, Review repair, post-capture rail, and a
clicked value in a detail view are five ways to dispatch the same command, not
five places to decide what that command does.

Surfaces dispatch; they do not choose sheets. Only `TaskWorkflowHost` and
`ProjectWorkflowHost` import a focused workflow sheet, and only
`useWorkItemCommands()` may call `taskWorkflow.open`, `projectWorkflow.open`,
or `taskDetail.open`. State-sensitive resolution belongs there too: whether
`task.waitingLifecycle` means "start waiting" or "follow up", and whether
`story.complete` must first show unmet acceptance criteria, is decided once.

`task.open` is the only command whose intent *is* opening task details. No
other command may open the detail sheet to focus a field; the narrow
`InboxPage` clarification queue is the documented exception. Accordingly
`TaskDetailFocusField` covers only what lives *in* the detail — `title`,
`notes`, `attachment`, `dependencies` — and never a scalar property that a
focused workflow owns.

Choosing and applying are separate commands where the choice itself is a
surface: `task.lifecycle` opens the status chooser, `task.setStatus` applies a
chosen status and resolves centrally which lifecycle mutation that requires
(complete, cancel, reopen, clarify, or a direct transition).

Rows keep only genuinely row-specific behavior: gesture mechanics, folding,
drag/outline manipulation, optimistic row presentation, and rail visibility.

`canonical-workflow-host` and `canonical-workflow-routing` in
`scripts/check-architecture.mjs` enforce this. Its exception map is empty:
no surface outside the two hosts renders a focused workflow. Never add to it.

## Canonical primitive registry

| Need | Canonical primitive or path |
|------|-----------------------------|
| Retained optimistic mutation | `apps/web/src/lib/useRetainedMutations.ts` |
| Pure task metadata semantics | `apps/web/src/lib/taskMutations.ts` |
| Task metadata and lifecycle actions | `apps/web/src/lib/useTaskActions.ts` |
| External-wait actions | `apps/web/src/lib/useTaskActions.ts` |
| Physical-context actions | `apps/web/src/lib/useTaskActions.ts` and `apps/web/src/lib/useProjectActions.ts` |
| Physical-context availability | `apps/api/src/integrations/homeAssistant.ts`, consumed through agenda/waiting projections |
| Home Assistant machine authentication | `apps/api/src/auth/routes.ts` route policy |
| Project next-action selection | `apps/api/src/repo/nextActionRepo.ts` and `Graph.selectedNextActionsFor()` |
| Derived review diagnosis | `apps/api/src/domain/reviewItems.ts` |
| Review decisions | `apps/web/src/lib/useProjectActions.ts` and `apps/web/src/lib/useTaskActions.ts` |
| Agenda eligibility and available work selection | `apps/api/src/domain/agendaSelection.ts` |
| Week planning projection | `apps/api/src/domain/weekAgenda.ts`, `/api/agenda/week`, and `apps/web/src/pages/WeekPage.tsx` |
| Exhaustive inventory filtering | `apps/web/src/lib/allInventory.ts` |
| Refinement sizing semantics | `apps/web/src/lib/refinementHelpers.ts` |
| Refinement optimistic projection | `apps/web/src/lib/useRefinementActions.ts` |
| Project metadata and lifecycle actions | `apps/web/src/lib/useProjectActions.ts` |
| Task hierarchy planning | `apps/web/src/lib/taskTreeMove.ts` |
| Task hierarchy execution | `apps/web/src/lib/useOutlineOrganize.tsx` and `api.moveTask` |
| Task owner selection | `apps/web/src/components/TaskOwnerSheet.tsx` and `apps/web/src/components/TaskOwnerChoiceGroup.tsx` |
| Household member selection | `apps/web/src/components/MemberSelectionSheet.tsx` |
| Single-task composition | `apps/web/src/components/InlineTaskComposer.tsx` |
| Acceptance criteria direct check/uncheck | `apps/web/src/lib/useCriterionCheck.ts` |
| Acceptance criteria structural editing | `apps/web/src/components/AcceptanceCriteriaEditor.tsx` via `story.editOutcome` |
| Completion-with-open-criteria continuation | `apps/web/src/components/CompleteWithCriteriaSheet.tsx`, opened as the `completeWithCriteria` workflow |
| Completion-with-open-tasks continuation | `apps/web/src/components/CompleteWithOpenTasksSheet.tsx`, opened as the `completeWithOpenTasks` workflow |
| Project list classification/sort presentation | `apps/web/src/lib/projectListFilter.ts` (`ProjectListClassification`, including the non-stuck `active-review` bucket for `completion_review`) |
| Detail action projection | `apps/web/src/components/ActionTileGrid.tsx` |
| Destination selection | `apps/web/src/components/DestinationPicker.tsx` |
| Horizontal row swipe | `apps/web/src/lib/useHorizontalSwipe.ts` |
| Paperless document access | `apps/api/src/integrations/paperless/` and `apps/api/src/routes/paperless.ts` |
| Markdown attachment references and projections | `apps/web/src/lib/paperlessAttachments.ts`, `apps/web/src/components/MarkdownAttachmentSheet.tsx`, and `apps/web/src/components/MarkdownEditor.tsx` |
| Memory-bounded photo cropping | `apps/web/src/components/ImageCropSheet.tsx` |
| Memory-bounded camera capture | `apps/web/src/components/CameraCaptureSheet.tsx` |
| Incoming file-share staging | `apps/web/public/sw.js` and `apps/web/src/lib/pendingShareTarget.ts` |
| Single-task capture and short syntax parsing/resolution | `apps/web/src/components/CaptureForm.tsx` and `apps/web/src/lib/captureSyntax.ts` (the shared editor creates tasks only; syntax is applied only there) |
| Task/story storage and hierarchy | `apps/api/src/db/schema.ts` (`workItems`) plus `apps/api/src/repo/treeRepo.ts` recursive CTEs |
| Task/story read projection (shared lifecycle vocabulary) | `apps/api/src/domain/workItem.ts` and `apps/api/src/domain/graph.ts` |
| Identity-preserving role conversion | `apps/api/src/domain/roleConversion.ts` (`convertTaskToStory` / `convertStoryToTask`) |
| Semantic user-intent commands (mouse/touch/keyboard dispatch a common vocabulary) | `apps/web/src/lib/commands.ts` and `apps/web/src/lib/useWorkItemCommands.ts` |
| Configurable work-item command rails and pure overflow | `apps/web/src/lib/railConfig.ts`, `apps/web/src/lib/railConfigContext.tsx`, and `apps/web/src/components/WorkItemCommandRail.tsx` |
| Logical active WorkItem, structural capability, and collapse state per navigable surface | `apps/web/src/lib/interactionScope.tsx` |
| Command descriptors, keyboard help, and prefix hints | `apps/web/src/lib/commandRegistry.ts`, `apps/web/src/components/CommandHelpSheet.tsx`, and `apps/web/src/lib/useGlobalNavigationKeys.ts` |
| Keyboard navigation (`j/k/h/l`, `Alt+arrows`, `g`-prefix, `?`, `c`, focused task keys) | `apps/web/src/lib/useWorkItemKeyboardNav.ts` and `apps/web/src/lib/useGlobalNavigationKeys.ts` |
| WorkItem detail disclosure chrome | `apps/web/src/components/WorkItemDetailSection.tsx` |
| Focused task workflows (one sheet per `task.*` command) | `apps/web/src/components/TaskWorkflowHost.tsx` and `apps/web/src/lib/taskWorkflowContext.tsx` |
| Explicit task reminders (multiple absolute/deadline-relative reminders per task) | `apps/api/src/db/schema.ts` (`taskReminders`), `apps/api/src/domain/taskCrud.ts`, `apps/api/src/notifications/outbox.ts`, and `apps/web/src/components/TaskRemindersSheet.tsx` reached via the `task.reminders` command |
| Focused project workflows (one sheet per `story.*` command) | `apps/web/src/components/ProjectWorkflowHost.tsx` and `apps/web/src/lib/projectWorkflowContext.tsx` |
| Project lifecycle prerequisites (missing driver, unmet criteria, no progress path) | `lifecyclePrerequisite()` in `apps/web/src/lib/projectWorkflow.ts`, resolved by `useWorkItemCommands()` |
| Legal project transition to `story.*` command | `storyWorkflowCommand()` in `apps/web/src/lib/commands.ts` |
| Authored project title/notes editing | `apps/web/src/pages/ProjectDetailPage.tsx` |
| Compiled-view (Today) compact descendant presentation and terminal-descendant hiding | `apps/web/src/components/TaskOutline.tsx` (`compactDescendants` prop) and `apps/web/src/components/TaskRow.tsx` |
| Focused waiting/follow-up workflow | `apps/web/src/components/WaitingFollowUpSheet.tsx` and `apps/web/src/lib/useTaskActions.ts` |
| Task/Project scalar-property pill (set and unset states) | `apps/web/src/components/DetailPropertyPill.tsx` |
| Task/Project inline work-item error presentation | `apps/web/src/components/WorkItemInlineError.tsx` |
| In-app single-choice delete confirmation | `apps/web/src/components/ConfirmDeleteSheet.tsx` (project deletion's task-cascade choice remains `apps/web/src/components/ProjectDeleteChoiceSheet.tsx`) |

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
