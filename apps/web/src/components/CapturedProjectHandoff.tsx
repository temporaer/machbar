import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { Task } from "@machbar/shared";
import type { ProjectWithActions } from "../lib/api";
import { api } from "../lib/api";
import { useIdentity } from "../lib/identity";
import { useRefresh } from "../lib/refresh";
import { useStrings } from "../lib/strings";
import { localizedErrorMessage } from "../lib/errorMessage";
import { sortByPosition } from "../lib/taskHelpers";
import { BottomSheet } from "./BottomSheet";
import { MemberSelectionSheet } from "./MemberSelectionSheet";
import { useProjectActions } from "../lib/useProjectActions";
import { hasProjectProgressPath } from "../lib/projectCommitments";

/**
 * The captured-item -> project handoff, reached right after converting an
 * Inbox item into a backlog project. Shows the project's steps as a
 * persistent, always-visible list (one row per already-added real task,
 * created immediately via `api.createTask`) with an always-available
 * trailing input row -- so the user can see exactly what's been added and
 * keep adding several steps in one sitting, instead of a single
 * fire-and-forget "add next action" button that gave no feedback.
 */
export function CapturedProjectHandoff({
  project,
  onDone,
}: {
  project: ProjectWithActions;
  /**
   * `openedProjectDirectly` is true for the "open project" exit, which
   * already navigates straight to the project's own detail page -- the
   * caller shouldn't also redirect to the Projects list/highlight in that
   * case, only clean up its own state.
   */
  onDone: (options?: { openedProjectDirectly?: boolean }) => void;
}) {
  const strings = useStrings();
  const navigate = useNavigate();
  const { currentMemberId, members } = useIdentity();
  const { bump } = useRefresh();
  const [currentProject, setCurrentProject] = useState(project);
  const [selectingDriver, setSelectingDriver] = useState(false);
  const [steps, setSteps] = useState<Task[] | null>(null);
  const [stepDraft, setStepDraft] = useState("");
  const [addingStep, setAddingStep] = useState(false);
  const [stepError, setStepError] = useState<string | null>(null);
  const stepInputRef = useRef<HTMLInputElement | null>(null);
  const projectActions = useProjectActions([currentProject]);
  const displayedProject =
    projectActions.retained.get(currentProject.id)?.story ?? currentProject;
  const canStart =
    displayedProject.availableActions.includes("activate") &&
    hasProjectProgressPath(displayedProject);

  useEffect(() => {
    let cancelled = false;
    void api.getProject(project.id).then((detail) => {
      if (cancelled) return;
      setSteps(sortByPosition(detail.tasks));
    });
    return () => {
      cancelled = true;
    };
    // Re-fetch only when a different project is handed off, not on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id]);

  const submitStep = async () => {
    const title = stepDraft.trim();
    if (!title || addingStep) return;
    setAddingStep(true);
    setStepError(null);
    try {
      const created = await api.createTask({
        title,
        projectId: project.id,
        status: "actionable",
        createdByMemberId: currentMemberId,
      });
      setSteps((current) => [...(current ?? []), created]);
      setStepDraft("");
      bump();
      const refreshed = await api.getProject(project.id);
      setCurrentProject(refreshed);
      setSteps(sortByPosition(refreshed.tasks));
    } catch (err) {
      setStepError(localizedErrorMessage(err, strings));
    } finally {
      setAddingStep(false);
      stepInputRef.current?.focus();
    }
  };

  return (
    <>
      <BottomSheet
        title={project.title}
        onClose={() => {
          if (!addingStep) onDone();
        }}
      >
        <div className="stack">
        <ul className="handoff-steps-list" aria-label={strings.projectSteps}>
          {(steps ?? []).map((step) => (
            <li key={step.id} className="handoff-step-row">
              {step.title}
            </li>
          ))}
        </ul>
        <form
          className="handoff-step-composer"
          onSubmit={(event) => {
            event.preventDefault();
            void submitStep();
          }}
        >
          <label htmlFor={`captured-project-next-step-${project.id}`} className="sr-only">
            {strings.addNextAction}
          </label>
          <input
            id={`captured-project-next-step-${project.id}`}
            ref={stepInputRef}
            value={stepDraft}
            placeholder={strings.splitTaskRowPlaceholder}
            disabled={addingStep}
            onChange={(event) => setStepDraft(event.target.value)}
          />
          <button
            type="submit"
            className="btn btn-sm btn-primary"
            disabled={addingStep || !stepDraft.trim()}
          >
            {strings.addNextAction}
          </button>
        </form>
        {stepError ? (
          <div className="task-row-error" role="alert">
            <span>{strings.error}</span>
            <span className="text-muted">{stepError}</span>
          </div>
        ) : null}
        {canStart ? (
          <>
            <p className="text-muted">{strings.activationReadyHint}</p>
            <button
              type="button"
              className="btn btn-primary btn-block"
              disabled={addingStep || projectActions.isPending(displayedProject.id)}
              onClick={() => {
                if (displayedProject.ownerMemberId === null) {
                  setSelectingDriver(true);
                  return;
                }
                void projectActions.activate(displayedProject).then((confirmed) => {
                  if (confirmed) setCurrentProject(confirmed);
                });
              }}
            >
              {strings.reviewStart}
            </button>
          </>
        ) : (
          <p className="text-muted">{strings.activationProgressRequired}</p>
        )}
        {projectActions.errors[displayedProject.id] ? (
          <p className="capture-error" role="alert">
            {projectActions.errors[displayedProject.id]}
          </p>
        ) : null}
        <button
          type="button"
          className="btn btn-block"
          disabled={addingStep}
          onClick={() => {
            onDone({ openedProjectDirectly: true });
            navigate(`/projects/${project.id}`);
          }}
        >
          {strings.openProject}
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-block"
          disabled={addingStep}
          onClick={() => onDone()}
        >
          {strings.done}
        </button>
        </div>
      </BottomSheet>
      {selectingDriver ? (
        <MemberSelectionSheet
          title={strings.assignDriver}
          label={strings.driver}
          idPrefix={`handoff-driver-${displayedProject.id}`}
          members={members}
          value={displayedProject.ownerMemberId}
          unassignedLabel={null}
          onClose={() => setSelectingDriver(false)}
          onSelect={async (ownerMemberId) => {
            const confirmed = await projectActions.activate(displayedProject, ownerMemberId);
            if (confirmed) setCurrentProject(confirmed);
            setSelectingDriver(false);
          }}
        />
      ) : null}
    </>
  );
}
