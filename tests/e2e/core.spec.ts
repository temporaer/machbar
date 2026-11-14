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

test("ordinary intake reviews and changes an existing project destination in the real app", async ({ page }, testInfo) => {
  await page.goto("/#/today");
  const memberId = await page.evaluate(() => localStorage.getItem("machbar:identity-member-id")!);
  const actorHeaders = { "x-machbar-actor-member-id": memberId };
  const first = await (await page.request.post("/api/projects", {
    headers: actorHeaders, data: { title: `Intake original ${randomUUID()}` },
  })).json();
  const second = await (await page.request.post("/api/projects", {
    headers: actorHeaders, data: { title: `Intake destination ${randomUUID()}` },
  })).json();
  const code = await (await page.request.post("/api/integrations/home-assistant/pairing-code")).json();
  const paired = await (await page.request.post("/api/integrations/home-assistant/pair", {
    data: { pairingCode: code.code, protocolVersion: 3 },
  })).json();
  const haHeaders = { authorization: `Bearer ${paired.token}` };
  expect((await page.request.post("/api/integrations/home-assistant/context", {
    headers: haHeaders, data: { protocolVersion: 3, observedAt: new Date().toISOString(), contexts: [], people: [],
      intake: { aiTask: { entityId: "ai_task.browser", state: "ok", supportsAttachments: true },
        calendar: { entityId: "calendar.browser", state: "ok" } } },
  })).ok()).toBe(true);
  const created = await page.request.post("/api/intake", { headers: actorHeaders, multipart: { text: "A new step for my project" } });
  expect(created.status()).toBe(201);
  const { id } = await created.json();
  const lease = await (await page.request.get("/api/integrations/home-assistant/requests/next?protocolVersion=3&waitSeconds=0",
    { headers: haHeaders })).json();
  const title = `Reviewed intake action ${randomUUID()}`;
  expect((await page.request.post(`/api/integrations/home-assistant/requests/${lease.id}/complete`, {
    headers: haHeaders, data: { leaseToken: lease.leaseToken, outcome: "succeeded", result: {
      summary: "New work only", calendarEvents: [], warnings: [],
      workItems: [{ key: "step", kind: "action", title, existingProjectId: first.id }],
    } },
  })).status()).toBe(204);
  await page.goto(`/#/intake/${id}`);
  await expect(page.getByText(`Bestehendes Projekt: ${first.title} · Später / noch nicht aktiv`, { exact: true })).toBeVisible();
  const updated = await page.request.patch(`/api/projects/${first.id}`, {
    headers: actorHeaders, data: { notes: "Changed after intake review", expectedRevision: first.revision },
  });
  expect(updated.status()).toBe(200);
  let applyRequests = 0;
  page.on("request", request => {
    if (new URL(request.url()).pathname === `/api/intake/${id}/apply` && request.method() === "POST") applyRequests += 1;
  });
  const apply = page.getByRole("button", { name: /^1 (?:Element|Vorschlag) übernehmen$/ });
  const rejected = page.waitForResponse(response => new URL(response.url()).pathname === `/api/intake/${id}/apply`);
  await apply.click();
  expect((await rejected).status()).toBe(400);
  const guidance = page.getByText(/Das Projektziel hat sich geändert oder ist nicht mehr verfügbar.*erneut.*entferne/);
  await expect(guidance).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("preclaim-destination-guidance.png"), fullPage: true });
  const unchanged = await (await page.request.get(`/api/intake/${id}`, { headers: actorHeaders })).json();
  expect(unchanged).toMatchObject({ status: "ready", error: null, applyResults: null,
    draft: { workItems: [{ existingProjectRevision: first.revision }] } });
  expect((await (await page.request.get(`/api/projects/${first.id}`, { headers: actorHeaders })).json()).tasks).toEqual([]);
  expect(applyRequests).toBe(1);
  const replacement = await (await page.request.post("/api/members", { data: { name: `Other intake viewer ${randomUUID()}` } })).json();
  await page.evaluate(member => {
    const key = "machbar:identity-member-id";
    localStorage.setItem(key, String(member));
    window.dispatchEvent(new StorageEvent("storage", { key, newValue: String(member), storageArea: localStorage }));
  }, replacement.id);
  await expect(page.getByRole("heading", { name: "Verarbeitung abgelaufen" })).toBeVisible();
  await expect(guidance).toHaveCount(0);
  await page.evaluate(member => {
    const key = "machbar:identity-member-id";
    localStorage.setItem(key, member);
    window.dispatchEvent(new StorageEvent("storage", { key, newValue: member, storageArea: localStorage }));
  }, memberId);
  await expect(apply).toBeVisible();
  await expect(guidance).toHaveCount(0);
  expect(applyRequests).toBe(1);
  await apply.click();
  await expect(guidance).toBeVisible();
  expect(applyRequests).toBe(2);
  const edit = page.getByRole("button", { name: `Bearbeiten: ${title}`, exact: true });
  await edit.click();
  let dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Kein bestehendes Projekt", exact: true }).click();
  await expect(guidance).toHaveCount(0);
  await dialog.getByRole("button", { name: "Schließen", exact: true }).click();
  await expect(edit).toBeFocused();
  await expect(page.getByText(`Bestehendes Projekt: ${first.title} · Später / noch nicht aktiv`, { exact: true })).toHaveCount(0);
  await edit.click();
  dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: new RegExp(second.title) }).click();
  await dialog.getByRole("button", { name: "Schließen", exact: true }).click();
  await page.getByRole("button", { name: /^1 (?:Element|Vorschlag) übernehmen$/ }).click();
  await expect.poll(async () => (await (await page.request.get(`/api/intake/${id}`, { headers: actorHeaders })).json()).status).toBe("applied");
  const record = await (await page.request.get(`/api/intake/${id}`, { headers: actorHeaders })).json();
  const result = await (await page.request.get(`/api/tasks/${record.applyResults.work[0].workItemId}`, { headers: actorHeaders })).json();
  expect(result).toMatchObject({ title, projectId: second.id });
  expect((await (await page.request.get(`/api/projects/${second.id}`, { headers: actorHeaders })).json()).status).toBe("backlog");
  expect(applyRequests).toBe(3);
});

