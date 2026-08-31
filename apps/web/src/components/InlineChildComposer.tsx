import { useStrings } from "../lib/strings";
import { useRefresh } from "../lib/refresh";
import { useIdentity } from "../lib/identity";
import { api } from "../lib/api";
import { InlineTaskComposer } from "./InlineTaskComposer";

export interface InlineChildComposerProps {
  /** The task this composer creates a direct child of — any depth, not just root tasks. */
  parentId: number;
  /** Cancel/dismiss without ever calling the API — no mutation happens. */
  onCancel: () => void;
  /**
   * Called once the child task was created successfully (after the refresh
   * bus was already bumped). The caller owns expanding its own collapsed
   * state and returning focus, since that state lives outside this component.
   */
  onCreated: () => void;
}

/**
 * Small inline composer rendered directly beneath a `TaskRow`, as an
 * alternative to opening the full `TaskDetailSheet` just to add a subtask.
 * Mirrors the focused quick-edit sheets (see `TaskQuickActionSheet`) in
 * spirit — a single field, save/cancel, errors stay visible — but renders
 * in place instead of as a sheet.
 */
export function InlineChildComposer({ parentId, onCancel, onCreated }: InlineChildComposerProps) {
  const strings = useStrings();
  const { currentMemberId } = useIdentity();
  const { bump } = useRefresh();

  const create = async (title: string) => {
    await api.createChildTask(parentId, {
      title,
      createdByMemberId: currentMemberId,
      status: "actionable",
    });
    bump();
    onCreated();
  };

  return (
    <InlineTaskComposer
      inputId={`inline-child-title-${parentId}`}
      label={strings.addChildTitle}
      placeholder={strings.addChildTitle}
      onCancel={onCancel}
      onSave={create}
    />
  );
}
