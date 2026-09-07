import { useEffect, useRef } from "react";
import { useWorkItemCommands } from "./useWorkItemCommands";
import type { WorkItemCommand } from "./commands";
import { shouldSuppressGlobalShortcuts } from "./keyboardShortcuts";

const NAV_COMMANDS: Record<string, WorkItemCommand> = {
  t: { type: "navigate.today" },
  i: { type: "navigate.inbox" },
  p: { type: "navigate.projects" },
  w: { type: "navigate.waiting" },
  m: { type: "navigate.more" },
};

const PREFIX_TIMEOUT_MS = 1200;

/**
 * The `g t/i/p/w/m` navigation sequence, mounted exactly once (in
 * `App.tsx`, above the route table) rather than per page. Unlike
 * `j/k/h/l` and the outline/story commands, navigation needs no
 * interaction scope — `g` works identically from any page — and a
 * page-local `InteractionScopeProvider` can't be read from an ancestor
 * anyway (React context only flows to descendants), so this has to live
 * above the routes as its own scope-independent handler. See
 * `useWorkItemKeyboardNav` for the scope-aware `j/k/h/l/Enter/Alt+arrows`
 * handler mounted per page.
 */
export function useGlobalNavigationKeys() {
  const dispatch = useWorkItemCommands();
  const dispatchRef = useRef(dispatch);
  dispatchRef.current = dispatch;

  useEffect(() => {
    let awaitingSecondKey = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    function clearPrefix() {
      awaitingSecondKey = false;
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (shouldSuppressGlobalShortcuts(event.target)) return;

      if (awaitingSecondKey) {
        clearPrefix();
        const command = NAV_COMMANDS[event.key];
        if (!command) return;
        event.preventDefault();
        dispatchRef.current(command);
        return;
      }

      if (event.key === "g") {
        awaitingSecondKey = true;
        timeoutId = setTimeout(clearPrefix, PREFIX_TIMEOUT_MS);
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      clearPrefix();
    };
  }, []);
}