test("Today keeps a future recurring plan out despite its reached revisit", async ({ page }) => {
  const item = await task(page, {
    scheduledDate: "2030-12-01",
    revisitAt: "2020-01-01T10:00:00.000Z",
    repeatAfterDays: 7,
    allowedDeviationDays: 2,
  });
  let writes = 0;
  page.on("request", request => {
    if (request.url().endsWith(`/api/tasks/${item.id}`) &&
      !["GET", "HEAD"].includes(request.method())) writes += 1;
  });
  const read = page.waitForResponse(response =>
    new URL(response.url()).pathname === "/api/agenda/today" &&
    response.request().method() === "GET",
  );
  await page.goto("/#/today");
  expect((await read).status()).toBe(200);
  await expect(page.locator(".today-page .loading-state")).toHaveCount(0);
  await expect(page.getByText(item.title, { exact: true })).toHaveCount(0);
  const stored = await (await page.request.get(`/api/tasks/${item.id}`)).json();
  expect(stored).toMatchObject({
    scheduledDate: item.scheduledDate,
    revisitAt: item.revisitAt,
    revision: item.revision,
  });
  expect(writes).toBe(0);
});

test("detail status control is visible on touch and desktop", async ({ page }) => {
  const item = await task(page);
  await page.goto("/#/today");
  await page.goto(`/#/tasks/${item.id}`);
  const control = page.locator(".detail-meta-status-button");
  await expect(control).toBeVisible();
  const bounds = await control.boundingBox();
  expect(bounds!.width).toBeGreaterThan(0);
  expect(bounds!.height).toBeGreaterThanOrEqual(44);
  await expect(page.locator(".task-detail-title-row .task-row-checkbox")).toHaveCount(0);
  await control.click();
  await page.getByRole("group", { name: "Status", exact: true })
    .getByRole("button", { name: "Aufgabe abschließen", exact: true })
    .click();
  await expect.poll(async () => (await (await page.request.get(`/api/tasks/${item.id}`)).json()).status).toBe("done");
});

