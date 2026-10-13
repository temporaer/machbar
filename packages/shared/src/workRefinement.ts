import { z } from "zod";
import {
  isoCalendarDateSchema,
  isoDateTimeSchema,
  taskReminderCreateSchema,
  taskRemindersSchema,
} from "./taskReminder.js";

export const workRefinementIntentSchema = z.enum(["improve", "next_action", "structure"]);
export type WorkRefinementIntent = z.infer<typeof workRefinementIntentSchema>;

const note = z.string().max(4_000);
const title = z.string().trim().min(1).max(200);
const changeBase = { rationale: z.string().trim().min(1).max(800), accepted: z.boolean().default(false) };
const refinementChangeFields = [
  "kind",
  "rationale",
  "accepted",
  "targetId",
  "taskId",
  "parentTaskId",
  "projectId",
  "dependsOnTaskId",
  "position",
  "title",
  "notes",
  "scheduledDate",
  "dueDate",
  "revisitAt",
  "clearScheduledDate",
  "clearDueDate",
  "clearRevisitAt",
  "reminders",
  "waitingFor",
  "outcome",
  "criterionId",
  "affectedIds",
] as const;
const optionalNonNullableRefinementChangeFields = new Set(["title", "criterionId"]);
const providerNullPlaceholderFields: Record<string, ReadonlySet<string>> = {
  update_task: new Set(["scheduledDate", "dueDate", "revisitAt", "reminders"]),
  create_child: new Set(["scheduledDate", "dueDate", "revisitAt", "reminders"]),
};
const explicitDateClearFields: Record<string, Readonly<Record<string, string>>> = {
  update_task: {
    scheduledDate: "clearScheduledDate",
    dueDate: "clearDueDate",
    revisitAt: "clearRevisitAt",
  },
  create_child: {
    scheduledDate: "clearScheduledDate",
    dueDate: "clearDueDate",
    revisitAt: "clearRevisitAt",
  },
};

const allowedRefinementChangeFields: Record<string, ReadonlySet<string>> = {
  update_task: new Set(["kind", "rationale", "accepted", "targetId", "title", "notes", "scheduledDate", "dueDate", "revisitAt", "clearScheduledDate", "clearDueDate", "clearRevisitAt", "reminders"]),
  update_project: new Set(["kind", "rationale", "accepted", "targetId", "title", "notes"]),
  convert_task_to_project: new Set(["kind", "rationale", "accepted", "targetId"]),
  create_child: new Set(["kind", "rationale", "accepted", "parentTaskId", "title", "notes", "scheduledDate", "dueDate", "revisitAt", "clearScheduledDate", "clearDueDate", "clearRevisitAt", "reminders"]),
  move_task: new Set(["kind", "rationale", "accepted", "targetId", "parentTaskId", "projectId", "position"]),
  add_dependency: new Set(["kind", "rationale", "accepted", "taskId", "dependsOnTaskId"]),
  update_wait: new Set(["kind", "rationale", "accepted", "taskId", "waitingFor", "revisitAt"]),
  update_project_outcome: new Set(["kind", "rationale", "accepted", "projectId", "criterionId", "outcome"]),
  advisory: new Set(["kind", "rationale", "accepted", "affectedIds", "title"]),
};

export const workRefinementChangeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("update_task"), targetId: z.number().int().positive(), title: title.optional(), notes: note.nullable().optional(), scheduledDate: isoCalendarDateSchema.nullable().optional(), dueDate: isoCalendarDateSchema.nullable().optional(), revisitAt: isoDateTimeSchema.nullable().optional(), reminders: taskRemindersSchema.optional(), ...changeBase }).strict(),
  z.object({ kind: z.literal("update_project"), targetId: z.number().int().positive(), title: title.optional(), notes: note.nullable().optional(), ...changeBase }).strict(),
  z.object({ kind: z.literal("convert_task_to_project"), targetId: z.number().int().positive(), ...changeBase }).strict(),
  z.object({ kind: z.literal("create_child"), parentTaskId: z.number().int().positive(), title, notes: note.nullable().optional(), scheduledDate: isoCalendarDateSchema.nullable().optional(), dueDate: isoCalendarDateSchema.nullable().optional(), revisitAt: isoDateTimeSchema.nullable().optional(), reminders: taskReminderCreateSchema.optional(), ...changeBase }).strict(),
  z.object({ kind: z.literal("move_task"), targetId: z.number().int().positive(), parentTaskId: z.number().int().positive().nullable(), projectId: z.number().int().positive().nullable(), position: z.number().int().min(0), ...changeBase }).strict(),
  z.object({ kind: z.literal("add_dependency"), taskId: z.number().int().positive(), dependsOnTaskId: z.number().int().positive(), ...changeBase }).strict(),
  z.object({ kind: z.literal("update_wait"), taskId: z.number().int().positive(), waitingFor: z.string().trim().min(1).max(500), revisitAt: z.string().datetime({ offset: true }).nullable().optional(), ...changeBase }).strict(),
  z.object({ kind: z.literal("update_project_outcome"), projectId: z.number().int().positive(), criterionId: z.number().int().positive().optional(), outcome: z.string().trim().min(1).max(4_000), ...changeBase }).strict(),
  z.object({ kind: z.literal("advisory"), affectedIds: z.array(z.number().int().positive()).max(20), title, ...changeBase }).strict(),
]);
export type WorkRefinementChange = z.infer<typeof workRefinementChangeSchema>;

