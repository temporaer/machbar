import { test, expect, type Page } from "@playwright/test";
import { calendarDateForInstant } from "@machbar/shared";
import { randomUUID } from "node:crypto";

const pageErrors = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page, request }) => {
  const errors: string[] = [];
  pageErrors.set(page, errors);
  page.on("pageerror", error => errors.push(error.message));
  const response = await request.post("/api/members", { data: { name: `Recovery ${randomUUID()}` } });
  expect(response.status()).toBe(201);
  const member = await response.json();
  await page.addInitScript(id => {
    localStorage.setItem("machbar:identity-member-id", String(id));
    localStorage.setItem("machbar:locale", "de");
  }, member.id);
});
test.afterEach(async ({ page }) => expect(pageErrors.get(page) ?? []).toEqual([]));

async function createTask(page: Page, extra: object = {}) {
  const response = await page.request.post("/api/tasks", {
    data: { title: `Recovery task ${randomUUID()}`, status: "actionable", ...extra },
  });
  expect(response.status()).toBe(201);
  return response.json();
}

async function weekDates(page: Page, start: string) {
  const response = await page.request.get(`/api/agenda/week?start=${start}`);
  expect(response.ok()).toBeTruthy();
  const agenda: { days: Array<{ date: string }> } = await response.json();
  expect(agenda.days).toHaveLength(7);
  return agenda.days;
}

for (const oldStatus of [200, 503]) {
  test(`an obsolete dispatched Planning response ${oldStatus} cannot close its recovered same opening`, async ({ page }) => {
    const item = await createTask(page, { scheduledDate: "2030-12-01" });
    await page.goto(`/#/tasks/${item.id}`);
    await page.getByRole("button", { name: /^Geplant/ }).first().click();
    const planner = page.getByRole("dialog", { name: "Planung", exact: true });
    await planner.getByLabel("Geplant für", { exact: true }).fill("2030-12-05");
    await planner.getByLabel("Geplant für", { exact: true }).press("Tab");
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let dispatched = false;
    let denied = false;
    await page.route(`**/api/tasks/${item.id}`, async route => {
      if (route.request().method() === "PATCH") {
        const response = await route.fetch();
        expect(response.ok()).toBeTruthy();
        dispatched = true;
        await held;
        if (oldStatus === 200) await route.fulfill({ response });
        else await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { message: "Old response unavailable" } }) });
      } else if (denied) {
        await route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: { message: "Other read denied" } }) });
      } else await route.continue();
    });
    await planner.getByRole("button", { name: "Speichern", exact: true }).click();
    await expect.poll(() => dispatched).toBe(true);
    denied = true;
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(planner.getByLabel("Geplant für", { exact: true })).toHaveCount(0);
    denied = false;
    await planner.getByRole("button", { name: "Erneut versuchen", exact: true }).click();
    const recovered = planner.getByLabel("Geplant für", { exact: true });
    await expect(recovered).toBeVisible();
    await recovered.fill("2030-12-09");
    await recovered.press("Tab");
    await recovered.evaluate(element => element.setAttribute("data-recovery-node", "recovered"));
    const settled = page.waitForResponse(response => response.url().endsWith(`/api/tasks/${item.id}`) && response.request().method() === "PATCH");
    release();
    await settled;
    await expect(recovered).toHaveAttribute("data-recovery-node", "recovered");
    await expect(recovered).toHaveValue("09.12.2030");
    await expect(planner).toBeVisible();
    await planner.getByRole("button", { name: "Abbrechen", exact: true }).click();
    await expect(planner).toHaveCount(0);
  });
}

