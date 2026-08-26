import { useEffect, useMemo, useRef, useState } from "react";
import type { InheritanceMode, Task } from "@machbar/shared";
import { inheritanceModes, taskStatuses } from "@machbar/shared";
import { api } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { useIdentity } from "../lib/identity";
import { useRefresh } from "../lib/refresh";
import { useTaskActions } from "../lib/useTaskActions";
import { useTaskDetail } from "../lib/taskDetailContext";
import type { TaskDetailFocusField } from "../lib/taskDetailContext";
import { strings, taskStatusLabels } from "../lib/strings";
import { formatDateTime } from "../lib/format";
import { sortByPosition } from "../lib/taskHelpers";
import { BottomSheet } from "./BottomSheet";
import { LoadingState, ErrorState } from "./AsyncStates";
import { StatusBadge } from "./StatusBadge";
import { TagChip } from "./TagChip";
import { TagPicker } from "./TagPicker";
import { ChildPolicyPrompt } from "./ChildPolicyPrompt";
import { MoveTaskSheet } from "./MoveTaskSheet";
import type { MoveMode } from "./MoveTaskSheet";

/** The subset of task fields edited as free-text drafts in this sheet. */
interface TextFieldsSnapshot {
  title: string;
  notes: string;
  waitingFor: string;
}

function textFieldsSnapshot(task: Task): TextFieldsSnapshot {
  return {
    title: task.title,
    notes: task.notes ?? "",
    waitingFor: task.waitingFor ?? "",
  };
}

function InheritanceControl({
  mode,
  onChange,
  explicitLabel,
}: {
  mode: InheritanceMode;
  onChange: (mode: InheritanceMode) => void;
  explicitLabel: string;
}) {
  const labels: Record<InheritanceMode, string> = {
    inherit: strings.inherited,
    explicit: explicitLabel,
    none: strings.noInheritance,
  };
  return (
    <div className="segmented" role="group">
      {inheritanceModes.map((m) => (
        <button key={m} type="button" aria-pressed={mode === m} onClick={() => onChange(m)}>
          {labels[m]}
        </button>
      ))}
    </div>
  );
}

/**
 * Full-metadata editor for a single task, opened as a bottom sheet from any
 * list (Today, Inbox, project outline, search, waiting). Every field on the
 * shared `Task` contract is represented, including inheritance modes, tag
 * exclusion, dependencies, subtasks and the explicit refile/move actions
 * (`Sortier-Werkzeuge`), which is how compiled views — where the outline's
 * drag editing is deliberately unavailable — still reach them.
 */
