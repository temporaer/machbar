import { test, expect, type Page } from "@playwright/test";
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