test("Deadline recovers unavailable activation requirements without losing choices or auto-saving", async ({ page }) => {
  const created = await page.request.post("/api/projects", { data: { title: `Deadline recovery ${randomUUID()}` } });
  expect(created.status()).toBe(201);
  const project = await created.json();
  await page.goto(`/#/projects/${project.id}`);
  await page.getByRole("button", { name: "+ Deadline hinzufügen", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "Projekt-Deadline", exact: true });
  await sheet.getByLabel("Fällig", { exact: true }).fill("2030-12-15");
  await sheet.getByLabel("Fällig", { exact: true }).press("Enter");
  const driver = sheet.getByLabel(`Verantwortlich für „${project.title}“`);
  await expect(driver).toBeVisible();
  await driver.selectOption({ index: 1 });
  const chosenDriver = await driver.inputValue();
  const next = sheet.getByLabel("Welcher konkrete nächste Schritt bringt das Projekt voran?");
  await next.fill("Keep deadline recovery choices");
  const changed = await page.request.patch(`/api/projects/${project.id}`, { data: { expectedRevision: project.revision, notes: "New real revision" } });
  expect(changed.ok()).toBeTruthy();
  const latest = await changed.json();
  let offline = true;
  const patches: Array<Record<string, unknown>> = [];
  await page.route(`**/api/projects/${project.id}`, async route => {
    if (route.request().method() === "GET" && offline) {
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { message: "Requirements unavailable" } }) });
    } else {
      if (route.request().method() === "PATCH") patches.push(route.request().postDataJSON());
      await route.continue();
    }
  });
  await sheet.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect(sheet.getByRole("button", { name: "Speichern", exact: true })).toBeDisabled();
  const retry = sheet.getByRole("button", { name: "Erneut versuchen", exact: true });
  await expect(retry).toBeVisible();
  offline = false;
  await retry.click();
  await expect(next).toHaveValue("Keep deadline recovery choices");
  await expect(driver).toHaveValue(chosenDriver);
  await expect(sheet.getByLabel("Fällig", { exact: true })).toHaveValue("15.12.2030");
  expect(patches).toHaveLength(1);
  await sheet.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect.poll(() => patches.length).toBe(2);
  expect(patches[1]).toMatchObject({ expectedRevision: latest.revision, activationResolution: {
    nextActionTitle: "Keep deadline recovery choices",
    expectedProjects: [{ projectId: project.id, revision: latest.revision }],
  } });
  await expect.poll(async () => (await (await page.request.get(`/api/projects/${project.id}`)).json()).dueDate).toBe("2030-12-15");
});

test("Move keeps its destination selection and provides a GET-only retry after another reader denies it", async ({ page }) => {
  const created = await page.request.post("/api/projects", { data: { title: `Move recovery ${randomUUID()}` } });
  expect(created.status()).toBe(201);
  const project = await created.json();
  const item = await createTask(page, { projectId: project.id });
  await page.goto(`/#/projects/${project.id}`);
  await page.getByRole("button", { name: item.title, exact: true }).click();
  await page.getByRole("dialog", { name: "Details", exact: true }).getByRole("button", { name: "Aktionen", exact: true }).click();
  await page.getByRole("dialog", { name: "Aktionen", exact: true }).getByRole("button", { name: "Struktur ändern", exact: true }).click();
  await page.getByRole("dialog").last().getByRole("button", { name: "Verschieben …", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "In anderes Projekt verschieben", exact: true });
  const move = sheet.getByRole("button", { name: "Hierher verschieben", exact: true });
  await expect(move).toBeEnabled();
  let denied = true;
  let commands = 0;
  await page.route(`**/api/projects/${project.id}`, async route => {
    if (denied) await route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: { message: "Destination denied" } }) });
    else await route.continue();
  });
  await page.route(`**/api/tasks/${item.id}/move`, async route => { commands += 1; await route.continue(); });
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(move).toBeDisabled();
  await expect(sheet.getByRole("alert")).toBeVisible();
  await expect(sheet.getByRole("button", { name: project.title, exact: true })).toHaveAttribute("aria-pressed", "true");
  denied = false;
  await sheet.getByRole("button", { name: "Erneut versuchen", exact: true }).click();
  await expect(move).toBeEnabled();
  await expect(sheet.getByRole("button", { name: project.title, exact: true })).toHaveAttribute("aria-pressed", "true");
  expect(commands).toBe(0);
  await sheet.getByRole("button", { name: "Abbrechen", exact: true }).click();
});

