import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";

// Use the real application, mutation providers and isolated API/database.
test.beforeEach(async ({ page }) => {
  const member = await (await page.request.post("/api/members", { data: { name: `Details ${randomUUID()}` } })).json();
  await page.addInitScript(id => {
    localStorage.setItem("machbar:identity-member-id", String(id));
    localStorage.setItem("machbar:locale", "de");
  }, member.id);
});
async function create(page: Page, role: "task" | "project", notes = "") {
  const path = role === "task" ? "/api/tasks" : "/api/projects";
  const response = await page.request.post(path, { data: { title: `Details ${randomUUID()}`, notes, ...(role === "task" ? { status: "actionable" } : {}) } });
  expect(response.status()).toBe(201);
  return { item: await response.json(), path };
}

for (const role of ["task", "project"] as const) {
  test(`${role} notes measure actual overflow, group actions, expand and edit in the document`, async ({ page }, info) => {
    const notes = Array.from({ length: 12 }, (_, i) => `Paragraph ${i}: **Keep this context** with several words that wrap on a narrow screen.`).join("\n\n") + "\n\n- [ ] A pending point\n- [x] A completed point\n\n[Reference](https://example.com/)";
    const { item } = await create(page, role, notes);
    await page.goto(`/#/${role === "task" ? "tasks" : "projects"}/${item.id}`);
    const section = page.locator(role === "task" ? ".task-notes-section" : ".project-notes-section");
    const preview = section.locator(".detail-notes-preview");
    const more = section.getByRole("button", { name: "Mehr anzeigen", exact: true });
    await expect(more).toBeVisible();
    await expect(more).toHaveAttribute("aria-expanded", "false");
    expect((await preview.boundingBox())!.height).toBeLessThanOrEqual(130);
    expect(await section.evaluate(node => getComputedStyle(node).paddingTop)).not.toBe("0px");
    expect(await section.evaluate(node => getComputedStyle(node).backgroundColor)).not.toBe("rgba(0, 0, 0, 0)");
    expect(await preview.evaluate(node => getComputedStyle(node, "::after").backgroundImage)).toContain("linear-gradient");
    const next = section.locator("xpath=following-sibling::*[1]");
    const sectionBox = (await section.boundingBox())!;
    expect((await next.boundingBox())!.y - sectionBox.y - sectionBox.height).toBeLessThan(50);
    await page.screenshot({ path: info.outputPath(`${role}-notes-collapsed.png`), fullPage: true });
    await more.focus();
    await page.keyboard.press("Enter");
    const less = section.getByRole("button", { name: "Weniger anzeigen", exact: true });
    await expect(less).toHaveAttribute("aria-expanded", "true");
    expect((await preview.boundingBox())!.height).toBeGreaterThan(130);
    expect(await preview.evaluate(node => getComputedStyle(node).overflowY)).toBe("visible");
    expect(await preview.evaluate(node => getComputedStyle(node).opacity)).toBe("1");
    expect(await preview.evaluate(node => getComputedStyle(node, "::after").content)).toBe("none");
    await expect(section.getByRole("link", { name: "Reference", exact: true })).toHaveAttribute("href", "https://example.com/");
    await expect(section.getByRole("checkbox")).toHaveCount(2);
    await less.click();
    await expect(more).toBeVisible();
    await section.getByRole("button", { name: "Bearbeiten", exact: true }).click();
    const editor = section.getByRole("textbox", { name: "Notizen", exact: true });
    await editor.focus();
    await editor.press("ControlOrMeta+End");
    await expect(editor).toContainText("Paragraph 11");
    await editor.press("ControlOrMeta+A");
    await page.keyboard.insertText("Discard this draft");
    await section.getByRole("button", { name: "Abbrechen", exact: true }).click();
    await expect(more).toBeVisible();
    await section.getByRole("button", { name: "Bearbeiten", exact: true }).click();
    await editor.press("ControlOrMeta+A");
    await page.keyboard.insertText("Short note with a [link](https://example.com/).");
    await section.getByRole("button", { name: "Notizen speichern", exact: true }).click();
    await expect(section.getByRole("link", { name: "link", exact: true })).toBeVisible();
    await expect(more).toHaveCount(0);
    expect(await preview.evaluate(node => getComputedStyle(node).opacity)).toBe("1");
    await section.getByRole("button", { name: "Notiz hinzufügen", exact: true }).click();
    await section.getByRole("textbox", { name: "Notiz hinzufügen", exact: true }).fill("Appended context");
    await section.getByRole("button", { name: "Notiz hinzufügen", exact: true }).click();
    await expect(section).toContainText("Appended context");
    await expect(section).toContainText("Short note");
  });

  for (const outcome of ["success", "write-failure", "read-failure"] as const) {
    test(`${role} status feedback spans independently delayed write/read (${outcome})`, async ({ page }) => {
      const { item, path } = await create(page, role);
      let releaseWrite!: () => void, releaseRead!: () => void;
      const write = new Promise<void>(resolve => { releaseWrite = resolve; });
      const read = new Promise<void>(resolve => { releaseRead = resolve; });
      let writes = 0, readStarted = false, failRead = outcome === "read-failure";
      await page.route(`**${path}/${item.id}/${role === "task" ? "complete" : "archive"}`, async route => {
        writes++;
        await write;
        if (outcome === "write-failure") await route.fulfill({ status: 503, json: { error: { code: "internal_error", message: "Write unavailable" } } });
        else await route.continue();
      });
      await page.route(`**${path}/${item.id}`, async route => {
        if (route.request().method() !== "GET" || writes === 0) { await route.continue(); return; }
        readStarted = true;
        await read;
        if (failRead) await route.fulfill({ status: 503, json: { error: { code: "internal_error", message: "Refresh unavailable" } } });
        else await route.continue();
      });
      await page.goto(`/#/${role === "task" ? "tasks" : "projects"}/${item.id}`);
      const status = page.locator(".detail-meta-status-button");
      await expect(status).toHaveAttribute("aria-expanded", "false");
      const originalStatus = (await status.textContent())!;
      const row = role === "task" ? page.locator(".detail-status-row") : page.locator(".project-detail-overview-row");
      expect((await row.boundingBox())!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
      await status.focus();
      await page.keyboard.press("Enter");
      await expect(status).toHaveAttribute("aria-expanded", "true");
      if (role === "task") await page.getByRole("group", { name: "Status", exact: true }).getByRole("button", { name: "Aufgabe abschließen", exact: true }).click();
      else await page.locator('[data-workflow-action="archive"]').click();
      await expect.poll(() => writes).toBe(1);
      await expect(status).toContainText("Wird gespeichert");
      await expect(status).toBeDisabled();
      releaseWrite();
      if (outcome === "write-failure") {
        await expect(status).toHaveText(originalStatus);
        await expect(page.getByRole("alert")).toBeVisible();
        expect(readStarted).toBe(false);
        releaseRead();
        return;
      }
      await expect.poll(() => readStarted).toBe(true);
      await expect(status).toContainText("Wird gespeichert");
      await expect(status).toBeDisabled();
      releaseRead();
      if (outcome === "read-failure") {
        await expect(page.getByRole("alert")).toContainText("Details konnten nicht aktualisiert werden");
        await expect(status).toHaveText(originalStatus);
        failRead = false;
        await page.getByRole("button", { name: "Erneut versuchen", exact: true }).click();
      }
      await expect(status).toContainText(role === "task" ? "Erledigt" : "Archiviert");
      await expect(status).toBeEnabled();
      expect(writes).toBe(1);
    });
  }
}

test("task descendant confirmation hands saving feedback back to details", async ({ page }) => {
  const { item } = await create(page, "task");
  expect((await page.request.post("/api/tasks", { data: { title: "Child to retain", status: "actionable", parentTaskId: item.id } })).status()).toBe(201);
  let releaseWrite!: () => void, releaseRead!: () => void;
  const write = new Promise<void>(resolve => { releaseWrite = resolve; });
  const read = new Promise<void>(resolve => { releaseRead = resolve; });
  let writing = false, reading = false;
  await page.route(`**/api/tasks/${item.id}/complete`, async route => { writing = true; await write; await route.continue(); });
  await page.route(`**/api/tasks/${item.id}`, async route => {
    if (writing) { reading = true; await read; }
    await route.continue();
  });
  await page.goto(`/#/tasks/${item.id}`);
  await page.getByRole("button", { name: "Erledigen", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Diese Aufgabe hat offene Teilaufgaben.", exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: /Nur diese Aufgabe/ }).click();
  await expect.poll(() => writing).toBe(true);
  await expect(page.locator(".detail-meta-status-button")).toContainText("Wird gespeichert");
  releaseWrite();
  await expect.poll(() => reading).toBe(true);
  await expect(page.locator(".detail-meta-status-button")).toContainText("Wird gespeichert");
  releaseRead();
  await expect(page.locator(".detail-meta-status-button")).toContainText("Erledigt");
  await expect(page.getByRole("button", { name: "Child to retain", exact: true })).toBeVisible();
});
