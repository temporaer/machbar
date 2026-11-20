import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import type Database from "better-sqlite3";
import { openDb } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import type { Db } from "../src/db/client.js";
import { Graph } from "../src/domain/graph.js";

type QuerySample = { ms: number; executions: number; rows: number; args: unknown[] };
type LoadSample = {
  wallMs: number;
  sqlMs: number;
  querySamples: Map<string, QuerySample>;
  taskRows: number;
  projectRows: number;
  error?: string;
};
type QueryAggregate = { sql: string; samples: QuerySample[] };

let activeQueries: Map<string, QuerySample> | undefined;

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

function resultRows(method: string, result: unknown): number {
  if (method === "all") return Array.isArray(result) ? result.length : 0;
  if (method === "get") return result === undefined ? 0 : 1;
  if (method === "run" && typeof result === "object" && result !== null && "changes" in result) {
    return Number((result as { changes: number }).changes);
  }
  return 0;
}

function installStatementProfiler(sqlite: Database.Database): void {
  const originalPrepare = sqlite.prepare.bind(sqlite);
  sqlite.prepare = ((sql: string) => {
    const statement = originalPrepare(sql);
    return new Proxy(statement, {
      get(target, property) {
        const value = Reflect.get(target, property, target) as unknown;
        if (typeof value !== "function") return value;
        if (property === "run" || property === "get" || property === "all") {
          return (...args: unknown[]) => {
            const startedAt = performance.now();
            let result: unknown;
            try {
              result = Reflect.apply(value, target, args);
              return result;
            } finally {
              if (activeQueries) {
                const key = normalizeSql(sql);
                const sample = activeQueries.get(key) ?? {
                  ms: 0,
                  executions: 0,
                  rows: 0,
                  args: [...args],
                };
                sample.ms += performance.now() - startedAt;
                sample.executions += 1;
                sample.rows += resultRows(String(property), result);
                activeQueries.set(key, sample);
              }
            }
          };
        }
        if (property === "iterate") {
          return (...args: unknown[]) => {
            const iterator = Reflect.apply(value, target, args) as Iterable<unknown>;
            return {
              [Symbol.iterator]: function* () {
                const startedAt = performance.now();
                let rows = 0;
                try {
                  for (const row of iterator) {
                    rows += 1;
                    yield row;
                  }
                } finally {
                  if (activeQueries) {
                    const key = normalizeSql(sql);
                    const sample = activeQueries.get(key) ?? {
                      ms: 0,
                      executions: 0,
                      rows: 0,
                      args: [...args],
                    };
                    sample.ms += performance.now() - startedAt;
                    sample.executions += 1;
                    sample.rows += rows;
                    activeQueries.set(key, sample);
                  }
                }
              },
            };
          };
        }
        return value.bind(target);
      },
    });
  }) as typeof sqlite.prepare;
}

function addRelations(sqlite: Database.Database, taskId: number, index: number): void {
  if (index % 8 === 0) {
    sqlite.prepare("INSERT OR IGNORE INTO work_item_tags (work_item_id, tag_id) VALUES (?, ?)")
      .run(taskId, (index % 5) + 1);
  }
  if (index % 19 === 0) {
    sqlite.prepare("INSERT OR IGNORE INTO work_item_physical_contexts (work_item_id, context_id) VALUES (?, ?)")
      .run(taskId, (index % 2) + 1);
  }
  if (index > 2 && index % 41 === 0) {
    sqlite.prepare("INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES (?, ?)")
      .run(taskId, taskId - 1);
  }
  if (index % 53 === 0) {
    sqlite.prepare("INSERT INTO task_reminders (task_id, kind, at) VALUES (?, 'absolute', '2030-01-15T09:00:00.000Z')")
      .run(taskId);
  }
}

