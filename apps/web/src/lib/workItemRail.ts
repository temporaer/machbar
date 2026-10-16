import type { Task } from "@machbar/shared";
import type { ProjectWithActions } from "./api";
import type { WorkItemCommand } from "./commands";
import { classifyProjectListItem } from "./projectListFilter";

/** Shared vocabulary; labels describe the same intervention in every list. */
export type RailIntent = "plan" | "split" | "wait" | "followUp" | "clarify" |
  "deferClarification" | "structure" | "inspectBlocker" | "startToday" |
  "availability" | "planActivation" | "outcome" | "nextStep";
type RailCommand = Extract<WorkItemCommand, { type:
  | "task.plan" | "task.split" | "task.waitingLifecycle" | "task.refine"
  | "task.deferClarification" | "task.structure" | "task.open"
  | "task.startToday" | "task.availability" | "story.defer"
  | "story.editOutcome" | "story.structure" | "story.planWork"
}>;

export interface RailAction {
  intent: RailIntent;
  command: RailCommand;
  prominent?: boolean;
}

/** Left swipe asks what should happen next; lifecycle belongs to right swipe. */
export function taskRailActions(task: Task, revisit = false): readonly RailAction[] {
  if (task.kind === "reference" || task.status === "done" || task.status === "cancelled") return [];
  if (task.needsClarification || task.status === "captured") return [
    { intent: "clarify", command: { type: "task.refine", taskId: task.id }, prominent: true },
    { intent: "deferClarification", command: { type: "task.deferClarification", taskId: task.id } },
    { intent: "structure", command: { type: "task.structure", taskId: task.id } },
  ];
  const plan: RailAction = { intent: "plan", command: { type: "task.plan", taskId: task.id } };
  if (task.externalWait) return [
    { intent: "followUp", command: { type: "task.waitingLifecycle", taskId: task.id }, prominent: true },
    plan,
  ];
  if (task.blocked) {
    const blocker = task.dependencies.find((dependency) => !dependency.resolved);
    return [
      ...(blocker ? [{ intent: "inspectBlocker" as const, command: { type: "task.open" as const, taskId: blocker.dependsOnTaskId }, prominent: true }] : []),
      plan,
    ];
  }
  if (revisit) return [
    { intent: "startToday", command: { type: "task.startToday", task }, prominent: true },
    { intent: "availability", command: { type: "task.availability", taskId: task.id } },
    plan,
  ];
  if (task.status === "someday") return [plan];
  return [
    plan,
    ...(task.repeatAfterDays === null ? [{ intent: "split" as const, command: { type: "task.split" as const, taskId: task.id } }] : []),
    { intent: "wait", command: { type: "task.waitingLifecycle", taskId: task.id } },
  ];
}

export function projectRailActions(story: ProjectWithActions, now: Date): readonly RailAction[] {
  const outcome: RailAction = { intent: "outcome", command: { type: "story.editOutcome", story } };
  const structure: RailAction = { intent: "structure", command: { type: "story.structure", story } };
  switch (classifyProjectListItem(story, now)) {
    case "backlog": return [
      { intent: "planActivation", command: { type: "story.defer", story }, prominent: true },
      outcome, structure,
    ];
    case "active-stuck": return [
      { intent: "nextStep", command: { type: "story.planWork", story }, prominent: true },
      outcome, structure,
    ];
    // Reviewing the outcome edits criteria, never completes the project.
    case "active-review": return [{ ...outcome, prominent: true }];
    // Project waiting is an aggregate, without a project follow-up command.
    // Its tasks own follow-up. Healthy/deferred and terminal projects need no intervention.
    default: return [];
  }
}
