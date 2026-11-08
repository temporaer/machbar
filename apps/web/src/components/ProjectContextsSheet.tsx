import type { ProjectWithActions } from "../lib/api";
import { api } from "../lib/api";
import { useStrings } from "../lib/strings";
import { useProjectActions } from "../lib/useProjectActions";
import { useAsync } from "../lib/useAsync";
import { BottomSheet, type BottomSheetPresentationProps } from "./BottomSheet";
import { PhysicalContextPicker } from "./PhysicalContextPicker";

/** Focused project/story physical-contexts editor. */
export function ProjectContextsSheet({
  story,
  onClose,
  ...presentation
}: {
  story: ProjectWithActions;
  onClose: () => void;
} & BottomSheetPresentationProps) {
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
      {...presentation}
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
