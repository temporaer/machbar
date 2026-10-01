import { z } from "zod";
import {
  intakeDraftIssues,
  intakePlanIssues,
  inheritanceModes,
  pushNotificationPreferenceKinds,
  pushLocales,
  projectStatuses,
  tagGroupingModes,
  tagKinds,
  taskKinds,
  taskSizes,
  taskStatuses,
  workItemScopes,
} from "@machbar/shared";
import type { IntakeDraft, IntakePlan } from "@machbar/shared";

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

function isValidIanaTimezone(value: string): boolean {
  try {
    // Throws a RangeError for an unrecognized IANA zone name.
    Intl.DateTimeFormat(undefined, { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

const deadlineRelativeReminderSchema = z.object({
  daysBefore: z.number().int().min(0),
  time: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Time must use HH:mm format."),
  timezone: z
    .string()
    .min(1)
    .refine(isValidIanaTimezone, "Timezone must be a valid IANA zone name."),
});

const managedDeadlineReminderSchema = deadlineRelativeReminderSchema.extend({
  key: z.string().min(1),
});

const managedDeadlineRemindersSchema = z
  .array(managedDeadlineReminderSchema)
  .superRefine((reminders, context) => {
    const keys = new Set<string>();
    for (const reminder of reminders) {
      if (keys.has(reminder.key)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Managed reminder keys must be unique.",
        });
      }
      keys.add(reminder.key);
    }
  });

export const taskReminderInputSchema = z.discriminatedUnion("kind", [
  z.object({
    id: z.number().int().positive().optional(),
    kind: z.literal("absolute"),
    at: isoDateTime,
  }),
  deadlineRelativeReminderSchema.extend({
    id: z.number().int().positive().optional(),
    kind: z.literal("deadline_relative"),
  }),
]);
export const taskRemindersSchema = z.array(taskReminderInputSchema);

export const homeAssistantSyncTaskSchema = z
  .object({
    sourceKey: z.string().min(1),
    relevant: z.boolean(),
    title: z.string().min(1).optional(),
    person: z.string().min(1).nullable().optional(),
    scheduledDate: isoDate.nullable().optional(),
    dueDate: isoDate.nullable().optional(),
    notBeforeAt: isoDateTime.nullable().optional(),
    notBeforeDate: isoDate.nullable().optional(),
    notes: z.string().nullable().optional(),
    reactivateCompleted: z.boolean().optional(),
    overwriteNotes: z.boolean().optional(),
    deadlineReminder: deadlineRelativeReminderSchema.nullable().optional(),
    deadlineReminders: managedDeadlineRemindersSchema.nullable().optional(),
    priority: z.number().int().min(1).max(5).nullable().optional(),
    size: z.enum(taskSizes).nullable().optional(),
  })
  .superRefine((input, context) => {
    const hasAt = input.notBeforeAt !== undefined;
    const hasDate = input.notBeforeDate !== undefined;
    if (hasAt !== hasDate) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["notBeforeAt"],
        message: "notBeforeAt and notBeforeDate must be supplied together.",
      });
    } else if (
      hasAt &&
      hasDate &&
      (input.notBeforeAt === null) !== (input.notBeforeDate === null)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["notBeforeDate"],
        message: "notBeforeAt and notBeforeDate must both be set or both be null.",
      });
    }
    if (input.deadlineReminder !== undefined && input.deadlineReminders !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["deadlineReminders"],
        message: "Use either deadlineReminder or deadlineReminders, not both.",
      });
    }
  });

export const createProjectSchema = z.object({
  title: z.string().min(1, "Project title must not be empty."),
  notes: z.string().optional(),
  parentId: z.number().int().nullable().optional(),
  status: z.enum(projectStatuses).optional(),
  ownerMemberId: z.number().int().nullable().optional(),
  scope: z.enum(workItemScopes).optional(),
  dueDate: isoDate.nullable().optional(),
  scheduledDate: isoDate.nullable().optional(),
  tagIds: z.array(z.number().int()).optional(),
  contextIds: z.array(z.number().int().positive()).optional(),
});