test("detail documents retain heading actions, ownership and breadcrumb navigation at narrow and large-text sizes", async ({ page }, testInfo) => {
  async function checkHeadingLayout(kind: "task" | "project") {
    for (const [width, fontSize] of [[320, "100%"], [390, "100%"], [320, "200%"]] as const) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(size => { document.documentElement.style.fontSize = size; }, fontSize);
      for (const summary of await page.locator(".detail-history > summary").all()) {
        expect(await summary.evaluate(node => {
          const style = getComputedStyle(node);
          return { weight: style.fontWeight, transform: style.textTransform };
        })).toEqual({ weight: "500", transform: "none" });
      }
      for (const section of await page.locator(".detail-disclosure-with-actions").all()) {
        const actionBounds = await section.locator(".detail-disclosure-actions button").boundingBox();
        const headingBounds = await section.locator(".task-detail-disclosure-heading").boundingBox();
        const summaryBounds = await section.locator("summary").boundingBox();
        expect(actionBounds!.height).toBeGreaterThanOrEqual(44);
        expect(actionBounds!.width).toBeGreaterThanOrEqual(44);
        expect(headingBounds!.x + headingBounds!.width).toBeLessThanOrEqual(actionBounds!.x);
        expect(actionBounds!.y).toBeGreaterThanOrEqual(summaryBounds!.y - 1);
        expect(actionBounds!.y + actionBounds!.height).toBeLessThanOrEqual(summaryBounds!.y + summaryBounds!.height + 1);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      if (kind === "task") {
        expect(await page.getByRole("dialog").evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
      }
      await page.locator(".detail-disclosure-with-actions").first().scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath(`${kind}-details-${width}-${fontSize}.png`), fullPage: true });
    }
    await page.evaluate(() => { document.documentElement.style.fontSize = ""; });
  }
  await page.goto("/#/today");
  const memberId = Number(await page.evaluate(() => localStorage.getItem("machbar:identity-member-id")));
  const projectResponse = await page.request.post("/api/projects", {
    data: { title: `Familienprojekt mit einem langen erklärenden Namen ${randomUUID()}`, ownerMemberId: memberId },
  });
  expect(projectResponse.status()).toBe(201);
  const project = await projectResponse.json();
  const item = await task(page, {
    projectId: project.id, ownerInheritanceMode: "inherit", repeatAfterDays: 7, allowedDeviationDays: 0,
    scheduledDate: "2099-05-10",
    title: `Eine ausführlich beschriebene Aufgabe ${randomUUID()}`,
  });
  await page.goto(`/#/tasks/${item.id}`);
  await expect(page.getByText("Vom Projekt geerbt", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /Aufgabenverantwortung/ })).toBeVisible();
  await expect(page.locator(".detail-history")).toHaveCount(2);
  for (const history of await page.locator(".detail-history").all()) {
    await expect(history).not.toHaveAttribute("open");
  }
  const taskStructure = page.getByRole("button", { name: "Struktur bearbeiten", exact: true });
  await expect(taskStructure).toBeVisible();
  await expect(taskStructure.locator("..").locator("..").locator("details")).not.toHaveAttribute("open");
  await checkHeadingLayout("task");
  const taskActions = page.getByRole("dialog").getByRole("button", { name: "Weitere Aktionen", exact: true });
  await taskActions.click();
  const deleteAction = page.getByRole("button", { name: "Löschen", exact: true });
  await expect(deleteAction).toHaveClass(/action-tile-danger/);
  await deleteAction.click();
  await page.getByRole("button", { name: "Abbrechen", exact: true }).click();
  await expect(taskActions).toBeFocused();
  const projectLink = page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("link", { name: project.title, exact: true });
  await expect(projectLink).toHaveAttribute("href", `#/projects/${project.id}`);
  for (const activation of ["Control", "middle"] as const) {
    const popup = page.context().waitForEvent("page");
    if (activation === "Control") await projectLink.click({ modifiers: ["Control"] });
    else await projectLink.click({ button: "middle" });
    const otherTab = await popup;
    await expect(otherTab.getByRole("heading", { name: project.title, exact: true })).toBeVisible();
    await otherTab.close();
    await expect(page.getByRole("heading", { name: item.title, exact: true })).toBeVisible();
  }
  await projectLink.click();
  await expect(page.getByRole("heading", { name: project.title, exact: true })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Projektverantwortung/ })).toBeVisible();
  await expect(page.locator(".detail-project-status")).toBeVisible();
  await expect(page.locator(".detail-project-status")).not.toHaveRole("button");
  await page.locator(".project-page-actions").getByRole("button", { name: "Weitere Aktionen", exact: true }).click();
  await expect(page.getByRole("dialog").locator("[data-workflow-action]")).toHaveCount(0);
  await expect(page.getByRole("dialog").getByRole("button", { name: "Projekt starten", exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  const projectDetail = await (await page.request.get(`/api/projects/${project.id}`)).json();
  await page.getByRole("button", { name: "Status ändern", exact: true }).click();
  await expect(page.locator("[data-workflow-action]")).toHaveCount(projectDetail.availableActions.length);
  for (const action of projectDetail.availableActions) {
    await expect(page.locator(`[data-workflow-action="${action}"]`)).toBeVisible();
  }
  await page.getByRole("button", { name: "Status ändern", exact: true }).click();

  await checkHeadingLayout("project");
  for (const [label, dialogName] of [
    ["Ergebnis bearbeiten", `Erledigt, wenn …: ${project.title}`],
    ["Struktur bearbeiten", `Struktur: ${project.title}`],
  ] as const) {
    const action = page.getByRole("button", { name: label, exact: true });
    const details = action.locator("..").locator("..").locator("details");
    await details.locator("summary").click();
    await expect(details).not.toHaveAttribute("open");
    await action.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog", { name: dialogName, exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(action).toBeFocused();
    await expect(details).not.toHaveAttribute("open");
  }
});

test("collapsed project tasks cannot be moved or planned by shortcuts", async ({ page }) => {
  const project = await (await page.request.post("/api/projects", {
    data: { title: `Keyboard project ${randomUUID()}` },
  })).json();
  const first = await task(page, { projectId: project.id });
  const second = await task(page, { projectId: project.id });
  const storedOrder = async () => {
    const result = await page.request.get(`/api/projects/${project.id}`);
    expect(result.ok()).toBe(true);
    const detail = await result.json();
    return detail.tasks.map((item: { id: number }) => item.id);
  };
  await page.goto(`/#/projects/${project.id}`);
  const firstRow = page.locator(`[data-workitem-id="${first.id}"] .task-row-main`);
  await expect(firstRow).toBeVisible();
  await page.keyboard.press("j");
  await expect(firstRow).toBeFocused();
  const tasksDisclosure = page.locator(".project-content-tasks");
  await tasksDisclosure.locator("summary").click();
  await expect(firstRow).not.toBeVisible();
  let moves = 0;
  page.on("request", request => {
    if (request.method() === "POST" && request.url().endsWith(`/api/tasks/${first.id}/move`)) moves += 1;
  });
  await page.keyboard.press("Alt+ArrowDown");
  await page.keyboard.press("s");
  await page.waitForLoadState("networkidle");
  expect(moves).toBe(0);
  expect(await storedOrder()).toEqual([first.id, second.id]);
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await tasksDisclosure.locator("summary").click();
  await page.keyboard.press("Alt+ArrowDown");
  await expect.poll(storedOrder).toEqual([second.id, first.id]);
  expect(moves).toBe(1);
});

test("pending detail writes retain enabled disclosure navigation and modal boundaries", async ({ page }) => {
  const item = await task(page);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route(`**/api/tasks/${item.id}`, async route => {
    if (route.request().method() === "PATCH") {
      await held;
    }
    await route.continue();
  });

  await page.goto(`/#/tasks/${item.id}`);
  const titleField = page.locator(".task-detail-title-field");
  await expect(titleField).toBeVisible();
  await titleField.getByRole("button", { name: "Bearbeiten", exact: true }).click();
  const titleInput = titleField.locator("#task-title");
  await titleInput.fill(`${item.title} pending`);
  const patch = page.waitForRequest(request =>
    request.url().endsWith(`/api/tasks/${item.id}`) && request.method() === "PATCH",
  );
  await titleField.getByRole("button", { name: "Speichern", exact: true }).click();
  await patch;

  const content = page.locator("fieldset.task-detail-content");
  await expect(content).toHaveAttribute("disabled", "");
  const close = page.getByRole("button", { name: "Schließen", exact: true });
  const summaries = page.getByRole("dialog").locator("summary");
  await expect(summaries.first()).toBeVisible();
  const firstSummary = summaries.first();
  const disabledInput = content.locator("input").first();
  await expect(disabledInput).toBeDisabled();
  await disabledInput.focus();
  await expect(disabledInput).not.toBeFocused();

  await firstSummary.focus();
  await expect(firstSummary).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("dialog")).toContainText("Teilaufgaben");

  const lastSummary = page.getByRole("dialog").locator("summary:visible").last();
  await expect(lastSummary).toBeVisible();
  await close.focus();
  await page.keyboard.press("Shift+Tab");
  await expect(lastSummary).toBeFocused();
  await lastSummary.focus();
  await page.keyboard.press("Tab");
  await expect(close).toBeFocused();

  release();
  await expect(page.getByRole("heading", { name: `${item.title} pending`, exact: true })).toBeVisible();
  await expect(content).not.toHaveAttribute("disabled");
});

