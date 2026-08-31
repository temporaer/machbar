import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeTestContext,
  createTestContext,
  type TestContext,
} from "./helpers.js";

describe("task external waits", () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(async () => {
    await closeTestContext(ctx);
  });

  async function createTask(payload: Record<string, unknown>) {
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: { status: "actionable", ...payload },
    });
    expect(response.statusCode).toBe(201);
    return response.json();
  }

  it("requires a reason before a task becomes externally blocked", async () => {
    const task = await createTask({ title: "Schrank aufbauen" });
    const response = await ctx.app.inject({
      method: "PUT",
      url: `/api/tasks/${task.id}/external-wait`,
      payload: {
        waitingFor: null,
        scheduledDate: "2026-09-02",
        expectedRevision: task.revision,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("external_wait_reason_required");
    const unchanged = await ctx.app.inject({
      method: "GET",
      url: `/api/tasks/${task.id}`,
    });
    expect(unchanged.json()).toMatchObject({
      externalWait: null,
      scheduledDate: null,
      blocked: false,
      executable: true,
      revision: task.revision,
    });
  });

  it("resolves the wait and clears its revisit date by default", async () => {
    const task = await createTask({ title: "Antwort abwarten" });
    const waiting = await ctx.app.inject({
      method: "PUT",
      url: `/api/tasks/${task.id}/external-wait`,
      payload: {
        waitingFor: "Sarah",
        scheduledDate: "2026-09-02",
        expectedRevision: task.revision,
      },
    });
    const waitingTask = waiting.json();

    const resolved = await ctx.app.inject({
      method: "DELETE",
      url: `/api/tasks/${task.id}/external-wait`,
      payload: { expectedRevision: waitingTask.revision },
    });

    expect(resolved.statusCode).toBe(200);
    expect(resolved.json()).toMatchObject({
      externalWait: null,
      scheduledDate: null,
      blocked: false,
      executable: true,
    });
  });

  it("keeps a task blocked until both dependency and external blockers clear", async () => {
    const prerequisite = await createTask({ title: "Wand streichen" });
    const task = await createTask({ title: "Schrank aufbauen" });
    await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${task.id}/dependencies`,
      payload: { dependsOnTaskId: prerequisite.id },
    });

    const waiting = await ctx.app.inject({
      method: "PUT",
      url: `/api/tasks/${task.id}/external-wait`,
      payload: { waitingFor: "IKEA-Lieferung" },
    });
    expect(waiting.json().blocked).toBe(true);

    await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${prerequisite.id}/complete`,
    });
    const dependencyResolved = await ctx.app.inject({
      method: "GET",
      url: `/api/tasks/${task.id}`,
    });
    expect(dependencyResolved.json()).toMatchObject({
      blocked: true,
      externalWait: { waitingFor: "IKEA-Lieferung" },
    });

    await ctx.app.inject({
      method: "DELETE",
      url: `/api/tasks/${task.id}/external-wait`,
      payload: { expectedRevision: dependencyResolved.json().revision },
    });
    const executable = await ctx.app.inject({
      method: "GET",
      url: `/api/tasks/${task.id}`,
    });
    expect(executable.json()).toMatchObject({
      blocked: false,
      executable: true,
    });
  });

  it("lists direct external waits once and skips dependency-only blockers", async () => {
    const prerequisite = await createTask({ title: "Prerequisite" });
    const dependencyOnly = await createTask({ title: "Dependency only" });
    await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${dependencyOnly.id}/dependencies`,
      payload: { dependsOnTaskId: prerequisite.id },
    });
    const externalOnly = await createTask({ title: "External only" });
    await ctx.app.inject({
      method: "PUT",
      url: `/api/tasks/${externalOnly.id}/external-wait`,
      payload: { waitingFor: "Delivery" },
    });
    const both = await createTask({ title: "Both" });
    await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${both.id}/dependencies`,
      payload: { dependsOnTaskId: prerequisite.id },
    });
    await ctx.app.inject({
      method: "PUT",
      url: `/api/tasks/${both.id}/external-wait`,
      payload: { waitingFor: "Approval" },
    });

    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/waiting",
    });
    expect(response.statusCode).toBe(200);
    const rows = response.json();
    expect(rows.map((row: { title: string }) => row.title)).not.toContain(
      "Dependency only",
    );
    expect(rows.map((row: { title: string }) => row.title)).toEqual(
      expect.arrayContaining(["External only", "Both"]),
    );
    expect(
      rows.filter((row: { id: number }) => row.id === both.id),
    ).toHaveLength(1);
    expect(
      rows.find((row: { id: number }) => row.id === both.id).blockers,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "dependency" }),
        expect.objectContaining({ type: "external" }),
      ]),
    );
  });

  it("rejects stale writes and leaves the current wait intact", async () => {
    const task = await createTask({ title: "Genehmigung abwarten" });
    const first = await ctx.app.inject({
      method: "PUT",
      url: `/api/tasks/${task.id}/external-wait`,
      payload: {
        waitingFor: "Amt",
        expectedRevision: task.revision,
      },
    });
    expect(first.statusCode).toBe(200);

    const stale = await ctx.app.inject({
      method: "PUT",
      url: `/api/tasks/${task.id}/external-wait`,
      payload: {
        waitingFor: "Andere Stelle",
        expectedRevision: task.revision,
      },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe("stale_write_conflict");

    const current = await ctx.app.inject({
      method: "GET",
      url: `/api/tasks/${task.id}`,
    });
    expect(current.json().externalWait).toEqual({ waitingFor: "Amt" });
  });

  it("removes the wait and revisit when leaving actionable", async () => {
    const task = await createTask({ title: "Später entscheiden" });
    const waiting = await ctx.app.inject({
      method: "PUT",
      url: `/api/tasks/${task.id}/external-wait`,
      payload: {
        waitingFor: "Rückmeldung",
        scheduledDate: "2026-09-02",
      },
    });

    const transitioned = await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${task.id}/status`,
      payload: {
        status: "someday",
        expectedRevision: waiting.json().revision,
      },
    });
    expect(transitioned.json()).toMatchObject({
      status: "someday",
      externalWait: null,
      scheduledDate: null,
      blocked: false,
    });
  });

  it("rejects waits on non-actionable and recurring tasks", async () => {
    const captured = await createTask({
      title: "Unklar",
      status: "captured",
    });
    const capturedWait = await ctx.app.inject({
      method: "PUT",
      url: `/api/tasks/${captured.id}/external-wait`,
      payload: {},
    });
    expect(capturedWait.statusCode).toBe(409);
    expect(capturedWait.json().error.code).toBe(
      "external_wait_status_invalid",
    );

    const recurring = await createTask({
      title: "Wöchentlich",
      scheduledDate: "2026-09-01",
      repeatAfterDays: 7,
      allowedDeviationDays: 0,
    });
    const recurringWait = await ctx.app.inject({
      method: "PUT",
      url: `/api/tasks/${recurring.id}/external-wait`,
      payload: {},
    });
    expect(recurringWait.statusCode).toBe(409);
    expect(recurringWait.json().error.code).toBe(
      "external_wait_recurring_forbidden",
    );
  });
});
