import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import type Database from "better-sqlite3";
import { buildApp } from "../src/app.js";
import { openDb } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import type { Env } from "../src/env.js";
import { Graph } from "../src/domain/graph.js";

type Metrics = {
  sqlQueries: number;
  sqlMs: number;
  graphLoads: number;
  graphMs: number;
  graphSqlMs: number;
};

type Sample = Metrics & {
  operation: string;
  wallMs: number;
  responseBytes: number;
  taskCountBefore: number;
};

let activeMetrics: Metrics | undefined;

function installSqlTiming(sqlite: Database.Database): void {
  const originalPrepare = sqlite.prepare.bind(sqlite);
  sqlite.prepare = ((query: string) => {
    const statement = originalPrepare(query);
    return new Proxy(statement, {
      get(target, property) {
        const value = Reflect.get(target, property, target) as unknown;
        if (typeof value !== "function") return value;
        if (property === "run" || property === "get" || property === "all") {
          return (...args: unknown[]) => {
            const startedAt = performance.now();
            try {
              return value.apply(target, args);
            } finally {
              if (activeMetrics) {
                activeMetrics.sqlQueries += 1;
                activeMetrics.sqlMs += performance.now() - startedAt;
              }
            }
          };
        }
        return value.bind(target);
      },
    });
  }) as typeof sqlite.prepare;
}

const originalGraphLoad = Graph.load;
Graph.load = ((...args: Parameters<typeof Graph.load>) => {
  if (!activeMetrics) return originalGraphLoad(...args);
  const metrics = activeMetrics;
  const beforeSqlMs = metrics.sqlMs;
  const startedAt = performance.now();
  try {
    return originalGraphLoad(...args);
  } finally {
    metrics.graphLoads += 1;
    metrics.graphMs += performance.now() - startedAt;
    metrics.graphSqlMs += metrics.sqlMs - beforeSqlMs;
  }
}) as typeof Graph.load;

function quantile(values: number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * fraction) - 1] ?? 0;
}

function summarize(samples: Sample[]) {
  const numericKeys = [
    "wallMs",
    "sqlMs",
    "sqlQueries",
    "graphLoads",
    "graphMs",
    "graphSqlMs",
    "responseBytes",
    "taskCountBefore",
  ] as const;
  return {
    operation: samples[0]!.operation,
    runs: samples.length,
    ...Object.fromEntries(numericKeys.map((key) => [
      key,
      {
        median: Number(quantile(samples.map((sample) => sample[key]), 0.5).toFixed(2)),
        p95: Number(quantile(samples.map((sample) => sample[key]), 0.95).toFixed(2)),
      },
    ])),
  };
}

async function measuredRequest(
  app: ReturnType<typeof buildApp>,
  sqlite: Database.Database,
  operation: string,
  url: string,
  options: { method?: "GET" | "POST"; payload?: Record<string, unknown> } = {},
): Promise<Sample> {
  const metrics: Metrics = {
    sqlQueries: 0,
    sqlMs: 0,
    graphLoads: 0,
    graphMs: 0,
    graphSqlMs: 0,
  };
  const taskCountBefore = (
    sqlite.prepare("SELECT COUNT(*) AS count FROM work_items WHERE role = 'task'").get() as { count: number }
  ).count;
  activeMetrics = metrics;
  const startedAt = performance.now();
  let response;
  try {
    response = await app.inject({
      method: options.method ?? "GET",
      url,
      ...(options.payload ? { payload: options.payload } : {}),
    });
  } finally {
    activeMetrics = undefined;
  }
  const wallMs = performance.now() - startedAt;
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`${operation} returned ${response.statusCode}: ${response.body}`);
  }
  return {
    operation,
    wallMs,
    responseBytes: Buffer.byteLength(response.body),
    taskCountBefore,
    ...metrics,
  };
}

function makeEnv(dataDir: string): Env {
  return {
    port: 0,
    host: "127.0.0.1",
    dataDir,
    databaseFile: "audit.sqlite",
    databasePath: ":memory:",
    basePath: "/",
    seedDatabase: false,
    webDistDir: path.join(dataDir, "missing-web-dist"),
    oidc: null,
    mcpOAuth: null,
    push: null,
    paperless: null,
  };
}

