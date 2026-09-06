import { z } from "zod";
import {
  inheritanceModes,
  pushNotificationPreferenceKinds,
  pushLocales,
  projectStatuses,
  tagGroupingModes,
  tagKinds,
  taskSizes,
  taskStatuses,
} from "@machbar/shared";

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must use YYYY-MM-DD format.");
const isoDateTime = z
  .string()
  .datetime({ offset: true })
  .transform((value) => new Date(value).toISOString());
const queryBoolean = z
  .union([z.boolean(), z.enum(["true", "false"])])
  .transform((value) => value === true || value === "true");

export const createProjectSchema = z.object({
  title: z.string().min(1, "Project title must not be empty."),
  notes: z.string().optional(),
  status: z.enum(projectStatuses).optional(),
  ownerMemberId: z.number().int().nullable().optional(),
  dueDate: isoDate.nullable().optional(),
  scheduledDate: isoDate.nullable().optional(),
  tagIds: z.array(z.number().int()).optional(),
  contextIds: z.array(z.number().int().positive()).optional(),
});

export const updateProjectSchema = z.object({
  title: z.string().min(1).optional(),
  notes: z.string().optional(),
  ownerMemberId: z.number().int().nullable().optional(),
  dueDate: isoDate.nullable().optional(),
  scheduledDate: isoDate.nullable().optional(),
  position: z.number().int().optional(),
  tagIds: z.array(z.number().int()).optional(),
  contextIds: z.array(z.number().int().positive()).optional(),
  expectedRevision: z.number().int().positive().optional(),
});

export const appendNotesSchema = z.object({
  content: z.string(),
});

export const activateProjectSchema = z.object({
  ownerMemberId: z.number().int().nullable().optional(),
  expectedRevision: z.number().int().positive().optional(),
});

export const projectLifecycleSchema = z.object({
  expectedRevision: z.number().int().positive().optional(),
});

export const acknowledgeReviewSchema = projectLifecycleSchema;

export const addCriterionSchema = z.object({
  text: z.string().min(1, "Acceptance criterion text must not be empty."),
});

export const updateCriterionSchema = z.object({
  text: z.string().min(1, "Acceptance criterion text must not be empty."),
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
  title: z.string().min(1, "Task title must not be empty."),
  notes: z.string().optional(),
  status: z.enum(taskStatuses).optional(),
  needsClarification: z.boolean().optional(),
  ownerMemberId: z.number().int().nullable().optional(),
  ownerInheritanceMode: z.enum(inheritanceModes).optional(),
  contextInheritanceMode: z.enum(inheritanceModes).optional(),
  createdByMemberId: z.number().int().nullable().optional(),
  dueDate: isoDate.nullable().optional(),
  scheduledDate: isoDate.nullable().optional(),
  priority: z.number().int().nullable().optional(),
  size: z.enum(taskSizes).nullable().optional(),
  repeatAfterDays: z.number().int().min(1).nullable().optional(),
  allowedDeviationDays: z.number().int().min(0).nullable().optional(),
  reminderAt: isoDateTime.nullable().optional(),
  tagIds: z.array(z.number().int()).optional(),
  contextIds: z.array(z.number().int().positive()).optional(),
});

export const createChildTaskSchema = createTaskSchema.omit({
  projectId: true,
  parentTaskId: true,
});

export const createTaskSequenceSchema = z.object({
  titles: z
    .array(z.string().trim().min(1, "Every step requires a title."))
    .min(2, "A sequence requires at least two steps."),
  createdByMemberId: z.number().int().nullable().optional(),
});

export const updateTaskSchema = z.object({
  title: z.string().min(1).optional(),
  notes: z.string().optional(),
  status: z.enum(taskStatuses).optional(),
  needsClarification: z.boolean().optional(),
  ownerMemberId: z.number().int().nullable().optional(),
  ownerInheritanceMode: z.enum(inheritanceModes).optional(),
  contextInheritanceMode: z.enum(inheritanceModes).optional(),
  dueDate: isoDate.nullable().optional(),
  scheduledDate: isoDate.nullable().optional(),
  priority: z.number().int().nullable().optional(),
  size: z.enum(taskSizes).nullable().optional(),
  repeatAfterDays: z.number().int().min(1).nullable().optional(),
  allowedDeviationDays: z.number().int().min(0).nullable().optional(),
  reminderAt: isoDateTime.nullable().optional(),
  tagIds: z.array(z.number().int()).optional(),
  excludedTagIds: z.array(z.number().int()).optional(),
  contextIds: z.array(z.number().int().positive()).optional(),
  expectedRevision: z.number().int().positive().optional(),
  completedOn: isoDate.optional(),
});

