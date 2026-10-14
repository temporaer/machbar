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
 * they are how `story.activate`/`story.reopen` resolve when readiness needs
 * a driver or progress path (see `lifecyclePrerequisite()`), collecting all
 * missing decisions before the canonical transition call.
 *
 * `completeWithDecisions` is one continuation for `story.complete` when
 * criteria need checking or open task branches need a disposition. It keeps
 * both kinds of choice locally and submits them with the same canonical
 * completion transition.
 *
 * `structure` backs the fixed row rail's `Struktur` button: it opens
 * `ProjectStructureSheet`, which only ever dispatches `story.planWork`/
 * `story.editOutcome`/`story.convertToTask` rather than rendering a sheet of
 * its own. `convertToTask` is the focused Project → Task role-conversion
 * workflow; it preflights project-only structure before calling the canonical
 * API endpoint.
 */
export type ProjectWorkflowKind =
  | "defer"
  | "structure"
  | "refinement"
  | "assignDriver"
  | "editOutcome"
  | "convertToTask"
  | "move"
  | "deadline"
  | "tags"
  | "contexts"
  | "activateWithDriver"
  | "reopenWithDriver"
  | "completeWithDecisions";

export interface ProjectWorkflowState {
  kind: ProjectWorkflowKind;
  projectId: number;
}

interface ProjectWorkflowContextValue {
  current: ProjectWorkflowState | null;
  open: (kind: ProjectWorkflowKind, projectId: number) => void;
  close: () => void;
  closeCurrent: () => void;
}

const ProjectWorkflowContext = createContext<ProjectWorkflowContextValue | null>(null);

export function ProjectWorkflowProvider({ children }: { children: ReactNode }) {
  const [current, setCurrent] = useState<ProjectWorkflowState | null>(null);
  const value = useMemo<ProjectWorkflowContextValue>(
    () => ({
      current,
      open: (kind, projectId) => setCurrent({ kind, projectId }),
      closeCurrent: () => setCurrent(null),
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
