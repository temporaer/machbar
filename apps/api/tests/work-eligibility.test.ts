import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeTestContext,
  createTestContext,
  type TestContext,
} from "./helpers.js";

describe("working-system task eligibility", () => {
  let ctx: TestContext;
  const today = "2026-08-29";

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(async () => {
    await closeTestContext(ctx);
  });

  it("keeps backlog project tasks out of operational queues until activation", async () => {
    const member = (
      await ctx.app.inject({
        method: "POST",
        url: "/api/members",
        payload: { name: "Mira" },
      })
    ).json();
    const project = (
      await ctx.app.inject({
        method: "POST",
        url: "/api/projects",
        payload: {
          title: "Später vorbereiten",
          ownerMemberId: member.id,
        },
      })
    ).json();

    const createTask = async (payload: Record<string, unknown>) =>
      (
        await ctx.app.inject({
          method: "POST",
          url: "/api/tasks",
          payload: { projectId: project.id, ...payload },
        })
      ).json();

    const actionable = await createTask({
      title: "Vorbereiteter nächster Schritt",
      status: "actionable",
      scheduledDate: today,
    });
    const waiting = await createTask({
      title: "Vorbereitete Rückmeldung",
      status: "actionable",
      scheduledDate: today,
    });
    const waitResponse = await ctx.app.inject({
      method: "PUT",
      url: `/api/tasks/${waiting.id}/external-wait`,
      payload: { waitingFor: "Rückmeldung" },
    });
    expect(waitResponse.statusCode).toBe(200);
    const captured = await createTask({
      title: "Vorbereitete offene Frage",
      needsClarification: true,
    });

    const agendaBefore = (
      await ctx.app.inject({
        method: "GET",
        url: `/api/agenda/today?scope=all&date=${today}`,
      })
    ).json();
    expect([
      ...agendaBefore.planned,
      ...agendaBefore.overdue,
      ...agendaBefore.dueToday,
      ...agendaBefore.dueSoon,
      ...agendaBefore.shared,
      ...agendaBefore.unscheduled,
      ...agendaBefore.revisit,
    ]).toEqual([]);

    expect(
      (
        await ctx.app.inject({ method: "GET", url: "/api/waiting" })
      ).json(),
    ).toEqual([]);
    expect(
      (
        await ctx.app.inject({ method: "GET", url: "/api/inbox" })
      ).json(),
    ).toEqual([]);
    expect(
      (
        await ctx.app.inject({
          method: "GET",
          url: "/api/refinement/tasks",
        })
      )
        .json()
        .map((task: { id: number }) => task.id),
    ).toEqual([]);

    const detail = (
      await ctx.app.inject({
        method: "GET",
        url: `/api/projects/${project.id}`,
      })
    ).json();
    expect(detail).not.toHaveProperty("refinementIssues");
    expect(detail).not.toHaveProperty("readiness");
    expect(detail.tasks.map((task: { id: number }) => task.id)).toEqual(
      expect.arrayContaining([actionable.id, waiting.id, captured.id]),
    );
    const search = (
      await ctx.app.inject({
        method: "GET",
        url: "/api/search?text=Vorbereitete",
      })
    ).json();
    expect(search.map((task: { id: number }) => task.id)).toEqual(
      expect.arrayContaining([actionable.id, waiting.id, captured.id]),
    );

    const activated = await ctx.app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/activate`,
      payload: {},
    });
    expect(activated.statusCode).toBe(200);

    const agendaAfter = (
      await ctx.app.inject({
        method: "GET",
        url: `/api/agenda/today?scope=all&date=${today}`,
      })
    ).json();
    expect(agendaAfter.planned.map((task: { id: number }) => task.id)).toContain(
      actionable.id,
    );
    expect(
      agendaAfter.revisit.map((task: { id: number }) => task.id),
    ).toContain(waiting.id);
    expect(
      (
        await ctx.app.inject({ method: "GET", url: "/api/waiting" })
      )
        .json()
        .map((task: { id: number }) => task.id),
    ).toContain(waiting.id);
    expect(
      (
        await ctx.app.inject({ method: "GET", url: "/api/inbox" })
      )
        .json()
        .map((task: { id: number }) => task.id),
    ).toContain(captured.id);
    expect(
      (
        await ctx.app.inject({
          method: "GET",
          url: "/api/refinement/tasks",
        })
      )
        .json()
        .map((task: { id: number }) => task.id),
    ).toEqual(expect.arrayContaining([actionable.id, waiting.id, captured.id]));
  });
});