test("Planning retries an advanced real revision without losing its draft, save error or recovered wait/dependency state", async ({ page }, testInfo) => {
  const item = await createTask(page, { scheduledDate: "2030-12-01" });
  const prerequisite = await createTask(page);
  await page.goto(`/#/tasks/${item.id}`);
  await page.getByRole("button", { name: /^Geplant/ }).first().click();
  const planner = page.getByRole("dialog", { name: "Planung", exact: true });
  const editor = planner.getByLabel("Geplant für", { exact: true });
  await editor.fill("2030-12-05");
  await editor.press("Tab");
  await editor.evaluate(element => element.setAttribute("data-recovery-node", "original"));
  let offline = true;
  const patches: Array<Record<string, unknown>> = [];
  await page.route(`**/api/tasks/${item.id}`, async route => {
    if (route.request().method() === "PATCH") {
      patches.push(route.request().postDataJSON());
      if (offline) { await route.abort("failed"); return; }
    } else if (offline) { await route.abort("failed"); return; }
    await route.continue();
  });
  await planner.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect(planner.getByRole("alert")).toBeVisible();
  const saveError = await planner.getByRole("alert").textContent();
  const changed = await page.request.patch(`/api/tasks/${item.id}`, {
    data: { expectedRevision: item.revision, externalWait: { waitingFor: "Recovered browser wait" } },
  });
  expect(changed.ok()).toBeTruthy();
  const changedTask = await changed.json();
  const added = await page.request.post(`/api/tasks/${item.id}/dependencies`, {
    data: { expectedRevision: changedTask.revision, dependsOnTaskId: prerequisite.id },
  });
  expect(added.ok()).toBeTruthy();
  const recovered = await added.json();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  const retry = planner.getByRole("button", { name: "Erneut versuchen", exact: true });
  await expect(retry).toBeVisible();
  offline = false;
  await retry.click();
  await expect(retry).toHaveCount(0);
  await expect(editor).toHaveAttribute("data-recovery-node", "original");
  await expect(editor).toHaveValue("05.12.2030");
  await expect(planner.getByRole("alert")).toHaveText(saveError!);
  await expect(planner.getByText("Recovered browser wait", { exact: true })).toBeVisible();
  await planner.locator('section:has([id^="planning-prerequisites"]) .task-planning-summary button').click();
  await expect(planner.getByRole("button", { name: prerequisite.title, exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("advanced-planning-recovery.png") });
  await planner.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect(planner).toHaveCount(0);
  expect(patches.at(-1)).toMatchObject({ expectedRevision: recovered.revision, scheduledDate: "2030-12-05" });
  expect(patches.at(-1)).not.toHaveProperty("externalWait");
  const stored = await (await page.request.get(`/api/tasks/${item.id}`)).json();
  expect(stored.externalWait.waitingFor).toBe("Recovered browser wait");
  expect(stored.dependencies.map((value: { dependsOnTaskId: number }) => value.dependsOnTaskId)).toEqual([prerequisite.id]);
});

test("an unfinished reminder keeps its exact textbox, draft, disclosure and focus through a newer read", async ({ page }, testInfo) => {
  const item = await createTask(page);
  await page.goto(`/#/tasks/${item.id}`);
  await page.getByRole("button", { name: "Wartet auf …", exact: true }).click();
  const planner = page.getByRole("dialog", { name: "Planung", exact: true });
  await planner.locator('section:has([id^="planning-editor-reminders"]) .task-planning-summary button').click();
  const reminders = planner.locator('section:has([id^="planning-editor-reminders"])');
  const add = reminders.getByRole("button", { name: "+ Erinnerung", exact: true });
  if (await add.isVisible()) await add.click();
  await reminders.getByRole("button", { name: "Benutzerdefiniert …", exact: true }).click();
  const editor = reminders.getByLabel("Fällig", { exact: true });
  await editor.fill("noch kein Datum");
  await editor.evaluate(element => element.setAttribute("data-recovery-node", "original"));
  let offline = true;
  let patches = 0;
  await page.route(`**/api/tasks/${item.id}`, async route => {
    if (route.request().method() === "PATCH") patches += 1;
    if (offline) await route.abort("failed");
    else await route.continue();
  });
  const changed = await page.request.patch(`/api/tasks/${item.id}`, { data: { expectedRevision: item.revision, notes: "New server revision" } });
  expect(changed.ok()).toBeTruthy();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(planner.getByRole("alert")).toBeVisible();
  await expect(editor).toBeFocused();
  offline = false;
  await planner.getByRole("button", { name: "Erneut versuchen", exact: true }).click();
  await expect(planner.locator(".sheet-header-status").getByRole("alert")).toHaveCount(0);
  await expect(reminders.getByRole("alert")).toHaveText("Datum nicht erkannt");
  await expect(editor).toHaveAttribute("data-recovery-node", "original");
  await expect(editor).toHaveValue("noch kein Datum");
  await expect(editor).toBeVisible();
  await planner.getByRole("button", { name: "Speichern", exact: true }).click();
  expect(patches).toBe(0);
  await expect(editor).toHaveValue("noch kein Datum");
  await page.screenshot({ path: testInfo.outputPath("unfinished-reminder-recovery.png") });
});

test("another target reader's denial hides already rendered task detail and obsolete content stays hidden after recovery", async ({ page }, testInfo) => {
  const item = await createTask(page, { scheduledDate: "2030-12-01" });
  await page.goto(`/#/tasks/${item.id}`);
  const detail = page.getByRole("dialog", { name: "Details", exact: true });
  await expect(detail.getByRole("heading", { name: item.title, exact: true })).toBeVisible();
  let denied = true;
  await page.route(`**/api/tasks/${item.id}`, async route => {
    if (denied) await route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: { message: "Read denied" } }) });
    else await route.continue();
  });
  await detail.getByRole("button", { name: /^Geplant/ }).first().click();
  const planner = page.getByRole("dialog", { name: "Planung", exact: true });
  await expect(planner.getByRole("alert")).toBeVisible();
  await expect(detail.getByRole("heading", { name: item.title, exact: true, includeHidden: true })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("cross-reader-denial.png") });
  denied = false;
  await planner.getByRole("button", { name: "Erneut versuchen", exact: true }).click();
  await expect(planner.getByLabel("Geplant für", { exact: true })).toBeVisible();
  await expect(detail.getByRole("heading", { name: item.title, exact: true, includeHidden: true })).toHaveCount(0);
  await planner.getByRole("button", { name: "Abbrechen", exact: true }).click();
  await detail.getByRole("button", { name: "Erneut versuchen", exact: true }).click();
  await expect(detail.getByRole("heading", { name: item.title, exact: true })).toBeVisible();
});

