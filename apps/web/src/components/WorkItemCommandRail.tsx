import type { ProjectRailCommand, TaskRailCommand } from "../lib/commands";
import { overflowRailCommands } from "../lib/railConfig";
import { CommandCategoryGrid } from "./CommandCategoryGrid";

type Props<T extends TaskRailCommand | ProjectRailCommand> = {
  kind: "task" | "project";
  favorites: readonly T[];
  labels: Record<string, string>;
  labelForCommand?: (command: T) => string;
  onCommand: (command: T) => void;
  groupLabel: string;
  overflowLabel: string;
  disabled?: boolean;
  overflowOpen?: boolean;
  onOverflowChange?: (open: boolean) => void;
  /**
   * Commands unavailable for this specific work item right now (e.g. an
   * unclassified captured inbox item cannot be reparented/filed into a
   * project or split into steps — the API rejects those with
   * `task_promotion_invalid`). Hidden from both the favorites row and the
   * overflow grid rather than shown and left to fail on click.
   */
  hiddenCommands?: readonly T[];
};

export function WorkItemCommandRail<T extends TaskRailCommand | ProjectRailCommand>(props: Props<T>) {
  const { kind, labels, groupLabel, overflowLabel, disabled = false, hiddenCommands = [] } = props;
  const overflow: readonly T[] = (
    kind === "task"
      ? overflowRailCommands("task", props.favorites as readonly TaskRailCommand[]) as readonly T[]
      : overflowRailCommands("project", props.favorites as readonly ProjectRailCommand[]) as readonly T[]
  ).filter((command) => !hiddenCommands.includes(command));
  const commands = props.favorites.filter((command) => !hiddenCommands.includes(command));

  return (
    <div
      className={`${kind === "task" ? "task" : "story"}-row-chips`}
      role="group"
      aria-label={groupLabel}
    >
      {commands.map((command) => (
        <button
          key={command}
          type="button"
          className="btn btn-sm"
          disabled={disabled}
          onClick={() => props.onCommand(command)}
        >
          {props.labelForCommand?.(command) ?? labels[command]}
        </button>
      ))}
      <details
        className="work-item-command-overflow"
        open={props.overflowOpen}
        onToggle={(event) => props.onOverflowChange?.(event.currentTarget.open)}
      >
        <summary className="btn btn-sm">{overflowLabel}</summary>
        <CommandCategoryGrid
          commands={overflow}
          labels={labels}
          labelForCommand={props.labelForCommand}
          onCommand={props.onCommand}
          disabled={disabled}
        />
      </details>
    </div>
  );
}
