import { z } from "zod";
import {
  inheritanceModes,
  projectStatuses,
  tagGroupingModes,
  tagKinds,
  taskSizes,
  taskStatuses,
} from "@machbar/shared";

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Datum muss im Format JJJJ-MM-TT sein.");
const isoDateTime = z.string().min(1);

export const createProjectSchema = z.object({
  title: z.string().min(1, "Der Projekttitel darf nicht leer sein."),
  notes: z.string().optional(),
  status: z.enum(projectStatuses).optional(),
  ownerMemberId: z.number().int().nullable().optional(),
  dueDate: isoDate.nullable().optional(),
  scheduledDate: isoDate.nullable().optional(),
  tagIds: z.array(z.number().int()).optional(),
});

export const updateProjectSchema = z.object({
  title: z.string().min(1).optional(),
  notes: z.string().optional(),
  ownerMemberId: z.number().int().nullable().optional(),
  dueDate: isoDate.nullable().optional(),
  scheduledDate: isoDate.nullable().optional(),
  position: z.number().int().optional(),
  tagIds: z.array(z.number().int()).optional(),
});

export const activateProjectSchema = z.object({
  ownerMemberId: z.number().int().nullable().optional(),
});

export const addCriterionSchema = z.object({
  text: z.string().min(1, "Der Text für „Erledigt, wenn …“ darf nicht leer sein."),
});

export const updateCriterionSchema = z.object({
  text: z.string().min(1, "Der Text für „Erledigt, wenn …“ darf nicht leer sein."),
});

export const checkCriterionSchema = z.object({
  checked: z.boolean(),
});

export const reorderCriteriaSchema = z.object({
  orderedCriterionIds: z.array(z.number().int()).min(1),
});

export const createTaskSchema = z.object({
  projectId: z.number().int().nullable().optional(),
  parentTaskId: z.number().int().nullable().optional(),
  title: z.string().min(1, "Der Aufgabentitel darf nicht leer sein."),
  notes: z.string().optional(),
  status: z.enum(taskStatuses).optional(),
  needsClarification: z.boolean().optional(),
  ownerMemberId: z.number().int().nullable().optional(),
  ownerInheritanceMode: z.enum(inheritanceModes).optional(),
  createdByMemberId: z.number().int().nullable().optional(),
  dueDate: isoDate.nullable().optional(),
  scheduledDate: isoDate.nullable().optional(),
  waitingFor: z.string().nullable().optional(),
  priority: z.number().int().nullable().optional(),
  size: z.enum(taskSizes).nullable().optional(),
  recurrenceRule: z.string().nullable().optional(),
  reminderAt: isoDateTime.nullable().optional(),
  tagIds: z.array(z.number().int()).optional(),
});

export const createChildTaskSchema = createTaskSchema.omit({
  projectId: true,
  parentTaskId: true,
});

export const createTaskSequenceSchema = z.object({
  titles: z
    .array(z.string().trim().min(1, "Jeder Schritt braucht einen Titel."))
    .min(2, "Ein Ablauf braucht mindestens zwei Schritte."),
  createdByMemberId: z.number().int().nullable().optional(),
});

export const updateTaskSchema = z.object({
  title: z.string().min(1).optional(),
  notes: z.string().optional(),
  status: z.enum(taskStatuses).optional(),
  needsClarification: z.boolean().optional(),
  ownerMemberId: z.number().int().nullable().optional(),
  ownerInheritanceMode: z.enum(inheritanceModes).optional(),
  dueDate: isoDate.nullable().optional(),
  scheduledDate: isoDate.nullable().optional(),
  waitingFor: z.string().nullable().optional(),
  priority: z.number().int().nullable().optional(),
  size: z.enum(taskSizes).nullable().optional(),
  recurrenceRule: z.string().nullable().optional(),
  reminderAt: isoDateTime.nullable().optional(),
  tagIds: z.array(z.number().int()).optional(),
  excludedTagIds: z.array(z.number().int()).optional(),
});

export const completeTaskSchema = z.object({
  descendantsPolicy: z.enum(["leave_open", "complete_children"]).optional(),
});

export const cancelTaskSchema = z.object({
  descendantsPolicy: z.enum(["leave_open", "cancel_children"]).optional(),
});

export const moveTaskSchema = z.object({
  parentTaskId: z.number().int().nullable().optional(),
  projectId: z.number().int().nullable().optional(),
  position: z.number().int().min(0).optional(),
});

export const reorderTaskSchema = z.object({
  position: z.number().int().min(0),
});

export const changeParentSchema = z.object({
  parentTaskId: z.number().int().nullable(),
  projectId: z.number().int().nullable().optional(),
});

export const moveSubtreeSchema = z.object({
  projectId: z.number().int().nullable(),
});

export const dependencySchema = z.object({
  dependsOnTaskId: z.number().int(),
});

export const tagRefSchema = z.object({
  tagId: z.number().int(),
});

export const createTagSchema = z.object({
  name: z.string().min(1, "Der Tag-Name darf nicht leer sein."),
  kind: z.enum(tagKinds).optional(),
});

export const updateTagSchema = z.object({
  kind: z.enum(tagKinds).optional(),
  groupingMode: z.enum(tagGroupingModes).optional(),
  sortPosition: z.number().int().nullable().optional(),
});

export const createMemberSchema = z.object({
  name: z.string().min(1, "Der Name darf nicht leer sein."),
});

export const renameMemberSchema = z.object({
  name: z.string().min(1, "Der Name darf nicht leer sein."),
});

export const searchQuerySchema = z.object({
  text: z.string().optional(),
  ownerId: z.coerce.number().int().optional(),
  projectId: z.coerce.number().int().optional(),
  tagIds: z
    .string()
    .optional()
    .transform((v) =>
      v
        ? v
            .split(",")
            .map((s) => Number.parseInt(s.trim(), 10))
            .filter((n) => !Number.isNaN(n))
        : undefined,
    ),
  status: z.enum(taskStatuses).optional(),
  dueFrom: isoDate.optional(),
  dueTo: isoDate.optional(),
  scheduledFrom: isoDate.optional(),
  scheduledTo: isoDate.optional(),
  waitingFor: z.string().optional(),
});