test("attachment dialog returns focus to the stable actions trigger", async ({ page }) => {
  const item = await task(page);
  await page.goto(`/#/tasks/${item.id}`);
  const actions = page.getByRole("button", { name: "Weitere Aktionen", exact: true });
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

test("changing identity retires a held read in the real app provider tree", async ({ page }) => {
  const created = await page.request.post("/api/projects", {
    data: { title: `Old identity read ${randomUUID()}` },
  });
  expect(created.status()).toBe(201);
  const project = await created.json();
  const memberResponse = await page.request.post("/api/members", {
    data: { name: `Replacement identity ${randomUUID()}` },
  });
  expect(memberResponse.status()).toBe(201);
  const member = await memberResponse.json();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let started = false;
  let finished = false;
  let reads = 0;
  await page.route(`**/api/projects/${project.id}`, async route => {
    if (route.request().method() !== "GET" || ++reads !== 1) {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    started = true;
    await held;
    await route.fulfill({ response });
    finished = true;
  });
  try {
    await page.goto(`/#/projects/${project.id}`);
    await expect.poll(() => started).toBe(true);
    const title = `Current identity read ${randomUUID()}`;
    expect((await page.request.patch(`/api/projects/${project.id}`, {
      data: { title, expectedRevision: project.revision },
    })).ok()).toBeTruthy();
    await page.evaluate(id => {
      const key = "machbar:identity-member-id";
      localStorage.setItem(key, String(id));
      window.dispatchEvent(new StorageEvent("storage", {
        key, newValue: String(id), storageArea: localStorage,
      }));
    }, member.id);
    await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
    release();
    await expect.poll(() => finished).toBe(true);
    await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: project.title, exact: true })).toHaveCount(0);
  } finally {
    release();
  }
});

test("a denied criterion edit discards its draft despite an authorized task refresh", async ({ page }) => {
  const item = await task(page);
  const added = await page.request.post(`/api/tasks/${item.id}/criteria`, {
    data: { text: "Saved criterion" },
  });
  expect(added.ok()).toBeTruthy();
  const detail = await added.json();
  const criterion = detail.acceptanceCriteria.find((entry: { text: string }) => entry.text === "Saved criterion");
  expect(criterion).toBeDefined();
  const path = `/api/tasks/${item.id}`;
  await page.route(`**${path}/criteria/${criterion.id}`, route => {
    if (route.request().method() !== "PATCH") return route.continue();
    return route.fulfill({ status: 403, json: { error: { code: "forbidden", message: "Write denied." } } });
  });
  await page.goto(`/#/tasks/${item.id}`);
  const row = page.locator(".criterion-row").filter({
    has: page.getByRole("checkbox", { name: criterion.text, exact: true }),
  });
  await page.getByPlaceholder("Erledigt, wenn …", { exact: true }).fill("Discard this new criterion too");
  await row.getByRole("button", { name: "Bearbeiten", exact: true }).click();
  const input = row.getByRole("textbox");
  await input.fill("Discard this criterion draft");
  const denied = page.waitForResponse(response =>
    new URL(response.url()).pathname === `${path}/criteria/${criterion.id}` && response.status() === 403,
  );
  await row.getByRole("button", { name: "Speichern", exact: true }).click();
  await (await denied).finished();
  const refresh = page.waitForResponse(response =>
    new URL(response.url()).pathname === path && response.request().method() === "GET",
  );
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  expect((await refresh).status()).toBe(200);
  await expect(input).toHaveAttribute("readonly", "");
  await expect(input).toHaveValue(criterion.text);
  await expect(page.getByPlaceholder("Erledigt, wenn …", { exact: true })).toHaveValue("");
  await expect(page.locator(".capture-error[role=alert]")).toBeVisible();
  await row.getByRole("button", { name: "Bearbeiten", exact: true }).click();
  await expect(input).toHaveValue(criterion.text);
});

test("a confirmed split consumes its submitted draft across identity replacement", async ({ page }) => {
  const item = await task(page, { status: "captured" });
  const otherResponse = await page.request.post("/api/members", { data: { name: `Replacement ${randomUUID()}` } });
  expect(otherResponse.ok()).toBeTruthy();
  const other = await otherResponse.json();
  const path = `/api/tasks/${item.id}/children/batch`;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let committed = false;
  await page.route(`**${path}`, async route => {
    const response = await route.fetch();
    expect(response.status()).toBe(201);
    committed = true;
    await held;
    await route.fulfill({ response });
  });
  try {
    await page.goto(`/#/tasks/${item.id}`);
    const memberId = await page.evaluate(() => localStorage.getItem("machbar:identity-member-id"));
    const storageKey = `machbar:steps:task-${item.id}-member-${memberId}`;
    await page.getByRole("button", { name: "Teilaufgaben hinzufügen", exact: true }).click();
    await page.getByPlaceholder("Schritt …").nth(0).fill("Already created first step");
    await page.getByPlaceholder("Schritt …").nth(1).fill("Already created second step");
    await expect.poll(() => page.evaluate(key => sessionStorage.getItem(key), storageKey)).not.toBeNull();
    await page.getByRole("button", { name: "2 Teilaufgaben anlegen", exact: true }).click();
    await expect.poll(() => committed).toBe(true);
    await page.evaluate(id => {
      const key = "machbar:identity-member-id";
      localStorage.setItem(key, String(id));
      window.dispatchEvent(new StorageEvent("storage", { key, newValue: String(id), storageArea: localStorage }));
    }, other.id);
    await expect(page.getByPlaceholder("Schritt …")).toHaveCount(0);
    const confirmation = page.waitForResponse(response => new URL(response.url()).pathname === path);
    release();
    await (await confirmation).finished();
    await expect.poll(() => page.evaluate(key => sessionStorage.getItem(key), storageKey)).toBeNull();
    await page.evaluate(id => {
      const key = "machbar:identity-member-id";
      localStorage.setItem(key, id);
      window.dispatchEvent(new StorageEvent("storage", { key, newValue: id, storageArea: localStorage }));
    }, memberId!);
    await page.getByRole("button", { name: "Aufgabe aufteilen", exact: true }).click();
    await expect(page.getByPlaceholder("Schritt …")).toHaveCount(1);
    await expect(page.getByPlaceholder("Schritt …").nth(0)).toHaveValue("");
    const stored = await (await page.request.get(`/api/tasks/${item.id}`)).json();
    expect(stored.children.map((child: { title: string }) => child.title)).toEqual([
      "Already created first step", "Already created second step",
    ]);
  } finally {
    release();
  }
});

