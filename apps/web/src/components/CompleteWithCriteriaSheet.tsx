import type { AcceptanceCriterion, Project, Task } from "@machbar/shared";
import { useStrings } from "../lib/strings";
import { BottomSheet } from "./BottomSheet";
import { AcceptanceCriteriaChecklist } from "./AcceptanceCriteriaChecklist";

/**
 * The focused continuation for project or task completion when acceptance
 * criteria remain unchecked: checking criteria is
 * direct manipulation via the shared `AcceptanceCriteriaChecklist`, not the
 * structural `story.editOutcome` editor. Completing is enabled only once
 * every criterion is checked, and commits the same `story.complete`
 * transition every other entry point uses.
 */
export function CompleteWithCriteriaSheet({
  workItem,
  workItemType,
  onClose,
  onComplete,
}: {
  workItem: Pick<Project | Task, "id" | "title"> & { acceptanceCriteria: AcceptanceCriterion[] };
  workItemType: "project" | "task";
  onClose: () => void;
  onComplete: () => Promise<void>;
}) {
  const strings = useStrings();
  const criteria = workItem.acceptanceCriteria ?? [];
  const allChecked = criteria.every((criterion) => criterion.checked);

  return (
    <BottomSheet
      title={`${workItemType === "project" ? strings.completeWithCriteriaTitle : strings.taskCompleteWithCriteriaTitle}: ${workItem.title}`}
      onClose={onClose}
      labelledBy="complete-with-criteria-title"
    >
      <div className="stack">
        <p className="text-muted">
          {workItemType === "project" ? strings.completeWithCriteriaHint : strings.taskCriteriaCompletionHint}
        </p>
        <AcceptanceCriteriaChecklist ownerType={workItemType} workItemId={workItem.id} criteria={criteria} />
        <button
          type="button"
          className="btn btn-primary btn-block"
          disabled={!allChecked}
          onClick={async () => {
            await onComplete();
            onClose();
          }}
        >
          {workItemType === "project" ? strings.completeProjectAction : strings.completeTaskAction}
        </button>
        <button type="button" className="btn btn-block" onClick={onClose}>
          {strings.close}
        </button>
      </div>
    </BottomSheet>
  );
}
