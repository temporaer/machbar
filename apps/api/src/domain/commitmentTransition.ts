/** Classifies concrete planning for read-side selection; never changes lifecycle. */
export function hasExecutionCommitment(input: {
  kind: "action" | "reference";
  dueDate: string | null;
  scheduledDate: string | null;
  revisitAt?: string | null;
  reminders: readonly unknown[];
}): boolean {
  return input.kind === "action" && (
    input.dueDate !== null || input.scheduledDate !== null ||
    (input.reminders.length > 0 && (input.revisitAt ?? null) === null)
  );
}
