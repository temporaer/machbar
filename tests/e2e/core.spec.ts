import { test, expect, type Page } from "@playwright/test";
import { calendarDateForInstant, type ReviewItem } from "@machbar/shared";
import { randomUUID } from "node:crypto";

const pageErrors = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page, request }) => {
  const errors: string[] = []; pageErrors.set(page, errors);
  page.on("pageerror", error => errors.push(error.message));
  const result = await request.post("/api/members", { data: { name: `Browser ${randomUUID()}` } });
  expect(result.ok()).toBeTruthy();
  const member = await result.json();
  await page.addInitScript(id => {
    localStorage.setItem("machbar:identity-member-id", String(id));
    localStorage.setItem("machbar:locale", "de");
  }, member.id);
});
test.afterEach(async ({ page }) => { expect(pageErrors.get(page) ?? []).toEqual([]); });
async function task(page: Page, extra: object = {}) {
  const result = await page.request.post("/api/tasks", { data: { title: `Browser task ${randomUUID()}`, status: "actionable", ...extra } });
  expect(result.status()).toBe(201);
  return result.json();
}

test("detail completion control is visible on touch and desktop", async ({ page }) => {
  const item = await task(page);
  await page.goto(`/#/tasks/${item.id}`);
  const control = page.locator(".detail-complete-trigger");
  await expect(control).toBeVisible();
  const glyph = control.locator(".task-row-checkbox");
  await expect(glyph).toBeVisible();
  const bounds = await glyph.boundingBox();
  expect(bounds!.width).toBeGreaterThan(0);
  await control.click();
  await expect.poll(async () => (await (await page.request.get(`/api/tasks/${item.id}`)).json()).status).toBe("done");
});

test("attachment dialog returns focus to the stable actions trigger", async ({ page }) => {
  const item = await task(page);
  await page.goto(`/#/tasks/${item.id}`);
  const actions = page.getByRole("button", { name: "Aktionen", exact: true });
  await actions.click();
  await page.getByRole("button", { name: "Anhang hinzufügen", exact: true }).click();
  const dialog = page.getByRole("dialog").last();
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Schließen", exact: true }).click();
  await expect(actions).toBeFocused();
});

test("two real app sessions converge after another client saves", async ({ page, browser }) => {
  const item = await task(page);
  await page.goto(`/#/tasks/${item.id}`);
  await expect(page.getByRole("heading", { name: item.title, exact: true })).toBeVisible();
  const second = await browser.newContext();
  try {
    const other = await second.newPage();
    const member = await page.evaluate(() => localStorage.getItem("machbar:identity-member-id"));
    await other.addInitScript(id => { localStorage.setItem("machbar:identity-member-id", id!); localStorage.setItem("machbar:locale", "de"); }, member);
    await other.goto(`http://127.0.0.1:4173/#/tasks/${item.id}`);
    await expect(other.getByRole("heading", { name: item.title, exact: true })).toBeVisible();
    const changed = `Changed in another session ${randomUUID()}`;
    await other.evaluate(async ({ id, title, revision }) => {
      const response = await fetch(`/api/tasks/${id}`, { method: "PATCH", headers: { "content-type": "application/json", "x-machbar-client-id": "other-session" }, body: JSON.stringify({ title, expectedRevision: revision }) });
      if (!response.ok) throw new Error(await response.text());
    }, { id: item.id, title: changed, revision: item.revision });
    await expect(page.getByRole("heading", { name: changed, exact: true })).toBeVisible({ timeout: 10000 });
    await expect(other.getByRole("heading", { name: changed, exact: true })).toBeVisible();
    const stale = await page.request.patch(`/api/tasks/${item.id}`, { data: { title: "Stale", expectedRevision: item.revision } });
    expect(stale.status()).toBe(409);
    await page.context().setOffline(true);
    const current = await (await other.request.get(`/api/tasks/${item.id}`)).json();
    const afterReconnect = `Saved while disconnected ${randomUUID()}`;
    expect((await other.request.patch(`/api/tasks/${item.id}`, { data: { title: afterReconnect, expectedRevision: current.revision } })).ok()).toBeTruthy();
    await expect(page.getByRole("heading", { name: changed, exact: true })).toBeVisible();
    await page.context().setOffline(false);
    await expect(page.getByRole("heading", { name: afterReconnect, exact: true })).toBeVisible({ timeout: 10000 });
  } finally { await second.close(); }
});

