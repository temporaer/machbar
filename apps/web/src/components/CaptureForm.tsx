import { useMemo, useState } from "react";
import type { ProjectWithActions, CreateTaskInput } from "../lib/api";
import { api } from "../lib/api";
import { useIdentity } from "../lib/identity";
import { useStrings } from "../lib/strings";
import { localizedErrorMessage } from "../lib/errorMessage";
import { ownerAssignmentPatch } from "../lib/taskMutations";
import { MarkdownEditor } from "./MarkdownEditor";
import { HumanDateInput } from "./HumanDateInput";
import { PendingMaterialPreview } from "./PendingMaterialPreview";
import { useLocale } from "../lib/locale";
import { useAsync } from "../lib/useAsync";
import {
  autoResolvedCaptureTokens,
  captureSyntaxSuggestions,
  mergeResolvedCaptureTokens,
  resolvedCaptureMetadata,
  stripResolvedTokens,
  type ResolvedCaptureToken,
} from "../lib/captureSyntax";

export type CaptureResult =
  | {
      kind: "task";
      task: Awaited<ReturnType<typeof api.createTask>>;
      needsClarification: boolean;
    }
  | {
      kind: "project";
      project: ProjectWithActions;
    };

export interface CaptureFormProps {
  initialTitle?: string;
  initialNotes?: string;
  initialDueDate?: string | null;
  projectId?: number | null;
  parentTaskId?: number | null;
  showNotes?: boolean;
  showDueDate?: boolean;
  autoFocus?: boolean;
  prepareNotes?: (notes: string) => Promise<string>;
  pendingFiles?: readonly File[];
  onCropPendingFile?: ((file: File, index: number) => void) | undefined;
  onCancel: () => void;
  onCaptured: (result: CaptureResult) => void;
}

