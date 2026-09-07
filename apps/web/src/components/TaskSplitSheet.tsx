import { useRef, useState } from "react";
import { api } from "../lib/api";
import { localizedErrorMessage } from "../lib/errorMessage";
import { useIdentity } from "../lib/identity";
import { useRefresh } from "../lib/refresh";
import { useStrings } from "../lib/strings";
import { BottomSheet } from "./BottomSheet";

function parseTitles(value: string): string[] {
  return value.split(/\r?\n/).map((title) => title.trim()).filter(Boolean);
}

export function TaskSplitSheet({
  parentId,
  onClose,
}: {
  parentId: number;
  onClose: () => void;
}) {
  const strings = useStrings();
  const { currentMemberId } = useIdentity();
  const { bump } = useRefresh();
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const titles = parseTitles(value);

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
        className="stack"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="field">
          <label htmlFor={`split-task-${parentId}`}>{strings.splitTaskSteps}</label>
          <textarea
            id={`split-task-${parentId}`}
            autoFocus
            rows={7}
            value={value}
            placeholder={strings.splitTaskPlaceholder}
            disabled={saving}
            onChange={(event) => setValue(event.target.value)}
          />
          <p className="text-muted">{strings.splitTaskHint}</p>
        </div>
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
