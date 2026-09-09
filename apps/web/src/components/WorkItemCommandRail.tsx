import type { ProjectRailCommand, TaskRailCommand } from "../lib/commands";
import { overflowRailCommands } from "../lib/railConfig";

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
  const configuredOverflow: readonly T[] = (
    kind === "task"
      ? overflowRailCommands("task", props.favorites as readonly TaskRailCommand[]) as readonly T[]
      : overflowRailCommands("project", props.favorites as readonly ProjectRailCommand[]) as readonly T[]
  ).filter((command) => !hiddenCommands.includes(command));
  const visibleFavorites = [
    ...props.favorites.filter((command) => !hiddenCommands.includes(command)),
    ...configuredOverflow,
  ].slice(0, 3);
  const overflow = configuredOverflow.filter((command) => !visibleFavorites.includes(command));

  return (
    <div
      className="work-item-command-rail"
      data-kind={kind}
      role="group"
      aria-label={groupLabel}
    >
      <div className="rail-main-grid">
        {visibleFavorites.map((command) => (
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
        <button
          type="button"
          className="btn btn-sm rail-overflow-toggle"
          disabled={disabled}
          aria-expanded={props.overflowOpen ?? false}
          onClick={() => props.onOverflowChange?.(!(props.overflowOpen ?? false))}
        >
          {overflowLabel}
        </button>
      </div>
      {props.overflowOpen ? (
        <div className="rail-overflow-grid" role="group" aria-label={overflowLabel}>
          {overflow.map((command) => (
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
        </div>
      ) : null}
    </div>
  );
}