test("Discussion renders real tasks/projects and live changes", async ({ page }) => {
  let item = await task(page);
  item = await (await page.request.patch(`/api/tasks/${item.id}`, { data: { discussionRequested: true, expectedRevision: item.revision } })).json();
  const response = await page.request.post("/api/projects", { data: { title: `Discussion project ${randomUUID()}`, discussionRequested: true } });
  expect(response.ok()).toBeTruthy();
  let project = await response.json();
  project = await (await page.request.patch(`/api/projects/${project.id}`, { data: { discussionRequested: true, expectedRevision: project.revision } })).json();
  await page.goto("/#/more/discussion");
  await expect(page.getByRole("button", { name: item.title, exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: new RegExp(project.title) })).toBeVisible();
  await page.request.patch(`/api/tasks/${item.id}`, { data: { discussionRequested: false, expectedRevision: item.revision } });
  await expect(page.getByRole("button", { name: item.title, exact: true })).toHaveCount(0);
});

test("a real service worker activates and controls a reloaded app", async ({ page }) => {
  await page.goto("/#/today");
  const result = await page.evaluate(async () => {
    await navigator.serviceWorker.register("/sw.js", { type: "module" });
    const registration = await navigator.serviceWorker.ready;
    return { active: registration.active?.state, scope: registration.scope };
  });
  expect(result.active).toBe("activated");
  await page.reload();
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
  await expect(page.getByRole("main")).toBeVisible();
});

for (const kind of ["task", "project"] as const) {
  test(`${kind} form retries its own lost creation response`, async ({ page }) => {
    const path = kind === "task" ? "/api/tasks" : "/api/projects";
    let dropped = false;
    let committedId: number | undefined;
    await page.route(`**${path}`, async route => {
      if (route.request().method() !== "POST" || dropped) { await route.continue(); return; }
      const response = await route.fetch();
      expect(response.status()).toBe(201);
      committedId = (await response.json()).id;
      dropped = true;
      await route.abort("failed");
    });
    await page.goto(kind === "task" ? "/#/inbox" : "/#/projects");
    await page.getByRole("button", { name: kind === "task" ? "Schnell hinzufügen" : "Projekt anlegen", exact: true }).click();
    const dialog = page.getByRole("dialog").last();
    const title = `Lost ${kind} response ${randomUUID()}`;
    await (kind === "task" ? dialog.locator("#capture-title") : dialog.getByLabel("Projekttitel")).fill(title);
    const save = dialog.getByRole("button", { name: kind === "task" ? "Erstellen" : "Projekt anlegen", exact: true });
    await save.click();
    await expect.poll(() => dropped).toBe(true);
    await expect(save).toBeEnabled();
    const retried = page.waitForResponse(response => response.url().endsWith(path) && response.request().method() === "POST");
    await save.click();
    const response = await retried;
    expect(response.status()).toBe(200);
    expect((await response.json()).id).toBe(committedId);
    if (kind === "project") await expect(page).toHaveURL(new RegExp(`#/projects/${committedId}$`));
    else await expect(dialog.locator("#capture-title")).toHaveValue("");
    const rows = await (await page.request.get(kind === "task" ? "/api/inbox?scope=all" : "/api/projects")).json();
    expect(rows.filter((row: { title: string }) => row.title === title)).toHaveLength(1);
  });
}

