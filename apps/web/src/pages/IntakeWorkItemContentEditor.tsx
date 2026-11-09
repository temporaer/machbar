import { useState } from "react";
import type { IntakeDraftWorkItem, IntakeIssue, IntakeRecord } from "@machbar/shared";
import { useStrings } from "../lib/strings";
import { BottomSheet } from "../components/BottomSheet";
import { MarkdownEditor } from "../components/MarkdownEditor";
import { MarkdownNotes } from "../components/MarkdownNotes";
import { IntakeIssueText } from "./IntakeReviewFields";
import { DestinationPicker } from "../components/DestinationPicker";

export function IntakeWorkItemContentEditor({
  item,
  index,
  issues,
  onChange,
  onKindChange,
  onClose,
  allowedKinds = ["action", "project", "reference"],
  allowClarification = true,
  existingProjects = [],
  workItems = [],
  allowDestination = true,
}: {
  item: IntakeDraftWorkItem;
  index: number;
  issues: IntakeIssue[];
  onChange: (item: IntakeDraftWorkItem) => void;
  onKindChange: (kind: IntakeDraftWorkItem["kind"]) => void;
  onClose: () => void;
  allowedKinds?: IntakeDraftWorkItem["kind"][] | undefined;
  allowClarification?: boolean;
  existingProjects?: IntakeRecord["existingProjects"];
  workItems?: IntakeDraftWorkItem[];
  allowDestination?: boolean;
}) {
  const strings = useStrings();
  const [titleEditing, setTitleEditing] = useState(false);
  const [titleDraft, setTitleDraft] = useState(item.title);
  const [notesEditing, setNotesEditing] = useState(false);
  const [notesDraft, setNotesDraft] = useState(item.notes ?? "");
  const path = ["workItems", index];

  return (
    <BottomSheet title={`${strings.edit}: ${item.title}`} onClose={onClose}>
      <div className="stack intake-edit-sheet">
        <section className="intake-authored-field">
          <div className="intake-authored-heading">
            <strong>{strings.intakeProposalTitle}</strong>
            {!titleEditing ? (
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => {
                  setTitleDraft(item.title);
                  setTitleEditing(true);
                }}
              >
                {strings.edit}
              </button>
            ) : null}
          </div>
          {titleEditing ? (
            <>
              <input
                aria-label={strings.intakeProposalTitle}
                value={titleDraft}
                onChange={(event) => setTitleDraft(event.target.value)}
              />
              <div className="row">
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => {
                    onChange({ ...item, title: titleDraft });
                    setTitleEditing(false);
                  }}
                >
                  {strings.save}
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    setTitleDraft(item.title);
                    setTitleEditing(false);
                  }}
                >
                  {strings.cancel}
                </button>
              </div>
            </>
          ) : (
            <p>{item.title}</p>
          )}
          <IntakeIssueText issues={issues} path={[...path, "title"]} />
        </section>

        <label className="field">
          <span className="field-label">{strings.intakeType}</span>
          <select
            value={item.kind}
            disabled={allowedKinds.length === 1}
            onChange={(event) =>
              onKindChange(
                event.target.value as IntakeDraftWorkItem["kind"],
              )
            }
          >
            {allowedKinds.includes("action") ? <option value="action">{strings.task}</option> : null}
            {allowedKinds.includes("project") ? <option value="project">{strings.project}</option> : null}
            {allowedKinds.includes("reference") ? <option value="reference">{strings.materialLabel}</option> : null}
          </select>
        </label>

        {allowDestination ? <>
          <label className="field">
            <span className="field-label">{strings.intakeParent}</span>
            <select value={item.parentKey ?? ""} onChange={(event) => onChange({
              ...item, parentKey: event.target.value || null, existingProjectId: null, existingProjectRevision: null,
            })}>
              <option value="">{strings.intakeStandalone}</option>
              {workItems.filter((candidate) => {
                if (candidate.key === item.key || !candidate.enabled) return false;
                if (candidate.kind !== "project" && !(candidate.kind === "action" && item.kind !== "project")) return false;
                let ancestor: IntakeDraftWorkItem | undefined = candidate;
                const seen = new Set<string>();
                while (ancestor) {
                  if (ancestor.key === item.key || seen.has(ancestor.key)) return false;
                  seen.add(ancestor.key);
                  ancestor = workItems.find((value) => value.key === ancestor?.parentKey);
                }
                return true;
              }).map((candidate) => <option key={candidate.key} value={candidate.key}>{candidate.title}</option>)}
            </select>
          </label>
          {item.kind === "action" ? <>
            <p className="text-muted">{strings.intakeExistingProjectHelp}</p>
            <DestinationPicker kind="project" label={strings.intakeExistingProject}
              options={existingProjects.map((project) => ({ id: project.id, title: project.title,
                subtitle: strings.projectStatusLabels[project.status] }))}
              value={item.existingProjectId ?? null} noneLabel={strings.intakeNoExistingProject}
              onChange={(id) => onChange({ ...item, existingProjectId: id,
                existingProjectRevision: existingProjects.find((project) => project.id === id)?.revision ?? null,
                ...(id !== null ? { parentKey: null } : {}),
              })} />
            <IntakeIssueText issues={issues} path={[...path, "existingProjectId"]} />
          </> : null}
        </> : null}

        <section className="intake-authored-field">
          <div className="intake-authored-heading">
            <strong>{strings.notes}</strong>
            {!notesEditing ? (
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => {
                  setNotesDraft(item.notes ?? "");
                  setNotesEditing(true);
                }}
              >
                {strings.edit}
              </button>
            ) : null}
          </div>
          {notesEditing ? (
            <>
              <MarkdownEditor
                aria-label={strings.notes}
                value={notesDraft}
                onChange={setNotesDraft}
              />
              <div className="row">
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => {
                    onChange({ ...item, notes: notesDraft || null });
                    setNotesEditing(false);
                  }}
                >
                  {strings.save}
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    setNotesDraft(item.notes ?? "");
                    setNotesEditing(false);
                  }}
                >
                  {strings.cancel}
                </button>
              </div>
            </>
          ) : item.notes?.trim() ? (
            <MarkdownNotes value={item.notes} />
          ) : (
            <p className="text-muted">{strings.intakeNoNotes}</p>
          )}
          <IntakeIssueText issues={issues} path={[...path, "notes"]} />
        </section>

        {allowClarification && item.kind === "action" ? (
          <label>
            <input
              type="checkbox"
              checked={item.needsClarification}
              onChange={(event) =>
                onChange({
                  ...item,
                  needsClarification: event.target.checked,
                })
              }
            />{" "}
            {strings.intakeNeedsClarification}
          </label>
        ) : null}
        <IntakeIssueText issues={issues} path={path} />
      </div>
    </BottomSheet>
  );
}
