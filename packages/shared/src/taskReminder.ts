import { z } from "zod";

export const isoCalendarDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must use YYYY-MM-DD format.");

export const isoDateTimeSchema = z
  .string()
  .datetime({ offset: true })
  .transform((value) => new Date(value).toISOString());

function isValidIanaTimezone(value: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

const deadlineRelativeReminderFields = {
  daysBefore: z.number().int().min(0),
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Time must use HH:mm format."),
  timezone: z.string().min(1).refine(isValidIanaTimezone, "Timezone must be a valid IANA zone name."),
};

export const taskReminderInputSchema = z.discriminatedUnion("kind", [
  z.object({
    id: z.number().int().positive().optional(),
    kind: z.literal("absolute"),
    at: isoDateTimeSchema,
  }),
  z.object({
    ...deadlineRelativeReminderFields,
    id: z.number().int().positive().optional(),
    kind: z.literal("deadline_relative"),
  }),
]);

export const taskReminderCreateInputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("absolute"), at: isoDateTimeSchema }),
  z.object({ kind: z.literal("deadline_relative"), ...deadlineRelativeReminderFields }),
]);

export const taskRemindersSchema = z.array(taskReminderInputSchema);
export const taskReminderCreateSchema = z.array(taskReminderCreateInputSchema);
export type TaskReminderInput = z.infer<typeof taskReminderInputSchema>;
export type TaskReminderCreateInput = z.infer<typeof taskReminderCreateInputSchema>;
