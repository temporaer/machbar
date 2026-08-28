import { useRef, useState } from "react";
import { api } from "../lib/api";
import { useStrings } from "../lib/strings";
import { localizedErrorMessage } from "../lib/errorMessage";
import { useIdentity } from "../lib/identity";
import { useRefresh } from "../lib/refresh";
import { BottomSheet } from "./BottomSheet";

function parseTitles(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((title) => title.trim())
    .filter(Boolean);
}

export function TaskSequenceSheet({
  projectId,
  onClose,
}: {
  projectId: number;
  onClose: () => void;
}) {
  const strings = useStrings();
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const { currentMemberId } = useIdentity();
  const { bump } = useRefresh();
  const titles = parseTitles(value);

  const submit = async () => {
    if (savingRef.current || titles.length < 2) return;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      await api.createTaskSequence(projectId, {
        titles,
        createdByMemberId: currentMemberId,
      });
      bump();
      onClose();
    } catch (err) {
      setError(localizedErrorMessage(err, strings));
      savingRef.current = false;
      setSaving(false);
    }
  };

  return (
    <BottomSheet
      title={strings.addSequence}
      onClose={onClose}
      labelledBy="task-sequence-title"
    >
      <form
        className="stack"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="field">
          <label htmlFor="task-sequence-steps">{strings.sequenceSteps}</label>
          <textarea
            id="task-sequence-steps"
            autoFocus
            rows={8}
            value={value}
            placeholder={strings.sequencePlaceholder}
            disabled={saving}
            onChange={(event) => setValue(event.target.value)}
          />
          <p className="text-muted">{strings.sequenceHint}</p>
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
          <button
            type="submit"
            className="btn btn-primary btn-block"
            disabled={saving || titles.length < 2}
          >
            {strings.addSequenceCount(titles.length)}
          </button>
        </div>
      </form>
    </BottomSheet>
  );
}
