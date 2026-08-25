import { useState } from "react";
import { useIdentity } from "../lib/identity";
import { useRefresh } from "../lib/refresh";
import { api } from "../lib/api";
import { strings } from "../lib/strings";
import { BottomSheet } from "./BottomSheet";

/**
 * Global quick-add: a single always-reachable floating button. Essential
 * because task creation must not depend on navigating into a specific
 * project or list first — a bare title is enough and the task lands in
 * Eingang (inbox) for later clarification/refile.
 */
export function QuickAdd({ projectId, parentTaskId }: { projectId?: number | null; parentTaskId?: number | null }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [saving, setSaving] = useState(false);
  const { currentMemberId } = useIdentity();
  const { bump } = useRefresh();

  const close = () => {
    setOpen(false);
    setTitle("");
  };

  const submit = async () => {
    const trimmed = title.trim();
    if (!trimmed) return;
    setSaving(true);
    try {
      await api.createTask({
        title: trimmed,
        projectId: projectId ?? null,
        parentTaskId: parentTaskId ?? null,
        createdByMemberId: currentMemberId,
        status: "actionable",
        needsClarification: projectId == null && parentTaskId == null,
      });
      bump();
      close();
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <button
        type="button"
        className="quick-add-fab"
        onClick={() => setOpen(true)}
        aria-label={strings.quickAdd}
      >
        +
      </button>
      {open ? (
        <BottomSheet title={strings.quickAdd} onClose={close} labelledBy="quick-add-title">
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <div className="field">
              <label htmlFor="quick-add-input">{strings.titleEnough}</label>
              <input
                id="quick-add-input"
                autoFocus
                value={title}
                placeholder={strings.quickAddPlaceholder}
                onChange={(e) => setTitle(e.target.value)}
              />
            </div>
            <div className="row">
              <button type="button" className="btn" onClick={close}>
                {strings.cancel}
              </button>
              <button type="submit" className="btn btn-primary btn-block" disabled={saving || !title.trim()}>
                {strings.save}
              </button>
            </div>
          </form>
        </BottomSheet>
      ) : null}
    </>
  );
}
