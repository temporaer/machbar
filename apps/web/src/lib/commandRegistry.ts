import type { TranslationCatalog } from "../i18n/catalog";
import type { WorkItemCommand } from "./commands";
import type { InteractionScopeValue } from "./interactionScope";

export type CommandGroup =
  | "navigation"
  | "capture"
  | "task"
  | "structure"
  | "help";

export interface CommandDescriptor {
  id: string;
  group: CommandGroup;
  keys: readonly string[];
  label: (strings: TranslationCatalog) => string;
  command?: WorkItemCommand;
  available?: (scope: InteractionScopeValue | null) => boolean;
}

export const commandDescriptors: readonly CommandDescriptor[] = [
  {
    id: "navigate.today",
    group: "navigation",
    keys: ["g t"],
    label: (strings) => strings.today,
    command: { type: "navigate.today" },
  },
  {
    id: "navigate.inbox",
    group: "navigation",
    keys: ["g i"],
    label: (strings) => strings.inbox,
    command: { type: "navigate.inbox" },
  },
  {
    id: "navigate.projects",
    group: "navigation",
    keys: ["g p"],
    label: (strings) => strings.projects,
    command: { type: "navigate.projects" },
  },
  {
    id: "navigate.waiting",
    group: "navigation",
    keys: ["g w"],
    label: (strings) => strings.waiting,
    command: { type: "navigate.waiting" },
  },
  {
    id: "navigate.more",
    group: "navigation",
    keys: ["g m"],
    label: (strings) => strings.more,
    command: { type: "navigate.more" },
  },
  {
    id: "capture.open",
    group: "capture",
    keys: ["c"],
    label: (strings) => strings.quickAdd,
    command: { type: "capture.open" },
    available: (scope) => scope?.captureOpen !== null,
  },
  {
    id: "task.schedule",
    group: "task",
    keys: ["s"],
    label: (strings) => strings.schedule,
    available: (scope) => scope?.activeRole === "task",
  },
  {
    id: "task.assign",
    group: "task",
    keys: ["a"],
    label: (strings) => strings.assign,
    available: (scope) => scope?.activeRole === "task",
  },
  {
    id: "task.notes",
    group: "task",
    keys: ["n"],
    label: (strings) => strings.notes,
    available: (scope) => scope?.activeRole === "task",
  },
  {
    id: "outline.collapse",
    group: "structure",
    keys: ["h"],
    label: (strings) => strings.collapse,
    available: (scope) => Boolean(scope?.canReorder || scope?.canReparent),
  },
  {
    id: "outline.expand",
    group: "structure",
    keys: ["l"],
    label: (strings) => strings.expand,
    available: (scope) => Boolean(scope?.canReorder || scope?.canReparent),
  },
  {
    id: "outline.move",
    group: "structure",
    keys: ["Alt+↑/↓", "Alt+←/→"],
    label: (strings) => strings.organize,
    available: (scope) => Boolean(scope?.moveBy),
  },
  {
    id: "help.open",
    group: "help",
    keys: ["?"],
    label: (strings) => strings.keyboardHelp,
    available: (scope) => scope?.helpOpen !== null,
  },
];

export function navigationBySecondKey(): Map<string, CommandDescriptor> {
  const entries = commandDescriptors
    .filter((descriptor) => descriptor.group === "navigation")
    .flatMap((descriptor) =>
      descriptor.keys
        .map((key) => key.match(/^g\s+(.+)$/)?.[1])
        .filter((key): key is string => key !== undefined)
        .map((key) => [key, descriptor] as const),
    );
  return new Map(entries);
}

export function availableCommandDescriptors(
  scope: InteractionScopeValue | null,
): CommandDescriptor[] {
  return commandDescriptors.filter(
    (descriptor) => descriptor.available?.(scope) ?? true,
  );
}
