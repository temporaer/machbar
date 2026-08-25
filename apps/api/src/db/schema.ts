import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  unique,
} from "drizzle-orm/sqlite-core";

/**
 * Members of the household / team. Tasks and projects can be
 * owned (explicitly or via inheritance) by a member.
 */
export const members = sqliteTable("members", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  color: text("color").notNull(),
});

export const tags = sqliteTable("tags", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull().unique(),
});

export const projects = sqliteTable("projects", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  status: text("status").notNull().default("active"), // active | completed | archived
  ownerMemberId: integer("owner_member_id").references(() => members.id, {
    onDelete: "set null",
  }),
  context: text("context"),
  dueDate: text("due_date"),
  scheduledDate: text("scheduled_date"),
  position: integer("position").notNull().default(0),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
});

export const projectTags = sqliteTable(
  "project_tags",
  {
    projectId: integer("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    tagId: integer("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.tagId] })],
);

export const tasks = sqliteTable(
  "tasks",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    projectId: integer("project_id").references(() => projects.id, {
      onDelete: "set null",
    }),
    parentTaskId: integer("parent_task_id").references((): any => tasks.id, {
      onDelete: "cascade",
    }),
    title: text("title").notNull(),
    notes: text("notes").notNull().default(""),
    status: text("status").notNull().default("inbox"),
    ownerMemberId: integer("owner_member_id").references(() => members.id, {
      onDelete: "set null",
    }),
    ownerInheritanceMode: text("owner_inheritance_mode")
      .notNull()
      .default("inherit"), // inherit | explicit | none
    createdByMemberId: integer("created_by_member_id").references(
      () => members.id,
      { onDelete: "set null" },
    ),
    dueDate: text("due_date"),
    scheduledDate: text("scheduled_date"),
    waitingFor: text("waiting_for"),
    context: text("context"),
    contextInheritanceMode: text("context_inheritance_mode")
      .notNull()
      .default("inherit"), // inherit | explicit | none
    priority: integer("priority"),
    position: integer("position").notNull().default(0),
    markedToday: integer("marked_today", { mode: "boolean" })
      .notNull()
      .default(false),
    completedAt: text("completed_at"),
    cancelledAt: text("cancelled_at"),
    recurrenceRule: text("recurrence_rule"),
    reminderAt: text("reminder_at"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (t) => [
    index("tasks_project_idx").on(t.projectId),
    index("tasks_parent_idx").on(t.parentTaskId),
    index("tasks_status_idx").on(t.status),
  ],
);

export const taskTags = sqliteTable(
  "task_tags",
  {
    taskId: integer("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    tagId: integer("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.taskId, t.tagId] })],
);

export const taskExcludedTags = sqliteTable(
  "task_excluded_tags",
  {
    taskId: integer("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    tagId: integer("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.taskId, t.tagId] })],
);

export const taskDependencies = sqliteTable(
  "task_dependencies",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    taskId: integer("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    dependsOnTaskId: integer("depends_on_task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
  },
  (t) => [
    unique("task_dependencies_unique").on(t.taskId, t.dependsOnTaskId),
    index("task_dependencies_task_idx").on(t.taskId),
    index("task_dependencies_depends_on_idx").on(t.dependsOnTaskId),
  ],
);
