/**
 * Presentation-only emphasis for compiled Today rows. Ordinary task and
 * project views keep their existing status/classification styling.
 */
export type AttentionTone =
  | "planned"
  | "overdue"
  | "due-today"
  | "due-soon"
  | "revisit"
  | "available";
