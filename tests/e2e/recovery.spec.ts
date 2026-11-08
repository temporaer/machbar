import { test, expect, type Page } from "@playwright/test";
import { calendarDateForInstant } from "@machbar/shared";
import { randomUUID } from "node:crypto";

const pageErrors = new WeakMap<Page, string[]>();
const pageMemberIds = new WeakMap<Page, number>();
test.beforeEach(async ({ page, request }) => {
  const errors: string[] = [];
  pageErrors.set(page, errors);
  page.on("pageerror", error => errors.push(error.message));
  const response = await request.post("/api/members", { data: { name: `Recovery ${randomUUID()}` } });
  expect(response.status()).toBe(201);
  const member = await response.json();
  pageMemberIds.set(page, member.id);
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

for (const kind of ["move", "convert"] as const) {
  test(`sixth review ${kind} binds stored requirements to the original ancestor read and preserves drafts through GET-only recovery`, async ({ page }) => {
    const parentResponse = await page.request.post("/api/projects", { data: {
      title: `Private ancestor ${randomUUID()}`, ownerMemberId: pageMemberIds.get(page),
    } });
    expect(parentResponse.status()).toBe(201);
    const parent = await parentResponse.json();
    const sourceResponse = await page.request.post("/api/projects", { data: {
      title: `Nested source ${randomUUID()}`, parentId: parent.id, ownerMemberId: pageMemberIds.get(page),
    } });
    expect(sourceResponse.status()).toBe(201);
    const source = await sourceResponse.json();
    const sourceTask = await createTask(page, { projectId: source.id });
    const currentSource = await (await page.request.get(`/api/projects/${source.id}`)).json();
    const activated = await page.request.post(`/api/projects/${source.id}/activate`, {
      data: { expectedRevision: currentSource.revision, ownerMemberId: pageMemberIds.get(page) },
    });
    expect(activated.ok()).toBeTruthy();
    const activeSource = await activated.json();
    expect(activeSource.status).toBe("active");
    const waitingTask = await page.request.put(`/api/tasks/${sourceTask.id}/external-wait`, {
      data: { expectedRevision: sourceTask.revision, waitingFor: "Recovery reader" },
    });
    expect(waitingTask.ok()).toBeTruthy();
    const parkedParent = await (await page.request.get(`/api/projects/${parent.id}`)).json();
    expect(parkedParent.status).toBe("backlog");
    const unassigned = await page.request.patch(`/api/projects/${parent.id}`, {
      data: { expectedRevision: parkedParent.revision, ownerMemberId: null },
    });
    expect(unassigned.ok()).toBeTruthy();
    const currentParent = await unassigned.json();
    const destinationResponse = kind === "move" ? await page.request.post("/api/projects", {
      data: { title: `Destination draft ${randomUUID()}`, parentId: parent.id },
    }) : null;
    const destination = destinationResponse ? await destinationResponse.json() : null;
    await page.goto(`/#/projects/${parent.id}`);
    await expect(page.getByRole("heading", { name: parent.title, exact: true })).toBeVisible();
    let releaseDenial!: () => void;
    const denial = new Promise<void>(resolve => { releaseDenial = resolve; });
    let heldRead = false;
    let qualifiedAffectedReads = 0;
    let secondCommandBody: { expectedHierarchyRevisions: Array<{ id: number; revision: number }> } | undefined;
    await page.route(`**/api/projects/${parent.id}`, async route => {
      if (!heldRead) {
        heldRead = true;
        await denial;
        await route.fulfill({ status: 403, contentType: "application/json",
          body: JSON.stringify({ error: { message: "Original ancestor reader denied" } }) });
      } else {
        const response = await route.fetch();
        if (response.ok()) qualifiedAffectedReads += 1;
        await route.fulfill({ response });
      }
    });
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect.poll(() => heldRead).toBe(true);
    const row = page.locator(`[data-workitem-id="${source.id}"][data-workitem-role="story"]`).first();
    await row.getByRole("button", { name: "Weitere Aktionen", exact: true }).click();
    await row.getByRole("group", { name: "Weitere Aktionen", exact: true })
      .getByRole("button", { name: "Struktur bearbeiten", exact: true }).click();
    const structure = page.getByRole("dialog", { name: `Struktur: ${source.title}`, exact: true });
    await structure.getByRole("button", {
      name: kind === "move" ? "Verschieben …" : "Zur Aufgabe machen", exact: true,
    }).click();
    const sheet = page.getByRole("dialog", {
      name: kind === "move" ? "In anderes Projekt verschieben" : "Projekt zur Aufgabe machen", exact: true,
    });
    const editor = kind === "move" ? sheet.getByRole("searchbox") : sheet.getByLabel("Titel", { exact: true });
    if (kind === "move") {
      await sheet.getByRole("button", { name: destination.title, exact: true }).click();
      await editor.fill("Destination draft");
    } else await editor.fill("Preserved authored conversion title");
    await editor.evaluate(element => element.setAttribute("data-sixth-node", "original"));
    const submit = sheet.getByRole("button", { name: kind === "move" ? "Hierher verschieben" : "Zur Aufgabe machen", exact: true });
    let commands = 0;
    let releaseRequirements!: () => void;
    const freshRequirements = new Promise<void>(resolve => { releaseRequirements = resolve; });
    await page.route(`**/api/projects/${source.id}/${kind === "move" ? "move" : "convert-to-task"}`, async route => {
      commands += 1;
      if (commands === 2) {
        secondCommandBody = route.request().postDataJSON() as typeof secondCommandBody;
        await freshRequirements;
      }
      await route.continue();
    });
    await submit.click();
    const originalDriver = sheet.getByLabel(`Verantwortlich für „${parent.title}“`);
    await originalDriver.selectOption({ index: 1 });
    const choice = await originalDriver.inputValue();
    if (destination) await sheet.getByLabel(`Verantwortlich für „${destination.title}“`).selectOption({ index: 1 });
    releaseDenial();
    await expect(originalDriver).toHaveCount(0);
    await expect(editor).toHaveAttribute("data-sixth-node", "original");
    let sourceUnavailable = true;
    await page.route(`**/api/projects/${source.id}`, async route => {
      if (!sourceUnavailable) await route.continue();
      else await route.fulfill({ status: 503, contentType: "application/json",
        body: JSON.stringify({ error: { message: "Source recovery failed" } }) });
    });
    const failedRead = page.waitForResponse(response => response.url().endsWith(`/api/projects/${source.id}`) && response.status() === 503);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await failedRead;
    await expect(originalDriver).toHaveCount(0);
    const recoveredTitle = `Recovered private ancestor ${randomUUID()}`;
    const changed = await page.request.patch(`/api/projects/${parent.id}`, {
      data: { expectedRevision: currentParent.revision, title: recoveredTitle },
    });
    expect(changed.ok()).toBeTruthy();
    const latestParent = await changed.json();
    let holdSourceRefresh = false;
    let sourceRefreshHeld = false;
    let markSourceRefreshStarted!: () => void;
    const sourceRefreshStarted = new Promise<void>(resolve => { markSourceRefreshStarted = resolve; });
    let heldSourceResponseBody: unknown;
    let releaseSourceRefresh!: () => void;
    const sourceRefreshGate = new Promise<void>(resolve => { releaseSourceRefresh = resolve; });
    const changedSource = await page.request.patch(`/api/projects/${source.id}`, {
      data: { expectedRevision: activeSource.revision, notes: "Accepted fresh source authority" },
    });
    expect(changedSource.ok()).toBeTruthy();
    sourceUnavailable = false;
    await page.unroute(`**/api/projects/${source.id}`);
    await page.route(`**/api/projects/${source.id}`, async route => {
      if (sourceUnavailable) {
        await route.fulfill({ status: 503, contentType: "application/json",
          body: JSON.stringify({ error: { message: "Source recovery failed" } }) });
      } else if (holdSourceRefresh && !sourceRefreshHeld) {
        sourceRefreshHeld = true;
        markSourceRefreshStarted();
        await sourceRefreshGate;
        const response = await route.fetch();
        heldSourceResponseBody = await response.json();
        await route.fulfill({ response });
      } else {
        await route.continue();
      }
    });
    const recoveredRead = page.waitForResponse(response => response.url().endsWith(`/api/projects/${source.id}`) && response.status() === 200);
    await sheet.getByRole("button", { name: "Erneut versuchen", exact: true }).first().click();
    await recoveredRead;
    await expect(originalDriver).toHaveCount(0);
    await expect(sheet.getByLabel(`Verantwortlich für „${recoveredTitle}“`)).toHaveCount(0);
    await expect(editor).toHaveAttribute("data-sixth-node", "original");
    await expect(editor).toHaveValue(kind === "move" ? "Destination draft" : "Preserved authored conversion title");
    expect(commands).toBe(1);
    if (kind === "move") await sheet.getByRole("button", { name: "Erneut versuchen", exact: true }).last().click();
    else await expect(sheet.getByRole("textbox", { name: /^Notizen/ })).toHaveValue("Accepted fresh source authority");
    await expect(submit).toBeEnabled();
    holdSourceRefresh = true;
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    const latestSourceResponse = await page.request.get(`/api/projects/${source.id}`);
    expect(latestSourceResponse.ok()).toBeTruthy();
    const latestSource = await latestSourceResponse.json();
    const refreshedSource = await page.request.patch(`/api/projects/${source.id}`, {
      data: { expectedRevision: latestSource.revision, notes: "Accepted fresh source authority after revalidation" },
    });
    expect(refreshedSource.ok()).toBeTruthy();
    await sourceRefreshStarted;
    await expect(submit).toBeDisabled();
    releaseSourceRefresh();
    await expect.poll(() => heldSourceResponseBody).not.toBeUndefined();
    expect(heldSourceResponseBody).toMatchObject({
      revision: (await refreshedSource.json()).revision,
      ancestors: [expect.objectContaining({ id: parent.id, revision: latestParent.revision, title: recoveredTitle })],
    });
    if (kind === "convert") {
      await expect(sheet.getByRole("textbox", { name: /^Notizen/ }))
        .toHaveValue("Accepted fresh source authority after revalidation");
    }
    await expect(submit).toBeEnabled();
    const freshCommandResponse = page.waitForResponse(response =>
      response.url().endsWith(`/api/projects/${source.id}/${kind === "move" ? "move" : "convert-to-task"}`) &&
      response.request().method() === "POST");
    await submit.click();
    await expect.poll(() => commands).toBe(2);
    await expect.poll(() => secondCommandBody).not.toBeUndefined();
    expect(secondCommandBody?.expectedHierarchyRevisions).toContainEqual({ id: parent.id, revision: latestParent.revision });
    await expect.poll(() => qualifiedAffectedReads).toBeGreaterThan(0);
    await expect(originalDriver).toHaveCount(0);
    await expect(sheet.getByLabel(`Verantwortlich für „${recoveredTitle}“`)).toHaveCount(0);
    releaseRequirements();
    const requirements = await freshCommandResponse;
    expect(requirements.status()).toBe(409);
    const responseBody = await requirements.json();
    expect(responseBody.error.code).toBe("project_commitment_resolution_required");
    expect(responseBody.error.details.projects).toContainEqual(expect.objectContaining({
      projectId: parent.id, title: recoveredTitle, revision: latestParent.revision,
      required: expect.arrayContaining(["driver"]),
    }));
    const driver = sheet.getByLabel(`Verantwortlich für „${recoveredTitle}“`);
    await expect(driver).toHaveValue(choice);
    if (kind === "convert") {
      await sheet.getByRole("textbox", { name: "Welcher konkrete nächste Schritt bringt das Projekt voran?" })
        .fill("Continue the waiting task");
    }
    expect(commands).toBe(2);
    await expect(editor).toHaveAttribute("data-sixth-node", "original");
    const finalCommand = page.waitForRequest(request => request.url().endsWith(`/api/projects/${source.id}/${kind === "move" ? "move" : "convert-to-task"}`));
    await submit.click();
    expect((await finalCommand).postDataJSON()).toMatchObject({
      activationResolution: { expectedProjects: expect.arrayContaining([{ projectId: parent.id, revision: latestParent.revision }]) },
    });
  });
}

test("sixth review project conversion reconciles real newer details without overwriting authored title/notes or unresolved choices", async ({ page }) => {
  const created = await page.request.post("/api/projects", { data: { title: `Conversion baseline ${randomUUID()}`, notes: "Initial notes" } });
  expect(created.status()).toBe(201);
  const project = await created.json();
  await page.goto(`/#/projects/${project.id}`);
  await page.getByRole("button", { name: "Aktionen", exact: true }).click();
  await page.getByRole("dialog", { name: "Aktionen", exact: true }).getByRole("button", { name: "Struktur ändern", exact: true }).click();
  await page.getByRole("dialog").last().getByRole("button", { name: "Zur Aufgabe machen", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "Projekt zur Aufgabe machen", exact: true });
  const title = sheet.getByRole("textbox", { name: /^Titel/ });
  const notes = sheet.getByRole("textbox", { name: /^Notizen/ });
  await title.fill("My conversion title");
  await notes.fill("My conversion notes");
  await title.evaluate(element => element.setAttribute("data-sixth-node", "title"));
  await notes.evaluate(element => element.setAttribute("data-sixth-node", "notes"));
  const changed = await page.request.patch(`/api/projects/${project.id}`, {
    data: { expectedRevision: project.revision, title: "Concurrent title2", notes: "Concurrent notes2" },
  });
  expect(changed.ok()).toBeTruthy();
  const second = await changed.json();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(sheet.getByRole("button", { name: "Serverfassung verwenden", exact: true })).toHaveCount(2);
  await expect(title).toHaveValue("My conversion title");
  await expect(notes).toHaveValue("My conversion notes");
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(sheet.getByRole("button", { name: "Serverfassung verwenden", exact: true })).toHaveCount(2);
  await expect(sheet.getByRole("button", { name: "Zur Aufgabe machen", exact: true })).toBeDisabled();
  const changedAgain = await page.request.patch(`/api/projects/${project.id}`, {
    data: { expectedRevision: second.revision, title: "Concurrent title3", notes: "Concurrent notes3" },
  });
  expect(changedAgain.ok()).toBeTruthy();
  const third = await changedAgain.json();
  const latestRead = page.waitForResponse(response => response.url().endsWith(`/api/projects/${project.id}`) && response.status() === 200);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await latestRead;
  await title.locator("..").getByRole("button", { name: "Serverfassung verwenden", exact: true }).click();
  await expect(title).toHaveValue("Concurrent title3");
  await notes.locator("..").getByRole("button", { name: "Meine Änderung beibehalten", exact: true }).click();
  await expect(notes).toHaveValue("My conversion notes");
  await expect(title).toHaveAttribute("data-sixth-node", "title");
  await expect(notes).toHaveAttribute("data-sixth-node", "notes");
  const command = page.waitForRequest(request => request.url().endsWith(`/api/projects/${project.id}/convert-to-task`));
  await sheet.getByRole("button", { name: "Zur Aufgabe machen", exact: true }).click();
  expect((await command).postDataJSON()).toMatchObject({ expectedRevision: third.revision, notes: "My conversion notes" });
  await expect.poll(async () => (await (await page.request.get(`/api/tasks/${project.id}`)).json()).title).toBe("Concurrent title3");
});

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

test("fifth review Move retains both search nodes and its warning through a failed then successful read retry", async ({ page }) => {
  const created = await page.request.post("/api/projects", { data: { title: `Sticky move ${randomUUID()}` } });
  const project = await created.json();
  const item = await createTask(page, { projectId: project.id });
  await page.goto(`/#/projects/${project.id}`);
  await page.getByRole("button", { name: item.title, exact: true }).click();
  await page.getByRole("dialog", { name: "Details", exact: true }).getByRole("button", { name: "Aktionen", exact: true }).click();
  await page.getByRole("dialog", { name: "Aktionen", exact: true }).getByRole("button", { name: "Struktur ändern", exact: true }).click();
  await page.getByRole("dialog").last().getByRole("button", { name: "Verschieben …", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "In anderes Projekt verschieben", exact: true });
  const searches = sheet.getByRole("searchbox");
  await expect(searches).toHaveCount(2);
  await searches.nth(0).fill("Sticky");
  await searches.nth(1).fill("Parent draft");
  await searches.nth(0).evaluate(element => element.setAttribute("data-fifth-node", "project"));
  await searches.nth(1).evaluate(element => element.setAttribute("data-fifth-node", "parent"));
  let mode: "denied" | "failed" | "success" = "denied";
  let release!: () => void;
  let waiting = false;
  await page.route(`**/api/projects/${project.id}`, async route => {
    if (mode === "denied") await route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: { message: "Destination denied" } }) });
    else if (mode === "failed") {
      waiting = true;
      await new Promise<void>(resolve => { release = resolve; });
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { message: "Retry failed" } }) });
    } else await route.continue();
  });
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  const retry = sheet.getByRole("button", { name: "Erneut versuchen", exact: true });
  await expect(retry).toBeVisible();
  mode = "failed";
  await retry.click();
  await expect.poll(() => waiting).toBe(true);
  await expect(searches.nth(0)).toHaveAttribute("data-fifth-node", "project");
  await expect(searches.nth(1)).toHaveAttribute("data-fifth-node", "parent");
  await expect(searches.nth(0)).toHaveValue("Sticky");
  await expect(searches.nth(1)).toHaveValue("Parent draft");
  await expect(sheet.getByRole("alert")).toBeVisible();
  await expect(sheet.getByRole("button", { name: "Hierher verschieben", exact: true })).toBeDisabled();
  release();
  await expect(retry).toBeEnabled();
  mode = "success";
  await retry.click();
  await expect(retry).toHaveCount(0);
  await expect(searches.nth(0)).toHaveAttribute("data-fifth-node", "project");
  await expect(searches.nth(1)).toHaveAttribute("data-fifth-node", "parent");
  await expect(searches.nth(0)).toHaveValue("Sticky");
  await expect(searches.nth(1)).toHaveValue("Parent draft");
  await expect(sheet.getByRole("button", { name: project.title, exact: true })).toHaveAttribute("aria-pressed", "true");
});

