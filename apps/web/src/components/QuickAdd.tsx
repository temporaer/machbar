import { useCallback, useEffect, useRef, useState, type ChangeEvent } from "react";
import { useRefresh } from "../lib/refresh";
import { useStrings } from "../lib/strings";
import { BottomSheet } from "./BottomSheet";
import { CaptureForm } from "./CaptureForm";
import { appendTextBlock } from "../lib/shareTarget";
import {
  uploadPaperlessFile,
  type UploadedPaperlessAttachment,
} from "../lib/paperlessAttachments";
import { ImageCropSheet } from "./ImageCropSheet";
import { CameraCaptureSheet } from "./CameraCaptureSheet";
import { useOptionalInteractionScope } from "../lib/interactionScope";
import { IntakeComposer } from "./IntakeComposer";
import { useWorkItemCommands } from "../lib/useWorkItemCommands";

/**
 * Global quick-add: a single always-reachable floating button. Essential
 * because task creation must not depend on navigating into a specific
 * project or list first — a bare title is enough and the task lands in
 * Eingang (inbox) for later clarification/refile.
 */
export function QuickAdd({
  autoOpen = false,
  onAutoOpenClose,
  defaultScope,
}: {
  autoOpen?: boolean;
  onAutoOpenClose?: (captured?: boolean) => void;
  /** Set on capture only when the mounting page's active view is the Work
   * scope; omitted (server default `"household"` applies) otherwise. */
  defaultScope?: "work";
}) {
  const strings = useStrings();
  // Contextual capture target: whichever `InteractionScopeProvider` this
  // `QuickAdd` instance is mounted inside of (a project/story outline
  // declares `captureTarget: {kind:"story", storyId}`; every compiled
  // view -- Today, Inbox -- leaves it at the default `{kind:"inbox"}`).
  // Replaces the previous `projectId`/`parentTaskId` props every caller
  // had to thread through by hand; every production `QuickAdd` mount
  // already sat inside a scope whose `captureTarget` said exactly the
  // same thing those props did.
  const scope = useOptionalInteractionScope();
  const dispatch = useWorkItemCommands();
  const projectId =
    scope?.captureTarget.kind === "story" ? scope.captureTarget.storyId : null;
  const [open, setOpen] = useState(autoOpen);
  const [captureStep, setCaptureStep] = useState<"form" | "intake">("form");
  const [captureFormKey, setCaptureFormKey] = useState(0);
  const [latestCapture, setLatestCapture] = useState<{
    id: number;
    title: string;
  } | null>(null);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [cropTarget, setCropTarget] = useState<{
    file: File;
    onApply?: (croppedFile: File) => void;
  } | null>(null);
  const [cameraOpen, setCameraOpen] = useState(false);
  const cameraRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const uploadedAttachmentRef =
    useRef<Promise<UploadedPaperlessAttachment> | null>(null);
  const { bump } = useRefresh();
  const openCapture = useCallback(() => {
    setCaptureStep("form");
    setOpen(true);
  }, []);

  useEffect(() => {
    if (autoOpen) {
      setCaptureStep("form");
      setOpen(true);
    }
  }, [autoOpen]);

  useEffect(() => {
    if (!scope) return undefined;
    scope.setCaptureOpen(() => openCapture);
    return () => scope.setCaptureOpen(null);
  }, [scope, openCapture]);

  const close = (captured = false) => {
    setOpen(false);
    setCaptureStep("form");
    setPendingFile(null);
    setCropTarget(null);
    setCameraOpen(false);
    uploadedAttachmentRef.current = null;
    if (autoOpen) onAutoOpenClose?.(captured);
  };

  const selectMaterial = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setPendingFile(file);
    uploadedAttachmentRef.current = null;
    setCaptureStep("form");
  };

  const prepareMaterialNotes = async (notes: string) => {
    if (!pendingFile) return notes;
    if (!uploadedAttachmentRef.current) {
      const upload = uploadPaperlessFile(pendingFile);
      uploadedAttachmentRef.current = upload;
      void upload.catch(() => {
        if (uploadedAttachmentRef.current === upload) {
          uploadedAttachmentRef.current = null;
        }
      });
    }
    const attachment = await uploadedAttachmentRef.current;
    if (!attachment) return notes;
    return appendTextBlock(notes, attachment.markdown);
  };

  return (
    <>
      <button
        type="button"
        className="quick-add-fab"
        onClick={() => {
          openCapture();
        }}
        aria-label={strings.quickAdd}
      >
        +
      </button>
      {open ? (
        <BottomSheet title={strings.quickAdd} onClose={close} labelledBy="quick-add-title">
          <input
            ref={cameraRef}
            className="visually-hidden"
            type="file"
            accept="image/*"
            capture="environment"
            aria-label={strings.takePhoto}
            onChange={selectMaterial}
          />
          <input
            ref={fileRef}
            className="visually-hidden"
            type="file"
            aria-label={captureStep === "form" ? strings.chooseFile : strings.captureFile}
            onChange={selectMaterial}
          />
          {latestCapture ? (
            <div className="quick-add-captured" role="status" aria-live="polite">
              <span>{strings.captureSaved(latestCapture.title)}</span>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => {
                  const taskId = latestCapture.id;
                  close(true);
                  dispatch({ type: "task.open", taskId });
                }}
              >
                {strings.openCapturedItem}
              </button>
            </div>
          ) : null}
          {captureStep === "intake" ? (
            <IntakeComposer
              initialFile={pendingFile}
              {...(defaultScope ? { defaultScope } : {})}
              onCropPendingFile={(file, onApply, seeded) => setCropTarget({
                file,
                onApply: (croppedFile) => {
                  onApply(croppedFile);
                  if (seeded) {
                    setPendingFile(croppedFile);
                    uploadedAttachmentRef.current = null;
                  }
                },
              })}
              onCancel={() => setCaptureStep("form")}
            />
          ) : null}
          <div hidden={captureStep !== "form"}>
            <CaptureForm
              key={captureFormKey}
              projectId={projectId}
              parentTaskId={null}
              pendingFiles={captureStep === "form" && pendingFile ? [pendingFile] : []}
              onCropPendingFile={(file) => setCropTarget({ file })}
              {...(captureStep === "form" && pendingFile
                ? { prepareNotes: prepareMaterialNotes }
                : {})}
              {...(pendingFile
                ? {
                    secondaryAction: {
                      label: strings.intakeProcess,
                      onClick: () => setCaptureStep("intake"),
                    },
                  }
                : {})}
              {...(captureStep === "form"
                ? {
                    secondaryAction: {
                      label: strings.intakeProcess,
                      onClick: () => setCaptureStep("intake"),
                    },
                    captureActions: {
                      photoLabel: strings.capturePhoto,
                      fileLabel: strings.captureFile,
                      onPhoto: () => setCameraOpen(true),
                      onFile: () => fileRef.current?.click(),
                    },
                  }
                : {})}
              {...(defaultScope ? { defaultScope } : {})}
              onCancel={close}
              onCaptured={(result) => {
                bump();
                setLatestCapture({ id: result.task.id, title: result.task.title });
                setPendingFile(null);
                uploadedAttachmentRef.current = null;
                setCaptureFormKey((current) => current + 1);
              }}
            />
          </div>
        </BottomSheet>
      ) : null}
      {cropTarget ? (
        <ImageCropSheet
          file={cropTarget.file}
          onClose={() => setCropTarget(null)}
          onUseOriginal={() => setCropTarget(null)}
          onApply={(croppedFile) => {
            if (cropTarget.onApply) cropTarget.onApply(croppedFile);
            else {
              setPendingFile(croppedFile);
              uploadedAttachmentRef.current = null;
            }
            setCropTarget(null);
          }}
        />
      ) : null}
      {cameraOpen ? (
        <CameraCaptureSheet
          onClose={() => setCameraOpen(false)}
          onFallback={() => {
            setCameraOpen(false);
            cameraRef.current?.click();
          }}
          onCapture={(file) => {
            setCameraOpen(false);
            setPendingFile(file);
            uploadedAttachmentRef.current = null;
            setCaptureStep("form");
          }}
        />
      ) : null}
    </>
  );
}
