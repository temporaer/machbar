import type { ProjectWithActions } from "../lib/api";
import { api } from "../lib/api";
import { useStrings } from "../lib/strings";
import { useProjectActions } from "../lib/useProjectActions";
import { useAsync } from "../lib/useAsync";
import { BottomSheet } from "./BottomSheet";
import { PhysicalContextPicker } from "./PhysicalContextPicker";

/** Focused project/story physical-contexts editor. */
export function ProjectContextsSheet({
  story,
  onClose,
}: {
  story: ProjectWithActions;
  onClose: () => void;
}) {
  const strings = useStrings();
  const projectActions = useProjectActions([story]);
  const saving = projectActions.isPending(story.id);
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
        <p className="text-muted">{story.title}</p>
        <PhysicalContextPicker
          contexts={homeAssistant?.contexts ?? []}
          selected={story.contexts}
          inherited={[]}
          disabled={saving}
          onChange={(_, contextIds) => {
            void projectActions.setContexts(story, contextIds);
          }}
        />
        <button type="button" className="btn" disabled={saving} onClick={onClose}>
          {strings.close}
        </button>
      </div>
    </BottomSheet>
  );
}
