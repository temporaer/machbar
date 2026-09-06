import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ACTIVITY_ACTOR_HEADER } from "@machbar/shared";
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
        revisitDate: "2026-09-02",
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

  it("resolves the wait without clearing the independent work plan", async () => {
    const task = await createTask({
      title: "Antwort abwarten",
      scheduledDate: "2026-09-10",
    });
    const waiting = await ctx.app.inject({
      method: "PUT",
      url: `/api/tasks/${task.id}/external-wait`,
      payload: {
        waitingFor: "Sarah",
        revisitDate: "2026-09-02",
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
      scheduledDate: "2026-09-10",
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
      externalWait: { waitingFor: "IKEA-Lieferung", revisitDate: null },
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
    expect(rows.map((row: { task: { title: string } }) => row.task.title)).not.toContain(
      "Dependency only",
    );
    expect(rows.map((row: { task: { title: string } }) => row.task.title)).toEqual(
      expect.arrayContaining(["External only", "Both"]),
    );
    expect(
      rows.filter((row: { task: { id: number } }) => row.task.id === both.id),
    ).toHaveLength(1);
    expect(
      rows.find((row: { task: { id: number; blockers: unknown[] } }) => row.task.id === both.id)
        .task.blockers,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "dependency" }),
        expect.objectContaining({ type: "external" }),
      ]),
    );
  });

  it("orders waiting work by attention, due date, title, and ID with missing dates last", async () => {
    async function wait(
      title: string,
      revisitDate?: string,
      dueDate?: string,
    ) {
      const task = await createTask({ title, dueDate });
      await ctx.app.inject({
        method: "PUT",
        url: `/api/tasks/${task.id}/external-wait`,
        payload: { waitingFor: "Reply", revisitDate },
      });
      return task;
    }

    const missingZulu = await wait("Missing Zulu");
    const missingAlphaFirst = await wait("Missing Alpha");
    const missingAlphaSecond = await wait("Missing Alpha");
    const laterDue = await wait(
      "Same attention, later due",
      "2026-09-02",
      "2026-09-05",
    );
    const earlierDue = await wait(
      "Same attention, earlier due",
      "2026-09-02",
      "2026-09-03",
    );
    const earliest = await wait("Earliest attention", "2026-09-01");

    ctx.handle.sqlite
      .prepare("UPDATE tasks SET position = CASE id WHEN ? THEN 0 ELSE 99 END WHERE id IN (?, ?)")
      .run(missingZulu.id, missingZulu.id, missingAlphaFirst.id);

    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/waiting",
    });
    expect(response.statusCode).toBe(200);
    expect(
      response.json().map((entry: { task: { id: number } }) => entry.task.id),
    ).toEqual([
      earliest.id,
      earlierDue.id,
      laterDue.id,
      missingAlphaFirst.id,
      missingAlphaSecond.id,
      missingZulu.id,
    ]);
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
    expect(current.json().externalWait).toEqual({
      waitingFor: "Amt",
      revisitDate: null,
    });
  });

  it("removes the wait but keeps the work plan when leaving actionable", async () => {
    const task = await createTask({
      title: "Später entscheiden",
      scheduledDate: "2026-09-12",
    });
    const waiting = await ctx.app.inject({
      method: "PUT",
      url: `/api/tasks/${task.id}/external-wait`,
      payload: {
        waitingFor: "Rückmeldung",
        revisitDate: "2026-09-02",
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
      scheduledDate: "2026-09-12",
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

  it("atomically appends an attributed follow-up and updates the wait", async () => {
    const member = (
      await ctx.app.inject({
        method: "POST",
        url: "/api/members",
        payload: { name: "Mira" },
      })
    ).json();
    const task = await createTask({
      title: "Ask again",
      notes: "Initial request.",
      scheduledDate: "2026-09-06",
    });
    const waiting = (
      await ctx.app.inject({
        method: "PUT",
        url: `/api/tasks/${task.id}/external-wait`,
        payload: {
          waitingFor: "Landlord",
          revisitDate: "2026-09-02",
          expectedRevision: task.revision,
        },
      })
    ).json();

    const response = await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${task.id}/external-wait/follow-up`,
      headers: { [ACTIVITY_ACTOR_HEADER]: String(member.id) },
      payload: {
        action: "continue",
        content: "Called again; awaiting the written answer.",
        waitingFor: "Property manager",
        revisitDate: "2026-09-09",
        expectedRevision: waiting.revision,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: task.id,
      status: "actionable",
      scheduledDate: "2026-09-06",
      externalWait: {
        waitingFor: "Property manager",
        revisitDate: "2026-09-09",
      },
      revision: waiting.revision + 1,
    });
    expect(response.json().notes).toMatch(
      /^Initial request\.\n\n\[[^\]]+ · Mira\]\nCalled again; awaiting the written answer\.$/,
    );
  });

  it("atomically appends a follow-up and resolves the wait without changing task status", async () => {
    const task = await createTask({
      title: "Resolve after reply",
      notes: "Initial request.",
      scheduledDate: "2026-09-11",
    });
    const waiting = (
      await ctx.app.inject({
        method: "PUT",
        url: `/api/tasks/${task.id}/external-wait`,
        payload: {
          waitingFor: "Supplier",
          revisitDate: "2026-09-02",
          expectedRevision: task.revision,
        },
      })
    ).json();

    const response = await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${task.id}/external-wait/follow-up`,
      payload: {
        action: "resolve",
        content: "The delivery was confirmed.",
        expectedRevision: waiting.revision,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "actionable",
      externalWait: null,
      scheduledDate: "2026-09-11",
      blocked: false,
      revision: waiting.revision + 1,
    });
    expect(response.json().notes).toContain(
      "· Unknown actor]\nThe delivery was confirmed.",
    );
  });

  it("rolls back the whole follow-up on stale revision or a missing continuation reason", async () => {
    const task = await createTask({
      title: "Keep atomic",
      notes: "Original note.",
      scheduledDate: "2026-09-06",
    });
    const waiting = (
      await ctx.app.inject({
        method: "PUT",
        url: `/api/tasks/${task.id}/external-wait`,
        payload: {
          waitingFor: "Authority",
          revisitDate: "2026-09-02",
          expectedRevision: task.revision,
        },
      })
    ).json();
    const stale = await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${task.id}/external-wait/follow-up`,
      payload: {
        action: "resolve",
        content: "Must not be appended.",
        expectedRevision: task.revision,
      },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe("stale_write_conflict");

    const noReason = await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${task.id}/external-wait/follow-up`,
      payload: {
        action: "continue",
        content: "Also must not be appended.",
        waitingFor: "   ",
        revisitDate: "2026-09-10",
        expectedRevision: waiting.revision,
      },
    });
    expect(noReason.statusCode).toBe(400);
    expect(noReason.json().error.code).toBe("external_wait_reason_required");

    const current = await ctx.app.inject({
      method: "GET",
      url: `/api/tasks/${task.id}`,
    });
    expect(current.json()).toMatchObject({
      notes: "Original note.",
      scheduledDate: "2026-09-06",
      externalWait: {
        waitingFor: "Authority",
        revisitDate: "2026-09-02",
      },
      revision: waiting.revision,
    });
  });
});