test("Quick Add puts full-width Create before the preserved capture alternatives", async ({ page }, testInfo) => {
  await page.goto("/#/inbox");
  await page.getByRole("button", { name: "Schnell hinzufügen", exact: true }).click();
  const dialog = page.getByRole("dialog").last();
  const title = `Simple capture ${randomUUID()}`;
  const input = dialog.locator("#capture-title");
  await input.fill(title);
  const create = dialog.getByRole("button", { name: "Erstellen", exact: true });
  const cancel = dialog.getByRole("button", { name: "Abbrechen", exact: true });
  const process = dialog.getByRole("button", { name: "Verarbeiten", exact: true });
  const photo = dialog.getByRole("button", { name: "Foto erfassen", exact: true });
  const file = dialog.getByRole("button", { name: "Datei erfassen", exact: true });
  for (const control of [create, cancel, process, photo, file]) await expect(control).toBeVisible();
  const createBounds = (await create.boundingBox())!;
  const inputBounds = (await input.boundingBox())!;
  expect(createBounds.width).toBeGreaterThanOrEqual(inputBounds.width - 2);
  expect(createBounds.y).toBeLessThan((await cancel.boundingBox())!.y);
  expect(createBounds.y).toBeLessThan((await process.boundingBox())!.y);
  expect((await process.boundingBox())!.y).toBeLessThan((await photo.boundingBox())!.y);
  await page.screenshot({ path: testInfo.outputPath("capture-hierarchy.png") });
  await create.click();
  await expect(input).toHaveValue("");
  await expect(dialog.getByRole("button", { name: "Öffnen", exact: true })).toBeVisible();
  const inbox = await (await page.request.get("/api/inbox?scope=all")).json();
  expect(inbox.filter((item: { title: string }) => item.title === title)).toHaveLength(1);
});

test("project task entry precedes context and returns focus after an atomic batch", async ({ page }, testInfo) => {
  const title = `Project flow ${randomUUID()}`;
  const response = await page.request.post("/api/projects", {
    data: { title, notes: "Measure first; keep these constraints before the task outline." },
  });
  expect(response.status()).toBe(201);
  const project = await response.json();
  await page.goto(`/#/projects/${project.id}`);
  const add = page.getByRole("button", { name: "Aufgaben hinzufügen", exact: true });
  await expect(add).toHaveCount(1);
  await expect(add).toBeVisible();
  const notes = page.getByRole("heading", { name: "Notizen", exact: true });
  expect((await add.boundingBox())!.y).toBeLessThan((await notes.boundingBox())!.y);
  await page.screenshot({ path: testInfo.outputPath("project-entry.png") });
  await add.click();
  const dialog = page.getByRole("dialog").last();
  await dialog.getByPlaceholder("Schritt …").nth(0).fill("Measure the available space");
  await dialog.getByPlaceholder("Schritt …").nth(1).fill("Prepare the materials");
  await dialog.getByRole("button", { name: "2 Aufgaben hinzufügen", exact: true }).click();
  await expect(dialog.getByText("Measure the available space", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Schließen", exact: true }).last().click();
  await expect(add).toBeFocused();
  const stored = await (await page.request.get(`/api/projects/${project.id}`)).json();
  expect(stored.status).toBe("backlog");
  expect(stored.tasks.map((item: { title: string }) => item.title)).toEqual([
    "Measure the available space", "Prepare the materials",
  ]);
});

test("captured work opens the existing subtask composer without choosing a project", async ({ page }, testInfo) => {
  const item = await task(page, { status: "captured" });
  await page.goto(`/#/tasks/${item.id}`);
  const add = page.getByRole("button", { name: "Teilaufgaben hinzufügen", exact: true });
  await expect(add).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("capture-subtasks.png") });
  await add.click();
  const dialog = page.getByRole("dialog").last();
  await expect(dialog.getByRole("checkbox", { name: "Als Projekt behandeln", exact: true })).not.toBeChecked();
  await dialog.getByRole("button", { name: "Schließen", exact: true }).click();
  await expect(add).toBeFocused();
  await add.click();
  await dialog.getByPlaceholder("Schritt …").nth(0).fill("First known step");
  await dialog.getByPlaceholder("Schritt …").nth(1).fill("Second known step");
  await dialog.getByRole("button", { name: "2 Teilaufgaben anlegen", exact: true }).click();
  await expect.poll(async () => {
    const stored = await (await page.request.get(`/api/tasks/${item.id}`)).json();
    return { status: stored.status, children: stored.children.map((child: { title: string }) => child.title) };
  }).toEqual({ status: "actionable", children: ["First known step", "Second known step"] });
  await dialog.getByRole("button", { name: "Schließen", exact: true }).click();
  await expect(page.locator(".detail-complete-trigger")).toBeFocused();
});

