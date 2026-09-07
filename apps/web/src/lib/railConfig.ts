import type { ProjectRailCommand, TaskRailCommand } from "./commands";

export type RailWorkItemKind = "task" | "project";
export type RailCommand = TaskRailCommand | ProjectRailCommand;

export const taskRailCommands: readonly TaskRailCommand[] = [
  "task.plan",
  "task.waitingLifecycle",
  "task.split",
  "task.assignOwner",
  "task.changeProject",
  "task.addSuccessor",
  "task.recurrence",
  "task.priority",
  "task.tags",
  "task.contexts",
  "task.convertToProject",
  "task.lifecycle",
];

export const projectRailCommands: readonly ProjectRailCommand[] = [
  "story.defer",
  "story.assignDriver",
  "story.planWork",
  "story.editOutcome",
  "story.tags",
  "story.contexts",
  "story.lifecycle",
];

const TASK_DEFAULT_FAVORITES: readonly TaskRailCommand[] = [
  "task.plan",
  "task.waitingLifecycle",
  "task.split",
];

const PROJECT_DEFAULT_FAVORITES: readonly ProjectRailCommand[] = [
  "story.defer",
  "story.assignDriver",
  "story.planWork",
];

const STORAGE_KEY = "machbar:rail-favorites";

type StoredFavorites = {
  task?: unknown;
  project?: unknown;
};

function isTaskCommand(value: unknown): value is TaskRailCommand {
  return typeof value === "string" && taskRailCommands.includes(value as TaskRailCommand);
}

function isProjectCommand(value: unknown): value is ProjectRailCommand {
  return (
    typeof value === "string" &&
    projectRailCommands.includes(value as ProjectRailCommand)
  );
}

function uniqueFavorites<T extends RailCommand>(
  value: unknown,
  isCommand: (candidate: unknown) => candidate is T,
  defaults: readonly T[],
): readonly T[] {
  if (!Array.isArray(value)) return defaults;
  const favorites = value.filter(isCommand).filter(
    (command, index, all) => all.indexOf(command) === index,
  );
  return favorites.length === 3 ? favorites : defaults;
}

export function readRailFavorites(
  kind: "task",
): readonly TaskRailCommand[];
export function readRailFavorites(
  kind: "project",
): readonly ProjectRailCommand[];
export function readRailFavorites(
  kind: RailWorkItemKind,
): readonly RailCommand[] {
  let stored: StoredFavorites = {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object") stored = parsed as StoredFavorites;
    }
  } catch {
    return kind === "task" ? TASK_DEFAULT_FAVORITES : PROJECT_DEFAULT_FAVORITES;
  }

  return kind === "task"
    ? uniqueFavorites(stored.task, isTaskCommand, TASK_DEFAULT_FAVORITES)
    : uniqueFavorites(stored.project, isProjectCommand, PROJECT_DEFAULT_FAVORITES);
}

export function writeRailFavorites(
  kind: "task",
  favorites: readonly TaskRailCommand[],
): void;
export function writeRailFavorites(
  kind: "project",
  favorites: readonly ProjectRailCommand[],
): void;
export function writeRailFavorites(
  kind: RailWorkItemKind,
  favorites: readonly RailCommand[],
): void {
  const current: StoredFavorites = {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object") Object.assign(current, parsed);
    }
    current[kind] = [...favorites];
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
  } catch {
    // localStorage may be unavailable in private mode, SSR, or tests.
  }
}

export function overflowRailCommands(
  kind: RailWorkItemKind,
  favorites: readonly RailCommand[],
): readonly RailCommand[];
export function overflowRailCommands(
  kind: "task",
  favorites: readonly TaskRailCommand[],
): readonly TaskRailCommand[];
export function overflowRailCommands(
  kind: "project",
  favorites: readonly ProjectRailCommand[],
): readonly ProjectRailCommand[];
export function overflowRailCommands(
  kind: RailWorkItemKind,
  favorites: readonly RailCommand[],
): readonly RailCommand[] {
  const commands = kind === "task" ? taskRailCommands : projectRailCommands;
  return commands.filter((command) => !favorites.includes(command));
}
