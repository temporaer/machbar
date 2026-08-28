import { useState } from "react";
import type { Project } from "@machbar/shared";
import { api } from "../lib/api";
import { useStrings } from "../lib/strings";
import { localizedErrorMessage } from "../lib/errorMessage";
import { useAsync } from "../lib/useAsync";
import { ErrorState, LoadingState } from "./AsyncStates";
import { BottomSheet } from "./BottomSheet";
import { TagPicker } from "./TagPicker";

function sameTagIds(left: number[], right: number[]) {
  return left.length === right.length && left.every((id) => right.includes(id));
}

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
  const initialTagIds = story.tags.map((tag) => tag.id);
  const [selectedIds, setSelectedIds] = useState(initialTagIds);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const { data: tags, loading, error, reload } = useAsync(() => api.getTags(), []);
  const unchanged = sameTagIds(selectedIds, initialTagIds);

  const submit = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      await onSave(selectedIds);
      onClose();
    } catch (cause) {
      setSaveError(localizedErrorMessage(cause, strings));
    } finally {
      setSaving(false);
    }
  };

  return (
    <BottomSheet title={strings.tags} onClose={onClose} labelledBy="project-tags-title">
      <div className="stack">
        <p className="text-muted">{story.title}</p>
        {loading ? <LoadingState /> : null}
        {error ? <ErrorState message={error} onRetry={reload} /> : null}
        {tags ? <TagPicker tags={tags} selectedIds={selectedIds} onChange={setSelectedIds} /> : null}
        {saveError ? (
          <p role="alert" style={{ color: "var(--color-danger)" }}>
            {saveError}
          </p>
        ) : null}
        <div className="row">
          <button type="button" className="btn" disabled={saving} onClick={onClose}>
            {strings.cancel}
          </button>
          <button
            type="button"
            className="btn btn-primary btn-block"
            disabled={loading || Boolean(error) || unchanged || saving}
            onClick={() => void submit()}
          >
            {strings.save}
          </button>
        </div>
      </div>
    </BottomSheet>
  );
}
