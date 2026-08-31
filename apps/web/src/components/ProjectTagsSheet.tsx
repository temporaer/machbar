import { useState } from "react";
import type { Project } from "@machbar/shared";
import { api } from "../lib/api";
import { useStrings } from "../lib/strings";
import { localizedErrorMessage } from "../lib/errorMessage";
import { useAsync } from "../lib/useAsync";
import { ErrorState, LoadingState } from "./AsyncStates";
import { BottomSheet } from "./BottomSheet";
import { TagPicker } from "./TagPicker";

/** Focused project-tag editor used directly from a project row. */
export function ProjectTagsSheet({
  story,
  onClose,
  onSave,
}: {
  story: Project;
  onClose: () => void;
  onSave: (tagIds: number[]) => Promise<void>;
}) {
  const strings = useStrings();
  const [selectedIds, setSelectedIds] = useState(
    story.tags.map((tag) => tag.id),
  );
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const { data: tags, loading, error, reload } = useAsync(() => api.getTags(), []);
  const change = async (nextIds: number[]) => {
    if (saving) return;
    const previousIds = selectedIds;
    setSelectedIds(nextIds);
    setSaving(true);
    setSaveError(null);
    try {
      await onSave(nextIds);
    } catch (cause) {
      setSelectedIds(previousIds);
      setSaveError(localizedErrorMessage(cause, strings));
    } finally {
      setSaving(false);
    }
  };

  return (
    <BottomSheet
      title={strings.tags}
      onClose={() => {
        if (!saving) onClose();
      }}
      labelledBy="project-tags-title"
    >
      <div className="stack">
        <p className="text-muted">{story.title}</p>
        {loading ? <LoadingState /> : null}
        {error ? <ErrorState message={error} onRetry={reload} /> : null}
        {tags ? (
          <TagPicker
            tags={tags}
            selectedIds={selectedIds}
            onChange={(nextIds) => void change(nextIds)}
          />
        ) : null}
        {saveError ? (
          <p role="alert" style={{ color: "var(--color-danger)" }}>
            {saveError}
          </p>
        ) : null}
        <button type="button" className="btn" disabled={saving} onClick={onClose}>
          {strings.close}
        </button>
      </div>
    </BottomSheet>
  );
}