test("a project workflow denial hides the already loaded project page until that page gets fresh authority", async ({ page }) => {
  const response = await page.request.post("/api/projects", { data: { title: `Private recovery project ${randomUUID()}` } });
  expect(response.status()).toBe(201);
  const item = await response.json();
  await page.goto(`/#/projects/${item.id}`);
  await expect(page.getByRole("heading", { name: item.title, exact: true })).toBeVisible();
  let denied = true;
  await page.route(`**/api/projects/${item.id}`, async route => {
    if (denied) await route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { message: "Read denied" } }) });
    else await route.continue();
  });
  await page.locator('[aria-label="Verantwortlich"] button').first().click();
  const workflow = page.getByRole("dialog");
  await expect(workflow.getByRole("alert")).toBeVisible();
  await expect(page.getByRole("heading", { name: item.title, exact: true, includeHidden: true })).toHaveCount(0);
  denied = false;
  await workflow.getByRole("button", { name: "Erneut versuchen", exact: true }).click();
  await expect(workflow).toHaveAccessibleName(`Verantwortliche Person zuweisen: ${item.title}`);
  await expect(page.getByRole("heading", { name: item.title, exact: true, includeHidden: true })).toHaveCount(0);
});

test("the real Shell receives focus when the last sheet closes with an unavailable opener", async ({ page }) => {
  await page.goto("/#/inbox");
  const opener = page.getByRole("button", { name: "Schnell hinzufügen", exact: true, includeHidden: true });
  await opener.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.locator("#capture-title")).toBeVisible();
  await opener.evaluate(element => {
    if (!(element instanceof HTMLButtonElement)) throw new Error("Expected a button opener");
    element.disabled = true;
  });
  await dialog.getByRole("button", { name: "Abbrechen", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("main")).toBeFocused();
});

