import { useEffect, useMemo, useRef, useState } from "react";
import type { CreateTaskInput, CreationIntent } from "../lib/api";
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
import { ProjectActivationDecisionFields } from "./ProjectActivationDecisionFields";
import {
  projectActivationPromptFromSnapshot, projectActivationPromptFromError,
  projectActivationResolutionFromPrompt,
  type ProjectActivationPrompt,
} from "../lib/projectActivationResolution";
import type { ProjectActivationResolution } from "@machbar/shared";

export type CaptureResult =
  | {
      kind: "task";
      task: Awaited<ReturnType<typeof api.createTask>>;
      needsClarification: boolean;
    };

export type CaptureFormProps = {
  onSavingChange?: (saving: boolean) => void;
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
  onCaptured: (result: CaptureResult) => void;
  secondaryAction?: { label: string; onClick: () => void };
  captureActions?: {
    photoLabel: string;
    fileLabel: string;
    onPhoto: () => void;
    onFile: () => void;
  };
  /** Set on capture only when the currently active view is the Work
   * scope; omitted (server default `"household"` applies) otherwise. */
  defaultScope?: "work";
} & (
  | {
      mode: "thought";
      onCancel?: never;
      thoughtDraft?: { key: number; title: string; onChange: (title: string) => void };
    }
  | { mode?: "standard"; onCancel: () => void; thoughtDraft?: never }
);

