import { useCallback, useEffect, useRef, useState, type ChangeEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useRefresh } from "../lib/refresh";
import { useStrings } from "../lib/strings";
import { BottomSheet } from "./BottomSheet";
import { CaptureForm } from "./CaptureForm";
import { appendTextBlock } from "../lib/shareTarget";
import {
  uploadPaperlessFile,
  type UploadedPaperlessAttachment,
} from "../lib/paperlessAttachments";
import { IconActionGlyph } from "./IconActionButton";
import { ImageCropSheet } from "./ImageCropSheet";
import { CameraCaptureSheet } from "./CameraCaptureSheet";
import { useOptionalInteractionScope } from "../lib/interactionScope";

/**
 * Global quick-add: a single always-reachable floating button. Essential
 * because task creation must not depend on navigating into a specific
 * project or list first — a bare title is enough and the task lands in
 * Eingang (inbox) for later clarification/refile.
 */
export function QuickAdd({
  autoOpen = false,
  onAutoOpenClose,
}: {
  autoOpen?: boolean;
  onAutoOpenClose?: () => void;
}) {
  const strings = useStrings();
  const navigate = useNavigate();
  // Contextual capture target: whichever `InteractionScopeProvider` this
  // `QuickAdd` instance is mounted inside of (a project/story outline
  // declares `captureTarget: {kind:"story", storyId}`; every compiled
  // view -- Today, Inbox -- leaves it at the default `{kind:"inbox"}`).
  // Replaces the previous `projectId`/`parentTaskId` props every caller
  // had to thread through by hand; every production `QuickAdd` mount
  // already sat inside a scope whose `captureTarget` said exactly the
  // same thing those props did.
  const scope = useOptionalInteractionScope();
  const projectId =
    scope?.captureTarget.kind === "story" ? scope.captureTarget.storyId : null;
  const [open, setOpen] = useState(autoOpen);
  const [captureStep, setCaptureStep] = useState<"choose" | "form">(
    autoOpen ? "form" : "choose",
  );
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [cropFile, setCropFile] = useState<File | null>(null);
  const [cameraOpen, setCameraOpen] = useState(false);
  const cameraRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const uploadedAttachmentRef =
    useRef<Promise<UploadedPaperlessAttachment> | null>(null);
  const { bump } = useRefresh();
  const openCapture = useCallback(() => {
    setCaptureStep("choose");
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

  const close = () => {
    setOpen(false);
    setCaptureStep("choose");
    setPendingFile(null);
    setCropFile(null);
    setCameraOpen(false);
    uploadedAttachmentRef.current = null;
    if (autoOpen) onAutoOpenClose?.();
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
          {captureStep === "choose" ? (
            <div className="stack quick-capture-choices">
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
                aria-label={strings.chooseFile}
                onChange={selectMaterial}
              />
              <button
                type="button"
                className="btn btn-primary btn-block quick-capture-choice"
                onClick={() => setCaptureStep("form")}
              >
                <span aria-hidden="true">+</span>
                <strong>{strings.captureTask}</strong>
              </button>
              <button
                type="button"
                className="btn btn-block quick-capture-choice"
                onClick={() => setCameraOpen(true)}
              >
                <span aria-hidden="true"><IconActionGlyph kind="camera" /></span>
                <strong>{strings.capturePhoto}</strong>
              </button>
              <button
                type="button"
                className="btn btn-block quick-capture-choice"
                onClick={() => fileRef.current?.click()}
              >
                <span aria-hidden="true"><IconActionGlyph kind="upload" /></span>
                <strong>{strings.captureFile}</strong>
              </button>
            </div>
          ) : (
            <CaptureForm
              projectId={projectId}
              parentTaskId={null}
              pendingFiles={pendingFile ? [pendingFile] : []}
              onCropPendingFile={(file) => setCropFile(file)}
              {...(pendingFile ? { prepareNotes: prepareMaterialNotes } : {})}
              onCancel={close}
              onCaptured={(result) => {
                bump();
                close();
                if (projectId === null) {
                  navigate(`/inbox?focus=${result.task.id}`);
                  return;
                }
                scope?.setOpenRail(result.task.id);
              }}
            />
          )}
        </BottomSheet>
      ) : null}
      {cropFile ? (
        <ImageCropSheet
          file={cropFile}
          onClose={() => setCropFile(null)}
          onUseOriginal={() => setCropFile(null)}
          onApply={(croppedFile) => {
            setPendingFile(croppedFile);
            uploadedAttachmentRef.current = null;
            setCropFile(null);
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
