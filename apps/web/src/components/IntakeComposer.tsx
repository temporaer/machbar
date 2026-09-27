import { useState } from "react";
import { useStrings } from "../lib/strings";
import { useStartIntake } from "../lib/useStartIntake";
import { PendingMaterialPreview } from "./PendingMaterialPreview";

export function IntakeComposer({
  initialFile = null,
  defaultScope,
  onCropPendingFile,
  onCancel,
}: {
  initialFile?: File | null;
  defaultScope?: "work";
  onCropPendingFile?: (file: File) => void;
  onCancel: () => void;
}) {
  const strings = useStrings();
  const [text, setText] = useState("");
  const [files, setFiles] = useState<readonly File[]>(
    initialFile ? [initialFile] : [],
  );
  const { start, pending, error } = useStartIntake();
  const disabled = pending || (!text.trim() && files.length === 0);
  return (
    <div className="stack intake-composer">
      <label className="field">
        <span>{strings.intakeTextLabel}</span>
        <textarea
          value={text}
          placeholder={strings.intakeTextPlaceholder}
          onChange={(event) => setText(event.target.value)}
          rows={6}
        />
      </label>
      <PendingMaterialPreview
        files={files}
        onCrop={onCropPendingFile ? (file) => onCropPendingFile(file) : undefined}
      />
      {error ? <p className="capture-error" role="alert">{error}</p> : null}
      <div className="row">
        <button
          type="button"
          className="btn btn-primary"
          disabled={disabled}
          onClick={() => void start({ text, files, ...(defaultScope ? { scope: defaultScope } : {}) })}
        >
          {pending ? strings.intakeStarting : strings.intakeProcess}
        </button>
        <button type="button" className="btn" disabled={pending} onClick={onCancel}>
          {strings.cancel}
        </button>
      </div>
    </div>
  );
}
