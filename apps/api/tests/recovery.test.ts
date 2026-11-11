import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { closeTestContext, createTestContext, type TestContext } from "./helpers.js";

describe("durable upgrade, restart and restore", () => {
  let directory: string;
  let ctx: TestContext | undefined;
  beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "machbar-recovery-")); });
  afterEach(async () => { if (ctx) await closeTestContext(ctx); ctx = undefined; rmSync(directory, { recursive: true, force: true }); });
  it("retains routine occurrence identity across restart and backup restore", async () => {
    const databasePath = join(directory, "routine.sqlite");
    ctx = createTestContext({ databasePath, dataDir: directory });
    const code = (await ctx.app.inject({ method: "POST", url: "/api/integrations/home-assistant/pairing-code" })).json().code;
    const { token } = (await ctx.app.inject({ method: "POST", url: "/api/integrations/home-assistant/pair", payload: { pairingCode: code, protocolVersion: 3 } })).json();
    const request = { method: "POST" as const, url: "/api/integrations/home-assistant/tasks/sync", headers: { authorization: `Bearer ${token}` }, payload: { sourceKey: "example:weekly-check", occurrenceKey: "2026-W46", relevant: true, title: "Weekly check", scheduledDate: "2026-11-10" } };
    const first = await ctx.app.inject(request);
    expect(first.statusCode, first.body).toBe(200);
    await ctx.handle.sqlite.backup(join(directory, "routine-backup.sqlite"));
    await closeTestContext(ctx); ctx = undefined;
    for (const name of ["routine.sqlite", "routine-backup.sqlite"]) {
      ctx = createTestContext({ databasePath: join(directory, name), dataDir: directory });
      const replay = await ctx.app.inject(request);
      expect(replay.statusCode, replay.body).toBe(200);
      expect(replay.json().taskId).toBe(first.json().taskId);
      expect(ctx.handle.sqlite.prepare("SELECT task_id AS taskId FROM external_task_routine_members").all()).toEqual([{ taskId: first.json().taskId }]);
      expect(ctx.handle.sqlite.prepare("SELECT count(*) AS n FROM work_items").get()).toEqual({ n: 1 });
      await closeTestContext(ctx); ctx = undefined;
    }
  });

  it("replays a committed creation after restart and after restoring an online SQLite backup", async () => {
    const databasePath = join(directory, "live.sqlite");
    ctx = createTestContext({ databasePath, dataDir: directory });
    const request = { method: "POST" as const, url: "/api/tasks", headers: { "idempotency-key": "recovery_request_0001" }, payload: { title: "Must survive" } };
    const first = await ctx.app.inject(request);
    expect(first.statusCode).toBe(201);
    const id = first.json().id;
    await ctx.handle.sqlite.backup(join(directory, "backup.sqlite"));
    await closeTestContext(ctx); ctx = undefined;
    for (const file of ["live.sqlite", "backup.sqlite"]) {
      ctx = createTestContext({ databasePath: join(directory, file), dataDir: directory });
      const retry = await ctx.app.inject(request);
      expect(retry.statusCode, retry.body).toBe(200);
      expect(retry.json().id).toBe(id);
      expect(ctx.handle.sqlite.prepare("SELECT count(*) AS n FROM work_items").get()).toEqual({ n: 1 });
      expect(ctx.handle.sqlite.pragma("integrity_check", { simple: true })).toBe("ok");
      expect(ctx.handle.sqlite.pragma("foreign_key_check")).toEqual([]);
      await closeTestContext(ctx); ctx = undefined;
    }
  });
  it("upgrades the pre-receipt schema without losing existing work and reruns migrations safely", async () => {
    const file = join(directory, "old.sqlite");
    const old = openDb(file); runMigrations(old.db);
    old.sqlite.prepare("INSERT INTO work_items (role, title, status) VALUES ('task', 'Pre-upgrade', 'active')").run();
    const journal = JSON.parse(readFileSync(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"));
    const receiptMigration = journal.entries.find((entry: { tag: string }) => entry.tag === "0031_creation_receipts");
    old.sqlite.exec("DROP TABLE external_task_routine_members; DROP TABLE external_task_occurrences; DROP TABLE creation_receipts");
    old.sqlite.prepare("DELETE FROM __drizzle_migrations WHERE created_at >= ?").run(receiptMigration.when);
    old.close();
    ctx = createTestContext({ databasePath: file, dataDir: directory });
    runMigrations(ctx.handle.db);
    expect(ctx.handle.sqlite.prepare("SELECT title FROM work_items").all()).toEqual([{ title: "Pre-upgrade" }]);
    expect(ctx.handle.sqlite.prepare("SELECT count(*) AS n FROM creation_receipts").get()).toEqual({ n: 0 });
    expect(ctx.handle.sqlite.pragma("foreign_key_check")).toEqual([]);
  });
  it("recovers committed WAL data after a real writer process is killed", async () => {
    const file = join(directory, "crash.sqlite");
    const setup = openDb(file); runMigrations(setup.db); setup.close();
    const code = `import {openDb} from './src/db/client.ts'; import {createTask} from './src/domain/taskCrud.ts'; import {createWithReceipt} from './src/domain/creationReceipt.ts'; const h=openDb(${JSON.stringify(file)}); createWithReceipt(h.db,{key:'crash_request_0001',route:'/api/tasks',viewer:undefined,body:{title:'Committed before kill'}},()=>createTask(h.db,{title:'Committed before kill'})); console.log('COMMITTED'); setInterval(()=>{},1000);`;
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
    try {
      await new Promise<void>((resolve, reject) => {
        let output = "";
        const timer = setTimeout(() => reject(new Error("Writer did not commit")), 5000);
        child.stdout.on("data", data => { output += data; if (output.includes("COMMITTED")) { clearTimeout(timer); resolve(); } });
        child.once("error", error => { clearTimeout(timer); reject(error); });
        child.once("exit", code => { clearTimeout(timer); reject(new Error(`Writer exited early: ${code}`)); });
      });
      const stopped = once(child, "exit"); child.kill("SIGKILL"); await stopped;
    } finally { child.kill("SIGKILL"); }
    ctx = createTestContext({ databasePath: file, dataDir: directory });
    const retry = await ctx.app.inject({ method: "POST", url: "/api/tasks", headers: { "idempotency-key": "crash_request_0001" }, payload: { title: "Committed before kill" } });
    expect(retry.statusCode, retry.body).toBe(200);
    expect(ctx.handle.sqlite.prepare("SELECT title FROM work_items").all()).toEqual([{ title: "Committed before kill" }]);
    expect(ctx.handle.sqlite.pragma("integrity_check", { simple: true })).toBe("ok");
  });
});
