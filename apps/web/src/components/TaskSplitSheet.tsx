import { useRef, useState } from "react";
import { api } from "../lib/api";
import { localizedErrorMessage } from "../lib/errorMessage";
import { useIdentity } from "../lib/identity";
import { useRefresh } from "../lib/refresh";
import { useStrings } from "../lib/strings";
import { BottomSheet } from "./BottomSheet";
import { IconActionButton } from "./IconActionButton";

/**
 * The one canonical `task.split` workflow — a small mini-outliner, not a
 * multiline textarea. One row per child task; `Enter` on the last
 * non-empty row opens the next empty row, an always-available empty
 * trailing row lets typing continue, and each populated row can be
 * removed individually. Submitting creates every child as one coherent
 * user transaction (sequential `createChildTask` calls under the hood,
 * since the API has no batch-create endpoint).
 */
export function TaskSplitSheet({
  parentId,
  parentTitle,
  onClose,
}: {
  parentId: number;
  parentTitle?: string;
  onClose: () => void;
}) {
  const strings = useStrings();
  const { currentMemberId } = useIdentity();
  const { bump } = useRefresh();
  const [rows, setRows] = useState<string[]>([""]);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);

  const titles = rows.map((row) => row.trim()).filter(Boolean);

  const focusRow = (index: number) => {
    requestAnimationFrame(() => inputRefs.current[index]?.focus());
  };

  const setRow = (index: number, value: string) => {
    setRows((prev) => {
      const next = [...prev];
      next[index] = value;
      if (index === next.length - 1 && value.trim() !== "") next.push("");
      return next;
    });
  };

  const removeRow = (index: number) => {
    setRows((prev) => {
      if (prev.length <= 1) return [""];
      const next = prev.filter((_, i) => i !== index);
      return next.length === 0 ? [""] : next;
    });
    focusRow(Math.max(0, index - 1));
  };

  const submit = async () => {
    if (savingRef.current || titles.length === 0) return;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      for (const title of titles) {
        await api.createChildTask(parentId, {
          title,
          createdByMemberId: currentMemberId,
          status: "actionable",
        });
      }
      bump();
      onClose();
    } catch (err) {
      setError(localizedErrorMessage(err, strings));
      savingRef.current = false;
      setSaving(false);
    }
  };

  return (
    <BottomSheet title={strings.splitTask} onClose={() => !saving && onClose()}>
      <form
        className="stack task-split-outliner"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {parentTitle ? <p className="text-muted">{parentTitle}</p> : null}
        {rows.map((row, index) => (
          <div className="row task-split-row" key={index}>
            <input
              ref={(el) => {
                inputRefs.current[index] = el;
              }}
              type="text"
              value={row}
              autoFocus={index === 0}
              placeholder={strings.splitTaskRowPlaceholder}
              disabled={saving}
              onChange={(event) => setRow(index, event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  if (row.trim() !== "" && index === rows.length - 1) {
                    setRows((prev) => [...prev, ""]);
                    focusRow(index + 1);
                  } else if (index < rows.length - 1) {
                    focusRow(index + 1);
                  }
                } else if (event.key === "Backspace" && row === "" && rows.length > 1) {
                  event.preventDefault();
                  removeRow(index);
                }
              }}
            />
            {row.trim() !== "" ? (
              <IconActionButton
                kind="close"
                label={strings.removeStep}
                onClick={() => removeRow(index)}
              />
            ) : null}
          </div>
        ))}
        {error ? (
          <div className="task-row-error" role="alert">
            <span>{strings.error}</span>
            <span className="text-muted">{error}</span>
          </div>
        ) : null}
        <div className="row">
          <button type="button" className="btn" disabled={saving} onClick={onClose}>
            {strings.cancel}
          </button>
          <button type="submit" className="btn btn-primary" disabled={saving || titles.length === 0}>
            {strings.splitTaskCount(titles.length)}
          </button>
        </div>
      </form>
    </BottomSheet>
  );
}
