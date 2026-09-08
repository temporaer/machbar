import type { ProjectRailCommand, TaskRailCommand } from "./commands";

export type RailWorkItemKind = "task" | "project";
export type RailCommand = TaskRailCommand | ProjectRailCommand;

// Declared in contiguous category blocks (see `RailCommandCategory` below) so
// that grouping a list of these commands by category also preserves a
// sensible within-category order, without a separate sort step.
export const taskRailCommands: readonly TaskRailCommand[] = [
  // schedule
  "task.plan",
  "task.waitingLifecycle",
  "task.recurrence",
  // organize
  "task.split",
  "task.assignOwner",
  "task.changeProject",
  "task.addSuccessor",
  "task.convertToProject",
  // classify
  "task.priority",
  "task.tags",
  "task.contexts",
  // lifecycle
  "task.discard",
  "task.lifecycle",
];

export const projectRailCommands: readonly ProjectRailCommand[] = [
  // schedule
  "story.defer",
  "story.planDates",
  // organize
  "story.assignDriver",
  "story.planWork",
  "story.editOutcome",
  // classify
  "story.tags",
  "story.contexts",
  // lifecycle
  "story.lifecycle",
];

/**
 * Coarse grouping used to visually cluster the "more actions"
 * overflow/disclosure lists (see `CommandCategoryGrid`) so a dozen
 * identically-styled buttons don't read as one undifferentiated wall.
 */
export type RailCommandCategory = "schedule" | "organize" | "classify" | "lifecycle";

const RAIL_COMMAND_CATEGORY: Record<RailCommand, RailCommandCategory> = {
  "task.plan": "schedule",
  "task.waitingLifecycle": "schedule",
  "task.recurrence": "schedule",
  "task.split": "organize",
  "task.assignOwner": "organize",
  "task.changeProject": "organize",
  "task.addSuccessor": "organize",
  "task.convertToProject": "organize",
  "task.priority": "classify",
  "task.tags": "classify",
  "task.contexts": "classify",
  "task.discard": "lifecycle",
  "task.lifecycle": "lifecycle",
  "story.defer": "schedule",
  "story.planDates": "schedule",
  "story.assignDriver": "organize",
  "story.planWork": "organize",
  "story.editOutcome": "organize",
  "story.tags": "classify",
  "story.contexts": "classify",
  "story.lifecycle": "lifecycle",
};

export function railCommandCategory(command: RailCommand): RailCommandCategory {
  return RAIL_COMMAND_CATEGORY[command];
}

/**
 * Groups commands by category, preserving each command's relative order —
 * grouping a `taskRailCommands`/`projectRailCommands`-derived list this way
 * naturally keeps commands within a category together, since both master
 * lists are declared in contiguous category blocks above.
 */
export function groupRailCommandsByCategory<T extends RailCommand>(
  commands: readonly T[],
): Array<{ category: RailCommandCategory; commands: T[] }> {
  const groups: Array<{ category: RailCommandCategory; commands: T[] }> = [];
  for (const command of commands) {
    const category = railCommandCategory(command);
    const group = groups.find((candidate) => candidate.category === category);
    if (group) {
      group.commands.push(command);
    } else {
      groups.push({ category, commands: [command] });
    }
  }
  return groups;
}

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

const STORAGE_KEY_PREFIX = "machbar:rail-favorites";

function storageKey(memberId: number | null): string {
  return memberId === null ? STORAGE_KEY_PREFIX : `${STORAGE_KEY_PREFIX}:${memberId}`;
}

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
  memberId?: number | null,
): readonly TaskRailCommand[];
export function readRailFavorites(
  kind: "project",
  memberId?: number | null,
): readonly ProjectRailCommand[];
export function readRailFavorites(
  kind: RailWorkItemKind,
  memberId: number | null = null,
): readonly RailCommand[] {
  let stored: StoredFavorites = {};
  try {
    const raw = window.localStorage.getItem(storageKey(memberId));
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
  memberId?: number | null,
): void;
export function writeRailFavorites(
  kind: "project",
  favorites: readonly ProjectRailCommand[],
  memberId?: number | null,
): void;
export function writeRailFavorites(
  kind: RailWorkItemKind,
  favorites: readonly RailCommand[],
  memberId: number | null = null,
): void {
  const current: StoredFavorites = {};
  try {
    const key = storageKey(memberId);
    const raw = window.localStorage.getItem(key);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object") Object.assign(current, parsed);
    }
    current[kind] = [...favorites];
    window.localStorage.setItem(key, JSON.stringify(current));
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
