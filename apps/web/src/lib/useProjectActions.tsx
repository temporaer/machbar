import { createContext, useCallback, useContext, type ReactNode } from "react";
import { api } from "./api";
import type { ProjectActivationResolution } from "@machbar/shared";
import type { ProjectWithActions, ProjectWorkflowAction, ProjectWorkflowInput, UpdateProjectInput } from "./api";
import { useItemMutations } from "./useItemMutations";

function useProjectActionsState() {
  const { run, ...feedback } = useItemMutations();
  const runAction = useCallback((
    story: ProjectWithActions, action: ProjectWorkflowAction, ownerMemberId?: number | null,
    activationResolution?: ProjectActivationResolution, throwOnError = false,
    expectedRevision?: number, workflowInput?: Partial<ProjectWorkflowInput>,
  ) => run({
    id: story.id, throwOnError,
    mutate: () => {
      const input = { expectedRevision: expectedRevision ?? story.revision, ...workflowInput };
      const activation = {
        ...input,
        ...(ownerMemberId !== undefined ? { ownerMemberId } : {}),
        ...(activationResolution ? { activationResolution } : {}),
      };
      switch (action) {
        case "activate": return api.activateProject(story.id, activation);
        case "return_to_backlog": return api.returnProjectToBacklog(story.id, input);
        case "complete": return api.completeProject(story.id, input);
        case "reopen": return api.reopenProject(story.id, activation);
        case "archive": return api.archiveProject(story.id, input);
      }
    },
  }), [run]);
  const activate = useCallback((story: ProjectWithActions, ownerMemberId?: number | null, activationResolution?: ProjectActivationResolution) =>
    runAction(story, "activate", ownerMemberId, activationResolution), [runAction]);
  const archive = useCallback((story: ProjectWithActions) => runAction(story, "archive"), [runAction]);
  const update = useCallback((story: ProjectWithActions, patch: UpdateProjectInput, throwOnError = false) =>
    run({ id: story.id, mutate: () => api.updateProject(story.id, { ...patch, expectedRevision: patch.expectedRevision ?? story.revision }), throwOnError }), [run]);
  const appendNotes = useCallback((story: ProjectWithActions, content: string) =>
    run({ id: story.id, mutate: () => api.appendProjectNotes(story.id, content), throwOnError: true }), [run]);
  const assignDriver = useCallback((story: ProjectWithActions, ownerMemberId: number | null) =>
    update(story, { ownerMemberId }, true), [update]);
  const schedule = useCallback((story: ProjectWithActions, patch: UpdateProjectInput) => update(story, patch, true), [update]);
  const returnToBacklog = useCallback((
    story: ProjectWithActions, revisitAt: string | null, withdrawCommitments = false,
    expectedTaskRevisions?: Array<{ taskId: number; revision: number }>,
  ) => run({
    id: story.id, throwOnError: true,
    mutate: () => api.returnProjectToBacklog(story.id, {
      expectedRevision: story.revision, revisitAt, withdrawCommitments,
      ...(expectedTaskRevisions !== undefined ? { expectedTaskRevisions } : {}),
    }),
  }), [run]);
  const setContexts = useCallback((story: ProjectWithActions, contextIds: number[]) =>
    update(story, { contextIds }, true), [update]);
  const acknowledgeReview = useCallback((story: ProjectWithActions) =>
    run({ id: story.id, mutate: () => api.acknowledgeProjectReview(story.id, { expectedRevision: story.revision }) }), [run]);
  return { ...feedback, runAction, activate, archive, update, appendNotes, assignDriver, schedule, returnToBacklog, setContexts, acknowledgeReview };
}

type ProjectActionsValue = ReturnType<typeof useProjectActionsState>;
const ProjectActionsContext = createContext<ProjectActionsValue | null>(null);
export function ProjectActionsProvider({ children }: { children: ReactNode }) {
  const value = useProjectActionsState();
  return <ProjectActionsContext.Provider value={value}>{children}</ProjectActionsContext.Provider>;
}
export function useProjectActions(): ProjectActionsValue {
  const context = useContext(ProjectActionsContext);
  if (!context) throw new Error("useProjectActions must be used within a ProjectActionsProvider");
  return context;
}