test("a stale project deadline can reload requirements after an outage without replaying the save", async ({ page }) => {
  const created = await page.request.post("/api/projects", { data: { title: `Deadline retry ${randomUUID()}` } });
  expect(created.status()).toBe(201);
  const project = await created.json();
  const path = `/api/projects/${project.id}`;
  let offline = false;
  let writes = 0;
  await page.route(`**${path}`, route => {
    if (route.request().method() === "PATCH") {
      writes += 1;
      if (writes === 1) {
        offline = true;
        return route.fulfill({ status: 409, json: { error: { code: "stale_write_conflict", message: "Changed project." } } });
      }
    } else if (offline && route.request().method() === "GET") {
      return route.fulfill({ status: 503, json: { error: { code: "internal_error", message: "Offline." } } });
    }
    return route.continue();
  });
  await page.goto(`/#/projects/${project.id}`);
  await page.getByRole("button", { name: "+ Deadline hinzufügen", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Projekt-Deadline", exact: true });
  const date = dialog.getByLabel("Fällig", { exact: true });
  await date.fill("31.04.2024");
  await date.press("Tab");
  await expect(dialog.getByRole("alert")).toHaveText("Datum nicht erkannt");
  await expect(date).toHaveValue("31.04.2024");
  await expect(date).toHaveAttribute("aria-invalid", "true");
  await date.fill("15.12.2099");
  await date.press("Enter");
  const retry = dialog.getByRole("button", { name: "Erneut versuchen", exact: true });
  await expect(retry).toBeVisible();
  await expect(date).toHaveValue("15.12.2099");
  expect(writes).toBe(1);
  offline = false;
  await retry.click();
  const driver = dialog.getByLabel(`Verantwortlich für „${project.title}“`, { exact: true });
  await expect(driver).toHaveValue("");
  expect(writes).toBe(1);
  await expect(date).toHaveValue("15.12.2099");
  const memberId = await page.evaluate(() => localStorage.getItem("machbar:identity-member-id"));
  await driver.selectOption(memberId!);
  await dialog.getByLabel("Welcher konkrete nächste Schritt bringt das Projekt voran?", { exact: true }).fill("Reconfirm the deadline");
  await dialog.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect.poll(async () => (await (await page.request.get(path)).json()).dueDate).toBe("2099-12-15");
  expect(writes).toBe(2);
});

test("a superseded dependency search cannot discard the current planning draft", async ({ page }) => {
  const item = await task(page);
  const candidate = await task(page, { title: `New dependency ${randomUUID()}` });
  const oldQuery = `Obsolete query ${randomUUID()}`;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let started = false;
  let writes = 0;
  page.on("request", request => {
    if (new URL(request.url()).pathname.startsWith("/api/tasks/") && request.method() !== "GET") writes += 1;
  });
  await page.route("**/api/search?**", async route => {
    if (new URL(route.request().url()).searchParams.get("text") !== oldQuery) return route.continue();
    started = true;
    await held;
    return route.fulfill({ status: 403, json: { error: { code: "forbidden", message: "Obsolete search denial." } } });
  });
  try {
    await page.goto(`/#/tasks/${item.id}`);
    await page.getByRole("button", { name: "Wartet auf …", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Planung", exact: true });
    const waiting = dialog.getByRole("textbox", { name: "Wartet auf", exact: true });
    await waiting.fill("Keep the current planning draft");
    await dialog.locator(`[aria-controls="planning-editor-dependencies-${item.id}"]`).click();
    const search = dialog.getByPlaceholder("Aufgabe suchen, die zuerst erledigt werden muss");
    await search.fill(oldQuery);
    await expect.poll(() => started).toBe(true);
    await search.fill(candidate.title);
    const result = dialog.getByRole("button", { name: `Abhängigkeit hinzufügen: ${candidate.title}`, exact: true });
    await expect(result).toBeVisible();
    const obsolete = page.waitForResponse(response =>
      new URL(response.url()).pathname === "/api/search" && response.status() === 403,
    );
    release();
    await (await obsolete).finished();
    await page.evaluate(() => new Promise<void>(resolve => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    }));
    await expect(waiting).toHaveValue("Keep the current planning draft");
    await expect(result).toBeVisible();
    expect(writes).toBe(0);
    expect((await (await page.request.get(`/api/tasks/${item.id}`)).json()).externalWait).toBeNull();
  } finally {
    release();
  }
});

for (const targetType of ["task", "project"] as const) {
  test(`a denied ${targetType} title write ends editing despite an authorized refresh`, async ({ page }) => {
    const created = await page.request.post(`/api/${targetType}s`, {
      data: { title: `Saved title ${randomUUID()}` },
    });
    expect(created.status()).toBe(201);
    const item = await created.json();
    const path = `/api/${targetType}s/${item.id}`;
    let status = 403;
    let writes = 0;
    await page.route(`**${path}`, async route => {
      if (route.request().method() !== "PATCH") return route.continue();
      writes += 1;
      return route.fulfill({
        status,
        json: { error: { code: status === 403 ? "forbidden" : "internal_error", message: "Write failed." } },
      });
    });
    await page.goto(`/#/${targetType}s/${item.id}`);
    const heading = page.getByRole("heading", { name: item.title, exact: true });
    await expect(heading).toBeVisible();
    const section = page.locator(targetType === "task" ? ".field" : ".page-header").filter({ has: heading });
    await section.getByRole("button", { name: "Bearbeiten", exact: true }).click();
    const input = page.getByRole("textbox", { name: targetType === "task" ? "Titel" : "Projekttitel", exact: true });
    await input.fill("Discard this denied draft");
    const refresh = page.waitForResponse(response =>
      new URL(response.url()).pathname === path && response.request().method() === "GET",
    );
    await page.getByRole("button", { name: "Speichern", exact: true }).click();
    expect((await refresh).status()).toBe(200);
    await expect(input).toHaveCount(0);
    await expect(page.locator(".detail-inline-error[role=alert]")).toBeVisible();
    await expect(heading).toBeVisible();
    expect(writes).toBe(1);
    expect((await (await page.request.get(path)).json()).title).toBe(item.title);

    await section.getByRole("button", { name: "Bearbeiten", exact: true }).click();
    await expect(input).toHaveValue(item.title);
    await input.fill("Keep this network-failure draft");
    status = 503;
    const failure = page.waitForResponse(response =>
      new URL(response.url()).pathname === path && response.request().method() === "PATCH",
    );
    await page.getByRole("button", { name: "Speichern", exact: true }).click();
    const response = await failure;
    expect(response.status()).toBe(503);
    await response.finished();
    await expect(page.locator(".detail-inline-error[role=alert]")).toBeVisible();
    await expect(page.getByRole("button", { name: "Speichern", exact: true })).toBeEnabled();
    await expect(input).toHaveValue("Keep this network-failure draft");
    expect(writes).toBe(2);
  });

  test(`a canceled tag read cannot end the current ${targetType} tag editor`, async ({ page }) => {
    const created = await page.request.post(`/api/${targetType}s`, {
      data: { title: `Tag cancellation ${randomUUID()}` },
    });
    expect(created.status()).toBe(201);
    const item = await created.json();
    const tagResponse = await page.request.post("/api/tags", {
      data: { name: `Cancellation tag ${randomUUID()}`, kind: "plain" },
    });
    expect(tagResponse.status()).toBe(201);
    const tag = await tagResponse.json();
    let phase: "initial" | "held" | "fresh" = "initial";
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let started = false;
    await page.route("**/api/tags", async route => {
      if (route.request().method() !== "GET" || phase !== "held") return route.continue();
      started = true;
      await held;
      return route.fulfill({ status: 403, json: { error: { code: "forbidden", message: "Obsolete denial." } } });
    });
    try {
      await page.goto(`/#/${targetType}s/${item.id}`);
      await page.getByRole("button", { name: "+ Tags", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Tags", exact: true });
      const choice = dialog.getByRole("button", { name: tag.name, exact: true });
      await expect(choice).toBeVisible();
      phase = "held";
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await expect.poll(() => started).toBe(true);
      phase = "fresh";
      const replacement = page.waitForResponse(response =>
        new URL(response.url()).pathname === "/api/tags" && response.status() === 200,
      );
      await choice.click();
      await (await replacement).finished();
      await expect(choice).toHaveAttribute("aria-pressed", "true");
      const obsolete = page.waitForResponse(response =>
        new URL(response.url()).pathname === "/api/tags" && response.status() === 403,
      );
      release();
      await (await obsolete).finished();
      await page.evaluate(() => new Promise<void>(resolve => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }));
      await expect(dialog).toBeVisible();
      await expect(choice).toHaveAttribute("aria-pressed", "true");
      await expect(dialog.getByRole("alert")).toHaveCount(0);
      const saved = await (await page.request.get(`/api/${targetType}s/${item.id}`)).json();
      const savedTags = targetType === "task" ? saved.explicitTags : saved.tags;
      expect(savedTags.map((entry: { id: number }) => entry.id)).toContain(tag.id);
    } finally {
      release();
    }
  });

  test(`changing identity retires a held ${targetType} refinement continuation`, async ({ page }) => {
    const created = await page.request.post(`/api/${targetType}s`, {
      data: { title: `Refinement identity ${randomUUID()}` },
    });
    expect(created.status()).toBe(201);
    const item = await created.json();
    const memberResponse = await page.request.post("/api/members", {
      data: { name: `Replacement refinement identity ${randomUUID()}` },
    });
    expect(memberResponse.status()).toBe(201);
    const member = await memberResponse.json();
    const jobId = randomUUID();
    const path = `/api/intake/refinement/${targetType}/${item.id}`;
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let started = false;
    let staleJobReads = 0;
    page.on("request", request => {
      if (new URL(request.url()).pathname === `/api/intake/${jobId}`) staleJobReads += 1;
    });
    await page.route(`**${path}`, async route => {
      started = true;
      await held;
      await route.fulfill({ status: 201, json: { id: jobId } });
    });
    try {
      await page.goto(`/#/${targetType}s/${item.id}`);
      await expect(page.getByRole("heading", { name: item.title, exact: true })).toBeVisible();
      if (targetType === "project") {
        await page.getByRole("button", { name: "Struktur bearbeiten", exact: true }).click();
      }
      await page.getByRole("dialog").getByRole("button", { name: "Mit KI klären…", exact: true }).click();
      await page.getByRole("button", { name: "Vorschlag vorbereiten", exact: true }).click();
      await expect.poll(() => started).toBe(true);
      const newScopeRead = page.waitForResponse(response =>
        new URL(response.url()).pathname === `/api/${targetType}s/${item.id}` &&
        response.request().method() === "GET",
      );
      await page.evaluate(id => {
        const key = "machbar:identity-member-id";
        localStorage.setItem(key, String(id));
        window.dispatchEvent(new StorageEvent("storage", {
          key, newValue: String(id), storageArea: localStorage,
        }));
      }, member.id);
      expect((await newScopeRead).status()).toBe(200);
      await expect(page.getByRole("button", { name: "Vorschlag vorbereiten", exact: true })).toHaveCount(0);
      await expect(page.getByRole("heading", { name: item.title, exact: true })).toBeVisible();
      const response = page.waitForResponse(response =>
        new URL(response.url()).pathname === path && response.request().method() === "POST",
      );
      release();
      await (await response).finished();
      await page.evaluate(() => new Promise<void>(resolve => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }));
      await expect(page).toHaveURL(new RegExp(`#/${targetType}s/${item.id}$`));
      expect(staleJobReads).toBe(0);
      await expect(page.getByRole("heading", { name: item.title, exact: true })).toBeVisible();
    } finally {
      release();
    }
  });
}

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

test("Discussion retains focused rows through an outage and retries without writes", async ({ page }) => {
  let item = await task(page);
  item = await (await page.request.patch(`/api/tasks/${item.id}`, {
    data: { discussionRequested: true, expectedRevision: item.revision },
  })).json();
  const created = await page.request.post("/api/projects", { data: { title: `Discussion retry ${randomUUID()}` } });
  expect(created.status()).toBe(201);
  let project = await created.json();
  project = await (await page.request.patch(`/api/projects/${project.id}`, {
    data: { discussionRequested: true, expectedRevision: project.revision },
  })).json();
  await page.goto("/#/more/discussion");
  const discussion = page.locator(".discussion-page");
  const row = discussion.getByRole("button", { name: item.title, exact: true });
  const projectRow = discussion.getByRole("button", { name: new RegExp(project.title) });
  await expect(row).toBeVisible();
  await expect(projectRow).toBeVisible();
  let offline = true;
  await page.route("**/api/discussion", async route => {
    if (offline) await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Unavailable" }) });
    else await route.continue();
  });
  await row.focus();
  const failed = page.waitForResponse(response => new URL(response.url()).pathname === "/api/discussion" && response.status() === 503);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await failed;
  await expect(discussion.getByRole("alert")).toBeVisible();
  await expect(row).toBeVisible();
  await expect(projectRow).toBeVisible();
  await expect(row).toBeFocused();
  const writes: string[] = [];
  page.on("request", request => {
    if (new URL(request.url()).pathname.startsWith("/api/") && !["GET", "HEAD"].includes(request.method())) {
      writes.push(`${request.method()} ${request.url()}`);
    }
  });
  offline = false;
  const retried = page.waitForResponse(response => new URL(response.url()).pathname === "/api/discussion" && response.request().method() === "GET" && response.status() === 200);
  await discussion.getByRole("button", { name: "Erneut versuchen", exact: true }).click();
  await retried;
  await expect(discussion.getByRole("alert")).toHaveCount(0);
  await expect(row).toBeVisible();
  await expect(projectRow).toBeVisible();
  expect(writes).toEqual([]);
  expect(await (await page.request.get(`/api/tasks/${item.id}`)).json()).toMatchObject({
    revision: item.revision, discussionRequested: true,
  });
  expect(await (await page.request.get(`/api/projects/${project.id}`)).json()).toMatchObject({
    revision: project.revision, discussionRequested: true,
  });
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

test("project activation ends on denial and an explicit reopen starts with empty choices", async ({ page }) => {
  const title = `Activation recovery ${randomUUID()}`;
  const created = await page.request.post("/api/projects", {
    data: { title, status: "backlog" },
  });
  expect(created.status()).toBe(201);
  const project = await created.json();
  const initialDetail = await (await page.request.get(`/api/projects/${project.id}`)).json();
  expect(initialDetail.directActivationDecisionSnapshot).toMatchObject({
    projects: [{
      projectId: project.id,
      required: ["driver", "progressPath"],
    }],
    expectedProjects: [{ projectId: project.id, revision: initialDetail.revision }],
    targetRevision: initialDetail.revision,
  });

  await page.goto(`/#/projects/${project.id}`);
  await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
  let phase: "initial" | "denied" | "restored" = "initial";
  let requests = 0;
  let activationWrites = 0;
  page.on("request", request => {
    if (request.url().endsWith(`/api/projects/${project.id}/activate`) &&
      request.method() === "POST") activationWrites += 1;
  });
  await page.route(`**/api/projects/${project.id}`, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    requests += 1;
    if (phase === "initial") {
      phase = "denied";
      return route.fulfill({ status: 200, json: initialDetail });
    }
    if (phase === "denied") {
      return route.fulfill({
        status: 403,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "forbidden", message: "Access denied." } }),
      });
    }
    return route.continue();
  });

  await page.getByRole("button", { name: "Status ändern", exact: true }).click();
  await page.locator('[data-workflow-action="activate"]').click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel(/Verantwortlich für/)).toBeVisible();
  const memberId = await page.evaluate(() => localStorage.getItem("machbar:identity-member-id"));
  await dialog.locator('select[id^="commitment-driver-"]').selectOption(memberId!);
  await dialog.locator("#commitment-next-action").fill("Confirm the insurance details");

  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect.poll(() => requests).toBeGreaterThan(1);
  await expect(dialog.getByRole("alert")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Erneut versuchen" })).toHaveCount(0);
  await expect(dialog).not.toContainText(title);
  expect(await dialog.locator("input, select, textarea").count()).toBe(0);
  expect(await dialog.locator("input, select, textarea").evaluateAll((controls) =>
    controls.flatMap((control) => Array.from(control.attributes, (attribute) => attribute.value)),
  )).toEqual([]);

  expect(activationWrites).toBe(0);
  expect((await (await page.request.get(`/api/projects/${project.id}`)).json()).status).toBe("backlog");

  await dialog.getByRole("button", { name: "Schließen", exact: true }).last().click();
  await expect(dialog).toHaveCount(0);
  phase = "restored";
  await page.getByRole("button", { name: "Erneut versuchen", exact: true }).first().click();
  await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Status ändern", exact: true }).click();
  await page.locator('[data-workflow-action="activate"]').click();
  await expect(dialog.locator('select[id^="commitment-driver-"]')).toHaveValue("");
  await expect(dialog.locator("#commitment-next-action")).toHaveValue("");
  expect(activationWrites).toBe(0);
  expect((await (await page.request.get(`/api/projects/${project.id}`)).json()).status).toBe("backlog");

  await dialog.locator('select[id^="commitment-driver-"]').selectOption(memberId!);
  await dialog.locator("#commitment-next-action").fill("Confirm the insurance details");
  await dialog.getByRole("button", { name: "Projekt starten", exact: true }).click();
  await expect.poll(async () => (await (await page.request.get(`/api/projects/${project.id}`)).json()).status).toBe("active");
  expect(activationWrites).toBe(1);
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
  await expect(page.locator(".task-detail-title-row").getByRole("button", { name: "Bearbeiten", exact: true })).toBeFocused();
});

test("waiting is directly reachable and revisit precedes the single follow-up commit", async ({ page }, testInfo) => {
  const item = await task(page);
  await page.goto(`/#/tasks/${item.id}`);
  const start = page.getByRole("button", { name: "Wartet auf …", exact: true });
  await start.click();
  let dialog = page.getByRole("dialog", { name: "Planung", exact: true });
  await expect(dialog.getByLabel("Wartet auf", { exact: true })).toBeVisible();
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

test("dirty planning navigation keeps the portaled choice explicit after a failed save", async ({ page }) => {
  const item = await task(page);
  await page.goto(`/#/tasks/${item.id}`);
  const waiting = await page.request.put(`/api/tasks/${item.id}/external-wait`, {
    data: { expectedRevision: item.revision, waitingFor: "Supplier response", revisitDate: "2099-05-01" },
  });
  expect(waiting.ok()).toBeTruthy();
  await page.reload();
  await page.getByRole("button", { name: /Wartet auf.*Supplier response/ }).click();
  const planning = page.locator('[role="dialog"]').filter({
    has: page.locator('h2:text-is("Planung")'),
  });
  const activePlanning = page.locator('[role="dialog"]:not([aria-hidden="true"])').filter({
    has: page.locator('h2:text-is("Planung")'),
  });
  const itemPlanning = activePlanning.filter({
    has: page.locator(`#planning-availability-date-${item.id}`),
  });
  await itemPlanning.getByRole("button", { name: "Bearbeiten", exact: true }).click();
  await itemPlanning.locator(`#planning-availability-date-${item.id}`).fill("10.05.2099");
  await itemPlanning.locator(`#planning-availability-date-${item.id}`).press("Tab");

  await page.route(`**/api/tasks/${item.id}`, async route => {
    if (route.request().method() === "PATCH") {
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "stale_write_conflict", message: "Stale draft." } }),
      });
      return;
    }
    await route.continue();
  });
  await page.locator('a[href="#/today"]').first().evaluate((element) => (element as HTMLElement).click());
  const prompt = page.getByRole("dialog", { name: "Verwerfen", exact: true });
  await expect(prompt).toBeVisible();
  await expect(prompt.getByRole("button", { name: "Abbrechen", exact: true })).toBeFocused();
  await prompt.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect(prompt).toBeVisible();
  await expect(planning.last().locator(`#planning-availability-date-${item.id}`)).toHaveValue("10.05.2099");

  await page.keyboard.press("Escape");
  await expect(prompt).toHaveCount(0);
  await expect(activePlanning).toBeVisible();
  await page.locator('a[href="#/today"]').first().evaluate((element) => (element as HTMLElement).click());
  await page.getByRole("dialog", { name: "Verwerfen", exact: true })
    .getByRole("button", { name: "Verwerfen", exact: true }).click();
  await expect(planning).toHaveCount(0);
  await expect(page).toHaveURL(/#\/today$/);
});

