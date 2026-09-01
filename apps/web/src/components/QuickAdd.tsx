import { useEffect, useRef, useState, type ChangeEvent } from "react";
import type { ProjectWithActions } from "../lib/api";
import { useRefresh } from "../lib/refresh";
import { api } from "../lib/api";
import { useStrings } from "../lib/strings";
import { localizedErrorMessage } from "../lib/errorMessage";
import { useTaskActions } from "../lib/useTaskActions";
import { MemberSelectionSheet } from "./MemberSelectionSheet";
import { BottomSheet } from "./BottomSheet";
import { CaptureForm } from "./CaptureForm";
import { CapturedProjectHandoff } from "./CapturedProjectHandoff";
import { DestinationPicker, type DestinationOption } from "./DestinationPicker";
import { useIdentity } from "../lib/identity";
import { useLocale } from "../lib/locale";
import { sortProjectDestinations } from "../lib/sortOrder";
import { appendTextBlock } from "../lib/shareTarget";
import {
  uploadPaperlessFile,
  type UploadedPaperlessAttachment,
} from "../lib/paperlessAttachments";
import { IconActionGlyph } from "./IconActionButton";
import { ImageCropSheet } from "./ImageCropSheet";

/**
 * Global quick-add: a single always-reachable floating button. Essential
 * because task creation must not depend on navigating into a specific
 * project or list first — a bare title is enough and the task lands in
 * Eingang (inbox) for later clarification/refile.
 */
