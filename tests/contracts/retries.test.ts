import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../apps/web/src/lib/api";
import { closeTestContext, createTestContext, type TestContext } from "../../apps/api/tests/helpers";
import { ChangeNotifier } from "../../apps/api/src/changeNotifier";

describe("ordinary creation after a lost response", () => {
  let ctx: TestContext;
  let responsesToLose: number;
  let requestKeys: string[];
  const notified = vi.fn();
  beforeEach(() => {
    const notifier = new ChangeNotifier(); notifier.subscribe(notified);
    ctx = createTestContext({ changeNotifier: notifier }); responsesToLose = 1; requestKeys = []; notified.mockClear();
    vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
      requestKeys.push(new Headers(init.headers).get("Idempotency-Key") ?? "");
      const result = await ctx.app.inject({ method: init.method as "POST", url, headers: Object.fromEntries(new Headers(init.headers)), payload: init.body as string });
      if (responsesToLose > 0 && result.statusCode < 300) { responsesToLose -= 1; throw new TypeError("Connection lost after commit"); }
      return new Response(result.body, { status: result.statusCode });
    });
  });
  afterEach(async () => { vi.unstubAllGlobals(); await closeTestContext(ctx); });
  it.each(["task", "project"] as const)("retries a committed %s exactly once, but allows an intentional second creation after success", async kind => {
    const intent = {};
    const create = () => kind === "task" ? api.createTask({ title: "Retry fixture" }, intent) : api.createProject({ title: "Retry fixture" }, intent);
    await expect(create()).rejects.toThrow("Connection lost after commit");
    const saved = await create();
    const rows = ctx.handle.sqlite.prepare("SELECT id FROM work_items WHERE title = ?").all("Retry fixture");
    expect(rows).toEqual([{ id: saved.id }]);
    expect(notified).toHaveBeenCalledTimes(1);
    const intentional = await create();
    expect(intentional.id).not.toBe(saved.id);
    expect(ctx.handle.sqlite.prepare("SELECT count(*) AS n FROM work_items WHERE title = ?").get("Retry fixture")).toEqual({ n: 2 });
  });
  it("recovers independent simultaneous creations after both responses are lost", async () => {
    responsesToLose = 2;
    const firstIntent = {}, secondIntent = {};
    const [firstAttempt, secondAttempt] = await Promise.allSettled([
      api.createTask({ title: "Two independent intents" }, firstIntent),
      api.createTask({ title: "Two independent intents" }, secondIntent),
    ]);
    expect(firstAttempt.status).toBe("rejected");
    expect(secondAttempt.status).toBe("rejected");
    expect(requestKeys[0]).not.toBe(requestKeys[1]);
    const createdForKey = (key: string) => (
      ctx.handle.sqlite
        .prepare("SELECT work_item_id AS id FROM creation_receipts WHERE request_key = ?")
        .get(key) as { id: number }
    ).id;
    const firstIntentId = createdForKey(requestKeys[0]!);
    const secondIntentId = createdForKey(requestKeys[1]!);
    const [first, second] = await Promise.all([
      api.createTask({ title: "Two independent intents" }, firstIntent),
      api.createTask({ title: "Two independent intents" }, secondIntent),
    ]);
    expect(requestKeys[2]).toBe(requestKeys[0]);
    expect(requestKeys[3]).toBe(requestKeys[1]);
    expect(first.id).toBe(firstIntentId);
    expect(second.id).toBe(secondIntentId);
    expect(ctx.handle.sqlite.prepare("SELECT id FROM work_items WHERE title = ? ORDER BY id").all("Two independent intents")).toHaveLength(2);
    expect(notified).toHaveBeenCalledTimes(2);
  });

  it("keeps retry identity when identical callers retry in reverse order", async () => {
    responsesToLose = 2;
    const firstIntent = {}, secondIntent = {};
    const input = { title: "Reverse-order identical intents" };
    await Promise.allSettled([api.createTask(input, firstIntent), api.createTask(input, secondIntent)]);
    const committed = (key: string) => (ctx.handle.sqlite.prepare("SELECT work_item_id AS id FROM creation_receipts WHERE request_key = ?").get(key) as { id: number }).id;
    const expectedFirst = committed(requestKeys[0]!);
    const expectedSecond = committed(requestKeys[1]!);
    const second = await api.createTask(input, secondIntent);
    const first = await api.createTask(input, firstIntent);
    expect(second.id).toBe(expectedSecond);
    expect(first.id).toBe(expectedFirst);
    expect(notified).toHaveBeenCalledTimes(2);
  });

  it("does not consume another caller's uncertain creation for a new intent", async () => {
    const failedIntent = {}, newIntent = {};
    const input = { title: "Separate forms with identical content" };
    await expect(api.createTask(input, failedIntent)).rejects.toThrow("Connection lost after commit");
    const originalId = (ctx.handle.sqlite.prepare("SELECT work_item_id AS id FROM creation_receipts WHERE request_key = ?").get(requestKeys[0]) as { id: number }).id;
    const fresh = await api.createTask(input, newIntent);
    expect(fresh.id).not.toBe(originalId);
    expect((await api.createTask(input, failedIntent)).id).toBe(originalId);
    expect(notified).toHaveBeenCalledTimes(2);
  });

});