/** Shared Capture editor for Quick Add, incoming shares, and guided thoughts. */
export function CaptureForm({
  mode = "standard",
  onSavingChange,
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
  secondaryAction,
  captureActions,
  defaultScope,
  thoughtDraft,
}: CaptureFormProps) {
  const strings = useStrings();
  const isThought = mode === "thought";
  const { locale } = useLocale();
  const creationIntents = useRef(new Map<number | undefined, CreationIntent>());
  const [localTitle, setTitle] = useState(initialTitle);
  const title = thoughtDraft?.title ?? localTitle;
  const activeDraftKey = useRef(thoughtDraft?.key);
  activeDraftKey.current = thoughtDraft?.key;
  const [titleCursor, setTitleCursor] = useState(initialTitle.length);
  const [selectedTokens, setSelectedTokens] = useState<ResolvedCaptureToken[]>([]);
  const [notes, setNotes] = useState(initialNotes);
  const [dueDate, setDueDate] = useState<string | null>(initialDueDate);
  const [dueDateValid, setDueDateValid] = useState(true);
  const [saving, setSaving] = useState(false);
  const focusAfterSave = useRef<number | undefined | null>(null);
  const [error, setError] = useState<{ message: string; draftKey: number | undefined } | null>(null);
  const [activationPrompt, setActivationPrompt] = useState<ProjectActivationPrompt | null>(null);
  const [projectDestinationOverride, setProjectDestinationOverride] = useState<
    number | null | undefined
  >(undefined);
  const [openModifier, setOpenModifier] = useState<
    "member" | "context" | "schedule" | "project" | null
  >(null);
  const titleInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (saving || focusAfterSave.current === null) return;
    if (focusAfterSave.current === activeDraftKey.current) titleInputRef.current?.focus();
    focusAfterSave.current = null;
  }, [saving]);
  const { currentMemberId, members } = useIdentity();
  const { data: tags } = useAsync(() => isThought ? Promise.resolve([]) : api.getTags(), [isThought]);
  const { data: projects } = useAsync(() => isThought ? Promise.resolve([]) : api.getProjects(), [isThought]);
  const { data: homeAssistant } = useAsync(() => isThought ? Promise.resolve(null) : api.getHomeAssistantStatus(), [isThought]);
  const automaticTokens = useMemo(
    () => isThought ? [] : autoResolvedCaptureTokens(title, locale),
    [isThought, locale, title],
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
  const capturedTitle = isThought ? title.trim() : stripResolvedTokens(title, resolvedTokens);
  const effectiveProjectId =
    syntaxMetadata.projectId ??
    (projectDestinationOverride !== undefined
      ? projectDestinationOverride
      : projectId ?? null);
  const effectiveProject = (projects ?? []).find(
    (project) => project.id === effectiveProjectId,
  );
  const suggestions = useMemo(
    () =>
      isThought ? [] : captureSyntaxSuggestions({
        input: title,
        cursor: titleCursor,
        locale,
        members,
        tags: tags ?? [],
        contexts: homeAssistant?.contexts ?? [],
        stories: projects ?? [],
      }),
    [isThought, homeAssistant?.contexts, locale, members, projects, tags, title, titleCursor],
  );
  const taskInput = (
    needsClarification: boolean,
    preparedNotes: string,
    activationResolution?: ProjectActivationResolution,
  ): CreateTaskInput => isThought ? ({
    title: title.trim(),
    createdByMemberId: currentMemberId,
    status: "captured",
    ...ownerAssignmentPatch(null),
  }) : ({
    title: capturedTitle,
    ...(preparedNotes ? { notes: preparedNotes } : {}),
    projectId: effectiveProjectId,
    parentTaskId: parentTaskId ?? null,
    createdByMemberId: currentMemberId,
    status: needsClarification ? "captured" : "actionable",
    ...(defaultScope ? { scope: defaultScope } : {}),
    ...(activationResolution ? { activationResolution } : {}),
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

  const needsClarification =
    isThought || (effectiveProjectId === null && (parentTaskId ?? null) === null);
  const requestFingerprint = JSON.stringify(taskInput(needsClarification, notes));
  const currentActivationPrompt =
    activationPrompt?.requestFingerprint === requestFingerprint ? activationPrompt : null;

  useEffect(() => {
    if (activationPrompt && activationPrompt.requestFingerprint !== requestFingerprint) {
      setActivationPrompt(null);
    }
  }, [activationPrompt, requestFingerprint]);

  const createTask = async () => {
    if (!capturedTitle || saving) return;
    const intentKey = thoughtDraft?.key;
    const intent = creationIntents.current.get(intentKey) ?? {};
    creationIntents.current.set(intentKey, intent);
    setSaving(true);
    onSavingChange?.(true);
    setError(null);
    try {
      const preparedNotes = prepareNotes ? await prepareNotes(notes) : notes;
      const input = taskInput(
          needsClarification,
          preparedNotes,
          currentActivationPrompt?.projects.length
            ? projectActivationResolutionFromPrompt(currentActivationPrompt) ?? undefined
            : undefined,
        );
      if (!currentActivationPrompt && (effectiveProjectId !== null || parentTaskId != null)) {
        const preview = await api.previewTaskCreation(input);
        if (preview.activatingProjects.length) {
          setActivationPrompt({ ...projectActivationPromptFromSnapshot(preview.decision), requestFingerprint });
          return;
        }
      }
      const task = await api.createTask(input, intent);
      creationIntents.current.delete(intentKey);
      onCaptured({ kind: "task", task, needsClarification });
      if (isThought && activeDraftKey.current === thoughtDraft?.key) {
        focusAfterSave.current = thoughtDraft?.key;
      }
    } catch (cause) {
      const refreshedPrompt = projectActivationPromptFromError(cause, currentActivationPrompt);
      if (refreshedPrompt) {
        setActivationPrompt({ ...refreshedPrompt, requestFingerprint });
      }
      setError({ message: localizedErrorMessage(cause, strings), draftKey: thoughtDraft?.key });
    } finally {
      setSaving(false);
      onSavingChange?.(false);
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

  const selectProjectDestination = (destination: number | null) => {
    const token = resolvedTokens.find((candidate) => candidate.kind === "story");
    if (token && title.slice(token.start, token.end) === token.raw) {
      setTitle((current) =>
        `${current.slice(0, token.start)}${current.slice(token.end)}`.replace(/\s+/g, " ").trim(),
      );
    }
    setSelectedTokens((current) => current.filter((candidate) => candidate.kind !== "story"));
    setProjectDestinationOverride(destination);
    setOpenModifier(null);
    focusTitle();
  };

  return (
    <form
      className={isThought ? "capture-thought-form" : "stack"}
      aria-busy={saving}
      onSubmit={(event) => {
        event.preventDefault();
        void createTask();
      }}
    >
      <PendingMaterialPreview files={pendingFiles} onCrop={onCropPendingFile} />
      <div className="field">
        <label htmlFor="capture-title" className={isThought ? "visually-hidden" : undefined}>{isThought ? strings.guidedCaptureInput : strings.titleEnough}</label>
        <input
          id="capture-title"
          ref={titleInputRef}
          autoFocus={autoFocus}
          disabled={saving}
          value={title}
          placeholder={isThought ? strings.guidedCapturePlaceholder : strings.quickAddPlaceholder}
          onChange={(event) => {
            if (thoughtDraft) thoughtDraft.onChange(event.target.value);
            else setTitle(event.target.value);
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
        {!isThought && suggestions.length > 0 ? (
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
        {!isThought ? <div className="capture-modifiers" role="group" aria-label={strings.captureModifiers}>
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
        </div> : null}
        {!isThought ? <p className="capture-destination" aria-live="polite">
          {strings.captureDestination}: {effectiveProject?.title ?? strings.inbox}
        </p> : null}
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
            <button
              type="button"
              className="choice-chip"
              aria-pressed={effectiveProjectId === null}
              onClick={() => selectProjectDestination(null)}
            >
              {strings.inbox}
            </button>
            {(projects ?? [])
              .slice()
              .sort((a, b) => a.title.localeCompare(b.title, locale))
              .map((project) => (
                <button
                  key={project.id}
                  type="button"
                  className="choice-chip"
                  aria-pressed={effectiveProjectId === project.id}
                  onClick={() => selectProjectDestination(project.id)}
                >
                  {project.title}
                </button>
              ))}
          </div>
        ) : null}
      </div>
      {showNotes || notes ? (
        <div className="field">
          <label id="capture-notes-label">{strings.notes}</label>
          <MarkdownEditor
            disabled={saving}
            id="capture-notes"
            aria-label={strings.notes}
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
      {currentActivationPrompt ? (
        <ProjectActivationDecisionFields
          prompt={currentActivationPrompt}
          disabled={saving}
          onChange={setActivationPrompt}
        />
      ) : null}
      {error && error.draftKey === thoughtDraft?.key ? <p className="capture-error" role="alert">{error.message}</p> : null}
      <div className="capture-actions">
        {!isThought ? <button type="button" className="btn" onClick={onCancel} disabled={saving}>
          {strings.cancel}
        </button> : null}
        {secondaryAction ? (
          <button type="button" className="btn" onClick={secondaryAction.onClick}>
            {secondaryAction.label}
          </button>
        ) : null}
        {captureActions ? (
          <>
            <button type="button" className="btn" onClick={captureActions.onPhoto}>
              {captureActions.photoLabel}
            </button>
            <button type="button" className="btn" onClick={captureActions.onFile}>
              {captureActions.fileLabel}
            </button>
          </>
        ) : null}
        <button
          type="submit"
          className="btn btn-primary"
          aria-label={isThought ? strings.guidedCaptureSave : strings.create}
          disabled={saving || !capturedTitle || !dueDateValid ||
            (currentActivationPrompt !== null && projectActivationResolutionFromPrompt(currentActivationPrompt) === null)}
        >
          {isThought ? strings.guidedCaptureSave : strings.create}
        </button>
      </div>
    </form>
  );
}
