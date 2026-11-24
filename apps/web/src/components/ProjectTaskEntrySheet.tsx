import { useEffect, useState } from "react";
import { useIdentity } from "../lib/identity";
import type { Task } from "@machbar/shared";
import type { WorkItemAncestor } from "@machbar/shared";
import type { ProjectWithActions } from "../lib/api";
import { api } from "../lib/api";
import { useRefresh } from "../lib/refresh";
import { useStrings } from "../lib/strings";
import { sortByPosition } from "../lib/taskHelpers";
import { BottomSheet } from "./BottomSheet";
import { useAsync } from "../lib/useAsync";
import { StepComposer, type StepDraft } from "./StepComposer";

/** Explicit project-owned task entry. Creation/conversion has already finished. */
export function ProjectTaskEntrySheet({
  project,
  onClose,
}: {
  project: ProjectWithActions & { ancestors?: WorkItemAncestor[] };
  onClose: () => void;
}) {
  const strings = useStrings();
  const { currentMemberId } = useIdentity();
  const { bump } = useRefresh();
  const [currentProject, setCurrentProject] = useState(project);
  const [steps, setSteps] = useState<Task[] | null>(null);
  const [addingStep, setAddingStep] = useState(false);
  const { data: projectDetail, error: projectLoadError } = useAsync(() => api.getProject(project.id), [project.id]);

  useEffect(() => {
    if (projectDetail) {
      const detail = projectDetail;
      setCurrentProject(detail);
      setSteps(sortByPosition(detail.tasks));
    }
  }, [projectDetail]);

  const refreshProject = async () => {
    const refreshed = await api.getProject(project.id);
    setCurrentProject(refreshed);
    setSteps(sortByPosition(refreshed.tasks));
  };

  const submitSteps = async (draft: StepDraft[]) => {
    try {
      const input = {
        steps: draft,
        expectedRevision: currentProject.revision,
      };
      const saved = await api.createTaskStepBatchForProject(project.id, input);
      setCurrentProject(previous => ({ ...previous, ...saved.project }));
      setSteps(previous => sortByPosition([...new Map([...(previous ?? []), ...saved.tasks].map(task => [task.id, task])).values()]));
      bump();
    } catch (cause) {
      if ((cause as { code?: string })?.code === "stale_write_conflict") {
        try { await refreshProject(); } catch { /* keep the batch draft for a visible retry */ }
      }
      throw cause;
    }
  };

  return (
    <BottomSheet title={strings.projectTasksTitle} onClose={() => !addingStep && onClose()}>
      <p className="text-muted">{strings.oneTaskPerLine}</p>
      <div className="stack">
        <ul className="handoff-steps-list" aria-label={strings.projectSteps}>
          {(steps ?? []).map((step) => <li key={step.id} className="handoff-step-row">{step.title}</li>)}
        </ul>
        {projectLoadError ? <p role="alert" className="task-row-error">{projectLoadError}</p> : null}
        <StepComposer
          key={`project-${project.id}-member-${currentMemberId ?? "shared"}`}
          inputIdPrefix={`project-step-${project.id}`}
          label={strings.projectTasksTitle}
          placeholder={strings.splitTaskRowPlaceholder}
          submitLabel={strings.addProjectTaskCount}
          draftKey={`project-${project.id}-member-${currentMemberId ?? "shared"}`}
          onPendingChange={setAddingStep}
          onSubmit={submitSteps}
        />
        <p className="text-muted">{strings.projectTaskDraftHint}</p>
        <button type="button" className="btn btn-ghost btn-block" disabled={addingStep} onClick={onClose}>{strings.close}</button>
      </div>
    </BottomSheet>
  );
}
