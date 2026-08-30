import type {
  DebugMetrics,
  ProjectStatus,
  TaskStatus,
} from "@machbar/shared";
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Db } from "../db/client.js";
import { getGraphLoadMetrics } from "../diagnostics/graphMetrics.js";

const processStartedAt = new Date().toISOString();

interface DatabaseCounts {
  members: number;
  projects: number;
  tasks: number;
  tags: number;
  dependencies: number;
  externalWaits: number;
  activityEvents: number;
  contributionEvents: number;
  tasksCreatedToday: number;
  tasksCreatedLast7Days: number;
  activityEventsCreatedLast7Days: number;
}

function completeCounts<T extends string>(
  values: readonly T[],
  rows: Array<{ status: T; count: number }>,
): Record<T, number> {
  const result = Object.fromEntries(values.map((value) => [value, 0])) as Record<
    T,
    number
  >;
  for (const row of rows) result[row.status] = row.count;
  return result;
}

export function registerDebugRoutes(app: FastifyInstance, db: Db) {
  app.get("/api/debug/metrics", async (): Promise<DebugMetrics> => {
    const counts = db.get<DatabaseCounts>(sql`
      SELECT
        (SELECT COUNT(*) FROM members) AS members,
        (SELECT COUNT(*) FROM projects) AS projects,
        (SELECT COUNT(*) FROM tasks) AS tasks,
        (SELECT COUNT(*) FROM tags) AS tags,
        (SELECT COUNT(*) FROM task_dependencies) AS dependencies,
        (SELECT COUNT(*) FROM task_external_waits) AS externalWaits,
        (SELECT COUNT(*) FROM activity_events) AS activityEvents,
        (SELECT COUNT(*) FROM contribution_events) AS contributionEvents,
        (SELECT COUNT(*) FROM tasks
          WHERE substr(created_at, 1, 10) = date('now')) AS tasksCreatedToday,
        (SELECT COUNT(*) FROM tasks
          WHERE created_at >= datetime('now', '-7 days')) AS tasksCreatedLast7Days,
        (SELECT COUNT(*) FROM activity_events
          WHERE created_at >= datetime('now', '-7 days')) AS activityEventsCreatedLast7Days
    `);
    const page = db.get<{
      pageSizeBytes: number;
      pageCount: number;
      freelistPages: number;
    }>(sql`
      SELECT
        (SELECT page_size FROM pragma_page_size) AS pageSizeBytes,
        (SELECT page_count FROM pragma_page_count) AS pageCount,
        (SELECT freelist_count FROM pragma_freelist_count) AS freelistPages
    `);
    const taskStatuses = db.all<{ status: TaskStatus; count: number }>(sql`
      SELECT status, COUNT(*) AS count
      FROM tasks
      WHERE status IN ('captured', 'actionable', 'someday', 'done', 'cancelled')
      GROUP BY status
    `);
    const projectStatuses = db.all<{
      status: ProjectStatus;
      count: number;
    }>(sql`
      SELECT status, COUNT(*) AS count FROM projects GROUP BY status
    `);
    const depth = db.get<{ maxDepth: number }>(sql`
      WITH RECURSIVE tree(id, depth) AS (
        SELECT id, 0 FROM tasks WHERE parent_task_id IS NULL
        UNION ALL
        SELECT task.id, tree.depth + 1
        FROM tasks task
        JOIN tree ON task.parent_task_id = tree.id
      )
      SELECT COALESCE(MAX(depth), 0) AS maxDepth FROM tree
    `);

    const pageSizeBytes = page?.pageSizeBytes ?? 0;
    const pageCount = page?.pageCount ?? 0;
    const freelistPages = page?.freelistPages ?? 0;
    return {
      generatedAt: new Date().toISOString(),
      processStartedAt,
      processUptimeSeconds: Math.floor(process.uptime()),
      database: {
        allocatedBytes: pageSizeBytes * pageCount,
        usedBytes: pageSizeBytes * Math.max(0, pageCount - freelistPages),
        pageSizeBytes,
        pageCount,
        freelistPages,
        counts: {
          members: counts?.members ?? 0,
          projects: counts?.projects ?? 0,
          tasks: counts?.tasks ?? 0,
          tags: counts?.tags ?? 0,
          dependencies: counts?.dependencies ?? 0,
          externalWaits: counts?.externalWaits ?? 0,
          activityEvents: counts?.activityEvents ?? 0,
          contributionEvents: counts?.contributionEvents ?? 0,
        },
        taskStatusCounts: completeCounts(
          ["captured", "actionable", "someday", "done", "cancelled"],
          taskStatuses,
        ),
        projectStatusCounts: completeCounts(
          ["backlog", "active", "completed", "archived"],
          projectStatuses,
        ),
        maxTaskDepth: depth?.maxDepth ?? 0,
        tasksCreatedToday: counts?.tasksCreatedToday ?? 0,
        tasksCreatedLast7Days: counts?.tasksCreatedLast7Days ?? 0,
        activityEventsCreatedLast7Days:
          counts?.activityEventsCreatedLast7Days ?? 0,
      },
      graphLoads: getGraphLoadMetrics(),
    };
  });
}
