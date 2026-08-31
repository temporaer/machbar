import { useState } from "react";
import { useNavigate } from "react-router-dom";
import type { ProjectWithActions } from "../lib/api";
import { api } from "../lib/api";
import { useIdentity } from "../lib/identity";
import { useRefresh } from "../lib/refresh";
import { useStrings } from "../lib/strings";
import { BottomSheet } from "./BottomSheet";
import { InlineTaskComposer } from "./InlineTaskComposer";
import { MemberSelectionSheet } from "./MemberSelectionSheet";
import { useProjectActions } from "../lib/useProjectActions";
import { hasProjectProgressPath } from "../lib/projectCommitments";

export function CapturedProjectHandoff({
  project,
  onDone,
}: {
  project: ProjectWithActions;
  onDone: () => void;
}) {
  const strings = useStrings();
  const navigate = useNavigate();
  const { currentMemberId, members } = useIdentity();
  const { bump } = useRefresh();
  const [addingNextAction, setAddingNextAction] = useState(false);
  const [composerPending, setComposerPending] = useState(false);
  const [currentProject, setCurrentProject] = useState(project);
  const [selectingDriver, setSelectingDriver] = useState(false);
  const projectActions = useProjectActions([currentProject]);
  const displayedProject =
    projectActions.retained.get(currentProject.id)?.story ?? currentProject;
  const canStart =
    displayedProject.availableActions.includes("activate") &&
    hasProjectProgressPath(displayedProject);

  return (
    <>
      <BottomSheet
        title={project.title}
        onClose={() => {
          if (!composerPending) onDone();
        }}
      >
        <div className="stack">
        {addingNextAction ? (
          <InlineTaskComposer
            inputId={`captured-project-next-action-${project.id}`}
            label={strings.addNextAction}
            placeholder={strings.addNextAction}
            onCancel={() => setAddingNextAction(false)}
            onPendingChange={setComposerPending}
            onSave={async (title) => {
              await api.createTask({
                title,
                projectId: project.id,
                status: "actionable",
                createdByMemberId: currentMemberId,
              });
              const refreshed = await api.getProject(project.id);
              setCurrentProject(refreshed);
              setComposerPending(false);
              bump();
              setAddingNextAction(false);
            }}
          />
        ) : (
          <button
            type="button"
            className="btn btn-primary btn-block"
            onClick={() => setAddingNextAction(true)}
          >
            {strings.addNextAction}
          </button>
        )}
        {canStart ? (
          <>
            <p className="text-muted">{strings.activationReadyHint}</p>
            <button
              type="button"
              className="btn btn-primary btn-block"
              disabled={composerPending || projectActions.isPending(displayedProject.id)}
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
          disabled={composerPending}
          onClick={() => {
            onDone();
            navigate(`/projects/${project.id}`);
          }}
        >
          {strings.openProject}
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-block"
          disabled={composerPending}
          onClick={onDone}
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