for (const kind of ["entry", "split"]) {
  test(`final acceptance ${kind} hides revoked preview titles and retains choices for a deliberate fresh preview`, async ({ page }) => {
    const created = await page.request.post("/api/projects", { data: { title: `Private preview ${randomUUID()}` } });
    const project = await created.json();
    const item = await createTask(page, { projectId: project.id });
    await page.goto(`/#/projects/${project.id}`);
    if (kind === "entry") await page.getByRole("button", { name: "Aufgaben hinzufügen", exact: true }).click();
    else {
      await page.getByRole("button", { name: item.title, exact: true }).click();
      await page.getByRole("dialog", { name: "Details", exact: true }).getByRole("button", { name: "Aktionen", exact: true }).click();
      await page.getByRole("dialog", { name: "Aktionen", exact: true }).getByRole("button", { name: "Struktur ändern", exact: true }).click();
      await page.getByRole("dialog").last().getByRole("button", { name: /Teilaufgaben/ }).click();
    }
    const sheet = page.getByRole("dialog", { name: kind === "entry" ? "Aufgaben hinzufügen" : "Aufgabe aufteilen", exact: true });
    const editor = sheet.getByPlaceholder("Schritt …").first();
    await editor.fill("Retained preview step");
    await editor.evaluate(element => element.setAttribute("data-acceptance-node", "preview"));
    await sheet.getByText("Planung (optional)", { exact: true }).first().click();
    await sheet.getByLabel("Fällig", { exact: true }).first().fill("2030-12-10");
    await sheet.getByLabel("Fällig", { exact: true }).first().press("Tab");
    const submit = sheet.getByRole("button", { name: kind === "entry" ? "Aufgabe hinzufügen" : "1 Teilaufgabe anlegen", exact: true });
    await submit.click();
    const driver = sheet.getByLabel(`Verantwortlich für „${project.title}“`);
    await driver.selectOption({ index: 1 });
    const choice = await driver.inputValue();
    let mode: "denied" | "failed" | "success" = "denied";
    let commands = 0;
    let previews = 0;
    await page.route(`**/api/projects/${project.id}`, async route => {
      if (route.request().method() !== "GET" || mode === "success") await route.continue();
      else await route.fulfill({ status: mode === "denied" ? 403 : 503, contentType: "application/json",
        body: JSON.stringify({ error: { message: "Preview source unavailable" } }) });
    });
    const batchPath = kind === "entry" ? `**/api/projects/${project.id}/tasks/batch` : `**/api/tasks/${item.id}/children/batch`;
    await page.route(batchPath, async route => {
      if (route.request().headers()["x-machbar-preview"] === "activation") previews += 1;
      else if (route.request().method() === "POST") commands += 1;
      await route.continue();
    });
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    const retry = sheet.getByRole("button", { name: "Erneut versuchen", exact: true });
    await expect(retry).toBeVisible();
    await expect(driver).toHaveCount(0);
    await expect(sheet.getByText(project.title, { exact: false })).toHaveCount(0);
    await expect(submit).toBeDisabled();
    mode = "failed";
    const failed = page.waitForResponse(response => response.url().endsWith(`/api/projects/${project.id}`) && response.status() === 503);
    await retry.click();
    await failed;
    await expect(retry).toBeEnabled();
    await expect(driver).toHaveCount(0);
    const title = `Fresh preview ${randomUUID()}`;
    const changed = await page.request.patch(`/api/projects/${project.id}`, { data: { expectedRevision: project.revision, title } });
    expect(changed.ok()).toBeTruthy();
    const latest = await changed.json();
    mode = "success";
    await retry.click();
    await expect(retry).toHaveCount(0);
    await expect(driver).toHaveCount(0);
    await expect(sheet.getByLabel(`Verantwortlich für „${title}“`)).toHaveCount(0);
    await expect(editor).toHaveAttribute("data-acceptance-node", "preview");
    await expect(editor).toHaveValue("Retained preview step");
    expect(commands).toBe(0);
    expect(previews).toBe(0);
    await submit.click();
    await expect(sheet.getByLabel(`Verantwortlich für „${title}“`)).toHaveValue(choice);
    expect(commands).toBe(0);
    expect(previews).toBe(1);
    const bodies: Array<Record<string, unknown>> = [];
    await page.route(batchPath, async route => {
      if (route.request().headers()["x-machbar-preview"] !== "activation") bodies.push(route.request().postDataJSON());
      await route.continue();
    });
    await submit.click();
    await expect.poll(() => bodies.length).toBe(1);
    if (kind === "entry") expect(bodies[0]).toMatchObject({ expectedRevision: latest.revision });
    else expect(bodies[0]!.expectedProjectRevisions).toContainEqual({ projectId: project.id, revision: latest.revision });
  });
}

