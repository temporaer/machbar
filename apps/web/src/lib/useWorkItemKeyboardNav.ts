import { useEffect } from "react";
import { useInteractionScope } from "./interactionScope";
import { useWorkItemCommands } from "./useWorkItemCommands";
import { shouldSuppressGlobalShortcuts } from "./keyboardShortcuts";
import type { StructuralMoveDirection } from "./interactionScope";

/**
 * Every `TaskRow` currently rendered by this scope's outline(s), in
 * visible DOM order. Read live at each keypress rather than kept as
 * reactive state: a collapsed subtree is not merely hidden, it is
 * unmounted (see `TaskRow.tsx`), so this naturally excludes collapsed
 * descendants without any separate bookkeeping, and it spans however
 * many `TaskOutline` sections a page renders (e.g. Today's up to five)
 * without a manual cross-outline registry.
 */
function visibleWorkItemIds(): number[] {
  return Array.from(document.querySelectorAll<HTMLElement>("[data-workitem-id]"))
    .map((element) => Number(element.dataset.workitemId))
    .filter((id) => Number.isFinite(id));
}

function focusRow(workItemId: number) {
  document
    .querySelector<HTMLElement>(`[data-workitem-id="${workItemId}"] .task-row-main`)
    ?.focus();
}

const ALT_DIRECTIONS: Record<string, StructuralMoveDirection> = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "outdent",
  ArrowRight: "indent",
};

/**
 * `j/k/h/l/Alt+arrows` for the WorkItem rows visible in this page's
 * interaction scope. Mounted once per page alongside that page's
 * `InteractionScopeProvider` (Today/Inbox/All/ProjectDetail/Waiting).
 * `Enter` is deliberately not handled here: `j/k` move DOM focus onto the
 * row's own primary button (`.task-row-main`, already wired to dispatch
 * `task.open` on click), so native browser Enter-activates-focused-button
 * behavior opens it without a second, redundant implementation.
 *
 * Only `TaskRow` (tasks) is covered in this pass — `ProjectStoryRow`
 * (stories/projects) is not yet migrated to the command layer or given a
 * `data-workitem-id` marker; that is Phase 7's universal-row work.
 */
export function useWorkItemKeyboardNav() {
  const scope = useInteractionScope();
  const dispatch = useWorkItemCommands();

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey) return;
      if (shouldSuppressGlobalShortcuts(event.target)) return;

      if (event.altKey) {
        const direction = ALT_DIRECTIONS[event.key];
        if (!direction || scope.activeId === null || !scope.moveBy) return;
        event.preventDefault();
        scope.moveBy(scope.activeId, direction);
        return;
      }

      switch (event.key) {
        case "j":
        case "k": {
          const ids = visibleWorkItemIds();
          if (ids.length === 0) return;
          event.preventDefault();
          const currentIndex = scope.activeId === null ? -1 : ids.indexOf(scope.activeId);
          let nextIndex: number;
          if (event.key === "j") {
            nextIndex = currentIndex === -1 ? 0 : Math.min(currentIndex + 1, ids.length - 1);
          } else {
            nextIndex = currentIndex === -1 ? ids.length - 1 : Math.max(currentIndex - 1, 0);
          }
          const nextId = ids[nextIndex];
          if (nextId === undefined) return;
          scope.setActive(nextId);
          focusRow(nextId);
          return;
        }
        case "h":
          if (scope.activeId === null) return;
          event.preventDefault();
          dispatch({ type: "outline.collapse", workItemId: scope.activeId });
          return;
        case "l":
          if (scope.activeId === null) return;
          event.preventDefault();
          dispatch({ type: "outline.expand", workItemId: scope.activeId });
          return;
        default:
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [scope, dispatch]);
}

