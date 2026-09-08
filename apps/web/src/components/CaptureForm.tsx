import { useMemo, useRef, useState } from "react";
import type { CreateTaskInput } from "../lib/api";
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
  modifierCaptureToken,
  type ResolvedCaptureToken,
} from "../lib/captureSyntax";
import { MemberChoiceGroup } from "./MemberChoiceGroup";
import { ScheduleShortcuts } from "./ScheduleShortcuts";

export type CaptureResult =
  | {
      kind: "task";
      task: Awaited<ReturnType<typeof api.createTask>>;
      needsClarification: boolean;
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
  const [openModifier, setOpenModifier] = useState<
    "member" | "context" | "schedule" | "project" | null
  >(null);
  const titleInputRef = useRef<HTMLInputElement>(null);
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
  const taskInput = (
    needsClarification: boolean,
    preparedNotes: string,
  ): CreateTaskInput => ({
    title: capturedTitle,
    ...(preparedNotes ? { notes: preparedNotes } : {}),
    projectId: syntaxMetadata.projectId ?? projectId ?? null,
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

  const createTask = async () => {
    if (!capturedTitle || saving) return;
    const needsClarification =
      (projectId ?? null) === null && (parentTaskId ?? null) === null;
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

  const focusTitle = () => {
    requestAnimationFrame(() => titleInputRef.current?.focus());
  };

  const selectModifier = (token: ResolvedCaptureToken) => {
    setSelectedTokens((current) =>
      mergeResolvedCaptureTokens(
        current.filter((candidate) => candidate.kind !== token.kind),
        [token],
      ),
    );
    setOpenModifier(null);
    focusTitle();
  };

  const toggleContextModifier = (contextId: number) => {
    const context = homeAssistant?.contexts.find((candidate) => candidate.id === contextId);
    if (!context) return;
    setSelectedTokens((current) => {
      const selected = current.filter((token) => token.kind === "context");
      const selectedIds = new Set(
        selected.map((token) => ("context" in token ? token.context.id : null)),
      );
      if (selectedIds.has(contextId)) selectedIds.delete(contextId);
      else selectedIds.add(contextId);
      return [
        ...current.filter((token) => token.kind !== "context"),
        ...[...selectedIds]
          .map((id) => homeAssistant?.contexts.find((candidate) => candidate.id === id))
          .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== undefined)
          .map((candidate) => modifierCaptureToken({ kind: "context", context: candidate })),
      ];
    });
  };

  return (
    <form
      className="stack"
      onSubmit={(event) => {
        event.preventDefault();
        void createTask();
      }}
    >
      <PendingMaterialPreview files={pendingFiles} onCrop={onCropPendingFile} />
      <div className="field">
        <label htmlFor="capture-title">{strings.titleEnough}</label>
        <input
          id="capture-title"
          ref={titleInputRef}
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
        <div className="capture-modifiers" role="group" aria-label={strings.captureModifiers}>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => setOpenModifier(openModifier === "member" ? null : "member")}
          >
            + {strings.member}
          </button>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => setOpenModifier(openModifier === "context" ? null : "context")}
          >
            + {strings.context}
          </button>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => setOpenModifier(openModifier === "schedule" ? null : "schedule")}
          >
            + {strings.schedule}
          </button>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => setOpenModifier(openModifier === "project" ? null : "project")}
          >
            + {strings.project}
          </button>
        </div>
        {openModifier === "member" ? (
          <MemberChoiceGroup
            label={strings.member}
            idPrefix="capture-member"
            members={members}
            value={syntaxMetadata.ownerMemberId ?? null}
            unassignedLabel={null}
            onChange={(memberId) => {
              const member = members.find((candidate) => candidate.id === memberId);
              if (member) selectModifier(modifierCaptureToken({ kind: "member", member }));
            }}
          />
        ) : null}
        {openModifier === "context" ? (
          <div className="choice-group" role="group" aria-label={strings.physicalContexts}>
            {(homeAssistant?.contexts ?? [])
              .filter((context) => context.active)
              .map((context) => {
                const selected = syntaxMetadata.contextIds.includes(context.id);
                return (
                  <button
                    key={context.id}
                    type="button"
                    className="choice-chip"
                    aria-pressed={selected}
                    onClick={() => toggleContextModifier(context.id)}
                  >
                    {context.name}
                  </button>
                );
              })}
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                setOpenModifier(null);
                focusTitle();
              }}
            >
              {strings.close}
            </button>
          </div>
        ) : null}
        {openModifier === "schedule" ? (
          <div className="stack">
            <ScheduleShortcuts
              value={syntaxMetadata.scheduledDate ?? null}
              onChange={(date) => {
                if (date) selectModifier(modifierCaptureToken({ kind: "scheduledDate", date }));
              }}
            />
            <HumanDateInput
              id="capture-scheduled-date"
              value={syntaxMetadata.scheduledDate ?? null}
              onChange={(date) => {
                if (date) selectModifier(modifierCaptureToken({ kind: "scheduledDate", date }));
              }}
            />
          </div>
        ) : null}
        {openModifier === "project" ? (
          <div className="choice-group" role="group" aria-label={strings.project}>
            {(projects ?? [])
              .slice()
              .sort((a, b) => a.title.localeCompare(b.title, locale))
              .map((project) => (
                <button
                  key={project.id}
                  type="button"
                  className="choice-chip"
                  aria-pressed={syntaxMetadata.projectId === project.id}
                  onClick={() => selectModifier(modifierCaptureToken({ kind: "story", story: project }))}
                >
                  {project.title}
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
      <div className="capture-actions">
        <button type="button" className="btn" onClick={onCancel}>
          {strings.cancel}
        </button>
        <button
          type="submit"
          className="btn btn-primary"
          aria-label={strings.create}
          disabled={saving || !capturedTitle || !dueDateValid}
        >
          {strings.create}
        </button>
      </div>
    </form>
  );
}
