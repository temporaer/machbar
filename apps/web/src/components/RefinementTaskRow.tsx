import { useCallback, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { useNavigate } from "react-router-dom";
import type { TaskSize } from "@machbar/shared";
import { taskSizes } from "@machbar/shared";
import { useStrings } from "../lib/strings";
import type { Strings } from "../lib/strings";
import type { RefinementListItem } from "../lib/useRefinementActions";
import type { useRefinementActions } from "../lib/useRefinementActions";
import { nextSizeInCycle } from "../lib/useRefinementActions";
import { useTaskDetail } from "../lib/taskDetailContext";
import { MemberSelectionSheet } from "./MemberSelectionSheet";
import { useIdentity } from "../lib/identity";

const SWIPE_THRESHOLD = 72;

/** Short label for a task's current size, or the "unestimated" placeholder. */
function sizeLabel(size: TaskSize | null, strings: Strings): string {
  return size ? strings.taskSizeLabels[size] : "–";
}

export interface RefinementTaskRowProps {
  task: RefinementListItem;
  ownerName: string | null;
  actions: ReturnType<typeof useRefinementActions>;
}

/**
 * A single open task in the refinement list: owner, story (project title),
 * current size and blocked/waiting context, with a right-swipe that cycles
 * its size and a left-swipe/kebab that reveals direct S/M/L/XL/clear
 * choices plus a targeted Zuweisen popup (never the
 * full task editor) and the shared Zum-Projekt navigation. Mirrors the same
 * "single-column grid with stacked swipe backgrounds" concept as
 * `TaskRow.tsx`/`index.css`'s `.task-row`, reimplemented in
 * `RefinementPage.css` under its own `.refinement-row*` class names so this
 * page never depends on (or risks colliding with edits to) the excluded
 * `TaskRow.tsx`/global `index.css`.
 */
export function RefinementTaskRow({ task: taskProp, ownerName, actions }: RefinementTaskRowProps) {
  const strings = useStrings();
  const [dragX, setDragX] = useState(0);
  const [chipsOpen, setChipsOpen] = useState(false);
  const [assigning, setAssigning] = useState(false);
  const dragState = useRef<{ startX: number; dragging: boolean }>({ startX: 0, dragging: false });
  const navigate = useNavigate();
  const { open } = useTaskDetail();
  const { members } = useIdentity();
  const { isPending, retained, errors, clearError, setSize, cycleSize, clearSize, assignOwner } = actions;

  const retainedTask = retained.get(taskProp.id);
  const task = retainedTask ?? taskProp;
  const isRetained = Boolean(retainedTask);
  const rowError = errors[taskProp.id];
  const busy = isPending(task.id);

  const showCycleBg = dragX > 0;
  const showChipsBg = dragX < 0 || chipsOpen;
  const upcomingSize = nextSizeInCycle(task.size);

  const handlePointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (isRetained) return;
      dragState.current = { startX: e.clientX, dragging: true };
      const target = e.currentTarget;
      if (typeof target.setPointerCapture === "function") {
        target.setPointerCapture(e.pointerId);
      }
    },
    [isRetained],
  );

  const handlePointerMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragState.current.dragging) return;
    const delta = e.clientX - dragState.current.startX;
    setDragX(Math.max(-140, Math.min(140, delta)));
  }, []);

  const finishDrag = useCallback(() => {
    if (!dragState.current.dragging) return;
    dragState.current.dragging = false;
    if (dragX > SWIPE_THRESHOLD) {
      cycleSize(task);
    } else if (dragX < -SWIPE_THRESHOLD) {
      setChipsOpen(true);
    }
    setDragX(0);
  }, [dragX, cycleSize, task]);

  const chooseSize = (size: TaskSize) => {
    void setSize(task, size);
    setChipsOpen(false);
  };

  const chooseClear = () => {
    void clearSize(task);
    setChipsOpen(false);
  };

  // Targeted assignment popup rather than the full task editor.
  const assign = () => {
    setChipsOpen(false);
    setAssigning(true);
  };

  const goToProject = () => {
    if (!task.projectId) return;
    setChipsOpen(false);
    navigate(`/projects/${task.projectId}`);
  };

  return (
    <li className="refinement-row" style={{ listStyle: "none" }}>
      <div className={`refinement-row-swipe-bg cycle${showCycleBg ? " visible" : ""}`} aria-hidden="true">
        {sizeLabel(upcomingSize, strings)}
      </div>
      <div className={`refinement-row-swipe-bg chips${showChipsBg ? " visible" : ""}`} aria-hidden="true">
        {strings.moreActions}
      </div>
      <div
        className={`refinement-row-content${isRetained ? " retained" : ""}`}
        style={dragX ? { transform: `translateX(${dragX}px)` } : undefined}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={finishDrag}
        onPointerCancel={() => {
          dragState.current.dragging = false;
          setDragX(0);
        }}
      >
        {/*
          Non-gesture equivalent of the right-swipe cycle (mouse/keyboard/
          screen-reader users, or anyone who doesn't want to swipe): tapping
          the size badge itself performs the exact same cycle step.
        */}
        <button
          type="button"
          className="refinement-row-size"
          disabled={busy || isRetained}
          aria-label={`${strings.currentSize}: ${sizeLabel(task.size, strings)}. ${strings.swipeHintSize}`}
          onClick={() => cycleSize(task)}
        >
          {sizeLabel(task.size, strings)}
        </button>
        <button type="button" className="refinement-row-main" onClick={() => open(task.id)}>
          <div className="refinement-row-title">
            {task.title}
            {task.blocked ? <span aria-label={strings.blockedBy}> 🔒</span> : null}
          </div>
          <div className="refinement-row-meta">
            {task.projectTitle ? (
              <span>
                {strings.story}: {task.projectTitle}
              </span>
            ) : null}
            {ownerName ? <span>{ownerName}</span> : <span>{strings.shared}</span>}
            <span>{strings.taskStatusLabels[task.status]}</span>
            {task.externalWait?.waitingFor?.trim() ? (
              <span>
                {strings.waitingFor}: {task.externalWait.waitingFor.trim()}
              </span>
            ) : null}
            {task.dependencies
              .filter((dependency) => !dependency.resolved)
              .map((dependency) => (
                <span key={dependency.id}>
                  {strings.blockedBy}: {dependency.title ?? `#${dependency.dependsOnTaskId}`}
                </span>
              ))}
          </div>
        </button>
        <button
          type="button"
          className="refinement-row-kebab"
          aria-label={strings.moreActions}
          aria-expanded={chipsOpen}
          disabled={isRetained}
          onClick={() => setChipsOpen((o) => !o)}
        >
          ⋯
        </button>
      </div>

      {chipsOpen ? (
        <div className="refinement-row-chips" role="group" aria-label={strings.moreActions}>
          {taskSizes.map((size) => (
            <button
              key={size}
              type="button"
              className="btn btn-sm"
              aria-pressed={task.size === size}
              onClick={() => chooseSize(size)}
            >
              {strings.taskSizeLabels[size]}
            </button>
          ))}
          <button type="button" className="btn btn-sm" onClick={chooseClear}>
            {strings.clearSize}
          </button>
          <button type="button" className="btn btn-sm" onClick={assign}>
            {strings.assign}
          </button>
          <button
            type="button"
            className="btn btn-sm"
            disabled={!task.projectId}
            aria-disabled={!task.projectId}
            title={task.projectId ? undefined : strings.noProjectChipHint}
            onClick={goToProject}
          >
            {strings.toProject}
          </button>
        </div>
      ) : null}

      {assigning ? (
        <MemberSelectionSheet
          title={`${strings.assign}: ${task.title}`}
          label={strings.owner}
          idPrefix={`refinement-owner-${task.id}`}
          members={members}
          value={task.effectiveOwnerId}
          valueIsExplicit={task.effectiveOwnerSource === "task"}
          unassignedLabel={strings.shared}
          onClose={() => setAssigning(false)}
          onSelect={async (ownerMemberId) => {
            await assignOwner(task, ownerMemberId);
          }}
        />
      ) : null}

      {rowError ? (
        <div className="refinement-row-error" role="alert">
          <span>{strings.error}</span>
          <span className="text-muted">{rowError}</span>
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => clearError(task.id)}>
            {strings.close}
          </button>
        </div>
      ) : null}
    </li>
  );
}