test("dirty planning dismissal saves and closes without navigation", async ({ page }) => {
  const item = await task(page);
  const waiting = await page.request.put(`/api/tasks/${item.id}/external-wait`, {
    data: { expectedRevision: item.revision, waitingFor: "Supplier response", revisitDate: "2099-05-01" },
  });
  expect(waiting.ok()).toBeTruthy();
  await page.goto(`/#/tasks/${item.id}`);
  await page.getByRole("button", { name: /Wartet auf.*Supplier response/ }).click();
  const planning = page.getByRole("dialog", { name: "Planung", exact: true });
  await planning.getByRole("button", { name: "Bearbeiten", exact: true }).click();
  await planning.locator(`#planning-availability-date-${item.id}`).fill("10.05.2099");
  await planning.locator(`#planning-availability-date-${item.id}`).press("Tab");

  await page.keyboard.press("Escape");
  const prompt = page.getByRole("dialog", { name: "Verwerfen", exact: true });
  await expect(prompt).toBeVisible();
  const saved = page.waitForResponse(response =>
    response.url().endsWith(`/api/tasks/${item.id}`) && response.request().method() === "PATCH",
  );
  await prompt.getByRole("button", { name: "Speichern", exact: true }).click();
  expect((await saved).ok()).toBeTruthy();
  await expect(prompt).toHaveCount(0);
  await expect(planning).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`#/tasks/${item.id}$`));
});

