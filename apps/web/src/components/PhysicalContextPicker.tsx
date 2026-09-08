import type { InheritanceMode, PhysicalContext } from "@machbar/shared";
import { useStrings } from "../lib/strings";

function visibleContexts(
  catalogue: PhysicalContext[],
  attached: PhysicalContext[],
): PhysicalContext[] {
  const byId = new Map<number, PhysicalContext>();
  for (const context of catalogue) {
    if (context.active) byId.set(context.id, context);
  }
  for (const context of attached) byId.set(context.id, context);
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function PhysicalContextPicker({
  contexts,
  selected,
  inherited = [],
  mode,
  disabled = false,
  onChange,
}: {
  contexts: PhysicalContext[];
  selected: PhysicalContext[];
  inherited?: PhysicalContext[];
  mode?: InheritanceMode;
  disabled?: boolean;
  onChange: (mode: InheritanceMode | undefined, contextIds: number[]) => void;
}) {
  const strings = useStrings();
  const options = visibleContexts(contexts, [...selected, ...inherited]);

  // A real inherited value only exists when the task has an inheritance mode at
  // all (projects have none) and there is something to actually inherit.
  const hasRealInheritance = mode !== undefined && inherited.length > 0;
  const isInheriting = mode === "inherit" && hasRealInheritance;
  const activeIds = new Set((isInheriting ? inherited : selected).map((context) => context.id));
  const noContextActive = mode !== undefined && activeIds.size === 0;

  const selectContext = (contextId: number) => {
    const next = new Set(activeIds);
    if (next.has(contextId)) next.delete(contextId);
    else next.add(contextId);
    onChange(mode === undefined ? undefined : "explicit", [...next]);
  };

  return (
    <div className="stack">
      {isInheriting ? (
        <p className="text-muted">
          {strings.contextInheritedFrom}:{" "}
          {inherited.map((context) => context.name).join(", ")}
        </p>
      ) : null}
      {hasRealInheritance && !isInheriting ? (
        <div className="choice-group">
          <button
            type="button"
            className="choice-chip"
            disabled={disabled}
            onClick={() => onChange("inherit", [])}
          >
            {strings.contextInheritFromProject}
          </button>
        </div>
      ) : null}
      {options.length > 0 ? (
        <div className="choice-group" role="group" aria-label={strings.physicalContexts}>
          {mode !== undefined ? (
            <button
              type="button"
              className="choice-chip"
              aria-pressed={noContextActive}
              disabled={disabled}
              onClick={() => onChange("none", [])}
            >
              {strings.noContext}
            </button>
          ) : null}
          {options.map((context) => (
            <button
              key={context.id}
              type="button"
              className="choice-chip"
              aria-pressed={activeIds.has(context.id)}
              disabled={disabled}
              onClick={() => selectContext(context.id)}
            >
              {context.name}
              {!context.active ? ` (${strings.inactive})` : ""}
            </button>
          ))}
        </div>
      ) : (
        <p className="text-muted">{strings.noPhysicalContexts}</p>
      )}
    </div>
  );
}