export function QuickAdd({
  projectId,
  parentTaskId,
  autoOpen = false,
  onAutoOpenClose,
}: {
  projectId?: number | null;
  parentTaskId?: number | null;
  autoOpen?: boolean;
  onAutoOpenClose?: () => void;
}) {
  const strings = useStrings();
  const { locale } = useLocale();
  const [open, setOpen] = useState(autoOpen);
  const [captureStep, setCaptureStep] = useState<"choose" | "form">(
    autoOpen ? "form" : "choose",
  );
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [cropFile, setCropFile] = useState<File | null>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const uploadedAttachmentRef =
    useRef<Promise<UploadedPaperlessAttachment> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [createdTask, setCreatedTask] = useState<Awaited<ReturnType<typeof api.createTask>> | null>(null);
  const [projectPickerOpen, setProjectPickerOpen] = useState(false);
  const [projects, setProjects] = useState<ProjectWithActions[] | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState<number | null>(null);
  const [projectPickerError, setProjectPickerError] = useState<string | null>(null);
  const [moving, setMoving] = useState(false);
  const [assigning, setAssigning] = useState(false);
  const [createdProject, setCreatedProject] = useState<ProjectWithActions | null>(null);
  const [captureNotice, setCaptureNotice] = useState<string | null>(null);
  const { bump } = useRefresh();
  const { members } = useIdentity();
  const taskActions = useTaskActions();

  useEffect(() => {
    if (autoOpen) {
      setCaptureStep("form");
      setOpen(true);
    }
  }, [autoOpen]);

  const close = () => {
    setOpen(false);
    setCaptureStep("choose");
    setPendingFile(null);
    setCropFile(null);
    uploadedAttachmentRef.current = null;
    setError(null);
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

  const loadProjects = () => {
    setProjectPickerError(null);
    setProjects(null);
    void api
      .getProjects()
      .then(setProjects)
      .catch((err: unknown) =>
        setProjectPickerError(localizedErrorMessage(err, strings)),
      );
  };

  const openProjectPicker = () => {
    setSelectedProjectId(createdTask?.projectId ?? null);
    setProjectPickerOpen(true);
    loadProjects();
  };

  const moveToProject = async () => {
    if (!createdTask || moving) return;
    setMoving(true);
    setProjectPickerError(null);
    try {
      const moved = await api.moveTask(createdTask.id, {
        parentTaskId: null,
        projectId: selectedProjectId,
        expectedRevision: createdTask.revision,
      });
      setCreatedTask(moved);
      bump();
      setProjectPickerOpen(false);
    } catch (err) {
      setProjectPickerError(localizedErrorMessage(err, strings));
    } finally {
      setMoving(false);
    }
  };

  const undo = async () => {
    if (!createdTask || moving) return;
    setMoving(true);
    setError(null);
    try {
      await api.deleteTask(createdTask.id);
      bump();
      setCreatedTask(null);
    } catch (err) {
      setError(localizedErrorMessage(err, strings));
    } finally {
      setMoving(false);
    }
  };

  const projectOptions: DestinationOption[] = sortProjectDestinations(
    projects ?? [],
    locale,
  ).map((project) => ({
    id: project.id,
    title: project.title,
  }));

  return (
    <>
      <button
        type="button"
        className="quick-add-fab"
        onClick={() => {
          setCaptureNotice(null);
          setCaptureStep("choose");
          setOpen(true);
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
                onClick={() => cameraRef.current?.click()}
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
              projectId={projectId ?? null}
              parentTaskId={parentTaskId ?? null}
              pendingFiles={pendingFile ? [pendingFile] : []}
              onCropPendingFile={(file) => setCropFile(file)}
              {...(pendingFile ? { prepareNotes: prepareMaterialNotes } : {})}
              onCancel={close}
              onCaptured={(result) => {
                bump();
                close();
                if (result.kind === "project") {
                  setCreatedProject(result.project);
                } else if (result.needsClarification) {
                  setCaptureNotice(strings.filedInInbox);
                } else {
                  setCaptureNotice(null);
                  setCreatedTask(result.task);
                }
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
      {createdTask ? (
        <section className="capture-correction-toast" role="status" aria-live="polite">
          <strong>{strings.addedToToday}</strong>
          {error ? <p className="capture-error" role="alert">{error}</p> : null}
          <div className="capture-correction-actions">
            <button type="button" className="btn btn-sm" disabled={assigning || moving} onClick={() => setAssigning(true)}>
              {strings.changeOwner}
            </button>
            <button type="button" className="btn btn-sm" disabled={assigning || moving} onClick={openProjectPicker}>
              {strings.selectProject}
            </button>
            <button type="button" className="btn btn-sm btn-ghost" disabled={assigning || moving} onClick={() => void undo()}>
              {strings.undo}
            </button>
            <button type="button" className="btn btn-sm btn-ghost" disabled={assigning || moving} onClick={() => setCreatedTask(null)}>
              {strings.close}
            </button>
          </div>
        </section>
      ) : null}
      {captureNotice ? (
        <section className="capture-correction-toast" role="status" aria-live="polite">
          <strong>{captureNotice}</strong>
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setCaptureNotice(null)}>
            {strings.close}
          </button>
        </section>
      ) : null}
      {assigning && createdTask ? (
        <MemberSelectionSheet
          title={strings.changeOwner}
          label={strings.owner}
          idPrefix={`capture-owner-${createdTask.id}`}
          members={members}
          value={createdTask.ownerMemberId}
          unassignedLabel={strings.shared}
          onClose={() => setAssigning(false)}
          onSelect={async (ownerMemberId) => {
            const task = await taskActions.assignOwner(
              createdTask,
              ownerMemberId,
            );
            if (task) setCreatedTask(task);
          }}
        />
      ) : null}
      {projectPickerOpen && createdTask ? (
        <BottomSheet title={strings.selectProject} onClose={() => setProjectPickerOpen(false)} labelledBy="capture-project-picker-title">
          <div className="stack">
            {projectPickerError ? <p className="capture-error" role="alert">{projectPickerError}</p> : null}
            {projects ? (
              <>
                <DestinationPicker
                  kind="project"
                  label={strings.selectProject}
                  options={projectOptions}
                  value={selectedProjectId}
                  onChange={setSelectedProjectId}
                  noneLabel={strings.noProject}
                  autoFocus
                />
                <button
                  type="button"
                  className="btn btn-primary btn-block"
                  disabled={moving}
                  onClick={() => void moveToProject()}
                >
                  {strings.moveHere}
                </button>
              </>
            ) : (
              <div className="stack">
                <p className="text-muted">{strings.loading}</p>
                {projectPickerError ? (
                  <button type="button" className="btn" onClick={loadProjects}>
                    {strings.retry}
                  </button>
                ) : null}
              </div>
            )}
          </div>
        </BottomSheet>
      ) : null}
      {createdProject ? (
        <CapturedProjectHandoff
          project={createdProject}
          onDone={() => setCreatedProject(null)}
        />
      ) : null}
    </>
  );
}