export const updateProjectSchema = z.object({
  title: z.string().min(1).optional(),
  notes: z.string().optional(),
  ownerMemberId: z.number().int().nullable().optional(),
  scope: z.enum(workItemScopes).optional(),
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

export const returnProjectToBacklogSchema = z.object({
  expectedRevision: z.number().int().positive().optional(),
  scheduledDate: isoDate.nullable().optional(),
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
  kind: z.enum(taskKinds).optional(),
  status: z.enum(taskStatuses).optional(),
  needsClarification: z.boolean().optional(),
  ownerMemberId: z.number().int().nullable().optional(),
  ownerInheritanceMode: z.enum(inheritanceModes).optional(),
  contextInheritanceMode: z.enum(inheritanceModes).optional(),
  createdByMemberId: z.number().int().nullable().optional(),
  /** Only meaningful for a root task (no parent/project); a child/
   * successor always inherits its parent's scope regardless. */
  scope: z.enum(workItemScopes).optional(),
  dueDate: isoDate.nullable().optional(),
  scheduledDate: isoDate.nullable().optional(),
  notBeforeAt: isoDateTime.nullable().optional(),
  notBeforeDate: isoDate.nullable().optional(),
  priority: z.number().int().nullable().optional(),
  size: z.enum(taskSizes).nullable().optional(),
  repeatAfterDays: z.number().int().min(1).nullable().optional(),
  allowedDeviationDays: z.number().int().min(0).nullable().optional(),
  reminders: taskRemindersSchema.optional(),
  tagIds: z.array(z.number().int()).optional(),
  contextIds: z.array(z.number().int().positive()).optional(),
});

export const createChildTaskSchema = createTaskSchema.omit({
  projectId: true,
  parentTaskId: true,
});

export const updateTaskSchema = z.object({
  title: z.string().min(1).optional(),
  notes: z.string().optional(),
  status: z.enum(taskStatuses).optional(),
  needsClarification: z.boolean().optional(),
  ownerMemberId: z.number().int().nullable().optional(),
  ownerInheritanceMode: z.enum(inheritanceModes).optional(),
  contextInheritanceMode: z.enum(inheritanceModes).optional(),
  scope: z.enum(workItemScopes).optional(),
  dueDate: isoDate.nullable().optional(),
  scheduledDate: isoDate.nullable().optional(),
  notBeforeAt: isoDateTime.nullable().optional(),
  notBeforeDate: isoDate.nullable().optional(),
  priority: z.number().int().nullable().optional(),
  size: z.enum(taskSizes).nullable().optional(),
  repeatAfterDays: z.number().int().min(1).nullable().optional(),
  allowedDeviationDays: z.number().int().min(0).nullable().optional(),
  reminders: taskRemindersSchema.optional(),
  additionalNextAction: z.boolean().optional(),
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

export const convertTaskToStorySchema = z.object({
  status: z.enum(["active", "backlog"]),
  title: z.string().min(1).optional(),
  notes: z.string().optional(),
  expectedRevision: z.number().int().positive().optional(),
});

export const convertStoryToTaskSchema = z.object({
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
  protocolVersion: z.number().int(),
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
  intake: z
    .object({
      aiTask: z.object({
        entityId: z.string().trim().min(1).nullable(),
        state: z.enum(["ok", "not_configured", "missing", "no_generate_data"]),
        supportsAttachments: z.boolean(),
      }).strict(),
      calendar: z.object({
        entityId: z.string().trim().min(1).nullable(),
        state: z.enum(["ok", "not_configured", "missing", "not_writable"]),
      }).strict(),
    })
    .strict(),
});

export const homeAssistantCalendarEventRefSchema = z.object({
  calendarEntityId: z.string().min(1),
  uid: z.string().min(1),
  recurrenceId: z.string().nullable(),
  summary: z.string(),
  start: z.string(),
  end: z.string(),
  correlationId: z.string().uuid(),
}).strict();

export const homeAssistantRequestCompletionSchema = z.discriminatedUnion("outcome", [
  z.object({
    leaseToken: z.string().min(1),
    outcome: z.literal("succeeded"),
    result: z.unknown(),
  }),
  z.object({
    leaseToken: z.string().min(1),
    outcome: z.literal("failed"),
    error: z.object({
      code: z.string().min(1),
      message: z.string().min(1),
      details: z.object({
        path: z.array(z.union([z.string(), z.number().int().nonnegative()])).optional(),
        expectedType: z.string().min(1).optional(),
        actualType: z.string().min(1).optional(),
        valuePreview: z.string().max(120).optional(),
        issues: z.array(z.object({
          path: z.array(z.union([z.string(), z.number().int().nonnegative()])),
          code: z.string().min(1),
          message: z.string().min(1),
        }).strict()).max(50).optional(),
      }).strict().optional(),
    }).strict(),
  }),
]);

const intakeShapeDateSchema = z.string().nullable();
const intakeShapeDateTimeSchema = z.string().nullable();
const intakeShapeReminderSchema = z.discriminatedUnion("kind", [
  z.object({
    id: z.number().int().positive().optional(),
    kind: z.literal("absolute"),
    at: z.string(),
  }),
  z.object({
    id: z.number().int().positive().optional(),
    kind: z.literal("deadline_relative"),
    daysBefore: z.number().int().nonnegative(),
    time: z.string(),
    timezone: z.string().min(1),
  }),
]);
const intakeCalendarEventSchema = z
  .object({
    key: z.string(),
    title: z.string().trim().min(1).max(200),
    description: z.string().max(4000).nullable(),
    location: z.string().max(300).nullable(),
    allDay: z.boolean(),
    startDate: intakeShapeDateSchema,
    endDate: intakeShapeDateSchema,
    startDateTime: intakeShapeDateTimeSchema,
    endDateTime: intakeShapeDateTimeSchema,
    relatedWorkKeys: z.array(z.string()),
  })
  .strict();
const intakeWorkItemSchema = z
  .object({
    key: z.string(),
    kind: z.enum(["action", "project", "reference"]),
    title: z.string().trim().min(1).max(200),
    notes: z.string().max(8000).nullable(),
    parentKey: z.string().nullable(),
    ownerName: z.string().nullable(),
    dueDate: intakeShapeDateSchema,
    scheduledDate: intakeShapeDateSchema,
    notBeforeDate: intakeShapeDateSchema,
    notBeforeAt: intakeShapeDateTimeSchema,
    reminders: z.array(intakeShapeReminderSchema),
    needsClarification: z.boolean(),
    relatedCalendarKeys: z.array(z.string()),
  })
  .strict();
export const intakePlanStructureSchema = z
  .object({
    summary: z.string().max(1000),
    calendarEvents: z.array(intakeCalendarEventSchema).max(20),
    workItems: z.array(intakeWorkItemSchema).max(50),
    warnings: z.array(z.object({ message: z.string().trim().min(1).max(500) }).strict()).max(20),
  })
  .strict();

export const intakePlanSchema = intakePlanStructureSchema
  .superRefine((value, ctx) => {
    for (const item of intakePlanIssues(value as IntakePlan)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: item.path,
        message: item.message,
        params: { code: item.code },
      });
    }
  });

const intakeDraftCalendarEventSchema = intakeCalendarEventSchema.extend({
  enabled: z.boolean(),
  durationAssumed: z.boolean(),
}).strict();
const intakeDraftWorkItemSchema = intakeWorkItemSchema.omit({ ownerName: true }).extend({
  enabled: z.boolean(),
  ownerMemberId: z.number().int().positive().nullable(),
}).strict();
export const intakeDraftStructureSchema = z
  .object({
    summary: z.string().max(1000),
    calendarEvents: z.array(intakeDraftCalendarEventSchema).max(20),
    workItems: z.array(intakeDraftWorkItemSchema).max(50),
    warnings: z.array(z.object({ message: z.string().trim().min(1).max(500) }).strict()).max(20),
    retainSourceInPaperless: z.boolean(),
  })
  .strict();

export const intakeDraftSchema = intakeDraftStructureSchema
  .superRefine((value, ctx) => {
    const memberIds = value.workItems
      .map((item) => item.ownerMemberId)
      .filter((id): id is number => id !== null);
    for (const item of intakeDraftIssues(value as IntakeDraft, {
      memberIds,
      paperlessAvailable: true,
      hasFiles: true,
    })) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: item.path,
        message: item.message,
        params: { code: item.code },
      });
    }
  });

export const homeAssistantMappingSchema = z.object({
  memberId: z.number().int().positive().nullable(),
});

export const createMcpAgentSchema = z.object({
  name: z.string().trim().min(1).max(100),
  scope: z.enum(workItemScopes),
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
  includeTerminal: queryBoolean.optional(),
  kinds: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(",").map((s) => s.trim()) : undefined))
    .pipe(z.array(z.enum(taskKinds)).optional()),
});

export const activityQuerySchema = z.object({
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  actorId: z.coerce.number().int().positive().optional(),
  taskId: z.coerce.number().int().positive().optional(),
  projectId: z.coerce.number().int().positive().optional(),
});
