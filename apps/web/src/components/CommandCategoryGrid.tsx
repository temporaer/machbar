import type { RailCommand } from "../lib/railConfig";
import { groupRailCommandsByCategory } from "../lib/railConfig";

/**
 * Renders a list of rail commands as a grid, grouped and tinted by
 * `RailCommandCategory` (schedule/organize/classify/lifecycle) rather than
 * one flat, undifferentiated row of identical buttons. Shared by the rail's
 * own "More…" overflow and the "Weitere Aktionen" disclosures in
 * `TaskDetailSheet`/`ProjectDetailPage`, so all three "more actions" surfaces
 * stay visually consistent.
 */
export function CommandCategoryGrid<T extends RailCommand>({
  commands,
  labels,
  labelForCommand,
  onCommand,
  disabled = false,
}: {
  commands: readonly T[];
  labels: Record<string, string>;
  labelForCommand?: ((command: T) => string) | undefined;
  onCommand: (command: T) => void;
  disabled?: boolean;
}) {
  const groups = groupRailCommandsByCategory(commands);
  return (
    <div className="command-category-grid">
      {groups.map(({ category, commands: group }) => (
        <div
          key={category}
          className={`command-category-group command-category-${category}`}
        >
          {group.map((command) => (
            <button
              key={command}
              type="button"
              className="btn btn-sm"
              disabled={disabled}
              onClick={() => onCommand(command)}
            >
              {labelForCommand?.(command) ?? labels[command]}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}