for (const kind of ["entry", "split"]) {
  test(`fifth review ${kind} owns read recovery without losing its step editor`, async ({ page }) => {
    const created = await page.request.post("/api/projects", { data: { title: `Batch retry ${randomUUID()}` } });
    const project = await created.json();
    const item = await createTask(page, { projectId: project.id });
    await page.goto(`/#/projects/${project.id}`);
    if (kind === "entry") await page.getByRole("button", { name: "Aufgaben hinzufügen", exact: true }).click();
    else {
      await page.getByRole("button", { name: item.title, exact: true }).click();
      await page.getByRole("dialog", { name: "Details", exact: true }).getByRole("button", { name: "Aktionen", exact: true }).click();
      await page.getByRole("dialog", { name: "Aktionen", exact: true }).getByRole("button", { name: "Struktur ändern", exact: true }).click();
      await page.getByRole("dialog").last().getByRole("button", { name: /Teilaufgaben/ }).click();
    }
    const sheet = page.getByRole("dialog", { name: kind === "entry" ? "Aufgaben hinzufügen" : "Aufgabe aufteilen", exact: true });
    const editor = sheet.getByPlaceholder("Schritt …").first();
    await editor.fill("Keep own recovery editor");
    await editor.evaluate(element => element.setAttribute("data-fifth-node", "batch"));
    let mode: "denied" | "failed" | "success" = "denied";
    let commands = 0;
    await page.route(`**/api/projects/${project.id}`, async route => {
      if (mode === "success") await route.continue();
      else await route.fulfill({ status: mode === "denied" ? 403 : 503, contentType: "application/json", body: JSON.stringify({ error: { message: "Batch read unavailable" } }) });
    });
    const batchPath = kind === "entry" ? `**/api/projects/${project.id}/tasks/batch` : `**/api/tasks/${item.id}/children/batch`;
    await page.route(batchPath, async route => { if (route.request().method() === "POST") commands += 1; await route.continue(); });
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    const retry = sheet.getByRole("button", { name: "Erneut versuchen", exact: true });
    await expect(retry).toBeVisible();
    mode = "failed";
    await retry.click();
    await expect(retry).toBeEnabled();
    await expect(editor).toHaveAttribute("data-fifth-node", "batch");
    await expect(editor).toHaveValue("Keep own recovery editor");
    mode = "success";
    await retry.click();
    await expect(retry).toHaveCount(0);
    await expect(editor).toHaveAttribute("data-fifth-node", "batch");
    await expect(editor).toHaveValue("Keep own recovery editor");
    expect(commands).toBe(0);
  });
}

