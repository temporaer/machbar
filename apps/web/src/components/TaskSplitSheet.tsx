import { useState } from "react";
import type { Task } from "@machbar/shared";
import { api, type CreateTaskStepBatchInput } from "../lib/api";
import { localizedErrorMessage } from "../lib/errorMessage";
import { InteractionScopeProvider } from "../lib/interactionScope";
import { useRefresh } from "../lib/refresh";
import { useStrings } from "../lib/strings";
import { sortByPosition } from "../lib/taskHelpers";
import { BottomSheet } from "./BottomSheet";
import { TaskOutline } from "./TaskOutline";
import { discardStepDraft, StepComposer, type StepDraft } from "./StepComposer";
import { useNavigate } from "react-router-dom";
import { useIdentity } from "../lib/identity";
import { useTaskDetail } from "../lib/taskDetailContext";

/** The shared task-step workflow combines the existing outline organizer with
 * one atomic, revision-checked batch creation. */
export function discardTaskSplitDraft(taskId: number, memberId: number | null) {
  discardStepDraft(`task-${taskId}-member-${memberId ?? "shared"}`);
}

export function TaskSplitSheet({
  parentId,
  parentTitle,
  parentRevision,
  parentStatus = "actionable",
  existingChildren = [],
  onClose,
  onFailure,
  isCurrent = () => true,
}: {
  parentId: number;
  parentTitle?: string;
  parentRevision?: number;
  parentStatus?: Task["status"];
  projectId?: number | null;
  existingChildren?: Task[];
  onClose: () => void;
  onFailure?: (cause: unknown) => void;
  isCurrent?: () => boolean;
}) {
  const strings = useStrings();
  const navigate = useNavigate();
  const detail = useTaskDetail();
  const { currentMemberId } = useIdentity();
  const { bump } = useRefresh();
  const [draftSteps, setDraftSteps] = useState<StepDraft[]>([]);
  const [convertParent, setConvertParent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [currentParentRevision, setCurrentParentRevision] = useState(parentRevision);
  const [currentParentStatus, setCurrentParentStatus] = useState(parentStatus);
  const [snapshotError, setSnapshotError] = useState<string | null>(null);

  const refreshSnapshots = async () => {
    if (parentId > 0) {
      const task = await api.getTask(parentId);
      setCurrentParentRevision(task.revision);
      setCurrentParentStatus(task.status);
    }
  };

  const submit = async (steps: StepDraft[]) => {
    if (currentParentRevision === undefined) throw new Error(strings.stepParentRevisionMissing);
    const input: CreateTaskStepBatchInput = {
      steps,
      expectedRevision: currentParentRevision,
      ...(convertParent ? { convertParentToProject: true } : {}),
    };
    try {
      const result = await api.createTaskStepBatchForTask(parentId, input);
      bump();
      if (!isCurrent()) return true;
      if (result.parent) {
        setCurrentParentRevision(result.parent.revision);
        setCurrentParentStatus(result.parent.status);
      }
      if (result.convertedProject) {
        onClose();
        detail.close();
        navigate(`/projects/${result.convertedProject.id}`, { state: { createdProjectId: result.convertedProject.id } });
      }
    } catch (cause) {
      if (!isCurrent()) return false;
      onFailure?.(cause);
      if ((cause as { code?: string })?.code === "stale_write_conflict") {
        try {
          await refreshSnapshots();
        } catch (refreshCause) {
          onFailure?.(refreshCause);
          setSnapshotError(localizedErrorMessage(refreshCause, strings));
        }
      }
      throw cause;
    }
  };


  return (
    <BottomSheet title={strings.splitTask} onClose={() => !busy && onClose()}>
      <div className="stack task-split-outliner">
        {parentTitle ? <p className="text-muted">{parentTitle}</p> : null}
        {existingChildren.length > 0 ? (
          <div className="stack">
            <h3 className="task-split-section-heading">{strings.splitTaskExistingHeading}</h3>
            <InteractionScopeProvider>
              <TaskOutline tasks={sortByPosition(existingChildren)} emptyMessage={strings.noSubtasks} organizable showSwipeHint={false} />
            </InteractionScopeProvider>
          </div>
        ) : null}
        {snapshotError ? <p role="alert" className="task-row-error">{snapshotError}</p> : null}
        {currentParentStatus === "captured" ? (
          <label className="row">
            <input type="checkbox" checked={convertParent} disabled={busy}
              onChange={(event) => setConvertParent(event.target.checked)} />
            <span>{strings.stepTreatAsProject}</span>
          </label>
        ) : null}
        <StepComposer
          key={`task-${parentId}-member-${currentMemberId ?? "shared"}`}
          inputIdPrefix={`task-step-${parentId}`}
          draftKey={`task-${parentId}-member-${currentMemberId ?? "shared"}`}
          label={strings.splitTaskAddHeading}
          placeholder={strings.splitTaskRowPlaceholder}
          submitLabel={strings.splitTaskCount(draftSteps.length)}
          onDraftChange={setDraftSteps}
          onPendingChange={setBusy}
          onSubmit={submit}
          onCancel={onClose}
        />
      </div>
    </BottomSheet>
  );
}
