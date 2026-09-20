import { api } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { useProjectActions } from "../lib/useProjectActions";
import { useProjectWorkflow } from "../lib/projectWorkflowContext";
import { useIdentity } from "../lib/identity";
import { MemberSelectionSheet } from "./MemberSelectionSheet";
import { ProjectDeferSheet } from "./ProjectDeferSheet";
import { ProjectStructureSheet } from "./ProjectStructureSheet";
import { ProjectTagsSheet } from "./ProjectTagsSheet";
import { ProjectDeadlineSheet } from "./ProjectDeadlineSheet";
import { ProjectContextsSheet } from "./ProjectContextsSheet";
import { StoryCriteriaSheet } from "./StoryCriteriaSheet";
import { CompleteWithCriteriaSheet } from "./CompleteWithCriteriaSheet";
import { CompleteWithOpenTasksSheet } from "./CompleteWithOpenTasksSheet";
import { useStrings } from "../lib/strings";
import { canClearDriver } from "../lib/projectWorkflow";
import type { ProjectWithActions } from "../lib/api";

/**
 * Project counterpart of `TaskWorkflowHost.tsx` — the single place that
 * imports every focused `story.*` sheet and switches on
 * `projectWorkflow.current?.kind`. Only `useWorkItemCommands()` may call
 * `projectWorkflow.open(...)`; rows, keyboard handlers, and project-detail
 * value clicks all just `dispatch()`.
 */
export function ProjectWorkflowHost() {
  const workflow = useProjectWorkflow();
  const strings = useStrings();
  const { members } = useIdentity();
  const projectActions = useProjectActions();
  const projectId = workflow.current?.projectId ?? null;
  const { data: fetchedProject } = useAsync(
    () => (projectId !== null ? api.getProject(projectId) : Promise.resolve(null)),
    [projectId],
  );
  const retained = projectId !== null ? projectActions.retained.get(projectId)?.story : undefined;
  const story = retained ?? fetchedProject;

  if (!workflow.current || !story) return null;
  const close = workflow.close;

  switch (workflow.current.kind) {
    case "defer":
      return (
        <ProjectDeferSheet
          story={story}
          onClose={close}
          onSave={async (patch) => {
            if (story.status === "active") {
              await projectActions.returnToBacklog(story, patch.scheduledDate);
            } else {
              await projectActions.schedule(story, patch);
            }
          }}
        />
      );
    case "structure":
      return <ProjectStructureSheet story={story} onClose={close} />;
    case "assignDriver":
      return (
        <MemberSelectionSheet
          title={`${strings.assignDriver}: ${story.title}`}
          label={strings.driver}
          idPrefix={`project-workflow-driver-${story.id}`}
          members={members}
          value={story.ownerMemberId}
          unassignedLabel={canClearDriver(story) ? strings.noDriver : null}
          hint={canClearDriver(story) ? undefined : strings.driverLockedHint}
          onClose={close}
          onSelect={async (ownerMemberId) => {
            await projectActions.assignDriver(story, ownerMemberId);
          }}
        />
      );
    case "editOutcome":
      return <StoryCriteriaSheet story={story} onClose={close} />;
    case "completeWithCriteria":
      return (
        <CompleteWithCriteriaSheet
          story={story}
          onClose={close}
          onComplete={async () => {
            await projectActions.runAction(story, "complete");
          }}
        />
      );
    case "completeWithOpenTasks":
      // Needs the full task list, which only the fetched `ProjectDetail`
      // carries -- the optimistic `retained` projection does not.
      if (!fetchedProject) return null;
      return (
        <CompleteWithOpenTasksSheet
          story={fetchedProject}
          onClose={close}
          onComplete={async () => {
            await projectActions.runAction(story, "complete");
          }}
        />
      );
    case "deadline":
      return (
        <ProjectDeadlineSheet
          story={story}
          onClose={close}
          onSave={async (patch) => {
            await projectActions.schedule(story, patch);
          }}
        />
      );
    case "tags":
      return (
        <ProjectTagsSheet
          story={story}
          onClose={close}
          onSave={async (tagIds) => {
            await projectActions.update(story, { tagIds }, undefined, true);
          }}
        />
      );
    case "contexts":
      return <ProjectContextsSheet story={story} onClose={close} />;
    case "activateWithDriver":
    case "reopenWithDriver": {
      const action = workflow.current.kind === "reopenWithDriver" ? "reopen" : "activate";
      return (
        <MemberSelectionSheet
          title={strings.assignDriver}
          label={strings.driver}
          idPrefix={`project-workflow-${action}-driver-${story.id}`}
          members={members}
          value={story.ownerMemberId}
          unassignedLabel={null}
          hint={strings.assignDriverToActivateHint}
          onClose={workflow.closeCurrent}
          onCancel={close}
          onSelect={async (ownerMemberId) => {
            if (workflow.continuation?.projectId === story.id) {
              if (story.activationReadiness.hasViableProgressPath) {
                const result = await projectActions.runAction(story, action, ownerMemberId);
                if (result) {
                  workflow.closeCurrent();
                  workflow.cancelContinuation();
                }
              } else {
                const assigned = await projectActions.assignDriver(story, ownerMemberId);
                const updated =
                  (assigned as ProjectWithActions | undefined) ??
                  (await api.getProject(story.id)) ??
                  { ...story, ownerMemberId, revision: story.revision + 1 };
                workflow.closeCurrent();
                workflow.resumeContinuation(updated);
              }
            } else {
              await projectActions.runAction(story, action, ownerMemberId);
            }
          }}
        />
      );
    }
    default:
      return null;
  }
}
