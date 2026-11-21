import { describe, expect, it } from "vitest";
import { performance } from "node:perf_hooks";
import type { Db } from "../src/db/client.js";
import * as schema from "../src/db/schema.js";
import { Graph } from "../src/domain/graph.js";
import { archiveTerminalWorkBatch } from "../src/repo/operationalArchiveRepo.js";
import { createTestDatabase } from "./database.js";

function percentile(values: number[], fraction: number): number {
  return [...values].sort((a, b) => a - b)[Math.ceil(fraction * values.length) - 1]!;
}

function addFixture(db: Db, count: number, terminalRatio: number): void {
  const terminalCount = Math.floor(count * terminalRatio);
  for (let start = 0; start < count; start += 250) {
    const values = Array.from({ length: Math.min(250, count - start) }, (_, offset) => {
      const id = start + offset;
      const terminal = id < terminalCount;
      return {
        id: id + 1,
        parentId: id % 10 === 0 ? null : id,
        role: "task" as const,
        title: `Synthetic task ${id}`,
        status: terminal ? "done" : "active",
        taskKind: "action" as const,
        completedAt: terminal ? "2026-11-01T12:00:00.000Z" : null,
      };
    });
    db.insert(schema.workItems).values(values).run();
  }
  while (archiveTerminalWorkBatch(db, { limit: 500 }) > 0) { /* bounded backfill */ }
}

describe("temporary operational archive benchmark", () => {
  it("compares full and operational Graph.load on identical 50% terminal fixtures", () => {
    const output: Array<Record<string, number>> = [];
    for (const count of [100, 1_000, 5_000]) {
      const handle = createTestDatabase();
      try {
        addFixture(handle.db, count, 0.5);
        const full: number[] = [];
        const operational: number[] = [];
        for (let sample = 0; sample < 9; sample += 1) {
          for (const [mode, target] of [["full", full], ["operational", operational]] as const) {
            const start = performance.now();
            if (mode === "full") Graph.load(handle.db, "2026-11-21");
            else Graph.loadOperational(handle.db, "2026-11-21");
            const elapsed = performance.now() - start;
            if (sample >= 2) target.push(elapsed);
          }
        }
        output.push({
          tasks: count,
          full_median_ms: Number(percentile(full, 0.5).toFixed(2)),
          full_p95_ms: Number(percentile(full, 0.95).toFixed(2)),
          operational_median_ms: Number(percentile(operational, 0.5).toFixed(2)),
          operational_p95_ms: Number(percentile(operational, 0.95).toFixed(2)),
          rows_operational: Graph.loadOperational(handle.db, "2026-11-21").tasksById.size,
        });
      } finally {
        handle.close();
      }
    }
    process.stderr.write(`ARCHIVE_BENCHMARK ${JSON.stringify(output)}\n`);
    expect(output).toHaveLength(3);
  });
});
