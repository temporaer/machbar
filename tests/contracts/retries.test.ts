import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../apps/web/src/lib/api";
import { closeTestContext, createTestContext, type TestContext } from "../../apps/api/tests/helpers";
import { ChangeNotifier } from "../../apps/api/src/changeNotifier";

describe("ordinary creation after a lost response", () => {
  let ctx: TestContext;
  let loseResponse: boolean;
  const notified = vi.fn();
  beforeEach(() => {
    const notifier = new ChangeNotifier(); notifier.subscribe(notified);
    ctx = createTestContext({ changeNotifier: notifier }); loseResponse = true; notified.mockClear();
    vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
      const result = await ctx.app.inject({ method: init.method as "POST", url, headers: Object.fromEntries(new Headers(init.headers)), payload: init.body as string });
      if (loseResponse && result.statusCode < 300) { loseResponse = false; throw new TypeError("Connection lost after commit"); }
      return new Response(result.body, { status: result.statusCode });
    });
  });
  afterEach(async () => { vi.unstubAllGlobals(); await closeTestContext(ctx); });
  it.each(["task", "project"] as const)("retries a committed %s exactly once, but allows an intentional second creation after success", async kind => {
    const create = () => kind === "task" ? api.createTask({ title: "Retry fixture" }) : api.createProject({ title: "Retry fixture" });
    await expect(create()).rejects.toThrow("Connection lost after commit");
    const saved = await create();
    const rows = ctx.handle.sqlite.prepare("SELECT id FROM work_items WHERE title = ?").all("Retry fixture");
    expect(rows).toEqual([{ id: saved.id }]);
    expect(notified).toHaveBeenCalledTimes(1);
    const intentional = await create();
    expect(intentional.id).not.toBe(saved.id);
    expect(ctx.handle.sqlite.prepare("SELECT count(*) AS n FROM work_items WHERE title = ?").get("Retry fixture")).toEqual({ n: 2 });
  });
  it("does not merge independent simultaneous creations with identical content", async () => {
    loseResponse = false;
    const [first, second] = await Promise.all([
      api.createTask({ title: "Two independent intents" }),
      api.createTask({ title: "Two independent intents" }),
    ]);
    expect(first.id).not.toBe(second.id);
    expect(notified).toHaveBeenCalledTimes(2);
  });

});