test("waiting is directly reachable and revisit precedes the single follow-up commit", async ({ page }, testInfo) => {
  const item = await task(page);
  await page.goto(`/#/tasks/${item.id}`);
  const start = page.getByRole("button", { name: "Wartet auf …", exact: true });
  await start.click();
  let dialog = page.getByRole("dialog", { name: "Planung", exact: true });
  await expect(dialog.getByLabel("Wartet auf", { exact: true })).toBeVisible();
  await dialog.getByLabel("Wartet auf", { exact: true }).fill("Unsaved wait");
  await dialog.getByRole("button", { name: "Abbrechen", exact: true }).click();
  await expect(start).toBeFocused();
  expect((await (await page.request.get(`/api/tasks/${item.id}`)).json()).externalWait).toBeNull();

  const response = await page.request.put(`/api/tasks/${item.id}/external-wait`, {
    data: { expectedRevision: item.revision, waitingFor: "Supplier response", revisitDate: "2099-05-01" },
  });
  expect(response.ok()).toBeTruthy();
  await page.reload();
  await page.getByRole("button", { name: /Wartet auf.*Supplier response/ }).click();
  dialog = page.getByRole("dialog", { name: "Planung", exact: true });
  const revisit = dialog.locator(".task-planning-inline-hint").filter({ hasText: "Erst wieder anzeigen ab" });
  const followUp = dialog.getByRole("button", { name: "Rückmeldung speichern", exact: true });
  await expect(revisit).toBeVisible();
  expect((await revisit.boundingBox())!.y).toBeLessThan((await followUp.boundingBox())!.y);
  await page.screenshot({ path: testInfo.outputPath("follow-up-order.png") });
  await dialog.getByLabel("Was ist passiert?", { exact: true }).fill("Supplier confirmed the new delivery window.");
  await revisit.getByRole("button", { name: "Bearbeiten", exact: true }).click();
  const date = dialog.locator(`#planning-availability-date-${item.id}`);
  await date.fill("10.05.2099");
  await date.press("Tab");
  const committed = page.waitForResponse(result => result.url().endsWith(`/api/tasks/${item.id}/external-wait/follow-up`) && result.request().method() === "POST");
  await followUp.click();
  expect((await committed).ok()).toBeTruthy();
  await expect(dialog).not.toBeVisible();
  const stored = await (await page.request.get(`/api/tasks/${item.id}`)).json();
  const { timezone } = await (await page.request.get("/api/settings/household")).json();
  expect(calendarDateForInstant(stored.revisitAt, timezone)).toBe("2099-05-10");
  expect(stored.externalWait.waitingFor).toBe("Supplier response");
  expect(stored.notes).toContain("Supplier confirmed the new delivery window.");
});

test("Review keeps one routine inspection, explicit Keep and a separate repair", async ({ page }) => {
  const title = `Routine project ${randomUUID()}`;
  const response = await page.request.post("/api/projects", { data: { title } });
  expect(response.status()).toBe(201);
  const project = await response.json();
  const repairTask = await task(page, { size: "XL" });
  const routineItem: ReviewItem = {
    entityType: "project",
    entityId: project.id,
    entityTitle: title,
    projectId: project.id,
    projectTitle: title,
    category: "reconsider",
    reason: "backlog_stale",
    suggestedAction: { code: "review_project" },
  };
  // Only the age-triggered card is injected; repairs, details and mutations use the real API.
  await page.route("**/api/review", async route => {
    const response = await route.fetch();
    const items = await response.json();
    await route.fulfill({
      response,
      json: [...items, routineItem],
    });
  });
  await page.goto("/#/more/review");
  const routine = page.locator("article.review-item").filter({ hasText: title });
  await expect(routine.getByRole("button", { name: "Details öffnen", exact: true })).toHaveCount(1);
  await expect(routine.getByRole("button", { name: "So beibehalten", exact: true })).toBeVisible();
  const repair = page.locator("article.review-item").filter({ hasText: repairTask.title });
  await expect(repair.getByRole("button", { name: "Teilaufgabe hinzufügen", exact: true })).toBeVisible();
  await expect(repair.getByRole("button", { name: "Details öffnen", exact: true })).toBeVisible();
  await routine.getByRole("button", { name: "Details öffnen", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`#/projects/${project.id}$`));
  await page.getByRole("link", { name: "← Review", exact: true }).click();
  await expect(routine).toBeFocused();
  expect((await (await page.request.get(`/api/projects/${project.id}`)).json()).reviewedAt).toBeNull();
});
