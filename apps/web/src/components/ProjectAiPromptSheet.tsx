import { useEffect, useState } from "react";
import { useBeforeUnload, useBlocker } from "react-router-dom";
import type { ProjectMaterialItem } from "../lib/projectMaterials";
import { buildProjectAiPromptText } from "../lib/projectAiPrompt";
import { localizedErrorMessage } from "../lib/errorMessage";
import { useStrings } from "../lib/strings";
import { BottomSheet } from "./BottomSheet";
import { NativeShareButton } from "./NativeShareButton";

export function ProjectAiPromptSheet({
  projectTitle,
  materials,
  onClose,
}: {
  projectTitle: string;
  materials: readonly ProjectMaterialItem[];
  onClose: () => void;
}) {
  const strings = useStrings();
  const [prompt, setPrompt] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<number>>(() => new Set());
  const [status, setStatus] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const selectedMaterials = materials.filter(({ task }) => selectedIds.has(task.id));
  const markdown = buildProjectAiPromptText(prompt, selectedMaterials);
  const canShare = markdown.trim().length > 0;
  const hasDraft = prompt.length > 0 || selectedIds.size > 0;
  const navigationBlocker = useBlocker(hasDraft);
  useBeforeUnload((event) => {
    if (hasDraft) event.preventDefault();
  });

  const keepEditing = () => {
    setConfirmDiscard(false);
    if (navigationBlocker.state === "blocked") navigationBlocker.reset();
  };
  const discard = () => {
    setConfirmDiscard(false);
    if (navigationBlocker.state === "blocked") navigationBlocker.proceed();
    onClose();
  };
  const requestClose = () => {
    if (confirmDiscard) keepEditing();
    else if (hasDraft) setConfirmDiscard(true);
    else onClose();
  };
  useEffect(() => {
    if (navigationBlocker.state === "blocked") setConfirmDiscard(true);
  }, [navigationBlocker.state]);

  const copy = async () => {
    setStatus(null);
    try {
      if (!navigator.clipboard?.writeText) throw new Error(strings.clipboardUnavailable);
      await navigator.clipboard.writeText(markdown);
      setStatus(strings.reflectionCopied);
    } catch (cause) {
      setStatus(localizedErrorMessage(cause, strings));
    }
  };

  return (
    <BottomSheet title={strings.projectAiPromptTitle} onClose={requestClose}>
      <div className="stack">
        <label className="field">
          <span>{strings.projectAiPromptInstruction}</span>
          <textarea
            aria-label={strings.projectAiPromptInstruction}
            rows={5}
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
          />
        </label>
        <fieldset className="stack">
          <legend>{strings.projectAiPromptMaterial}</legend>
          {materials.length ? materials.map(({ task, parentTitles }) => (
            <label key={task.id} className="row">
              <input
                type="checkbox"
                checked={selectedIds.has(task.id)}
                onChange={(event) => setSelectedIds((current) => {
                  const next = new Set(current);
                  if (event.target.checked) next.add(task.id);
                  else next.delete(task.id);
                  return next;
                })}
              />
              <span>
                {task.title}
                {parentTitles.length ? <span className="text-muted"> · {parentTitles.join(" › ")}</span> : null}
              </span>
            </label>
          )) : <p className="text-muted">{strings.projectAiPromptNoMaterial}</p>}
        </fieldset>
        <div className="row">
          <button type="button" className="btn btn-primary" disabled={!canShare} onClick={() => void copy()}>
            {strings.reflectionCopy}
          </button>
          <NativeShareButton
            title={`${strings.projectAiPromptTitle}: ${projectTitle}`}
            text={markdown}
            disabled={!canShare}
            showLabel
            actionLabel={strings.projectAiPromptShare}
          />
        </div>
        {status ? <p className="text-muted" role="status">{status}</p> : null}
      </div>
      {confirmDiscard ? (
        <BottomSheet
          title={strings.projectAiPromptDiscardTitle}
          initialFocus="first-control"
          stackPriority={2}
          onClose={keepEditing}
        >
          <div className="stack">
            <p>{strings.projectAiPromptDiscardWarning}</p>
            <div className="row">
              <button type="button" className="btn" onClick={keepEditing}>
                {strings.projectAiPromptKeepEditing}
              </button>
              <button type="button" className="btn" onClick={discard}>
                {strings.discard}
              </button>
            </div>
          </div>
        </BottomSheet>
      ) : null}
    </BottomSheet>
  );
}
