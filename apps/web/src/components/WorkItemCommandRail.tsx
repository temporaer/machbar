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
};

export function WorkItemCommandRail<T extends TaskRailCommand | ProjectRailCommand>(props: Props<T>) {
  const { kind, labels, groupLabel, overflowLabel, disabled = false } = props;
  const overflow: readonly T[] =
    kind === "task"
      ? overflowRailCommands("task", props.favorites as readonly TaskRailCommand[]) as readonly T[]
      : overflowRailCommands("project", props.favorites as readonly ProjectRailCommand[]) as readonly T[];
  const commands = props.favorites;

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
