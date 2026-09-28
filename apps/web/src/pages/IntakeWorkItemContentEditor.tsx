import { useState } from "react";
import type { IntakeDraftWorkItem, IntakeIssue } from "@machbar/shared";
import { useStrings } from "../lib/strings";
import { BottomSheet } from "../components/BottomSheet";
import { MarkdownEditor } from "../components/MarkdownEditor";
import { MarkdownNotes } from "../components/MarkdownNotes";
import { IntakeIssueText } from "./IntakeReviewFields";

export function IntakeWorkItemContentEditor({
  item,
  index,
  issues,
  onChange,
  onKindChange,
  onClose,
}: {
  item: IntakeDraftWorkItem;
  index: number;
  issues: IntakeIssue[];
  onChange: (item: IntakeDraftWorkItem) => void;
  onKindChange: (kind: IntakeDraftWorkItem["kind"]) => void;
  onClose: () => void;
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
            onChange={(event) =>
              onKindChange(
                event.target.value as IntakeDraftWorkItem["kind"],
              )
            }
          >
            <option value="action">{strings.task}</option>
            <option value="project">{strings.project}</option>
            <option value="reference">{strings.materialLabel}</option>
          </select>
        </label>

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

        {item.kind === "action" ? (
          <label>
            <input
              type="checkbox"
              checked={item.needsClarification}
              onChange={(event) =>
                onChange({
                  ...item,
                  needsClarification: event.target.checked,
                  reminderAt: event.target.checked ? null : item.reminderAt,
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