export const workRefinementProposalSchema = z.object({
  intent: workRefinementIntentSchema,
  summary: z.string().trim().min(1).max(1_000),
  disposition: z.enum(["changes", "clarification", "leave_alone"]),
  question: z.string().trim().max(500).nullable(),
  changes: z.array(workRefinementChangeSchema).max(12),
}).strict().superRefine((proposal, context) => {
  if (proposal.disposition === "clarification" && !proposal.question) {
    context.addIssue({ code: "custom", path: ["question"], message: "A clarification proposal needs a question." });
  }
  if (proposal.disposition === "clarification" && proposal.changes.length > 0) {
    context.addIssue({ code: "custom", path: ["changes"], message: "A clarification proposal must not include mutations." });
  }
  if (proposal.disposition !== "clarification" && proposal.question !== null) {
    context.addIssue({ code: "custom", path: ["question"], message: "Only clarification proposals can include a question." });
  }
  if (proposal.disposition === "leave_alone" && proposal.changes.length > 0) {
    context.addIssue({ code: "custom", path: ["changes"], message: "A leave-alone proposal cannot contain changes." });
  }
  if (proposal.disposition === "changes" && proposal.changes.length === 0) {
    context.addIssue({ code: "custom", path: ["changes"], message: "A changes proposal needs at least one recommendation." });
  }
});
export type WorkRefinementProposal = z.infer<typeof workRefinementProposalSchema>;

export const workRefinementInputSchema = z.object({
  intent: workRefinementIntentSchema,
  instruction: z.string().trim().max(2_000).optional(),
}).strict();

/**
 * Compacts the provider-compatible refinement envelope without weakening the
 * application contract. HA structured output may include every union field as
 * null; only fields known to be irrelevant for a recognized kind are removed.
 * Non-null mismatches and unknown fields remain for strict Zod validation.
 */
export function normalizeWorkRefinementProposalInput(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const proposal = value as Record<string, unknown>;
  if (!Array.isArray(proposal.changes)) return value;

  return {
    ...proposal,
    changes: proposal.changes.map((rawChange) => {
      if (rawChange === null || typeof rawChange !== "object" || Array.isArray(rawChange)) {
        return rawChange;
      }
      const change = rawChange as Record<string, unknown>;
      const kind = change.kind;
      const allowed = typeof kind === "string" ? allowedRefinementChangeFields[kind] : undefined;
      const normalized = { ...change };
      const explicitlyCleared = new Set<string>();
      for (const [field, clearField] of Object.entries(explicitDateClearFields[kind as string] ?? {})) {
        if (normalized[clearField] === true) {
          if (normalized[field] !== undefined && normalized[field] !== null) continue;
          normalized[field] = null;
          explicitlyCleared.add(field);
          delete normalized[clearField];
        } else if (normalized[clearField] === false || normalized[clearField] === null) {
          delete normalized[clearField];
        }
      }
      if (allowed) {
        for (const field of refinementChangeFields) {
          if (normalized[field] !== null) continue;
          if (explicitlyCleared.has(field)) continue;
          if (!allowed.has(field) || optionalNonNullableRefinementChangeFields.has(field) || providerNullPlaceholderFields[kind as string]?.has(field)) {
            delete normalized[field];
          }
        }
      }
      if (Array.isArray(normalized.reminders)) {
        normalized.reminders = normalized.reminders.map((rawReminder) => {
          if (rawReminder === null || typeof rawReminder !== "object" || Array.isArray(rawReminder)) return rawReminder;
          const reminder = { ...(rawReminder as Record<string, unknown>) };
          const irrelevant = reminder.kind === "absolute"
            ? ["daysBefore", "time", "timezone"]
            : reminder.kind === "deadline_relative"
              ? ["at"]
              : [];
          for (const field of [...irrelevant, "id"]) if (reminder[field] === null) delete reminder[field];
          return reminder;
        });
      }
      normalized.accepted = false;
      return normalized;
    }),
  };
}

/** AI output is data; never let the model mark its own recommendations accepted. */
export function unacceptedWorkRefinementProposal(value: unknown): WorkRefinementProposal {
  const candidate = workRefinementProposalSchema.parse(value);
  return {
    ...candidate,
    changes: candidate.changes.map((change) => ({ ...change, accepted: false })),
  } as WorkRefinementProposal;
}
