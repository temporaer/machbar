import { api } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { useProjectActions } from "../lib/useProjectActions";
import { useProjectWorkflow } from "../lib/projectWorkflowContext";
import { useIdentity } from "../lib/identity";
import { MemberSelectionSheet } from "./MemberSelectionSheet";
import { ProjectDeferSheet } from "./ProjectDeferSheet";
import { ProjectTagsSheet } from "./ProjectTagsSheet";
import { ProjectContextsSheet } from "./ProjectContextsSheet";
import { StoryCriteriaSheet } from "./StoryCriteriaSheet";
import { useStrings } from "../lib/strings";
import { canClearDriver } from "../lib/projectWorkflow";

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
            await projectActions.schedule(story, patch);
          }}
        />
      );
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
    default:
      return null;
  }
}
