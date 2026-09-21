/**
 * Centralized action/reference discriminator guards.
 *
 * A `role="task"` work item is either actionable work (`kind: "action"`) or
 * non-actionable outline material (`kind: "reference"`). Every mutation
 * that assumes actionable semantics — lifecycle transitions, scheduling,
 * reminders, priority/size, recurrence, external waits, dependencies,
 * `additionalNextAction` — must route through one of these helpers instead
 * of re-deriving its own `task.kind` check, so the invariant "references
 * never behave as actionable work" stays enforced in exactly one place.
 */
import type { TaskKind } from "@machbar/shared";
import { AppError } from "../errors.js";

export interface KindAwareTask {
  id: number;
  kind: TaskKind;
}

/** Throws `reference_action_not_allowed` if the task is not an action. Use
 * for lifecycle/mutation operations that only make sense for actionable
 * work (complete, cancel, reopen, schedule, remind, depend on, etc.). */
export function assertActionTask(
  task: KindAwareTask,
  operation: string,
): void {
  if (task.kind !== "action") {
    throw AppError.conflict(
      "reference_action_not_allowed",
      `The '${operation}' operation is not available for reference material.`,
      { taskId: task.id, operation },
    );
  }
}

/** Throws `reference_dependency_not_allowed` if the task is not an action.
 * Dependencies only ever relate actionable work to actionable work. */
export function assertDependencyCapableTask(task: KindAwareTask): void {
  if (task.kind !== "action") {
    throw AppError.conflict(
      "reference_dependency_not_allowed",
      "Reference material cannot participate in dependencies.",
      { taskId: task.id },
    );
  }
}

/** The set of `CreateTaskInput`/`UpdateTaskInput` keys that make sense for
 * a reference. Everything else is action-only metadata. */
export const REFERENCE_ALLOWED_FIELDS = new Set<string>([
  "kind",
  "projectId",
  "parentTaskId",
  "title",
  "notes",
  "scope",
  "ownerInheritanceMode",
  "contextInheritanceMode",
  "createdByMemberId",
  "expectedRevision",
]);

/** Rejects (rather than silently dropping) any task-only field supplied with
 * a defined value for a `kind: "reference"` create/update input. Keys that
 * are simply absent, or explicitly `undefined`, are ignored. */
export function assertReferenceCapableInput(
  input: Record<string, unknown>,
): void {
  const rejected = Object.keys(input).filter(
    (key) => input[key] !== undefined && !REFERENCE_ALLOWED_FIELDS.has(key),
  );
  if (rejected.length > 0) {
    throw AppError.badRequest(
      "reference_field_not_allowed",
      `Reference material does not support: ${rejected.join(", ")}.`,
      { rejectedFields: rejected },
    );
  }
}
