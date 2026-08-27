import { useState } from "react";
import type { Project } from "@machbar/shared";
import { strings } from "../lib/strings";
import { AcceptanceCriteriaEditor } from "./AcceptanceCriteriaEditor";
import { BottomSheet } from "./BottomSheet";

/**
 * The Backlog-review row's targeted "Akzeptanzkriterien" popup: exactly the
 * same editor the full `ProjectEditSheet` embeds, but with nothing else
 * around it, so refining a story's criteria never means leaving the backlog
 * list (and losing the reviewing flow) just to reach the project detail
 * page.
 */
export function StoryCriteriaSheet({ story, onClose }: { story: Project; onClose: () => void }) {
  const [error, setError] = useState<string | null>(null);

  return (
    <BottomSheet
      title={`${strings.criteria}: ${story.title}`}
      onClose={onClose}
      labelledBy="story-criteria-title"
    >
      <div className="stack">
        {error ? (
          <p role="alert" style={{ color: "var(--color-danger)" }}>
            {error}
          </p>
        ) : null}
        <AcceptanceCriteriaEditor
          projectId={story.id}
          criteria={story.acceptanceCriteria}
          onError={setError}
          autoFocusNewCriterion
        />
        <button type="button" className="btn btn-block" onClick={onClose}>
          {strings.close}
        </button>
      </div>
    </BottomSheet>
  );
}
