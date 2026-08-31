import { useState } from "react";
import { useNavigate } from "react-router-dom";
import type { ProjectWithActions } from "../lib/api";
import { api } from "../lib/api";
import { useIdentity } from "../lib/identity";
import { useRefresh } from "../lib/refresh";
import { useStrings } from "../lib/strings";
import { BottomSheet } from "./BottomSheet";
import { InlineTaskComposer } from "./InlineTaskComposer";

export function CapturedProjectHandoff({
  project,
  onDone,
}: {
  project: ProjectWithActions;
  onDone: () => void;
}) {
  const strings = useStrings();
  const navigate = useNavigate();
  const { currentMemberId } = useIdentity();
  const { bump } = useRefresh();
  const [addingNextAction, setAddingNextAction] = useState(false);
  const [composerPending, setComposerPending] = useState(false);

  return (
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
  );
}