/** Shared Capture editor used by both the global FAB and incoming shares. */
export function CaptureForm({
  initialTitle = "",
  initialNotes = "",
  initialDueDate = null,
  projectId,
  parentTaskId,
  showNotes = false,
  showDueDate = false,
  autoFocus = true,
  prepareNotes,
  pendingFiles = [],
  onCropPendingFile,
  onCancel,
  onCaptured,
}: CaptureFormProps) {
  const strings = useStrings();
  const { locale } = useLocale();
  const [title, setTitle] = useState(initialTitle);
  const [titleCursor, setTitleCursor] = useState(initialTitle.length);
  const [selectedTokens, setSelectedTokens] = useState<ResolvedCaptureToken[]>([]);
  const [notes, setNotes] = useState(initialNotes);
  const [dueDate, setDueDate] = useState<string | null>(initialDueDate);
  const [dueDateValid, setDueDateValid] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { currentMemberId, members } = useIdentity();
  const { data: tags } = useAsync(() => api.getTags(), []);
  const { data: projects } = useAsync(() => api.getProjects(), []);
  const { data: homeAssistant } = useAsync(() => api.getHomeAssistantStatus(), []);
  const automaticTokens = useMemo(
    () => autoResolvedCaptureTokens(title, locale),
    [locale, title],
  );
  const resolvedTokens = useMemo(
    () =>
      mergeResolvedCaptureTokens(
        selectedTokens.filter((token) => title.slice(token.start, token.end) === token.raw),
        automaticTokens,
      ),
    [automaticTokens, selectedTokens, title],
  );
  const syntaxMetadata = useMemo(
    () => resolvedCaptureMetadata(resolvedTokens),
    [resolvedTokens],
  );
  const capturedTitle = stripResolvedTokens(title, resolvedTokens);
  const suggestions = useMemo(
    () =>
      captureSyntaxSuggestions({
        input: title,
        cursor: titleCursor,
        locale,
        members,
        tags: tags ?? [],
        contexts: homeAssistant?.contexts ?? [],
        stories: projects ?? [],
      }),
    [homeAssistant?.contexts, locale, members, projects, tags, title, titleCursor],
  );
  const canDeferClassification =
    (projectId ?? null) === null && (parentTaskId ?? null) === null;

  const taskInput = (
    needsClarification: boolean,
    preparedNotes: string,
  ): CreateTaskInput => ({
    title: capturedTitle,
    ...(preparedNotes ? { notes: preparedNotes } : {}),
    projectId: projectId ?? syntaxMetadata.projectId ?? null,
    parentTaskId: parentTaskId ?? null,
    createdByMemberId: currentMemberId,
    status: needsClarification ? "captured" : "actionable",
    dueDate: syntaxMetadata.dueDate ?? dueDate,
    scheduledDate: syntaxMetadata.scheduledDate ?? null,
    ...(syntaxMetadata.size !== undefined ? { size: syntaxMetadata.size } : {}),
    ...(syntaxMetadata.tagIds.length ? { tagIds: syntaxMetadata.tagIds } : {}),
    ...(syntaxMetadata.contextIds.length
      ? { contextIds: syntaxMetadata.contextIds, contextInheritanceMode: "explicit" }
      : {}),
    ...(syntaxMetadata.ownerMemberId !== undefined
      ? ownerAssignmentPatch(syntaxMetadata.ownerMemberId)
      : currentMemberId === null
        ? {}
        : ownerAssignmentPatch(currentMemberId)),
  });

  const createTask = async (needsClarification: boolean) => {
    if (!capturedTitle || saving) return;
    setSaving(true);
    setError(null);
    try {
      const preparedNotes = prepareNotes ? await prepareNotes(notes) : notes;
      const task = await api.createTask(
        taskInput(needsClarification, preparedNotes),
      );
      onCaptured({ kind: "task", task, needsClarification });
    } catch (cause) {
      setError(localizedErrorMessage(cause, strings));
    } finally {
      setSaving(false);
    }
  };

  const createProject = async () => {
    if (!capturedTitle || saving) return;
    setSaving(true);
    setError(null);
    try {
      const preparedNotes = prepareNotes ? await prepareNotes(notes) : notes;
      const project = await api.createProject({
        title: capturedTitle,
        ...(preparedNotes ? { notes: preparedNotes } : {}),
        ...(syntaxMetadata.projectId !== undefined ? { parentId: syntaxMetadata.projectId } : {}),
        status: "backlog",
        ownerMemberId: syntaxMetadata.ownerMemberId ?? currentMemberId,
        ...(syntaxMetadata.dueDate !== undefined
          ? { dueDate: syntaxMetadata.dueDate }
          : showDueDate
            ? { dueDate }
            : {}),
        ...(syntaxMetadata.scheduledDate !== undefined
          ? { scheduledDate: syntaxMetadata.scheduledDate }
          : {}),
        ...(syntaxMetadata.tagIds.length ? { tagIds: syntaxMetadata.tagIds } : {}),
        ...(syntaxMetadata.contextIds.length ? { contextIds: syntaxMetadata.contextIds } : {}),
      });
      onCaptured({ kind: "project", project });
    } catch (cause) {
      setError(localizedErrorMessage(cause, strings));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      className="stack"
      onSubmit={(event) => {
        event.preventDefault();
        void createTask(canDeferClassification);
      }}
    >
      <PendingMaterialPreview files={pendingFiles} onCrop={onCropPendingFile} />
      <div className="field">
        <label htmlFor="capture-title">{strings.titleEnough}</label>
        <input
          id="capture-title"
          autoFocus={autoFocus}
          value={title}
          placeholder={strings.quickAddPlaceholder}
          onChange={(event) => {
            setTitle(event.target.value);
            setTitleCursor(event.target.selectionStart ?? event.target.value.length);
          }}
          onKeyUp={(event) =>
            setTitleCursor(event.currentTarget.selectionStart ?? title.length)
          }
          onClick={(event) =>
            setTitleCursor(event.currentTarget.selectionStart ?? title.length)
          }
        />
        {resolvedTokens.length > 0 ? (
          <div className="capture-token-list" aria-label={strings.captureResolvedTokens}>
            {resolvedTokens.map((token) => (
              <button
                key={`${token.kind}-${token.start}-${token.end}-${token.raw}`}
                type="button"
                className="capture-token-chip"
                onClick={() => {
                  setTitle((currentTitle) =>
                    currentTitle.slice(token.start, token.end) === token.raw
                      ? `${currentTitle.slice(0, token.start)}${currentTitle.slice(token.end)}`.replace(/\s+/g, " ")
                      : currentTitle,
                  );
                  setSelectedTokens((current) =>
                    current.filter((candidate) => candidate !== token),
                  );
                }}
              >
                {token.kind === "scheduledDate" ? strings.scheduled : null}
                {token.kind === "dueDate" ? strings.due : null}
                {token.kind === "member" ? strings.owner : null}
                {token.kind === "tag" ? strings.tags : null}
                {token.kind === "context" ? strings.context : null}
                {token.kind === "story" ? strings.project : null}
                {token.kind === "size" ? strings.currentSize : null}
                {": "}
                {"date" in token
                  ? token.date
                  : "member" in token
                    ? token.member.name
                    : "tag" in token
                      ? token.tag.name
                      : "context" in token
                        ? token.context.name
                        : "story" in token
                          ? token.story.title
                          : token.size}
              </button>
            ))}
          </div>
        ) : null}
        {suggestions.length > 0 ? (
          <div className="capture-suggestions" role="listbox" aria-label={strings.captureSuggestions}>
            {suggestions.map((suggestion) => (
              <button
                key={suggestion.key}
                type="button"
                className="capture-suggestion"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() =>
                  setSelectedTokens((current) =>
                    mergeResolvedCaptureTokens(current, [suggestion.token]),
                  )
                }
              >
                <span>{suggestion.label}</span>
                {suggestion.description ? <small>{suggestion.description}</small> : null}
              </button>
            ))}
          </div>
        ) : null}
      </div>
      {showNotes || notes ? (
        <div className="field">
          <label htmlFor="capture-notes">{strings.notes}</label>
          <MarkdownEditor
            id="capture-notes"
            rows={5}
            value={notes}
            onChange={setNotes}
            toolbarLabel={strings.markdownToolbar}
          />
        </div>
      ) : null}
      {showDueDate ? (
        <div className="field">
          <label htmlFor="capture-due">{strings.due}</label>
          <HumanDateInput
            id="capture-due"
            value={dueDate}
            onChange={setDueDate}
            onValidityChange={setDueDateValid}
          />
        </div>
      ) : null}
      {error ? <p className="capture-error" role="alert">{error}</p> : null}
      <div className="capture-shape-actions">
        <button type="button" className="btn" onClick={onCancel}>
          {strings.cancel}
        </button>
        {canDeferClassification ? (
          <button
            type="submit"
            className="btn"
            disabled={saving || !capturedTitle || !dueDateValid}
          >
            {strings.clarifyLater}
          </button>
        ) : null}
        <button
          type="button"
          className="btn btn-primary capture-shape-action"
          aria-label={strings.captureMachbar}
          disabled={saving || !capturedTitle || !dueDateValid}
          onClick={() => void createTask(false)}
        >
          <span>{strings.captureMachbar}</span>
          <small>{strings.captureMachbarHint}</small>
        </button>
        <button
          type="button"
          className="btn btn-primary capture-shape-action"
          aria-label={strings.captureProject}
          disabled={saving || !capturedTitle || !dueDateValid}
          onClick={() => void createProject()}
        >
          <span>{strings.captureProject}</span>
          <small>{strings.captureProjectHint}</small>
        </button>
      </div>
    </form>
  );
}