function seedFixture(sqlite: Database.Database, taskCount: number, shape: "balanced" | "deep-chain") {
  sqlite.prepare("INSERT INTO members (name, color) VALUES (?, ?)").run("Profile owner", "#334155");
  sqlite.prepare("INSERT INTO members (name, color) VALUES (?, ?)").run("Profile second owner", "#64748b");

  for (let index = 0; index < 5; index += 1) {
    sqlite.prepare("INSERT INTO tags (name, color) VALUES (?, ?)").run("Profile tag " + index, "#64748b");
  }
  sqlite.prepare("INSERT INTO physical_contexts (source, external_id, name) VALUES ('home_assistant', ?, ?)")
    .run("profile-home", "Profile home");
  sqlite.prepare("INSERT INTO physical_contexts (source, external_id, name) VALUES ('home_assistant', ?, ?)")
    .run("profile-car", "Profile car");

  const projectCount = shape === "deep-chain"
    ? 1
    : Math.max(5, Math.min(20, Math.ceil(taskCount / 100)));
  const insertItem = sqlite.prepare(`
    INSERT INTO work_items
      (parent_id, role, title, status, owner_member_id, owner_inheritance_mode,
       task_kind, position, size, due_date, scheduled_date, needs_clarification)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const projects: number[] = [];
  for (let index = 0; index < projectCount; index += 1) {
    const inserted = insertItem.run(
      null, "story", "Profile project " + index, "active", 1, "explicit",
      null, index, null, null, null, 0,
    );
    const projectId = Number(inserted.lastInsertRowid);
    projects.push(projectId);
    sqlite.prepare("INSERT OR IGNORE INTO work_item_tags (work_item_id, tag_id) VALUES (?, ?)")
      .run(projectId, (index % 5) + 1);
    sqlite.prepare("INSERT OR IGNORE INTO work_item_physical_contexts (work_item_id, context_id) VALUES (?, ?)")
      .run(projectId, (index % 2) + 1);
  }

  const taskIds: number[] = [];
  const tasksByProject: number[][] = Array.from({ length: projectCount }, () => []);
  const transaction = sqlite.transaction(() => {
    for (let index = 0; index < taskCount; index += 1) {
      let projectIndex: number;
      let localIndex: number;
      let parentId: number;
      if (shape === "deep-chain") {
        projectIndex = 0;
        localIndex = index;
        parentId = index === 0 ? projects[0]! : taskIds[index - 1]!;
      } else {
        projectIndex = index % projectCount;
        const previousInProject = tasksByProject[projectIndex]!;
        localIndex = previousInProject.length;
        parentId = localIndex % 4 === 0
          ? projects[projectIndex]!
          : previousInProject.at(-1)!;
      }
      const kind = index % 29 === 0 ? "reference" : "action";
      const status = kind === "reference"
        ? "captured"
        : index % 13 === 0
          ? "done"
          : index % 7 === 0
            ? "backlog"
            : "active";
      const inserted = insertItem.run(
        parentId,
        "task",
        "Profile task " + index,
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
      const taskId = Number(inserted.lastInsertRowid);
      taskIds.push(taskId);
      tasksByProject[projectIndex]!.push(taskId);
      addRelations(sqlite, taskId, index);
    }
  });
  transaction();

  return {
    projectCount,
    taskCount,
    shape,
    maxHierarchyDepth: shape === "deep-chain" ? taskCount : Math.min(4, taskCount),
  };
}

function quantile(values: number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * fraction) - 1] ?? 0;
}

function percentile(values: number[]) {
  return {
    median: Number(quantile(values, 0.5).toFixed(2)),
    p95: Number(quantile(values, 0.95).toFixed(2)),
  };
}

function cteNames(sql: string): string[] {
  const names: string[] = [];
  const head = sql.match(/^\s*WITH\s+(?:RECURSIVE\s+)?([\w]+)\s+AS\s*\(/i);
  if (head?.[1]) names.push(head[1]);
  for (const match of sql.matchAll(/,\s*([\w]+)\s+AS\s*\(/gi)) {
    names.push(match[1]!);
  }
  return names;
}

function queryPlans(sqlite: Database.Database, aggregates: QueryAggregate[]) {
  return aggregates.map(({ sql, samples }) => {
    const executable = /^\s*(SELECT|WITH)\b/i.test(sql);
    if (!executable) return { sql, ctes: cteNames(sql), plan: [], explainError: "not a read query" };
    try {
      const args = samples.find((sample) => sample.args.length > 0)?.args ?? [];
      const rows = sqlite.prepare("EXPLAIN QUERY PLAN " + sql).all(...args) as Array<Record<string, unknown>>;
      return {
        sql,
        ctes: cteNames(sql),
        plan: rows.map((row) => ({
          id: row.id,
          parent: row.parent,
          detail: row.detail,
        })),
      };
    } catch (error) {
      return {
        sql,
        ctes: cteNames(sql),
        plan: [],
        explainError: error instanceof Error ? error.message : String(error),
      };
    }
  });
}

function summarize(taskCount: number, shape: "balanced" | "deep-chain", repeats: number, samples: LoadSample[], sqlite: Database.Database) {
  const queryKeys = new Set(samples.flatMap((sample) => [...sample.querySamples.keys()]));
  const aggregates: QueryAggregate[] = [...queryKeys].map((sql) => ({
    sql,
    samples: samples.map((sample) => sample.querySamples.get(sql) ?? { ms: 0, executions: 0, rows: 0, args: [] }),
  })).sort((left, right) =>
    percentile(right.samples.map((sample) => sample.ms)).median -
    percentile(left.samples.map((sample) => sample.ms)).median,
  );

  const queryResults = aggregates.map(({ sql, samples: querySamples }) => ({
    sql,
    ctes: cteNames(sql),
    executions: percentile(querySamples.map((sample) => sample.executions)),
    rowsReturnedOrChanged: percentile(querySamples.map((sample) => sample.rows)),
    elapsedMs: percentile(querySamples.map((sample) => sample.ms)),
  }));
  const plans = queryPlans(sqlite, aggregates);
  const totals = {
    wallMs: percentile(samples.map((sample) => sample.wallMs)),
    sqlMs: percentile(samples.map((sample) => sample.sqlMs)),
    nonSqlMs: percentile(samples.map((sample) => Math.max(0, sample.wallMs - sample.sqlMs))),
    taskRows: percentile(samples.map((sample) => sample.taskRows)),
    projectRows: percentile(samples.map((sample) => sample.projectRows)),
  };

  return {
    shape,
    taskCount,
    repeats,
    warmups: 1,
    totals,
    queryCount: queryResults.length,
    statements: queryResults,
    queryPlans: plans,
    errors: samples.flatMap((sample) => sample.error ? [sample.error] : []),
  };
}

function oneLoad(db: Db, sqlite: Database.Database): LoadSample {
  const queries = new Map<string, QuerySample>();
  activeQueries = queries;
  const startedAt = performance.now();
  let graph: Graph | undefined;
  let error: string | undefined;
  try {
    graph = Graph.load(db);
  } catch (caught) {
    error = caught instanceof Error ? caught.stack ?? caught.message : String(caught);
  } finally {
    activeQueries = undefined;
  }
  const wallMs = performance.now() - startedAt;
  const sqlMs = [...queries.values()].reduce((total, sample) => total + sample.ms, 0);
  return {
    wallMs,
    sqlMs,
    querySamples: queries,
    taskRows: graph?.tasksById.size ?? 0,
    projectRows: graph?.projectsById.size ?? 0,
    ...(error ? { error } : {}),
  };
}

function runShape(taskCount: number, shape: "balanced" | "deep-chain", repeats: number) {
  const handle = openDb(":memory:");
  runMigrations(handle.db);
  const fixture = seedFixture(handle.sqlite, taskCount, shape);
  installStatementProfiler(handle.sqlite);

  try {
    oneLoad(handle.db, handle.sqlite);
    const samples = Array.from({ length: repeats }, () => oneLoad(handle.db, handle.sqlite));
    return { fixture, result: summarize(taskCount, shape, repeats, samples, handle.sqlite) };
  } finally {
    handle.close();
  }
}

function main() {
  const sizes = (process.env.AUDIT_SIZES ?? "100,1000,5000")
    .split(",").map((value) => Number(value.trim()))
    .filter((value) => Number.isInteger(value) && value > 0);
  const repeats = Number(process.env.AUDIT_REPEATS ?? 3);
  const shapes = (process.env.AUDIT_SHAPES ?? "balanced,deep-chain")
    .split(",").map((value) => value.trim())
    .filter((value): value is "balanced" | "deep-chain" => value === "balanced" || value === "deep-chain");
  if (sizes.length === 0 || repeats < 1 || !Number.isInteger(repeats) || shapes.length === 0) {
    throw new Error("AUDIT_SIZES, AUDIT_SHAPES and AUDIT_REPEATS must contain valid values.");
  }

  console.log(JSON.stringify({
    environment: {
      node: process.version,
      platform: process.platform + "-" + process.arch,
      cpus: os.cpus().length,
      cpuModel: os.cpus()[0]?.model,
      memoryGiB: Number((os.totalmem() / 1024 ** 3).toFixed(1)),
      sqlite: handleSqliteVersion(),
    },
    methodology: {
      measuredUnit: "one direct Graph.load() call",
      warmupsPerFixture: 1,
      repeatedSamples: repeats,
      fixtures: shapes,
      sizes,
      sqlMetrics: "prepared statement wall time, call count, and result/change rows; grouped by normalized SQL text",
      queryPlans: "EXPLAIN QUERY PLAN for each observed SELECT/WITH statement after measured runs",
      notes: [
        "Fixture setup and query-plan collection are excluded from measured Graph.load() calls.",
        "nonSqlMs is wall time minus prepared-statement execution time; inspect assembly membership scans separately only if this residual is material.",
        "Bounded-depth tasks are spread over projects with branches capped at four levels; deep-chain tasks form one parent chain per project.",
      ],
    },
    results: sizes.flatMap((size) => shapes.map((shape) => runShape(size, shape, repeats))),
  }, null, 2));
}

function handleSqliteVersion() {
  const handle = openDb(":memory:");
  try {
    return handle.sqlite.prepare("SELECT sqlite_version() AS version").get();
  } finally {
    handle.close();
  }
}

main();
