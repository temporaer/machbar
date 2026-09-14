import { useMemo } from "react";
import type { Task } from "@machbar/shared";
import {
  extractCaptionHints,
  removeCaptionHintSpans,
  strongestCaptionHints,
  type ContextCaptionHint,
} from "../lib/captionHints";
import { api } from "../lib/api";
import { useLocale } from "../lib/locale";
import { updatePhysicalContextSelection } from "../lib/physicalContextSelection";
import { useStrings } from "../lib/strings";
import { useTaskActions } from "../lib/useTaskActions";
import { useAsync } from "../lib/useAsync";
import { BottomSheet } from "./BottomSheet";
import { CaptionHintSuggestions } from "./CaptionHintSuggestions";
import { PhysicalContextPicker } from "./PhysicalContextPicker";

/** Focused `task.contexts` editor — the canonical destination regardless of rail/keyboard/detail invocation. */
export function TaskContextsSheet({ task, onClose }: { task: Task; onClose: () => void }) {
  const strings = useStrings();
  const { locale } = useLocale();
  const taskActions = useTaskActions();
  const saving = taskActions.isPending(task.id);
  const { data: homeAssistant } = useAsync(
    () =>
      typeof api.getHomeAssistantStatus === "function"
        ? api.getHomeAssistantStatus()
        : Promise.resolve(null),
    [],
  );
  const hints = useMemo(
    () =>
      strongestCaptionHints(
        extractCaptionHints(task.title, {
          locale,
          referenceDate: new Date(task.createdAt),
          contexts: homeAssistant?.contexts ?? [],
        }).filter(
          (hint): hint is ContextCaptionHint => hint.kind === "context",
        ),
      ),
    [homeAssistant?.contexts, locale, task.createdAt, task.title],
  );

  const acceptHint = (hint: ContextCaptionHint) => {
    const title = removeCaptionHintSpans(task.title, [hint.removalSpan]);
    if (task.effectiveContexts.some((context) => context.id === hint.context.id)) {
      if (title !== task.title) {
        void taskActions.update(task, { title }, { title }, true);
      }
      return;
    }
    const selection = updatePhysicalContextSelection(
      hint.context.id,
      task.explicitContexts,
      task.inheritedContexts,
      task.contextInheritanceMode,
      true,
    );
    if (!selection.mode) return;
    void taskActions.setContexts(
      task,
      selection.mode,
      selection.contextIds,
      title !== task.title ? { title } : {},
    );
  };

  return (
    <BottomSheet
      title={strings.physicalContexts}
      onClose={() => {
        if (!saving) onClose();
      }}
    >
      <div className="stack">
        <p className="text-muted">{task.title}</p>
        <CaptionHintSuggestions
          hints={hints.map((hint) => ({
            key: hint.key,
            label: hint.context.name,
          }))}
          disabled={saving}
          onSelect={(key) => {
            const hint = hints.find((candidate) => candidate.key === key);
            if (hint) acceptHint(hint);
          }}
        />
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
