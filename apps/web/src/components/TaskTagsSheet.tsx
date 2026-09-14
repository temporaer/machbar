import { useMemo, useState } from "react";
import type { Task } from "@machbar/shared";
import {
  extractCaptionHints,
  removeCaptionHintSpans,
  strongestCaptionHints,
  type TagCaptionHint,
} from "../lib/captionHints";
import { api } from "../lib/api";
import { useLocale } from "../lib/locale";
import { useStrings } from "../lib/strings";
import { useTaskActions } from "../lib/useTaskActions";
import { localizedErrorMessage } from "../lib/errorMessage";
import { useAsync } from "../lib/useAsync";
import { ErrorState, LoadingState } from "./AsyncStates";
import { BottomSheet } from "./BottomSheet";
import { CaptionHintSuggestions } from "./CaptionHintSuggestions";
import { TagPicker } from "./TagPicker";
import { TagChip } from "./TagChip";

/** Focused `task.tags` editor — the canonical destination regardless of rail/keyboard/detail invocation. */
export function TaskTagsSheet({ task, onClose }: { task: Task; onClose: () => void }) {
  const strings = useStrings();
  const { locale } = useLocale();
  const taskActions = useTaskActions();
  const { data: tags, loading, error, reload } = useAsync(() => api.getTags(), []);
  const [saveError, setSaveError] = useState<string | null>(null);
  const saving = taskActions.isPending(task.id);
  const hints = useMemo(
    () =>
      strongestCaptionHints(
        extractCaptionHints(task.title, {
          locale,
          referenceDate: new Date(task.createdAt),
          tags: tags ?? [],
        }).filter((hint): hint is TagCaptionHint => hint.kind === "tag"),
      ),
    [locale, tags, task.createdAt, task.title],
  );

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

  const acceptHint = async (hint: TagCaptionHint) => {
    setSaveError(null);
    try {
      const inherited = task.inheritedTags.some((tag) => tag.id === hint.tag.id);
      const tagIds = inherited
        ? task.explicitTags.map((tag) => tag.id)
        : [
            ...new Set([
              ...task.explicitTags.map((tag) => tag.id),
              hint.tag.id,
            ]),
          ];
      const title = removeCaptionHintSpans(task.title, [hint.removalSpan]);
      await taskActions.update(
        task,
        {
          tagIds,
          ...(inherited && task.excludedTagIds.includes(hint.tag.id)
            ? {
                excludedTagIds: task.excludedTagIds.filter(
                  (id) => id !== hint.tag.id,
                ),
              }
            : {}),
          ...(title !== task.title ? { title } : {}),
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
        <CaptionHintSuggestions
          hints={hints.map((hint) => ({ key: hint.key, label: hint.tag.name }))}
          disabled={saving}
          onSelect={(key) => {
            const hint = hints.find((candidate) => candidate.key === key);
            if (hint) void acceptHint(hint);
          }}
        />
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