test("fifth review activation refreshes the actual revision while preserving choices", async ({ page }) => {
  const createdParent = await page.request.post("/api/projects", { data: { title: `Activation parent ${randomUUID()}` } });
  const parent = await createdParent.json();
  const created = await page.request.post("/api/projects", { data: { title: `Activation child ${randomUUID()}`, parentId: parent.id } });
  const child = await created.json();
  await page.goto(`/#/projects/${child.id}`);
  await page.getByRole("button", { name: "Aktionen", exact: true }).first().click();
  await page.getByRole("dialog", { name: "Aktionen", exact: true }).getByRole("button", { name: "Projekt starten", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "Projekt starten", exact: true });
  await sheet.getByLabel(`Verantwortlich für „${child.title}“`).selectOption({ index: 1 });
  const selectedDriver = await sheet.getByLabel(`Verantwortlich für „${child.title}“`).inputValue();
  const next = sheet.getByLabel("Welcher konkrete nächste Schritt bringt das Projekt voran?");
  await next.fill("Preserved ancestor choices");
  const updatedTitle = `Accepted activation ${randomUUID()}`;
  const changed = await page.request.patch(`/api/projects/${child.id}`, { data: {
    expectedRevision: child.revision, notes: "New actual revision", title: updatedTitle,
  } });
  expect(changed.ok()).toBeTruthy();
  const latest = await changed.json();
  const reads: Array<Record<string, unknown>> = [];
  await page.route(`**/api/projects/${child.id}/activate`, async route => { reads.push(route.request().postDataJSON()); await route.continue(); });
  const refreshed = page.waitForResponse(response => response.url().endsWith(`/api/projects/${child.id}`) && response.request().method() === "GET");
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await refreshed;
  await expect(sheet.getByLabel(`Verantwortlich für „${updatedTitle}“`)).toHaveValue(selectedDriver);
  await expect(next).toHaveValue("Preserved ancestor choices");
  expect(reads).toHaveLength(0);
  await sheet.getByRole("button", { name: "Projekt starten", exact: true }).click();
  await expect.poll(() => reads.length).toBe(1);
  const resolution = reads[0]!.activationResolution as { expectedProjects: Array<{ projectId: number; revision: number }> };
  expect(reads[0]).toMatchObject({ expectedRevision: latest.revision });
  expect(resolution.expectedProjects).toContainEqual({ projectId: child.id, revision: latest.revision });
});

