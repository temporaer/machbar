import { useWorkItemKeyboardNav } from "../lib/useWorkItemKeyboardNav";

/**
 * Renders nothing; exists so each page can mount `useWorkItemKeyboardNav`
 * as a child *inside* its own `InteractionScopeProvider` (the hook itself
 * requires a scope) without every page repeating the same trivial wrapper.
 */
export function WorkItemKeyboardNavMount() {
  useWorkItemKeyboardNav();
  return null;
}