test("ID-only planning recovers through a delayed GET and returns to its original opener", async ({ page }, testInfo) => {
  const item = await createTask(page);
  await page.goto(`/#/tasks/${item.id}`);
  const opener = page.getByRole("button", { name: "Wartet auf …", exact: true });
  await expect(opener).toBeVisible();
  let delaying = false;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let reads = 0;
  let writes = 0;
  page.on("request", request => {
    if (request.url().includes("/api/") && !["GET", "HEAD"].includes(request.method())) writes += 1;
  });
  await page.route(`**/api/tasks/${item.id}`, async route => {
    reads += 1;
    if (!delaying) { await route.abort("failed"); return; }
    await gate;
    await route.continue();
  });
  await opener.click();
  const dialog = page.getByRole("dialog", { name: "Planung", exact: true });
  await expect(dialog.getByRole("alert")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("workflow-read-recovery.png") });
  const readsBefore = reads;
  delaying = true;
  const retry = dialog.getByRole("button", { name: "Erneut versuchen", exact: true });
  await retry.click();
  await expect.poll(() => reads).toBe(readsBefore + 1);
  await expect(retry).toBeDisabled();
  await expect(dialog.getByRole("alert")).toBeVisible();
  release();
  await expect(dialog.getByLabel("Wartet auf", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await dialog.getByLabel("Wartet auf", { exact: true }).fill("Unsaved recovery draft");
  await dialog.getByRole("button", { name: "Abbrechen", exact: true }).click();
  await expect(opener).toBeFocused();
  expect(writes).toBe(0);
  const stored = await (await page.request.get(`/api/tasks/${item.id}`)).json();
  expect(stored.revision).toBe(item.revision);
  expect(stored.externalWait).toBeNull();
});

test("a usable planning editor keeps its draft and focus through background failure and retry", async ({ page }, testInfo) => {
  const item = await createTask(page);
  await page.goto(`/#/tasks/${item.id}`);
  await page.getByRole("button", { name: "Wartet auf …", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Planung", exact: true });
  const editor = dialog.getByLabel("Wartet auf", { exact: true });
  await editor.fill("Retained recovery draft");
  let failing = true;
  await page.route(`**/api/tasks/${item.id}`, async route => {
    if (failing) await route.abort("failed");
    else await route.continue();
  });
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(dialog.getByRole("alert")).toBeVisible();
  await expect(editor).toHaveValue("Retained recovery draft");
  await expect(editor).toBeFocused();
  await page.screenshot({ path: testInfo.outputPath("retained-workflow-warning.png") });
  failing = false;
  await dialog.getByRole("button", { name: "Erneut versuchen", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await expect(editor).toHaveValue("Retained recovery draft");
  await expect.poll(() => dialog.evaluate(element => element.contains(document.activeElement))).toBe(true);
  await dialog.getByRole("button", { name: "Abbrechen", exact: true }).click();
  const stored = await (await page.request.get(`/api/tasks/${item.id}`)).json();
  expect(stored.externalWait).toBeNull();
  expect(stored.revision).toBe(item.revision);
});

test("Today keeps real scheduled work visible and retries only its failed read", async ({ page }, testInfo) => {
  const { timezone } = await (await page.request.get("/api/settings/household")).json();
  const date = calendarDateForInstant(new Date().toISOString(), timezone);
  expect(date).not.toBeNull();
  const item = await createTask(page, { scheduledDate: date });
  await page.goto("/#/today");
  await expect(page.getByText(item.title, { exact: true })).toBeVisible();
  let failing = true;
  let reads = 0;
  let writes = 0;
  page.on("request", request => {
    if (request.url().includes("/api/") && !["GET", "HEAD"].includes(request.method())) writes += 1;
  });
  await page.route("**/api/agenda/today?*", async route => {
    reads += 1;
    if (failing) await route.abort("failed");
    else await route.continue();
  });
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  const alert = page.getByRole("alert").filter({ hasText: "Heute konnte nicht aktualisiert werden." });
  await expect(alert).toBeVisible();
  await expect(page.getByText(item.title, { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("today-read-warning.png") });
  const readsBefore = reads;
  failing = false;
  await alert.getByRole("button", { name: "Erneut versuchen", exact: true }).click();
  await expect.poll(() => reads).toBe(readsBefore + 1);
  await expect(alert).toHaveCount(0);
  await expect(page.getByText(item.title, { exact: true })).toBeVisible();
  expect(writes).toBe(0);
  const stored = await (await page.request.get(`/api/tasks/${item.id}`)).json();
  expect(stored.revision).toBe(item.revision);
  expect(stored.scheduledDate).toBe(date);
});

test("Week clears old-query cards and warnings while a new selection waits", async ({ page }) => {
  const { timezone } = await (await page.request.get("/api/settings/household")).json();
  const today = calendarDateForInstant(new Date().toISOString(), timezone)!;
  const item = await createTask(page, { scheduledDate: today });
  const dates = await weekDates(page, today);
  const nextStart = (await weekDates(page, dates[6]!.date))[1]!.date;
  await page.goto("/#/more/week");
  const card = page.locator(`.week-card[data-workitem-id="${item.id}"]`);
  await expect(card).toBeVisible();
  let failing = true;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/agenda/week?*", async route => {
    const start = new URL(route.request().url()).searchParams.get("start");
    if (start === nextStart) await gate;
    if (failing) await route.abort("failed");
    else await route.continue();
  });
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByRole("alert")).toBeVisible();
  failing = false;
  await page.getByRole("button", { name: "Nächste Woche", exact: true }).click();
  await expect(card).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
  release();
  await expect(page.locator(".week-grid")).toBeVisible();
  await expect(card).toHaveCount(0);
  await page.getByRole("button", { name: "Vorherige Woche", exact: true }).click();
  await expect(card).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("Week card Open and Planning remain reachable with Cancel and stacked focus restoration", async ({ page }) => {
  const { timezone } = await (await page.request.get("/api/settings/household")).json();
  const today = calendarDateForInstant(new Date().toISOString(), timezone)!;
  const item = await createTask(page, { scheduledDate: today });
  const dates = await weekDates(page, today);
  await page.goto("/#/more/week");
  const open = page.locator(`.week-card[data-workitem-id="${item.id}"] button.week-card-main`);
  await open.click();
  const detail = page.getByRole("dialog").last();
  const planning = detail.getByRole("button", { name: /^Geplant/ }).first();
  await planning.click();
  const dialog = page.getByRole("dialog", { name: "Planung", exact: true });
  const editor = dialog.getByLabel("Geplant für", { exact: true });
  await editor.fill(dates[2]!.date);
  await editor.press("Tab");
  await dialog.getByRole("button", { name: "Abbrechen", exact: true }).click();
  await expect(planning).toBeFocused();
  await detail.getByRole("button", { name: "Schließen", exact: true }).first().click();
  await expect(open).toBeFocused();
  const stored = await (await page.request.get(`/api/tasks/${item.id}`)).json();
  expect(stored.scheduledDate).toBe(today);
  expect(stored.revision).toBe(item.revision);
});

test("Week accepted moves stay draggable through refresh failure and a failed next move", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "mobile-chrome", "Native touch drag is not established by mouse emulation; mobile uses the tested Open/Planning path.");
  const { timezone } = await (await page.request.get("/api/settings/household")).json();
  const today = calendarDateForInstant(new Date().toISOString(), timezone)!;
  const item = await createTask(page, {
    scheduledDate: today,
    title: `Recovery zzz native drag ${randomUUID()}`,
  });
  const dates = await weekDates(page, today);
  const selectedWeek = page.waitForResponse(response => {
    const url = new URL(response.url());
    return response.ok() && url.pathname === "/api/agenda/week" &&
      url.searchParams.get("start") === today && url.searchParams.has("memberId") &&
      url.searchParams.get("scope") === "mine";
  });
  await page.goto("/#/more/week");
  const selected = await selectedWeek;
  expect(new URL(selected.url()).searchParams.get("memberId")).toBe(
    await page.evaluate(() => localStorage.getItem("machbar:identity-member-id")));
  const card = page.locator(`.week-card[data-workitem-id="${item.id}"]`);
  await expect(card).toBeVisible();
  let failing = true;
  let patches = 0;
  await page.route("**/api/agenda/week?*", async route => {
    if (failing) await route.abort("failed");
    else await route.continue();
  });
  await page.route(`**/api/tasks/${item.id}`, async route => {
    if (route.request().method() === "PATCH") {
      patches += 1;
      if (patches >= 2) {
        expect(route.request().postDataJSON().expectedRevision).toBe(item.revision + 1);
      }
      if (patches === 2) {
        await route.abort("failed");
        return;
      }
    }
    await route.continue();
  });
  const zones = page.locator(".week-grid .week-drop-zone");
  const dragToDay = async (index: number) => {
    const target = zones.nth(index);
    await card.hover({ position: { x: 6, y: 6 } });
    const source = await card.boundingBox();
    if (!source) throw new Error("Week drag source is not visible");
    await page.mouse.down();
    // Begin dragging before target hover can scroll the source out of view.
    await page.mouse.move(source.x + 16, source.y + 6, { steps: 5 });
    await target.hover({ position: { x: 12, y: 12 } });
    await target.hover({ position: { x: 12, y: 12 } });
    await page.mouse.up();
  };
  const readError = page.getByRole("alert").filter({ hasText: "konnte nicht aktualisiert werden." });
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(readError).toBeVisible();
  const firstWrite = page.waitForResponse(response =>
    response.url().endsWith(`/api/tasks/${item.id}`) && response.request().method() === "PATCH");
  await dragToDay(1);
  const accepted = await firstWrite;
  expect(accepted.status()).toBe(200);
  const receipt = await accepted.json();
  expect(receipt.scheduledDate).toBe(dates[1]!.date);
  expect(receipt.revision).toBe(item.revision + 1);
  await expect(zones.nth(1).locator(`[data-workitem-id="${item.id}"]`)).toBeVisible();
  await dragToDay(2);
  await expect.poll(() => patches).toBe(2);
  await expect(zones.nth(1).locator(`[data-workitem-id="${item.id}"]`)).toBeVisible();
  const afterFailure = await (await page.request.get(`/api/tasks/${item.id}`)).json();
  expect(afterFailure.scheduledDate).toBe(dates[1]!.date);
  expect(afterFailure.revision).toBe(item.revision + 1);
  const retryWrite = page.waitForResponse(response =>
    response.url().endsWith(`/api/tasks/${item.id}`) && response.request().method() === "PATCH");
  await dragToDay(3);
  const retryAccepted = await retryWrite;
  expect(retryAccepted.status()).toBe(200);
  const retryReceipt = await retryAccepted.json();
  expect(retryReceipt.scheduledDate).toBe(dates[3]!.date);
  expect(retryReceipt.revision).toBe(item.revision + 2);
  await expect(zones.nth(3).locator(`[data-workitem-id="${item.id}"]`)).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("week-confirmed-recovery.png") });
  failing = false;
  await readError.getByRole("button", { name: "Erneut versuchen", exact: true }).click();
  await expect(readError).toHaveCount(0);
  await expect(card).toHaveCount(1);
  const stored = await (await page.request.get(`/api/tasks/${item.id}`)).json();
  expect(stored.scheduledDate).toBe(dates[3]!.date);
  expect(stored.revision).toBe(item.revision + 2);
});

test("a suspended planner retains its draft and warning through prerequisite inspection", async ({ page }, testInfo) => {
  const prerequisite = await createTask(page);
  const item = await createTask(page);
  const dependency = await page.request.post(`/api/tasks/${item.id}/dependencies`, {
    data: { dependsOnTaskId: prerequisite.id, expectedRevision: item.revision },
  });
  expect(dependency.ok()).toBeTruthy();
  await page.goto(`/#/tasks/${item.id}`);
  const opener = page.getByRole("button", { name: "Wartet auf …", exact: true });
  await opener.click();
  const planner = page.getByRole("dialog", { name: "Planung", exact: true });
  const draft = planner.getByLabel("Wartet auf", { exact: true });
  await draft.fill("Draft across inspection");
  await planner.locator('section:has([id^="planning-prerequisites"]) .task-planning-summary button').click();
  await planner.getByRole("button", { name: prerequisite.title, exact: true }).click();
  const inspection = page.getByRole("dialog").last();
  await expect(inspection.getByRole("heading", { name: prerequisite.title, exact: true })).toBeVisible();
  let failing = true;
  let failedReads = 0;
  await page.route(`**/api/tasks/${item.id}`, async route => {
    if (failing) { failedReads += 1; await route.abort("failed"); }
    else await route.continue();
  });
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect.poll(() => failedReads).toBeGreaterThan(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await inspection.getByRole("button", { name: "Schließen", exact: true }).first().click();
  await expect(planner).toBeVisible();
  await expect(draft).toHaveValue("Draft across inspection");
  await expect(planner.getByRole("alert")).toBeVisible();
  await expect.poll(() => planner.evaluate(element => element.contains(document.activeElement))).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("resumed-planning-recovery.png") });
  failing = false;
  await planner.getByRole("button", { name: "Erneut versuchen", exact: true }).click();
  await expect(planner.getByRole("alert")).toHaveCount(0);
  await expect(draft).toHaveValue("Draft across inspection");
  await planner.getByRole("button", { name: "Abbrechen", exact: true }).click();
  const originalDetail = page.getByRole("dialog", { name: "Details", exact: true });
  const detailRetry = originalDetail.getByRole("button", { name: "Erneut versuchen", exact: true });
  await expect(detailRetry).toBeFocused();
  await detailRetry.click();
  await expect(opener).toBeVisible();
  const stored = await (await page.request.get(`/api/tasks/${item.id}`)).json();
  expect(stored.externalWait).toBeNull();
  expect(stored.revision).toBe(item.revision + 1);
  expect(stored.dependencies.map((value: { dependsOnTaskId: number }) => value.dependsOnTaskId)).toEqual([prerequisite.id]);
});