export const transitionTaskStatusSchema = z.object({
  status: z.enum(taskStatuses),
  completedOn: isoDate.optional(),
  expectedRevision: z.number().int().positive().optional(),
});

export const promoteTaskToProjectSchema = z.object({
  status: z.enum(["active", "backlog"]),
  title: z.string().min(1).optional(),
  notes: z.string().optional(),
  expectedRevision: z.number().int().positive().optional(),
});

export const completeTaskSchema = z.object({
  descendantsPolicy: z
    .enum(["leave_open", "complete_children", "cancel_children"])
    .optional(),
  completedOn: isoDate.optional(),
  expectedRevision: z.number().int().positive().optional(),
});

export const cancelTaskSchema = z.object({
  descendantsPolicy: z
    .enum(["leave_open", "complete_children", "cancel_children"])
    .optional(),
  expectedRevision: z.number().int().positive().optional(),
});

export const taskLifecycleSchema = z.object({
  expectedRevision: z.number().int().positive().optional(),
});

export const moveTaskSchema = z.object({
  parentTaskId: z.number().int().nullable().optional(),
  projectId: z.number().int().nullable().optional(),
  position: z.number().int().min(0).optional(),
  expectedRevision: z.number().int().positive(),
});

export const dependencySchema = z.object({
  dependsOnTaskId: z.number().int(),
});

export const upsertExternalWaitSchema = z.object({
  waitingFor: z.string().nullable().optional(),
  revisitDate: isoDate.nullable().optional(),
  expectedRevision: z.number().int().positive().optional(),
});

export const resolveExternalWaitSchema = z.object({
  expectedRevision: z.number().int().positive().optional(),
});

const externalWaitFollowUpBaseSchema = z.object({
  content: z.string().trim().min(1, "Follow-up text must not be empty."),
  expectedRevision: z.number().int().positive().optional(),
});

export const externalWaitFollowUpSchema = z.discriminatedUnion("action", [
  externalWaitFollowUpBaseSchema.extend({
    action: z.literal("resolve"),
  }),
  externalWaitFollowUpBaseSchema.extend({
    action: z.literal("continue"),
    waitingFor: z.string().nullable().optional(),
    revisitDate: isoDate.nullable().optional(),
  }),
]);

export const pushSubscriptionSchema = z.object({
  endpoint: z.string().url(),
  p256dh: z.string().min(1),
  auth: z.string().min(1),
  locale: z.enum(pushLocales),
  timezone: z.string().min(1).max(255).nullable().optional(),
});

export const pushSubscriptionRemovalSchema = z.object({
  endpoint: z.string().url(),
});

export const pushNotificationPreferencesSchema = z.object(
  Object.fromEntries(
    pushNotificationPreferenceKinds.map((kind) => [kind, z.boolean()]),
  ) as Record<(typeof pushNotificationPreferenceKinds)[number], z.ZodBoolean>,
);

export const tagRefSchema = z.object({
  tagId: z.number().int(),
});

export const createTagSchema = z.object({
  name: z.string().min(1, "Tag name must not be empty."),
  kind: z.enum(tagKinds).optional(),
});

export const updateTagSchema = z.object({
  name: z.string().min(1, "Tag name must not be empty.").optional(),
  kind: z.enum(tagKinds).optional(),
  groupingMode: z.enum(tagGroupingModes).optional(),
  sortPosition: z.number().int().nullable().optional(),
});

export const homeAssistantPairSchema = z.object({
  pairingCode: z.string().min(1),
  protocolVersion: z.number().int(),
});

export const homeAssistantSnapshotSchema = z.object({
  protocolVersion: z.literal(1),
  observedAt: isoDateTime,
  contexts: z.array(
    z.object({
      externalId: z.string().trim().min(1).max(255),
      name: z.string().trim().min(1).max(255),
    }),
  ),
  people: z.array(
    z.object({
      externalId: z.string().trim().min(1).max(255),
      name: z.string().trim().min(1).max(255),
      state: z.enum(["known", "unknown"]),
      contexts: z.array(z.string().trim().min(1).max(255)),
    }),
  ),
});

export const homeAssistantMappingSchema = z.object({
  memberId: z.number().int().positive().nullable(),
});

export const createMemberSchema = z.object({
  name: z.string().min(1, "Member name must not be empty."),
});

export const renameMemberSchema = z.object({
  name: z.string().min(1, "Member name must not be empty."),
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
  blocked: queryBoolean.optional(),
  externalWait: queryBoolean.optional(),
});

export const activityQuerySchema = z.object({
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  actorId: z.coerce.number().int().positive().optional(),
  taskId: z.coerce.number().int().positive().optional(),
  projectId: z.coerce.number().int().positive().optional(),
});
