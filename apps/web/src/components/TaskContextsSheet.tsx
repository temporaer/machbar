import type { Task } from "@machbar/shared";
import { api } from "../lib/api";
import { useStrings } from "../lib/strings";
import { useTaskActions } from "../lib/useTaskActions";
import { useAsync } from "../lib/useAsync";
import { BottomSheet } from "./BottomSheet";
import { PhysicalContextPicker } from "./PhysicalContextPicker";

/** Focused `task.contexts` editor — the canonical destination regardless of rail/keyboard/detail invocation. */
export function TaskContextsSheet({ task, onClose }: { task: Task; onClose: () => void }) {
  const strings = useStrings();
  const taskActions = useTaskActions();
  const saving = taskActions.isPending(task.id);
  const { data: homeAssistant } = useAsync(
    () =>
      typeof api.getHomeAssistantStatus === "function"
        ? api.getHomeAssistantStatus()
        : Promise.resolve(null),
    [],
  );

  return (
    <BottomSheet
      title={strings.physicalContexts}
      onClose={() => {
        if (!saving) onClose();
      }}
    >
      <div className="stack">
        <p className="text-muted">{task.title}</p>
        <PhysicalContextPicker
          contexts={homeAssistant?.contexts ?? []}
          selected={task.explicitContexts}
          inherited={task.inheritedContexts}
          mode={task.contextInheritanceMode}
          disabled={saving}
          onChange={(mode, contextIds) => {
            if (mode) void taskActions.setContexts(task, mode, contextIds);
          }}
        />
        <button type="button" className="btn" disabled={saving} onClick={onClose}>
          {strings.close}
        </button>
      </div>
    </BottomSheet>
  );
}
