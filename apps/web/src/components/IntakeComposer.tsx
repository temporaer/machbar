import { useEffect, useRef, useState } from "react";
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
  onCropPendingFile?: (file: File, onApply: (croppedFile: File) => void, seeded: boolean) => void;
  onCancel: () => void;
}) {
  const strings = useStrings();
  const [text, setText] = useState("");
  const [files, setFiles] = useState<readonly File[]>(
    initialFile ? [initialFile] : [],
  );
  const seededFile = useRef(initialFile);
  useEffect(() => {
    const previous = seededFile.current;
    if (previous === initialFile) return;
    seededFile.current = initialFile;
    setFiles((current) => {
      const index = previous ? current.indexOf(previous) : -1;
      if (index < 0) return initialFile ? [initialFile, ...current] : current;
      if (!initialFile) return current.filter((_, fileIndex) => fileIndex !== index);
      return current.map((file, fileIndex) => fileIndex === index ? initialFile : file);
    });
  }, [initialFile]);
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
      <label className="field">
        <span>{strings.chooseFile}</span>
        <input
          type="file"
          multiple
          onChange={(event) => {
            const selected = Array.from(event.target.files ?? []);
            if (selected.length) setFiles((current) => [...current, ...selected]);
            event.target.value = "";
          }}
        />
      </label>
      <PendingMaterialPreview
        files={files}
        onCrop={onCropPendingFile ? (file, index) => {
          const seeded = file === seededFile.current && index === files.indexOf(seededFile.current);
          onCropPendingFile(file, (croppedFile) => {
            if (seeded && seededFile.current === file) seededFile.current = croppedFile;
            setFiles((current) => current.map((entry, position) =>
              position === index && entry === file ? croppedFile : entry
            ));
          }, seeded);
        } : undefined}
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