function seedFixture(sqlite: Database.Database, taskCount: number) {
  const insertMember = sqlite.prepare("INSERT INTO members (name, color) VALUES (?, ?)");
  insertMember.run("Audit owner", "#334155");
  insertMember.run("Audit second owner", "#64748b");

  const insertTag = sqlite.prepare("INSERT INTO tags (name, color) VALUES (?, ?)");
  for (let index = 0; index < 5; index += 1) insertTag.run(`Audit tag ${index}`, "#64748b");

  const insertContext = sqlite.prepare(
    "INSERT INTO physical_contexts (source, external_id, name) VALUES ('home_assistant', ?, ?)",
  );
  insertContext.run("audit-home", "Audit home");
  insertContext.run("audit-car", "Audit car");

  const insertWorkItem = sqlite.prepare(`
    INSERT INTO work_items
      (parent_id, role, title, status, owner_member_id, owner_inheritance_mode,
       task_kind, position, size, due_date, scheduled_date, needs_clarification)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertTagRelation = sqlite.prepare(
    "INSERT OR IGNORE INTO work_item_tags (work_item_id, tag_id) VALUES (?, ?)",
  );
  const insertContextRelation = sqlite.prepare(
    "INSERT OR IGNORE INTO work_item_physical_contexts (work_item_id, context_id) VALUES (?, ?)",
  );
  const insertDependency = sqlite.prepare(
    "INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES (?, ?)",
  );
  const insertReminder = sqlite.prepare(`
    INSERT INTO task_reminders (task_id, kind, at)
    VALUES (?, 'absolute', '2030-01-15T09:00:00.000Z')
  `);
  const projectCount = Math.max(5, Math.min(20, Math.ceil(taskCount / 100)));
  const projects: number[] = [];
  const tasksByProject: number[][] = Array.from({ length: projectCount }, () => []);
  const transaction = sqlite.transaction(() => {
    for (let index = 0; index < projectCount; index += 1) {
      const result = insertWorkItem.run(
        null,
        "story",
        `Audit project ${index}`,
        "active",
        1,
        "explicit",
        null,
        index,
        null,
        null,
        null,
        0,
      );
      projects.push(Number(result.lastInsertRowid));
      insertTagRelation.run(projects[index], (index % 5) + 1);
      insertContextRelation.run(projects[index], (index % 2) + 1);
    }

    for (let index = 0; index < taskCount; index += 1) {
      const projectIndex = index % projectCount;
      const projectTasks = tasksByProject[projectIndex]!;
      const localIndex = projectTasks.length;
      const parentId = localIndex % 4 === 0
        ? projects[projectIndex]!
        : projectTasks.at(-1)!;
      const kind = index % 29 === 0 ? "reference" : "action";
      const status = kind === "reference"
        ? "captured"
        : index % 13 === 0
          ? "done"
          : index % 7 === 0
            ? "backlog"
            : "active";
      const result = insertWorkItem.run(
        parentId,
        "task",
        `Audit task ${index}`,
        status,
        index % 17 === 0 ? 2 : null,
        index % 17 === 0 ? "explicit" : "inherit",
        kind,
        localIndex,
        localIndex % 11 === 0 ? "XL" : "M",
        index % 37 === 0 ? "2030-01-15" : null,
        index % 43 === 0 ? "2030-01-10" : null,
        status === "captured" ? 1 : 0,
      );
      const taskId = Number(result.lastInsertRowid);
      projectTasks.push(taskId);
      if (index % 8 === 0) insertTagRelation.run(taskId, (index % 5) + 1);
      if (index % 19 === 0) insertContextRelation.run(taskId, (index % 2) + 1);
      if (index > 2 && index % 41 === 0) insertDependency.run(taskId, taskId - 1);
      if (index % 53 === 0) insertReminder.run(taskId);
    }
  });
  transaction();
  return { projects, tasksByProject };
}

function insertAuditTask(
  sqlite: Database.Database,
  parentId: number | null,
  status = "active",
  size = "M",
): number {
  const result = sqlite.prepare(`
    INSERT INTO work_items
      (parent_id, role, title, status, task_kind, position, size, needs_clarification)
    VALUES (?, 'task', ?, ?, 'action', 999999, ?, 0)
  `).run(parentId, "Measured audit operation", status, size);
  return Number(result.lastInsertRowid);
}

async function runSample(
  app: ReturnType<typeof buildApp>,
  sqlite: Database.Database,
  operation: string,
  setup: () => { url: string; method?: "GET" | "POST"; payload?: Record<string, unknown> },
): Promise<Sample> {
  sqlite.exec("SAVEPOINT audit_sample");
  try {
    const request = setup();
    return await measuredRequest(app, sqlite, operation, request.url, request);
  } finally {
    sqlite.exec("ROLLBACK TO audit_sample");
    sqlite.exec("RELEASE audit_sample");
  }
}

async function benchmarkSize(taskCount: number, repeats: number) {
  const handle = openDb(":memory:");
  runMigrations(handle.db);
  const fixture = seedFixture(handle.sqlite, taskCount);
  installSqlTiming(handle.sqlite);
  const dataDir = os.tmpdir();
  const app = buildApp({ db: handle.db, env: makeEnv(dataDir), logger: false });
  const results: ReturnType<typeof summarize>[] = [];

  const scenarios: Array<{
    operation: string;
    setup: () => { url: string; method?: "GET" | "POST"; payload?: Record<string, unknown> };
  }> = [
    {
      operation: "create-root",
      setup: () => ({
        url: "/api/tasks",
        method: "POST",
        payload: { title: "Measured root task" },
      }),
    },
    {
      operation: "create-under-project",
      setup: () => ({
        url: "/api/tasks",
        method: "POST",
        payload: { title: "Measured project task", projectId: fixture.projects[0], status: "actionable" },
      }),
    },
    {
      operation: "status-change",
      setup: () => {
        const id = insertAuditTask(handle.sqlite, null);
        return { url: `/api/tasks/${id}/status`, method: "POST", payload: { status: "done", expectedRevision: 1 } };
      },
    },
    {
      operation: "cancel",
      setup: () => {
        const id = insertAuditTask(handle.sqlite, null);
        return { url: `/api/tasks/${id}/cancel`, method: "POST", payload: { expectedRevision: 1 } };
      },
    },
    {
      operation: "complete",
      setup: () => {
        const id = insertAuditTask(handle.sqlite, null);
        return { url: `/api/tasks/${id}/complete`, method: "POST", payload: { expectedRevision: 1 } };
      },
    },
    {
      operation: "reopen",
      setup: () => {
        const id = insertAuditTask(handle.sqlite, null, "done");
        handle.sqlite.prepare("UPDATE work_items SET completed_at = '2026-01-01T00:00:00.000Z' WHERE id = ?").run(id);
        return { url: `/api/tasks/${id}/reopen`, method: "POST", payload: { expectedRevision: 1 } };
      },
    },
    {
      operation: "move-task",
      setup: () => {
        const id = insertAuditTask(handle.sqlite, null, "captured");
        return {
          url: `/api/tasks/${id}/move`,
          method: "POST",
          payload: { projectId: fixture.projects[1], expectedRevision: 1 },
        };
      },
    },
    {
      operation: "today-view",
      setup: () => ({ url: "/api/agenda/today?scope=all&date=2026-10-12" }),
    },
  ];

  try {
    for (const scenario of scenarios) {
      await runSample(app, handle.sqlite, scenario.operation, scenario.setup);
      const samples: Sample[] = [];
      for (let index = 0; index < repeats; index += 1) {
        samples.push(await runSample(app, handle.sqlite, scenario.operation, scenario.setup));
      }
      results.push(summarize(samples));
    }

    for (const batchSize of [1, 5, 20, 30]) {
      const operation = `create-${batchSize}-children`;
      await runSample(app, handle.sqlite, operation, () => {
        const parentId = insertAuditTask(handle.sqlite, fixture.projects[0]!);
        return {
          url: `/api/tasks/${parentId}/children/batch`,
          method: "POST",
          payload: {
            expectedRevision: 1,
            expectedProjectRevisions: [{ projectId: fixture.projects[0], revision: 1 }],
            steps: Array.from({ length: batchSize }, (_, index) => ({ title: `Measured child ${index}` })),
          },
        };
      });
      const samples: Sample[] = [];
      for (let index = 0; index < repeats; index += 1) {
        samples.push(await runSample(app, handle.sqlite, operation, () => {
          const parentId = insertAuditTask(handle.sqlite, fixture.projects[0]!);
          return {
            url: `/api/tasks/${parentId}/children/batch`,
            method: "POST",
            payload: {
              expectedRevision: 1,
              expectedProjectRevisions: [{ projectId: fixture.projects[0], revision: 1 }],
              steps: Array.from({ length: batchSize }, (_, step) => ({ title: `Measured child ${step}` })),
            },
          };
        }));
      }
      results.push(summarize(samples));
    }

    const plans = {
      childLookup: handle.sqlite.prepare(
        "EXPLAIN QUERY PLAN SELECT id FROM work_items WHERE parent_id = ? AND role = 'task' AND task_kind = 'action'",
      ).all(fixture.projects[0]),
      dependencyLookup: handle.sqlite.prepare(
        "EXPLAIN QUERY PLAN SELECT depends_on_task_id FROM task_dependencies WHERE task_id = ?",
      ).all(fixture.tasksByProject[0]![0]),
    };
    return {
      taskCount,
      projectCount: fixture.projects.length,
      repeats,
      results,
      indexes: handle.sqlite.prepare("PRAGMA index_list('work_items')").all(),
      queryPlans: plans,
    };
  } finally {
    await app.close();
    handle.close();
  }
}

async function main() {
  const sizes = (process.env.AUDIT_SIZES ?? "100,1000,5000")
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isInteger(value) && value > 0);
  const repeats = Number(process.env.AUDIT_REPEATS ?? 3);
  if (sizes.length === 0 || !Number.isInteger(repeats) || repeats < 1) {
    throw new Error("AUDIT_SIZES must contain positive integers and AUDIT_REPEATS must be a positive integer.");
  }

  const probe = openDb(":memory:");
  const sqliteVersion = probe.sqlite.prepare("SELECT sqlite_version() AS version").get();
  probe.close();
  console.log(JSON.stringify({
    environment: {
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      cpus: os.cpus().length,
      cpuModel: os.cpus()[0]?.model,
      memoryGiB: Number((os.totalmem() / 1024 ** 3).toFixed(1)),
      sqlite: sqliteVersion,
    },
    methodology: {
      warmupsPerScenario: 1,
      measuredRepeats: repeats,
      stages: "HTTP injection wall time; prepared-statement count/time; Graph.load count/inclusive time and its SQL subset; serialized response bytes",
      note: "No frontend, network, or browser invalidation/refetch is included.",
    },
  }));
  for (const size of sizes) {
    console.log(JSON.stringify(await benchmarkSize(size, repeats)));
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
