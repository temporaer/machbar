import { useMemo, useState } from "react";
import type { Task } from "@machbar/shared";
import { api } from "../lib/api";
import { useStrings } from "../lib/strings";
import { useTaskActions } from "../lib/useTaskActions";
import { localizedErrorMessage } from "../lib/errorMessage";
import { useAsync } from "../lib/useAsync";
import { ErrorState, LoadingState } from "./AsyncStates";
import { BottomSheet } from "./BottomSheet";
import { TagPicker } from "./TagPicker";
import { TagChip } from "./TagChip";

/** Focused `task.tags` editor — the canonical destination regardless of rail/keyboard/detail invocation. */
export function TaskTagsSheet({ task, onClose }: { task: Task; onClose: () => void }) {
  const strings = useStrings();
  const taskActions = useTaskActions();
  const { data: tags, loading, error, reload } = useAsync(() => api.getTags(), []);
  const [saveError, setSaveError] = useState<string | null>(null);
  const saving = taskActions.isPending(task.id);

  const inheritedTags = useMemo(() => {
    const explicitIds = new Set(task.explicitTags.map((tag) => tag.id));
    return task.inheritedTags.filter((tag) => !explicitIds.has(tag.id));
  }, [task]);

  const change = async (tagIds: number[]) => {
    setSaveError(null);
    try {
      await taskActions.update(task, { tagIds }, undefined, true);
    } catch (cause) {
      setSaveError(localizedErrorMessage(cause, strings));
    }
  };

  const toggleExclude = async (tagId: number, excluded: boolean) => {
    setSaveError(null);
    try {
      await taskActions.update(
        task,
        {
          excludedTagIds: excluded
            ? task.excludedTagIds.filter((id) => id !== tagId)
            : [...task.excludedTagIds, tagId],
        },
        undefined,
        true,
      );
    } catch (cause) {
      setSaveError(localizedErrorMessage(cause, strings));
    }
  };

  return (
    <BottomSheet
      title={strings.tags}
      onClose={() => {
        if (!saving) onClose();
      }}
    >
      <div className="stack">
        <p className="text-muted">{task.title}</p>
        {loading ? <LoadingState /> : null}
        {error ? <ErrorState message={error} onRetry={reload} /> : null}
        {inheritedTags.length > 0 ? (
          <div className="field">
            <label>{strings.inherited}</label>
            <div className="row" style={{ flexWrap: "wrap" }}>
              {inheritedTags.map((tag) => {
                const excluded = task.excludedTagIds.includes(tag.id);
                return (
                  <TagChip
                    key={tag.id}
                    tag={tag}
                    excluded={excluded}
                    onToggleExclude={() => void toggleExclude(tag.id, excluded)}
                  />
                );
              })}
            </div>
          </div>
        ) : null}
        {tags ? (
          <TagPicker
            tags={tags}
            selectedIds={task.explicitTags.map((tag) => tag.id)}
            hiddenIds={inheritedTags.map((tag) => tag.id)}
            onChange={(tagIds) => void change(tagIds)}
          />
        ) : null}
        {saveError ? (
          <div className="task-row-error" role="alert">
            {saveError}
          </div>
        ) : null}
        <button type="button" className="btn" disabled={saving} onClick={onClose}>
          {strings.close}
        </button>
      </div>
    </BottomSheet>
  );
}
