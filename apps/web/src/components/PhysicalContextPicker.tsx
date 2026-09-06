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
  const selectedIds = new Set(selected.map((context) => context.id));

  return (
    <div className="stack">
      {mode !== undefined ? (
        <div className="choice-group" role="group" aria-label={strings.physicalContexts}>
          {(["inherit", "explicit", "none"] as const).map((value) => (
            <button
              key={value}
              type="button"
              className="choice-chip"
              aria-pressed={mode === value}
              disabled={disabled}
              onClick={() =>
                onChange(value, value === "explicit" ? [...selectedIds] : [])
              }
            >
              {strings.contextModeLabels[value]}
            </button>
          ))}
        </div>
      ) : null}
      {mode === "inherit" && inherited.length > 0 ? (
        <p className="text-muted">
          {strings.contextInheritedFrom}:{" "}
          {inherited.map((context) => context.name).join(", ")}
        </p>
      ) : null}
      {mode === undefined || mode === "explicit" ? (
        options.length > 0 ? (
          <div className="choice-group">
            {options.map((context) => (
              <button
                key={context.id}
                type="button"
                className="choice-chip"
                aria-pressed={selectedIds.has(context.id)}
                disabled={disabled}
                onClick={() => {
                  const next = new Set(selectedIds);
                  if (next.has(context.id)) next.delete(context.id);
                  else next.add(context.id);
                  onChange(mode, [...next]);
                }}
              >
                {context.name}
                {!context.active ? ` (${strings.inactive})` : ""}
              </button>
            ))}
          </div>
        ) : (
          <p className="text-muted">{strings.noPhysicalContexts}</p>
        )
      ) : null}
    </div>
  );
}
