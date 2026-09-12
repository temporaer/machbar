import { createContext, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";

/**
 * Project counterpart of `taskWorkflowContext.tsx`. Every `story.*`
 * command whose canonical destination is a focused editor (as opposed to a
 * direct workflow-transition mutation or navigation) opens one of these —
 * see `ProjectWorkflowHost.tsx`, the only component that imports every one
 * of the focused sheets below.
 *
 * `story.lifecycle` and `story.openOverflow` are not workflow kinds: they
 * manipulate the interaction scope's `openLifecycleId`/`openOverflowId`
 * directly (see `useWorkItemCommands.ts`), and `story.planWork` is pure
 * navigation to the project's next-action focus, not a sheet.
 *
 * `activateWithDriver`/`reopenWithDriver` are not separate user intents:
 * they are how `story.activate`/`story.reopen` resolve when the story still
 * needs a driver (see `lifecyclePrerequisite()`), collecting one and
 * committing the transition atomically in the same call.
 *
 * `completeWithCriteria` is the analogous continuation for `story.complete`
 * when acceptance criteria remain unchecked: it opens the focused checklist
 * (`CompleteWithCriteriaSheet`), not the structural `editOutcome` editor, and
 * commits the same `story.complete` transition once every criterion is
 * checked.
 */
export type ProjectWorkflowKind =
  | "defer"
  | "assignDriver"
  | "editOutcome"
  | "planDates"
  | "tags"
  | "contexts"
  | "activateWithDriver"
  | "reopenWithDriver"
  | "completeWithCriteria";

export interface ProjectWorkflowState {
  kind: ProjectWorkflowKind;
  projectId: number;
}

interface ProjectWorkflowContextValue {
  current: ProjectWorkflowState | null;
  open: (kind: ProjectWorkflowKind, projectId: number) => void;
  close: () => void;
}

const ProjectWorkflowContext = createContext<ProjectWorkflowContextValue | null>(null);

export function ProjectWorkflowProvider({ children }: { children: ReactNode }) {
  const [current, setCurrent] = useState<ProjectWorkflowState | null>(null);
  const value = useMemo<ProjectWorkflowContextValue>(
    () => ({
      current,
      open: (kind, projectId) => setCurrent({ kind, projectId }),
      close: () => setCurrent(null),
    }),
    [current],
  );
  return <ProjectWorkflowContext.Provider value={value}>{children}</ProjectWorkflowContext.Provider>;
}

export function useProjectWorkflow(): ProjectWorkflowContextValue {
  const ctx = useContext(ProjectWorkflowContext);
  if (!ctx) throw new Error("useProjectWorkflow must be used within a ProjectWorkflowProvider");
  return ctx;
}