test("dirty browser Back saves to the destination and Forward does not reopen planning", async ({ page }) => {
  const item = await task(page);
  const waiting = await page.request.put(`/api/tasks/${item.id}/external-wait`, {
    data: { expectedRevision: item.revision, waitingFor: "Supplier response", revisitDate: "2099-05-01" },
  });
  expect(waiting.ok()).toBeTruthy();
  await page.goto("/#/more/activity");
  const taskLink = page.getByRole("link", { name: item.title, exact: true }).first();
  await expect(taskLink).toBeVisible();
  await taskLink.click();
  await expect(page).toHaveURL(new RegExp(`#/tasks/${item.id}$`));
  await page.reload();
  await page.getByRole("button", { name: /Wartet auf.*Supplier response/ }).click();
  const planning = page.getByRole("dialog", { name: "Planung", exact: true });
  await planning.getByRole("button", { name: "Bearbeiten", exact: true }).click();
  await planning.locator(`#planning-availability-date-${item.id}`).fill("10.05.2099");
  await planning.locator(`#planning-availability-date-${item.id}`).press("Tab");
  await expect(planning.locator(`#planning-availability-date-${item.id}`)).toHaveValue("10.05.2099");
  await page.waitForTimeout(100);

  await page.goBack();
  const prompt = page.getByRole("dialog", { name: "Verwerfen", exact: true });
  await expect(prompt).toBeVisible();
  const saved = page.waitForResponse(response =>
    response.url().endsWith(`/api/tasks/${item.id}`) && response.request().method() === "PATCH",
  );
  await prompt.getByRole("button", { name: "Speichern", exact: true }).click();
  expect((await saved).ok()).toBeTruthy();
  await expect(prompt).toHaveCount(0);
  await expect(planning).toHaveCount(0);
  await expect(page).toHaveURL(/#\/more\/activity$/);

  await page.goForward();
  await expect(page).toHaveURL(new RegExp(`#/tasks/${item.id}$`));
  await expect(page.getByRole("dialog", { name: "Planung", exact: true })).toHaveCount(0);
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