export function TaskDetailSheet() {
  const { openTaskId, queueActive, focusField, clearFocusField, open, advanceQueue, close } = useTaskDetail();
  const { bump } = useRefresh();
  const { members } = useIdentity();
  const taskActions = useTaskActions();
  const [movePrompt, setMovePrompt] = useState<MoveMode | null>(null);
  const [depQuery, setDepQuery] = useState("");
  const [depResults, setDepResults] = useState<Task[]>([]);
  const [titleDraft, setTitleDraft] = useState("");
  const [notesDraft, setNotesDraft] = useState("");
  const [waitingForDraft, setWaitingForDraft] = useState("");
  const [textFieldsBaseline, setTextFieldsBaseline] = useState<TextFieldsSnapshot | null>(null);
  const [savingTextFields, setSavingTextFields] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const ownerFieldRef = useRef<HTMLDivElement>(null);
  const scheduleFieldRef = useRef<HTMLDivElement>(null);
  const notesRef = useRef<HTMLTextAreaElement>(null);
  const lastLoadedTaskIdRef = useRef<number | null>(null);

  const {
    data: task,
    loading,
    error,
    reload,
  } = useAsync(() => (openTaskId ? api.getTask(openTaskId) : Promise.resolve(null)), [openTaskId]);
  const { data: tags } = useAsync(() => api.getTags(), []);

  // Resets the drafts (and the dirty-check baseline) whenever a *different*
  // task is opened, or whenever this task's data arrives from the server and
  // the user has no unsaved edits. A background reload triggered while the
  // user is mid-edit (e.g. another patch on this task, or an unrelated
  // refresh elsewhere in the app) must never clobber in-progress typing, so
  // it is skipped whenever the current drafts still differ from the last
  // known-saved baseline.
  useEffect(() => {
    if (!task) {
      lastLoadedTaskIdRef.current = null;
      setTextFieldsBaseline(null);
      return;
    }
    const nextBaseline = textFieldsSnapshot(task);
    const isNewTask = lastLoadedTaskIdRef.current !== task.id;
    if (isNewTask) setSaveError(null);
    const hasUnsavedEdits =
      !isNewTask &&
      textFieldsBaseline !== null &&
      (titleDraft !== textFieldsBaseline.title ||
        notesDraft !== textFieldsBaseline.notes ||
        waitingForDraft !== textFieldsBaseline.waitingFor);

    if (!hasUnsavedEdits) {
      setTitleDraft(nextBaseline.title);
      setNotesDraft(nextBaseline.notes);
      setWaitingForDraft(nextBaseline.waitingFor);
      setTextFieldsBaseline(nextBaseline);
    }
    lastLoadedTaskIdRef.current = task.id;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task]);

  // Chip-driven opens (Zuweisen/Planen/Notizen) land the user directly on the
  // relevant field of this same edit flow instead of just the sheet's top.
  useEffect(() => {
    if (!task || !focusField) return;
    const containers: Record<TaskDetailFocusField, HTMLElement | null> = {
      owner: ownerFieldRef.current,
      schedule: scheduleFieldRef.current,
      notes: notesRef.current,
    };
    const container = containers[focusField];
    if (container) {
      if (typeof container.scrollIntoView === "function") {
        container.scrollIntoView({ block: "center", behavior: "smooth" });
      }
      const focusable = container.matches("input, select, textarea, button")
        ? container
        : container.querySelector<HTMLElement>("input, select, textarea, button");
      focusable?.focus();
    }
    clearFocusField();
  }, [task, focusField, clearFocusField]);

  const inheritedTags = useMemo(() => {
    if (!task) return [];
    const explicitIds = new Set(task.explicitTags.map((t) => t.id));
    return task.effectiveTags.filter((t) => !explicitIds.has(t.id));
  }, [task]);

  if (openTaskId === null) return null;

  const patch = async (input: Parameters<typeof api.updateTask>[1]) => {
    if (!task) return;
    await api.updateTask(task.id, input);
    bump();
    reload();
  };

  const titleIsValid = titleDraft.trim().length > 0;
  const textFieldsDirty =
    textFieldsBaseline !== null &&
    (titleDraft !== textFieldsBaseline.title ||
      notesDraft !== textFieldsBaseline.notes ||
      waitingForDraft !== textFieldsBaseline.waitingFor);
  const saveChangesDisabled = !textFieldsDirty || !titleIsValid || savingTextFields;
  const saveNextDisabled = !titleIsValid || savingTextFields;

  const saveTextFields = async (clarify = false): Promise<boolean> => {
    if (!task || !titleIsValid || savingTextFields) return false;
    if (!clarify && !textFieldsDirty) return true;
    const snapshot: TextFieldsSnapshot = {
      title: titleDraft.trim(),
      notes: notesDraft,
      waitingFor: waitingForDraft,
    };
    setSavingTextFields(true);
    setSaveError(null);
    try {
      await api.updateTask(task.id, {
        title: snapshot.title,
        notes: snapshot.notes,
        waitingFor: snapshot.waitingFor || null,
        ...(clarify ? { needsClarification: false } : {}),
      });
      // Adopt the just-saved values as the new baseline right away so the
      // save button disables immediately, without waiting for the follow-up
      // reload's round trip (which may race with further typing).
      setTextFieldsBaseline(snapshot);
      bump();
      reload();
      return true;
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setSavingTextFields(false);
    }
  };

  const saveOnBlur = (relatedTarget: EventTarget | null) => {
    if (relatedTarget instanceof Element && relatedTarget.closest("[data-text-save]")) return;
    void saveTextFields();
  };

  const runDependencySearch = async (value: string) => {
    setDepQuery(value);
    if (!value.trim()) {
      setDepResults([]);
      return;
    }
    const results = await api.searchTasks({ text: value });
    setDepResults(results.filter((t) => task && t.id !== task.id).slice(0, 8));
  };

  return (
    <BottomSheet title={strings.taskDetails} onClose={close} labelledBy="task-detail-title">
      {loading ? <LoadingState /> : null}
      {error ? <ErrorState message={error} onRetry={reload} /> : null}
      {task ? (
        <div className="stack">
          {task.blocked ? <div className="badge badge-status-waiting">{strings.blockedHint}</div> : null}

          <div className="field">
            <label htmlFor="task-title">{strings.title}</label>
            <input
              id="task-title"
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              onBlur={(e) => saveOnBlur(e.relatedTarget)}
            />
          </div>

          <div className="row-between">
            <div className="row">
              <StatusBadge status={task.status} />
              {task.needsClarification ? (
                <span className="badge badge-clarification">{strings.needsClarification}</span>
              ) : null}
            </div>
            {task.status === "done" || task.status === "cancelled" ? (
              <button type="button" className="btn btn-sm" onClick={() => void taskActions.reopen(task).then(reload)}>
                {strings.reopen}
              </button>
            ) : (
              <button type="button" className="btn btn-sm btn-primary" onClick={() => taskActions.requestToggle(task)}>
                {strings.done}
              </button>
            )}
          </div>

          <div className="field">
            <label htmlFor="task-status">{strings.status}</label>
            <select
              id="task-status"
              value={task.status}
              onChange={(e) =>
                void patch({
                  status: e.target.value as Task["status"],
                  needsClarification: false,
                })
              }
            >
              {taskStatuses.map((s) => (
                <option key={s} value={s}>
                  {taskStatusLabels[s]}
                </option>
              ))}
            </select>
          </div>

          {task.status === "waiting" ? (
            <div className="field">
              <label htmlFor="task-waiting-for">{strings.waitingFor}</label>
              <input
                id="task-waiting-for"
                value={waitingForDraft}
                placeholder={strings.waitingForPlaceholder}
                onChange={(e) => setWaitingForDraft(e.target.value)}
                onBlur={(e) => saveOnBlur(e.relatedTarget)}
              />
            </div>
          ) : null}

          <div className="field" ref={ownerFieldRef}>
            <label>{strings.owner}</label>
            <InheritanceControl
              mode={task.ownerInheritanceMode}
              explicitLabel={strings.ownOwner}
              onChange={(mode) => void patch({ ownerInheritanceMode: mode })}
            />
            {task.ownerInheritanceMode === "explicit" ? (
              <select
                aria-label={strings.owner}
                value={task.ownerMemberId ?? ""}
                onChange={(e) => void patch({ ownerMemberId: e.target.value ? Number(e.target.value) : null })}
              >
                <option value="">{strings.unassigned}</option>
                {members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            ) : (
              <p className="text-muted">
                {members.find((m) => m.id === task.effectiveOwnerId)?.name ?? strings.unassigned}
              </p>
            )}
          </div>

          <div className="row">
            <div className="field" style={{ flex: 1 }}>
              <label htmlFor="task-due">{strings.due}</label>
              <input
                id="task-due"
                type="date"
                value={task.dueDate ?? ""}
                onChange={(e) => void patch({ dueDate: e.target.value || null })}
              />
            </div>
            <div className="field" style={{ flex: 1 }} ref={scheduleFieldRef}>
              <label htmlFor="task-scheduled">{strings.scheduled}</label>
              <input
                id="task-scheduled"
                type="date"
                value={task.scheduledDate ?? ""}
                onChange={(e) => void patch({ scheduledDate: e.target.value || null })}
              />
            </div>
          </div>

          <div className="field">
            <label htmlFor="task-priority">{strings.priority}</label>
            <select
              id="task-priority"
              value={task.priority ?? ""}
              onChange={(e) => void patch({ priority: e.target.value ? Number(e.target.value) : null })}
            >
              <option value="">{strings.none}</option>
              <option value="1">1 – höchste</option>
              <option value="2">2</option>
              <option value="3">3</option>
              <option value="4">4</option>
              <option value="5">5 – niedrigste</option>
            </select>
          </div>

          <div className="field">
            <label>{strings.effectiveTags}</label>
            <div className="row" style={{ flexWrap: "wrap" }}>
              {task.explicitTags.length === 0 && inheritedTags.length === 0 ? (
                <span className="text-muted">{strings.noTags}</span>
              ) : null}
              {inheritedTags.map((tag) => {
                const excluded = task.excludedTagIds.includes(tag.id);
                return (
                  <TagChip
                    key={tag.id}
                    tag={tag}
                    excluded={excluded}
                    onToggleExclude={() =>
                      void patch({
                        excludedTagIds: excluded
                          ? task.excludedTagIds.filter((id) => id !== tag.id)
                          : [...task.excludedTagIds, tag.id],
                      })
                    }
                  />
                );
              })}
            </div>
            <TagPicker
              tags={tags ?? []}
              selectedIds={task.explicitTags.map((tag) => tag.id)}
              hiddenIds={inheritedTags.map((tag) => tag.id)}
              onChange={(tagIds) => patch({ tagIds })}
            />
          </div>

          <div className="field">
            <label htmlFor="task-notes">{strings.notes}</label>
            <textarea
              id="task-notes"
              ref={notesRef}
              value={notesDraft}
              onChange={(e) => setNotesDraft(e.target.value)}
              onBlur={(e) => saveOnBlur(e.relatedTarget)}
            />
          </div>

          <button
            type="button"
            className={`btn btn-block${saveChangesDisabled ? "" : " btn-primary"}`}
            disabled={saveChangesDisabled}
            data-text-save
            onClick={() => void saveTextFields()}
          >
            {strings.saveChanges}
          </button>

          {queueActive ? (
            <button
              type="button"
              className="btn btn-block btn-primary"
              disabled={saveNextDisabled}
              data-text-save
              onClick={() => {
                void saveTextFields(true).then((saved) => {
                  if (saved) advanceQueue();
                });
              }}
            >
              {strings.saveNext}
            </button>
          ) : null}

          {saveError ? (
            <div className="task-row-error" role="alert">
              <span>{strings.error}</span>
              <span className="text-muted">{saveError}</span>
            </div>
          ) : null}

          <div className="field">
            <label>{strings.dependencies}</label>
            {task.dependencies.length === 0 ? <p className="text-muted">{strings.noDependencies}</p> : null}
            <ul className="list" style={{ padding: 0, margin: 0 }}>
              {task.dependencies.map((dep) => (
                <li key={dep.id} className="row-between">
                  <span>{dep.title ?? `#${dep.dependsOnTaskId}`}</span>
                  <span className="row">
                    <span className="text-muted">{dep.resolved ? strings.resolved : strings.unresolved}</span>
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      onClick={() => void api.removeDependency(task.id, dep.dependsOnTaskId).then(() => { bump(); reload(); })}
                    >
                      {strings.removeDependency}
                    </button>
                  </span>
                </li>
              ))}
            </ul>
            <input
              aria-label={strings.searchDependency}
              placeholder={strings.searchDependency}
              value={depQuery}
              onChange={(e) => void runDependencySearch(e.target.value)}
            />
            {depResults.length > 0 ? (
              <ul className="list" style={{ padding: 0, margin: 0 }}>
                {depResults.map((t) => (
                  <li key={t.id}>
                    <button
                      type="button"
                      className="btn btn-sm btn-block"
                      onClick={() =>
                        void api.addDependency(task.id, t.id).then(() => {
                          setDepQuery("");
                          setDepResults([]);
                          bump();
                          reload();
                        })
                      }
                    >
                      {strings.addDependency}: {t.title}
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>

          <div className="field">
            <div className="row-between">
              <label>{strings.subtasks}</label>
            </div>
            {task.children.length === 0 ? <p className="text-muted">{strings.noTasks}</p> : null}
            <ul className="list" style={{ padding: 0, margin: 0 }}>
              {sortByPosition(task.children).map((child) => (
                <li key={child.id} className="row-between">
                  <span className="row">
                    <button
                      type="button"
                      className={`task-row-checkbox${child.status === "done" ? " done" : ""}${child.status === "cancelled" ? " cancelled" : ""}`}
                      aria-label={child.status === "done" || child.status === "cancelled" ? strings.reopen : strings.done}
                      onClick={() => {
                        taskActions.requestToggle(child);
                        reload();
                      }}
                    >
                      {child.status === "done" ? "✓" : child.status === "cancelled" ? "×" : ""}
                    </button>
                    <button type="button" className="link-plain" onClick={() => open(child.id)}>
                      {child.title}
                    </button>
                  </span>
                  <StatusBadge status={child.status} />
                </li>
              ))}
            </ul>
            <AddChildForm parentTaskId={task.id} onAdded={reload} />
          </div>

          <div className="field">
            <label>{strings.organizeControls}</label>
            <div className="row" style={{ flexWrap: "wrap" }}>
              <button type="button" className="btn btn-sm" onClick={() => setMovePrompt("parent")}>
                {strings.changeParent}
              </button>
              <button type="button" className="btn btn-sm" onClick={() => setMovePrompt("project")}>
                {strings.moveProject}
              </button>
              <button type="button" className="btn btn-sm" onClick={() => setMovePrompt("subtree")}>
                {strings.moveSubtree}
              </button>
            </div>
          </div>

          <p className="text-muted">
            {strings.created}: {formatDateTime(task.createdAt)} · {strings.updated}: {formatDateTime(task.updatedAt)}
          </p>

          <button
            type="button"
            className="btn btn-danger btn-block"
            onClick={() => {
              if (window.confirm(strings.deleteTaskConfirm)) {
                void api.deleteTask(task.id).then(() => {
                  bump();
                  close();
                });
              }
            }}
          >
            {strings.delete}
          </button>
        </div>
      ) : null}

      {taskActions.pendingTask ? (
        <ChildPolicyPrompt
          taskTitle={taskActions.pendingTask.title}
          action={taskActions.pendingAction ?? "complete"}
          onChoose={(policy) => {
            taskActions.resolvePolicy(policy);
            reload();
          }}
          onClose={taskActions.cancelPrompt}
        />
      ) : null}

      {movePrompt && task ? (
        <MoveTaskSheet
          task={task}
          mode={movePrompt}
          onClose={() => {
            setMovePrompt(null);
            reload();
          }}
        />
      ) : null}
    </BottomSheet>
  );
}

function AddChildForm({
  parentTaskId,
  onAdded,
}: {
  parentTaskId: number;
  onAdded: () => void;
}) {
  const [title, setTitle] = useState("");
  const [saving, setSaving] = useState(false);
  const { currentMemberId } = useIdentity();
  const { bump } = useRefresh();

  const submit = async () => {
    const trimmed = title.trim();
    if (!trimmed) return;
    setSaving(true);
    try {
      await api.createChildTask(parentTaskId, { title: trimmed, createdByMemberId: currentMemberId });
      setTitle("");
      bump();
      onAdded();
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      className="row"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <input
        aria-label={strings.addSubtask}
        placeholder={strings.addSubtask}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
      />
      <button type="submit" className="btn btn-sm" disabled={saving || !title.trim()}>
        {strings.addChild}
      </button>
    </form>
  );
}
