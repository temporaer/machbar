import { mkdtempSync, rmSync } from "node:fs";
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
    old.sqlite.exec("DROP TABLE creation_receipts; DELETE FROM __drizzle_migrations WHERE created_at = (SELECT max(created_at) FROM __drizzle_migrations)");
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
