import { useCallback, useEffect, useMemo, useState } from "react";
import { availableCommandDescriptors } from "../lib/commandRegistry";
import type { CommandGroup } from "../lib/commandRegistry";
import { useInteractionScope } from "../lib/interactionScope";
import { useStrings } from "../lib/strings";
import { BottomSheet } from "./BottomSheet";

const groupOrder: CommandGroup[] = [
  "navigation",
  "capture",
  "task",
  "structure",
  "help",
];

export function CommandHelpSheet() {
  const strings = useStrings();
  const scope = useInteractionScope();
  const [open, setOpen] = useState(false);
  const openHelp = useCallback(() => setOpen(true), []);

  useEffect(() => {
    scope.setHelpOpen(() => openHelp);
    return () => scope.setHelpOpen(null);
  }, [scope, openHelp]);

  const groups = useMemo(() => {
    const descriptors = availableCommandDescriptors(scope);
    return groupOrder
      .map((group) => ({
        group,
        commands: descriptors.filter((descriptor) => descriptor.group === group),
      }))
      .filter((entry) => entry.commands.length > 0);
  }, [scope]);

  if (!open) return null;

  return (
    <BottomSheet
      title={strings.keyboardHelp}
      onClose={() => setOpen(false)}
      labelledBy="command-help-title"
    >
      <div className="command-help">
        {groups.map(({ group, commands }) => (
          <section key={group} className="command-help-group">
            <h3>{strings.commandGroupLabels[group]}</h3>
            <dl>
              {commands.map((command) => (
                <div key={command.id} className="command-help-row">
                  <dt>{command.keys.join(", ")}</dt>
                  <dd>{command.label(strings)}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </BottomSheet>
  );
}