test("fifth review conversion uses fresh host dependencies and revision despite a failed local refresh", async ({ page }) => {
  const item = await createTask(page, { scheduledDate: "2030-12-01" });
  const prerequisite = await createTask(page);
  let initialReads = 0;
  let recoveredReads = 0;
  let recover = false;
  await page.route(`**/api/tasks/${item.id}`, async route => {
    if (route.request().method() !== "GET") { await route.continue(); return; }
    if (!recover) initialReads += 1;
    else if (++recoveredReads > 2) { await route.abort("failed"); return; }
    await route.continue();
  });
  await page.goto(`/#/tasks/${item.id}`);
  await page.getByRole("dialog", { name: "Details", exact: true }).getByRole("button", { name: "Aktionen", exact: true }).click();
  await page.getByRole("dialog", { name: "Aktionen", exact: true }).getByRole("button", { name: "Struktur ändern", exact: true }).click();
  await page.getByRole("dialog").last().getByRole("button", { name: "In Projekt umwandeln", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: /^In Projekt umwandeln:/ });
  const authored = sheet.getByRole("textbox", { name: "Bisherige Aufgabe als Arbeitsschritt fortführen", exact: true });
  await authored.fill("Keep real conversion draft");
  await expect.poll(() => initialReads).toBeGreaterThanOrEqual(4);
  recover = true;
  const changed = await page.request.post(`/api/tasks/${item.id}/dependencies`, { data: { expectedRevision: item.revision, dependsOnTaskId: prerequisite.id } });
  expect(changed.ok()).toBeTruthy();
  const latest = await changed.json();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(sheet.getByLabel(`Diese Aufgabe hängt ab von: ${prerequisite.title}`)).toBeVisible();
  await expect(authored).toHaveValue("Keep real conversion draft");
  await expect.poll(() => recoveredReads).toBeGreaterThan(2);
  const commands: Array<Record<string, unknown>> = [];
  await page.route(`**/api/tasks/${item.id}/convert-to-story`, async route => { commands.push(route.request().postDataJSON()); await route.continue(); });
  await sheet.getByRole("button", { name: "In Projekt umwandeln", exact: true }).click();
  await expect.poll(() => commands.length).toBe(1);
  expect(commands[0]).toMatchObject({ expectedRevision: latest.revision, preservedStepTitle: "Keep real conversion draft" });
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

test("a project workflow denial hides the page until a shared fresh query restores authority", async ({ page }) => {
  const response = await page.request.post("/api/projects", { data: { title: `Private recovery project ${randomUUID()}` } });
  expect(response.status()).toBe(201);
  const item = await response.json();
  await page.goto(`/#/projects/${item.id}`);
  await expect(page.getByRole("heading", { name: item.title, exact: true })).toBeVisible();
  let denied = true;
  let projectGets = 0;
  await page.route(`**/api/projects/${item.id}`, async route => {
    if (route.request().method() === "GET") projectGets += 1;
    if (denied) await route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { message: "Read denied" } }) });
    else await route.continue();
  });
  await page.locator('[aria-label="Verantwortlich"] button').first().click();
  const workflow = page.getByRole("dialog");
  await expect(workflow.getByRole("alert")).toBeVisible();
  await expect(page.getByRole("heading", { name: item.title, exact: true, includeHidden: true })).toHaveCount(0);
  denied = false;
  const recoveredRead = page.waitForResponse(response =>
    response.url().endsWith(`/api/projects/${item.id}`) &&
    response.request().method() === "GET",
  );
  await workflow.getByRole("button", { name: "Erneut versuchen", exact: true }).click();
  expect((await recoveredRead).status()).toBe(200);
  await expect(workflow).toHaveAccessibleName(`Verantwortliche Person zuweisen: ${item.title}`);
  const readsAfterRecovery = projectGets;
  await expect(page.getByRole("heading", { name: item.title, exact: true, includeHidden: true })).toHaveCount(1);
  await workflow.getByRole("button", { name: "Abbrechen", exact: true }).click();
  await expect(workflow).toHaveCount(0);
  await expect(page.getByRole("heading", { name: item.title, exact: true })).toBeVisible();
  expect(projectGets).toBe(readsAfterRecovery);
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

test("Today does not surface a future recurring plan from its reached revisit", async ({ page }) => {
  const item = await createTask(page, {
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
