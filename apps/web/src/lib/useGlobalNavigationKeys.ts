import { useEffect, useMemo, useRef, useState } from "react";
import { useWorkItemCommands } from "./useWorkItemCommands";
import { shouldSuppressGlobalShortcuts } from "./keyboardShortcuts";
import { commandDescriptors, navigationBySecondKey } from "./commandRegistry";

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
  const [prefixOpen, setPrefixOpen] = useState(false);
  const navigation = useMemo(navigationBySecondKey, []);

  useEffect(() => {
    let awaitingSecondKey = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    function clearPrefix() {
      awaitingSecondKey = false;
      setPrefixOpen(false);
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
        const descriptor = navigation.get(event.key);
        if (!descriptor?.command) return;
        event.preventDefault();
        dispatchRef.current(descriptor.command);
        return;
      }

      if (event.key === "g") {
        awaitingSecondKey = true;
        setPrefixOpen(true);
        timeoutId = setTimeout(clearPrefix, PREFIX_TIMEOUT_MS);
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      clearPrefix();
    };
  }, [navigation]);

  return {
    prefixOpen,
    choices: commandDescriptors.filter(
      (descriptor) => descriptor.group === "navigation",
    ),
  };
}
