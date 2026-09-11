import { useStrings } from "../lib/strings";

/**
 * Shared inline error treatment for Task/Project detail surfaces: a
 * top-level save/action error, or a scoped error next to the control that
 * triggered it (e.g. a rejected dependency candidate). Distinct from
 * `.task-row-error`, which stays reserved for compact list-row contexts
 * (e.g. `TaskOutline` child rows) with their fixed checkbox-aligned padding.
 */
export function WorkItemInlineError({ message }: { message: string }) {
  const strings = useStrings();
  return (
    <div className="detail-inline-error" role="alert">
      <span>{strings.error}</span>
      <span className="text-muted">{message}</span>
    </div>
  );
}
