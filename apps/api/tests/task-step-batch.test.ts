import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACTIVITY_ACTOR_HEADER } from "@machbar/shared";
import { Graph } from "../src/domain/graph.js";
import { closeTestContext, createTestContext, type TestContext } from "./helpers.js";

describe("atomic task step batches", () => {
  let ctx: TestContext;

  beforeEach(() => { ctx = createTestContext(); });
  afterEach(async () => {
    vi.restoreAllMocks();
    await closeTestContext(ctx);
  });

  async function createTask(payload: Record<string, unknown>) {
    const response = await ctx.app.inject({ method: "POST", url: "/api/tasks", payload });
    expect(response.statusCode).toBe(201);
    return response.json();
  }

  async function createProject(payload: Record<string, unknown>) {
    const response = await ctx.app.inject({ method: "POST", url: "/api/projects", payload });
    expect(response.statusCode).toBe(201);
    return response.json();
  }

  function mutationRecords(ids: number[]) {
    const placeholders = ids.map(() => "?").join(", ");
    const activities = ctx.handle.sqlite.prepare(`
      SELECT kind, entity_type AS entityType, entity_title AS entityTitle,
        json_extract(metadata, '$.previousStatus') AS previousStatus,
        json_extract(metadata, '$.nextStatus') AS nextStatus,
        json_extract(metadata, '$.changedFields') AS changedFields
      FROM activity_events
      WHERE entity_id IN (${placeholders})
      ORDER BY entity_title, kind, previousStatus, nextStatus
    `).all(...ids);
    const contributions = ctx.handle.sqlite.prepare(`
      SELECT activity.entity_title AS activityTitle,
        contribution.category,
        contribution.reason,
        contribution.entity_type AS entityType
      FROM contribution_events contribution
      JOIN activity_events activity ON activity.id = contribution.activity_event_id
      WHERE activity.entity_id IN (${placeholders})
      ORDER BY activity.entity_title, contribution.category, contribution.reason
    `).all(...ids);
    return { activities, contributions };
  }

  it("classifies an Inbox parent together with its first child batch", async () => {
    const parent = await createTask({ title: "Kita-Formular" });
    const response = await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${parent.id}/children/batch`,
      payload: {
        expectedRevision: parent.revision,
        steps: [{ title: "Formular ausfüllen" }, { title: "Im Sekretariat abgeben" }],
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().tasks).toHaveLength(2);
    expect(response.json().tasks.map((task: { title: string }) => task.title)).toEqual([
      "Formular ausfüllen",
      "Im Sekretariat abgeben",
    ]);
    expect((await ctx.app.inject({ method: "GET", url: `/api/tasks/${parent.id}` })).json())
      .toMatchObject({ status: "actionable", needsClarification: false });
  });

  it("projects a child batch from one graph and matches authorized task reads", async () => {
    const member = (await ctx.app.inject({ method: "POST", url: "/api/members", payload: { name: "Mira" } })).json();
    const headers = { [ACTIVITY_ACTOR_HEADER]: String(member.id) };
    const parentResponse = await ctx.app.inject({
      method: "POST",
      url: "/api/tasks",
      headers,
      payload: { title: "Wohnung vorbereiten" },
    });
    expect(parentResponse.statusCode).toBe(201);
    const parent = parentResponse.json();
    const graphLoad = vi.spyOn(Graph, "load");
    const response = await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${parent.id}/children/batch`,
      headers,
      payload: {
        expectedRevision: parent.revision,
        steps: [{ title: "Kisten packen" }, { title: "Transporter buchen" }, { title: "Schlüssel übergeben" }],
      },
    });

    expect(response.statusCode).toBe(201);
    expect(graphLoad).toHaveBeenCalledTimes(2);
    const result = response.json();
    expect(result.parent).toEqual(
      (await ctx.app.inject({ method: "GET", url: `/api/tasks/${parent.id}`, headers })).json(),
    );
    for (const task of result.tasks) {
      expect(task).toEqual(
        (await ctx.app.inject({ method: "GET", url: `/api/tasks/${task.id}`, headers })).json(),
      );
    }
  });

  it("matches the canonical child path after a reference-first XL breakdown", async () => {
    const member = (await ctx.app.inject({ method: "POST", url: "/api/members", payload: { name: "Mira" } })).json();
    const headers = { [ACTIVITY_ACTOR_HEADER]: String(member.id) };
    const singleParent = await createTask({ title: "Reise planen", size: "XL" });
    const batchParent = await createTask({ title: "Reise planen", size: "XL" });

    const singleReference = await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${singleParent.id}/children`,
      headers,
      payload: { title: "Material", kind: "reference" },
    });
    const batchReference = await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${batchParent.id}/children`,
      headers,
      payload: { title: "Material", kind: "reference" },
    });
    expect(singleReference.statusCode).toBe(201);
    expect(batchReference.statusCode).toBe(201);

    const singleChildren = [];
    for (const title of ["Zug buchen", "Hotel buchen"]) {
      const child = await ctx.app.inject({
        method: "POST",
        url: `/api/tasks/${singleParent.id}/children`,
        headers,
        payload: { title },
      });
      expect(child.statusCode).toBe(201);
      singleChildren.push(child.json());
    }
    const currentBatchParent = (await ctx.app.inject({
      method: "GET",
      url: `/api/tasks/${batchParent.id}`,
      headers,
    })).json();
    const batch = await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${batchParent.id}/children/batch`,
      headers,
      payload: {
        expectedRevision: currentBatchParent.revision,
        steps: [{ title: "Zug buchen" }, { title: "Hotel buchen" }],
      },
    });
    expect(batch.statusCode).toBe(201);

    async function outcome(parentId: number, childIds: number[]) {
      const parent = (await ctx.app.inject({
        method: "GET",
        url: `/api/tasks/${parentId}`,
        headers,
      })).json();
      return {
        parent: {
          status: parent.status,
          needsClarification: parent.needsClarification,
          children: parent.children.map((child: { title: string; kind: string; status: string; position: number }) => ({
            title: child.title,
            kind: child.kind,
            status: child.status,
            position: child.position,
          })),
        },
        records: mutationRecords([parentId, ...childIds]),
      };
    }

    expect(await outcome(batchParent.id, [
      batchReference.json().id,
      ...batch.json().tasks.map((task: { id: number }) => task.id),
    ])).toEqual(await outcome(singleParent.id, [
      singleReference.json().id,
      ...singleChildren.map((task: { id: number }) => task.id),
    ]));
  });

  it("does not award a second XL breakdown contribution when the parent already has an open action child", async () => {
    const member = (await ctx.app.inject({ method: "POST", url: "/api/members", payload: { name: "Mira" } })).json();
    const headers = { [ACTIVITY_ACTOR_HEADER]: String(member.id) };
    const parent = await createTask({ title: "Keller entrümpeln", status: "actionable", size: "XL" });
    const firstChild = await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${parent.id}/children`,
      headers,
      payload: { title: "Regale sortieren" },
    });
    expect(firstChild.statusCode).toBe(201);
    const before = (ctx.handle.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM contribution_events WHERE reason = 'task_broken_down' AND entity_id = ?",
    ).get(parent.id) as { count: number }).count;
    expect(before).toBe(1);

    const batch = await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${parent.id}/children/batch`,
      headers,
      payload: {
        expectedRevision: parent.revision,
        steps: [{ title: "Werkzeug inventarisieren" }, { title: "Spenden sortieren" }],
      },
    });
    expect(batch.statusCode).toBe(201);
    const after = (ctx.handle.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM contribution_events WHERE reason = 'task_broken_down' AND entity_id = ?",
    ).get(parent.id) as { count: number }).count;
    expect(after).toBe(1);
  });

  it("recomputes next-action state after classifying a captured parent with a reference child", async () => {
    const member = (await ctx.app.inject({ method: "POST", url: "/api/members", payload: { name: "Mira" } })).json();
    const headers = { [ACTIVITY_ACTOR_HEADER]: String(member.id) };

    async function setup() {
      const project = await createProject({ title: "Keller", status: "backlog" });
      const parent = await createTask({ title: "Werkbank aufbauen", projectId: project.id, status: "captured" });
      const reference = await ctx.app.inject({
        method: "POST",
        url: `/api/tasks/${parent.id}/children`,
        headers,
        payload: { title: "Montageanleitung", kind: "reference" },
      });
      expect(reference.statusCode).toBe(201);
      return { project, parent, reference: reference.json() };
    }

    const single = await setup();
    const singleAction = await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${single.parent.id}/children`,
      headers,
      payload: { title: "Schrauben sortieren" },
    });
    expect(singleAction.statusCode).toBe(201);

    const batch = await setup();
    const batchAction = await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${batch.parent.id}/children/batch`,
      headers,
      payload: {
        expectedRevision: batch.parent.revision,
        steps: [{ title: "Schrauben sortieren" }],
      },
    });
    expect(batchAction.statusCode).toBe(201);
    expect(batchAction.json().parent).toMatchObject({ status: "actionable", needsClarification: false });

    async function outcome(projectId: number, parentId: number, referenceId: number, actionId: number) {
      const parent = (await ctx.app.inject({
        method: "GET",
        url: `/api/tasks/${parentId}`,
        headers,
      })).json();
      return {
        project: (await ctx.app.inject({ method: "GET", url: `/api/projects/${projectId}`, headers })).json().status,
        parent: { status: parent.status, needsClarification: parent.needsClarification },
        children: parent.children.map((child: { title: string; kind: string; status: string; position: number }) => ({
          title: child.title,
          kind: child.kind,
          status: child.status,
          position: child.position,
        })),
        records: mutationRecords([projectId, parentId, referenceId, actionId]),
      };
    }
    const singleOutcome = await outcome(single.project.id, single.parent.id, single.reference.id, singleAction.json().id);
    const batchOutcome = await outcome(
      batch.project.id,
      batch.parent.id,
      batch.reference.id,
      batchAction.json().tasks[0].id,
    );
    expect(batchOutcome).toEqual(singleOutcome);
    expect(batchOutcome.records.contributions).toEqual([]);
  });

  it("matches canonical next-action and due-plan contribution transitions across a batch", async () => {
    const member = (await ctx.app.inject({ method: "POST", url: "/api/members", payload: { name: "Mira" } })).json();
    const headers = { [ACTIVITY_ACTOR_HEADER]: String(member.id) };

    async function setup(title: string) {
      const project = await createProject({ title, status: "backlog" });
      const parent = await createTask({ title: "Fenster austauschen", projectId: project.id, status: "someday" });
      return { project, parent };
    }
    const single = await setup("Fensterprojekt");
    const firstSingle = await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${single.parent.id}/children`,
      headers,
      payload: { title: "Material sichten" },
    });
    expect(firstSingle.statusCode).toBe(201);
    expect(firstSingle.json().status).toBe("someday");

    const committedSinglePayload = { title: "Termin setzen", scheduledDate: "2027-01-15" };
    const committedSingle = await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${single.parent.id}/children`,
      headers,
      payload: committedSinglePayload,
    });
    expect(committedSingle.statusCode).toBe(201);
    const lastSingle = await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${single.parent.id}/children`,
      headers,
      payload: { title: "Angebote vergleichen", dueDate: "2027-01-16" },
    });
    expect(lastSingle.statusCode).toBe(201);

    const batch = await setup("Fensterprojekt");
    const batchPayload = {
      expectedRevision: batch.parent.revision,
      steps: [
        { title: "Material sichten" },
        { title: "Termin setzen", scheduledDate: "2027-01-15" },
        { title: "Angebote vergleichen", dueDate: "2027-01-16" },
      ],
    };
    const committedBatch = await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${batch.parent.id}/children/batch`,
      headers,
      payload: batchPayload,
    });
    expect(committedBatch.statusCode).toBe(201);

    async function outcome(projectId: number, parentId: number, childIds: number[]) {
      const [projectResponse, parentResponse] = await Promise.all([
        ctx.app.inject({ method: "GET", url: `/api/projects/${projectId}`, headers }),
        ctx.app.inject({ method: "GET", url: `/api/tasks/${parentId}`, headers }),
      ]);
      const parent = parentResponse.json();
      return {
        projectStatus: projectResponse.json().status,
        parentStatus: parent.status,
        children: parent.children.map((child: {
          title: string;
          status: string;
          dueDate: string | null;
          scheduledDate: string | null;
          position: number;
        }) => ({
          title: child.title,
          status: child.status,
          dueDate: child.dueDate,
          scheduledDate: child.scheduledDate,
          position: child.position,
        })),
        records: mutationRecords([projectId, parentId, ...childIds]),
      };
    }

    const singleOutcome = await outcome(single.project.id, single.parent.id, [
      firstSingle.json().id,
      committedSingle.json().id,
      lastSingle.json().id,
    ]);
    const batchOutcome = await outcome(batch.project.id, batch.parent.id, [
      ...committedBatch.json().tasks.map((task: { id: number }) => task.id),
    ]);
    expect(batchOutcome).toEqual(singleOutcome);
    expect(batchOutcome.projectStatus).toBe("backlog");
    expect(batchOutcome.parentStatus).toBe("someday");
    expect(batchOutcome.records.contributions).not.toContainEqual(expect.objectContaining({
      reason: "project_next_action_added",
    }));
    expect(batchOutcome.records.contributions).not.toContainEqual(expect.objectContaining({
      reason: "project_due_plan_added",
    }));
  });

  it("matches the due-plan contribution when an existing task already supplies the next action", async () => {
    const member = (await ctx.app.inject({ method: "POST", url: "/api/members", payload: { name: "Mira" } })).json();
    const headers = { [ACTIVITY_ACTOR_HEADER]: String(member.id) };

    async function setup() {
      const project = await createProject({
        title: "Kellerboden",
        status: "backlog",
      });
      const existingAction = await createTask({ title: "Laufende Aufgabe", projectId: project.id, status: "actionable" });
      const parent = await createTask({
        title: "Späteres Vorhaben",
        projectId: project.id,
        status: "actionable",
      });
      ctx.handle.sqlite.prepare("UPDATE work_items SET status = 'active', owner_member_id = ? WHERE id = ?").run(member.id, project.id);
      const planned = await ctx.app.inject({
        method: "PATCH",
        url: `/api/projects/${project.id}`,
        headers,
        payload: { dueDate: "2027-12-31", expectedRevision: project.revision },
      });
      expect(planned.statusCode, planned.body).toBe(200);
      return { project, existingAction, parent };
    }
    const single = await setup();
    const firstSingle = await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${single.parent.id}/children`,
      headers,
      payload: { title: "Notizen sammeln" },
    });
    expect(firstSingle.statusCode, firstSingle.body).toBe(201);
    const scheduledSingle = await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${single.parent.id}/children`,
      headers,
      payload: { title: "Termin vormerken", scheduledDate: "2027-02-20" },
    });
    expect(scheduledSingle.statusCode, scheduledSingle.body).toBe(201);

    const batch = await setup();
    const batchPayload = {
      expectedRevision: batch.parent.revision,
      steps: [{ title: "Notizen sammeln" }, { title: "Termin vormerken", scheduledDate: "2027-02-20" }],
    };
    const scheduledBatch = await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${batch.parent.id}/children/batch`,
      headers,
      payload: batchPayload,
    });
    expect(scheduledBatch.statusCode, scheduledBatch.body).toBe(201);

    async function outcome(projectId: number, parentId: number, existingId: number, childIds: number[]) {
      const parent = (await ctx.app.inject({
        method: "GET",
        url: `/api/tasks/${parentId}`,
        headers,
      })).json();
      return {
        project: (await ctx.app.inject({ method: "GET", url: `/api/projects/${projectId}`, headers })).json().status,
        parentStatus: parent.status,
        children: parent.children.map((child: { title: string; status: string; scheduledDate: string | null; position: number }) => ({
          title: child.title,
          status: child.status,
          scheduledDate: child.scheduledDate,
          position: child.position,
        })),
        records: mutationRecords([projectId, parentId, existingId, ...childIds]),
      };
    }
    const singleOutcome = await outcome(single.project.id, single.parent.id, single.existingAction.id, [
      firstSingle.json().id,
      scheduledSingle.json().id,
    ]);
    const batchOutcome = await outcome(
      batch.project.id,
      batch.parent.id,
      batch.existingAction.id,
      scheduledBatch.json().tasks.map((task: { id: number }) => task.id),
    );
    expect(batchOutcome).toEqual(singleOutcome);
    expect(batchOutcome.records.contributions).toContainEqual(expect.objectContaining({
      category: "planning",
      reason: "project_due_plan_added",
      entityType: "project",
    }));
    expect(batchOutcome.records.contributions).not.toContainEqual(expect.objectContaining({
      reason: "project_next_action_added",
    }));
  });

  it("matches the due-plan transition when the project already has a next action", async () => {
    const member = (await ctx.app.inject({ method: "POST", url: "/api/members", payload: { name: "Mira" } })).json();
    const headers = { [ACTIVITY_ACTOR_HEADER]: String(member.id) };

    async function setup() {
      const project = await createProject({
        title: "Kellerboden",
        status: "backlog",
      });
      const existingAction = await createTask({ title: "Laufende Aufgabe", projectId: project.id, status: "actionable" });
      const parent = await createTask({
        title: "Späteres Vorhaben",
        projectId: project.id,
        status: "actionable",
      });
      ctx.handle.sqlite.prepare("UPDATE work_items SET status = 'active', owner_member_id = ? WHERE id = ?").run(member.id, project.id);
      const planned = await ctx.app.inject({
        method: "PATCH",
        url: `/api/projects/${project.id}`,
        headers,
        payload: { dueDate: "2027-12-31", expectedRevision: project.revision },
      });
      expect(planned.statusCode, planned.body).toBe(200);
      return { project, existingAction, parent };
    }
    const single = await setup();
    const firstSingle = await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${single.parent.id}/children`,
      headers,
      payload: { title: "Notizen sammeln" },
    });
    expect(firstSingle.statusCode, firstSingle.body).toBe(201);
    const scheduledSingle = await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${single.parent.id}/children`,
      headers,
      payload: { title: "Termin vormerken", scheduledDate: "2027-02-20" },
    });
    expect(scheduledSingle.statusCode, scheduledSingle.body).toBe(201);

    const batch = await setup();
    const batchPayload = {
      expectedRevision: batch.parent.revision,
      steps: [{ title: "Notizen sammeln" }, { title: "Termin vormerken", scheduledDate: "2027-02-20" }],
    };
    const scheduledBatch = await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${batch.parent.id}/children/batch`,
      headers,
      payload: batchPayload,
    });
    expect(scheduledBatch.statusCode, scheduledBatch.body).toBe(201);

    const batchRecords = mutationRecords([
      batch.project.id,
      batch.existingAction.id,
      batch.parent.id,
      ...scheduledBatch.json().tasks.map((task: { id: number }) => task.id),
    ]);
    const singleRecords = mutationRecords([
      single.project.id,
      single.existingAction.id,
      single.parent.id,
      firstSingle.json().id,
      scheduledSingle.json().id,
    ]);
    expect(batchRecords).toEqual(singleRecords);
    expect(batchRecords.contributions).toContainEqual(expect.objectContaining({
      category: "planning",
      reason: "project_due_plan_added",
      entityType: "project",
    }));
    expect(batchRecords.contributions).not.toContainEqual(expect.objectContaining({
      reason: "project_next_action_added",
    }));
  });

  it("gives XL breakdown credit to the first eligible child before project planning credit", async () => {
    const member = (await ctx.app.inject({ method: "POST", url: "/api/members", payload: { name: "Mira" } })).json();
    const headers = { [ACTIVITY_ACTOR_HEADER]: String(member.id) };
    const project = await createProject({ title: "Dachfenster", status: "backlog" });
    const parent = await createTask({
      title: "Dachfenster renovieren",
      projectId: project.id,
      status: "someday",
      size: "XL",
    });
    const reference = await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${parent.id}/children`,
      headers,
      payload: { title: "Montageanleitung", kind: "reference" },
    });
    expect(reference.statusCode).toBe(201);

    const payload = {
      expectedRevision: parent.revision,
      steps: [
        { title: "Termin vereinbaren", scheduledDate: "2027-03-12" },
        { title: "Werkzeug bereitlegen" },
      ],
    };
    const applied = await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${parent.id}/children/batch`,
      headers,
      payload,
    });
    expect(applied.statusCode).toBe(201);
    expect((await ctx.app.inject({ method: "GET", url: `/api/projects/${project.id}`, headers })).json().status).toBe("backlog");

    const contributions = ctx.handle.sqlite.prepare(`
      SELECT activity.entity_title AS title, contribution.reason AS reason
      FROM contribution_events contribution
      JOIN activity_events activity ON activity.id = contribution.activity_event_id
      WHERE contribution.entity_id = ? AND contribution.entity_type = 'task'
      ORDER BY contribution.id
    `).all(parent.id);
    expect(contributions).toEqual([{ title: "Termin vereinbaren", reason: "task_broken_down" }]);
  });

  it("leaves a Someday parent parked when the batch has no execution commitment", async () => {
    const parent = await createTask({ title: "Irgendwann Dachboden", status: "someday" });
    const response = await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${parent.id}/children/batch`,
      payload: { expectedRevision: parent.revision, steps: [{ title: "Kisten sichten" }] },
    });

    expect(response.statusCode).toBe(201);
    const updatedParent = (await ctx.app.inject({ method: "GET", url: `/api/tasks/${parent.id}` })).json();
    expect(updatedParent.status).toBe("someday");
    expect(updatedParent.children).toMatchObject([{ title: "Kisten sichten", status: "someday" }]);
    const agenda = await ctx.app.inject({ method: "GET", url: "/api/agenda/today?scope=all&date=2026-10-12" });
    expect(JSON.stringify(agenda.json())).not.toContain("Irgendwann Dachboden");
    expect(JSON.stringify(agenda.json())).not.toContain("Kisten sichten");

    const committed = await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${parent.id}/children/batch`,
      payload: {
        expectedRevision: response.json().parent.revision,
        steps: [{ title: "Kisten sortieren", scheduledDate: "2027-01-15" }],
      },
    });
    expect(committed.statusCode).toBe(201);
    expect(committed.json().parent).toMatchObject({ status: "someday" });
    expect(committed.json().tasks).toMatchObject([{ status: "someday", scheduledDate: "2027-01-15" }]);
    const futureAgenda = await ctx.app.inject({ method: "GET", url: "/api/agenda/today?scope=all&date=2026-10-12" });
    expect(JSON.stringify(futureAgenda.json())).not.toContain("Irgendwann Dachboden");
    expect(JSON.stringify(futureAgenda.json())).not.toContain("Kisten sortieren");
  });

  it("classifies the first Inbox action child through every canonical create entry point", async () => {
    const viaGeneralCreate = await createTask({ title: "Posteingang A" });
    const viaGeneralChildCreate = await ctx.app.inject({
      method: "POST", url: "/api/tasks", payload: { title: "Erster Schritt A", parentTaskId: viaGeneralCreate.id },
    });
    expect(viaGeneralChildCreate.statusCode).toBe(201);
    expect((await ctx.app.inject({ method: "GET", url: `/api/tasks/${viaGeneralCreate.id}` })).json())
      .toMatchObject({ status: "actionable", needsClarification: false });

    const viaChildRoute = await createTask({ title: "Posteingang B" });
    const childRoute = await ctx.app.inject({
      method: "POST", url: `/api/tasks/${viaChildRoute.id}/children`, payload: { title: "Erster Schritt B" },
    });
    expect(childRoute.statusCode).toBe(201);
    expect((await ctx.app.inject({ method: "GET", url: `/api/tasks/${viaChildRoute.id}` })).json())
      .toMatchObject({ status: "actionable", needsClarification: false });

    const viaBatch = await createTask({ title: "Posteingang C" });
    const batch = await ctx.app.inject({
      method: "POST", url: `/api/tasks/${viaBatch.id}/children/batch`,
      payload: { expectedRevision: viaBatch.revision, steps: [{ title: "Erster Schritt C" }] },
    });
    expect(batch.statusCode).toBe(201);
    expect(batch.json().parent).toMatchObject({ status: "actionable", needsClarification: false });
  });

  it("rolls back first-child classification when the child is invalid", async () => {
    const parent = await createTask({ title: "Unvollständige Inbox-Aufgabe" });
    const response = await ctx.app.inject({
      method: "POST", url: "/api/tasks", payload: {
        title: "Ungültiges Kind", parentTaskId: parent.id, contextIds: [99999],
      },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("physical_context_not_found");
    expect((await ctx.app.inject({ method: "GET", url: `/api/tasks/${parent.id}` })).json())
      .toMatchObject({ status: "captured", needsClarification: true, children: [] });
  });

  it("creates a dated successor without activating the backlog project", async () => {
    const project = await createProject({ title: "Sommerfest", status: "backlog" });
    const predecessor = await createTask({ title: "Termin abstimmen", projectId: project.id, status: "actionable" });
    const payload = { title: "Angebot vergleichen", scheduledDate: "2027-03-12", status: "actionable" };

    const applied = await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${predecessor.id}/successors`,
      payload,
    });
    expect(applied.statusCode, applied.body).toBe(201);
    expect(applied.json()).toMatchObject({ title: "Angebot vergleichen", scheduledDate: "2027-03-12" });

    const updatedProject = (await ctx.app.inject({ method: "GET", url: `/api/projects/${project.id}` })).json();
    expect(updatedProject.status).toBe("backlog");
    expect(updatedProject.tasks.filter((task: { title: string }) => task.title === "Angebot vergleichen")).toHaveLength(1);
  });

  it("creates a dated batch without activating its backlog project", async () => {
    const project = await createProject({ title: "Dachfenster", status: "backlog" });
    const parent = await createTask({ title: "Dachfenster planen", projectId: project.id, status: "actionable" });
    const payload = {
      expectedRevision: parent.revision,
      steps: [
        { title: "Maße prüfen", scheduledDate: "2027-01-15" },
        { title: "Angebot vergleichen" },
      ],
    };

    const retry = await ctx.app.inject({
      method: "POST", url: `/api/tasks/${parent.id}/children/batch`, payload,
    });
    expect(retry.statusCode).toBe(201);
    expect(retry.json().tasks).toHaveLength(2);
    expect(retry.json().tasks[0]).toMatchObject({ title: "Maße prüfen", scheduledDate: "2027-01-15" });
    expect((await ctx.app.inject({ method: "GET", url: `/api/projects/${project.id}` })).json().status).toBe("backlog");
  });

  it("keeps earlier and final scheduled children without activating their project", async () => {
    const project = await createProject({ title: "Fenster", status: "backlog" });
    const parent = await createTask({
      title: "Fenster vorbereiten",
      projectId: project.id,
      status: "actionable",
    });
    const response = await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${parent.id}/children/batch`,
      payload: {
        expectedRevision: parent.revision,
        steps: [
          { title: "Maße notieren" },
          { title: "Termin planen", scheduledDate: "2027-02-11" },
        ],
      },
    });

    expect(response.statusCode).toBe(201);
    expect((await ctx.app.inject({ method: "GET", url: `/api/tasks/${parent.id}` })).json())
      .toMatchObject({ status: "actionable", children: [
        { title: "Maße notieren" },
        { title: "Termin planen", scheduledDate: "2027-02-11" },
      ] });
    expect((await ctx.app.inject({ method: "GET", url: `/api/projects/${project.id}` })).json().status).toBe("backlog");
  });

  it("rejects an invalid child in the submitted batch without creating earlier entries", async () => {
    const parent = await createTask({ title: "Projekt" });
    const response = await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${parent.id}/children/batch`,
      payload: {
        expectedRevision: parent.revision,
        steps: [{ title: "Gültig" }, { title: "Ungültiges Datum", dueDate: "morgen" }],
      },
    });

    expect(response.statusCode).toBe(400);
    expect((await ctx.app.inject({ method: "GET", url: `/api/tasks/${parent.id}` })).json().children).toHaveLength(0);
    expect((await ctx.app.inject({ method: "GET", url: `/api/tasks/${parent.id}` })).json().status).toBe("captured");
  });

  it("accepts a current parent revision after an ancestor edit without activating projects", async () => {
    const ancestor = await createProject({ title: "Umbau" });
    const destination = await createProject({ title: "Bad renovieren", parentId: ancestor.id });
    const parent = await createTask({ title: "Wand streichen", projectId: destination.id, status: "actionable" });
    const edit = await ctx.app.inject({ method: "PATCH", url: `/api/projects/${ancestor.id}`, payload: { notes: "Aktualisiert", expectedRevision: ancestor.revision } });
    expect(edit.statusCode).toBe(200);

    const response = await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${parent.id}/children/batch`,
      payload: {
        expectedRevision: parent.revision,
        steps: [{ title: "Kanten abkleben" }],
      },
    });
    expect(response.statusCode).toBe(201);
    expect((await ctx.app.inject({ method: "GET", url: `/api/tasks/${parent.id}` })).json().children).toMatchObject([{ title: "Kanten abkleben" }]);
    expect((await ctx.app.inject({ method: "GET", url: `/api/projects/${ancestor.id}` })).json()).toMatchObject({ status: "backlog", notes: "Aktualisiert", revision: edit.json().revision });
    expect((await ctx.app.inject({ method: "GET", url: `/api/projects/${destination.id}` })).json().status).toBe("backlog");
  });

  it("uses the same current archived-project behavior for single and batch children", async () => {
    const project = await createProject({ title: "Archiv" });
    const singleParent = await createTask({ title: "Einzelner Schritt", projectId: project.id, status: "actionable" });
    const batchParent = await createTask({ title: "Mehrere Schritte", projectId: project.id, status: "actionable" });
    const archived = await ctx.app.inject({
      method: "POST", url: `/api/projects/${project.id}/archive`,
      payload: { expectedRevision: project.revision },
    });
    expect(archived.statusCode, archived.body).toBe(200);
    const single = await ctx.app.inject({
      method: "POST", url: `/api/tasks/${singleParent.id}/children`,
      payload: { title: "Einzelkind" },
    });
    const batch = await ctx.app.inject({
      method: "POST", url: `/api/tasks/${batchParent.id}/children/batch`,
      payload: { expectedRevision: batchParent.revision, steps: [{ title: "Batchkind" }] },
    });
    expect(single.statusCode, single.body).toBe(201);
    expect(batch.statusCode, batch.body).toBe(201);
    expect(batch.json().tasks).toMatchObject([{ title: "Batchkind", status: single.json().status }]);
    expect((await ctx.app.inject({ method: "GET", url: `/api/projects/${project.id}` })).json())
      .toMatchObject({ status: "archived", revision: archived.json().revision });
  });

  it("rejects a batch from a viewer without parent access without writing children", async () => {
    const owner = (await ctx.app.inject({ method: "POST", url: "/api/members", payload: { name: "Owner" } })).json();
    const other = (await ctx.app.inject({ method: "POST", url: "/api/members", payload: { name: "Other" } })).json();
    const created = await ctx.app.inject({
      method: "POST", url: "/api/tasks",
      headers: { [ACTIVITY_ACTOR_HEADER]: String(owner.id) },
      payload: { title: "Private", scope: "work", ownerMemberId: owner.id, ownerInheritanceMode: "explicit", status: "actionable" },
    });
    expect(created.statusCode).toBe(201);
    const parent = created.json();
    const before = ctx.handle.sqlite.serialize();
    const denied = await ctx.app.inject({
      method: "POST", url: `/api/tasks/${parent.id}/children/batch`,
      headers: { [ACTIVITY_ACTOR_HEADER]: String(other.id) },
      payload: { expectedRevision: parent.revision, steps: [{ title: "Hidden child" }] },
    });
    expect(denied.statusCode).toBe(404);
    expect(ctx.handle.sqlite.serialize()).toEqual(before);
  });

  it("rejects a changed task parent and creates no children", async () => {
    const parent = await createTask({ title: "Angebot planen", status: "actionable" });
    await ctx.app.inject({ method: "PATCH", url: `/api/tasks/${parent.id}`, payload: { title: "Angebot planen lassen" } });
    const response = await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${parent.id}/children/batch`,
      payload: {
        expectedRevision: parent.revision,
        steps: [{ title: "Anbieter anrufen" }],
      },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("stale_write_conflict");
    expect((await ctx.app.inject({ method: "GET", url: `/api/tasks/${parent.id}` })).json()).toMatchObject({
      title: "Angebot planen lassen", children: [],
    });
  });

  it("uses the existing task-to-project conversion atomically when requested", async () => {
    const capture = await createTask({ title: "Kita-Platz" });
    const response = await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${capture.id}/children/batch`,
      payload: {
        expectedRevision: capture.revision,
        convertParentToProject: true,
        steps: [{ title: "Unterlagen zusammenstellen" }],
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().convertedProject).toMatchObject({ id: capture.id, title: "Kita-Platz", status: "backlog" });
    const project = await ctx.app.inject({ method: "GET", url: `/api/projects/${capture.id}` });
    expect(project.statusCode).toBe(200);
    expect(project.json().tasks.map((task: { title: string }) => task.title)).toEqual(["Unterlagen zusammenstellen"]);
  });

  it("preserves an external wait when converting a task before adding batch steps", async () => {
    const capture = await createTask({ title: "Versicherung anrufen", status: "actionable" });
    const withWait = await ctx.app.inject({ method: "PATCH", url: `/api/tasks/${capture.id}`, payload: { externalWait: { waitingFor: "Versicherung" } } });
    expect(withWait.statusCode).toBe(200);
    ctx.handle.sqlite.prepare("UPDATE work_items SET status = 'captured' WHERE id = ?").run(capture.id);
    const current = (await ctx.app.inject({ method: "GET", url: `/api/tasks/${capture.id}` })).json();
    const response = await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${capture.id}/children/batch`,
      payload: {
        expectedRevision: current.revision,
        convertParentToProject: true,
        steps: [{ title: "Rückruf vorbereiten" }],
      },
    });
    expect(response.statusCode).toBe(201);
    const project = (await ctx.app.inject({ method: "GET", url: `/api/projects/${capture.id}` })).json();
    expect(project.tasks.map((task: { title: string }) => task.title)).toEqual([
      capture.title,
      "Rückruf vorbereiten",
    ]);
    expect(project.tasks[0]).toMatchObject({ status: "captured", externalWait: { waitingFor: "Versicherung" } });
  });
});
