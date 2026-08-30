import { useState } from "react";
import type { ProjectWithActions } from "../lib/api";
import { api } from "../lib/api";
import { useIdentity } from "../lib/identity";
import { useRefresh } from "../lib/refresh";
import { useStrings } from "../lib/strings";
import type { Strings } from "../lib/strings";
import {
  isStaleWriteConflict,
  localizedErrorMessage,
} from "../lib/errorMessage";
import { BottomSheet } from "./BottomSheet";

function errorMessage(error: unknown, strings: Strings): string {
  return localizedErrorMessage(error, strings);
}

/**
 * The deliberately small follow-up after capturing a project. It records
 * one useful next piece of structure without turning capture into the full
 * project editor or leaving the just-created project stranded.
 */
export function CaptureProjectBreakdownSheet({
  project,
  onClose,
}: {
  project: ProjectWithActions;
  onClose: () => void;
}) {
  const strings = useStrings();
  const { currentMemberId } = useIdentity();
  const { bump } = useRefresh();
  const [nextAction, setNextAction] = useState("");
  const [subtask, setSubtask] = useState("");
  const [waitingTitle, setWaitingTitle] = useState("");
  const [waitingFor, setWaitingFor] = useState("");
  const [criterion, setCriterion] = useState("");
  const [notes, setNotes] = useState(project.notes);
  const [savedNotes, setSavedNotes] = useState(project.notes);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const addTask = async (
    kind: "next-action" | "subtask" | "waiting",
    title: string,
    externalWaitingFor?: string,
  ) => {
    const trimmed = title.trim();
    if (!trimmed || saving) return;
    setSaving(kind);
    setError(null);
    try {
      const created = await api.createTask({
        title: trimmed,
        projectId: project.id,
        parentTaskId: null,
        createdByMemberId: currentMemberId,
        status: "actionable",
      });
      if (externalWaitingFor !== undefined) {
        await api.setExternalWait(created.id, {
          waitingFor: externalWaitingFor,
          expectedRevision: created.revision,
        });
      }
      if (kind === "next-action") setNextAction("");
      if (kind === "subtask") setSubtask("");
      if (kind === "waiting") {
        setWaitingTitle("");
        setWaitingFor("");
      }
      bump();
    } catch (err) {
      if (isStaleWriteConflict(err)) bump();
      setError(errorMessage(err, strings));
    } finally {
      setSaving(null);
    }
  };

  const addCriterion = async () => {
    const trimmed = criterion.trim();
    if (!trimmed || saving) return;
    setSaving("criterion");
    setError(null);
    try {
      await api.addCriterion(project.id, trimmed);
      setCriterion("");
      bump();
    } catch (err) {
      setError(errorMessage(err, strings));
    } finally {
      setSaving(null);
    }
  };

  const saveNotes = async () => {
    if (saving || notes === project.notes) return;
    setSaving("notes");
    setError(null);
    try {
      await api.updateProject(project.id, {
        notes,
        expectedRevision: project.revision,
      });
      setSavedNotes(notes);
      bump();
    } catch (err) {
      setError(errorMessage(err, strings));
    } finally {
      setSaving(null);
    }
  };

  return (
    <BottomSheet title={strings.projectBreakdownTitle} onClose={onClose} labelledBy="capture-project-breakdown-title">
      <div className="stack capture-project-breakdown">
        <p className="text-muted">{project.title}</p>
        {error ? <p className="capture-error" role="alert">{error}</p> : null}

        <form
          className="stack"
          onSubmit={(event) => {
            event.preventDefault();
            void addTask("next-action", nextAction);
          }}
        >
          <div className="field">
            <label htmlFor="capture-next-action">{strings.nextStepQuestion}</label>
            <input
              id="capture-next-action"
              autoFocus
              value={nextAction}
              onChange={(event) => setNextAction(event.target.value)}
              placeholder={strings.nextStepQuestion}
            />
          </div>
          <button type="submit" className="btn btn-primary" disabled={saving !== null || !nextAction.trim()}>
            {strings.addNextAction}
          </button>
        </form>

        <div className="capture-breakdown-section">
          <div className="field">
            <label htmlFor="capture-subtask">{strings.addChild}</label>
            <input
              id="capture-subtask"
              value={subtask}
              onChange={(event) => setSubtask(event.target.value)}
              placeholder={strings.addChild}
            />
          </div>
          <button
            type="button"
            className="btn"
            disabled={saving !== null || !subtask.trim()}
            onClick={() => void addTask("subtask", subtask)}
          >
            {strings.addChild}
          </button>
        </div>

        <div className="capture-breakdown-section">
          <div className="field">
            <label htmlFor="capture-waiting-title">{strings.waitingItem}</label>
            <input
              id="capture-waiting-title"
              value={waitingTitle}
              onChange={(event) => setWaitingTitle(event.target.value)}
              placeholder={strings.title}
            />
          </div>
          <div className="field">
            <label htmlFor="capture-waiting-for">{strings.waitingFor}</label>
            <input
              id="capture-waiting-for"
              value={waitingFor}
              onChange={(event) => setWaitingFor(event.target.value)}
              placeholder={strings.waitingForPlaceholder}
            />
          </div>
          <button
            type="button"
            className="btn"
            disabled={saving !== null || !waitingTitle.trim() || !waitingFor.trim()}
            onClick={() => void addTask("waiting", waitingTitle, waitingFor.trim())}
          >
            {strings.addWaitingItem}
          </button>
        </div>

        <div className="capture-breakdown-section">
          <div className="field">
            <label htmlFor="capture-criterion">{strings.criteria}</label>
            <input
              id="capture-criterion"
              value={criterion}
              onChange={(event) => setCriterion(event.target.value)}
              placeholder={strings.addCriterionPlaceholder}
            />
          </div>
          <button
            type="button"
            className="btn"
            disabled={saving !== null || !criterion.trim()}
            onClick={() => void addCriterion()}
          >
            {strings.addCriterion}
          </button>
        </div>

        <div className="capture-breakdown-section">
          <div className="field">
            <label htmlFor="capture-project-notes">{strings.notes}</label>
            <textarea
              id="capture-project-notes"
              rows={3}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
            />
          </div>
          <button
            type="button"
            className="btn"
            disabled={saving !== null || notes === savedNotes}
            onClick={() => void saveNotes()}
          >
            {strings.saveNotes}
          </button>
        </div>

        <button type="button" className="btn btn-block" onClick={onClose} disabled={saving !== null}>
          {strings.finishLater}
        </button>
      </div>
    </BottomSheet>
  );
}
