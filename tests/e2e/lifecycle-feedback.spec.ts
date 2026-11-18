import { test, expect, type Page } from "@playwright/test";
import type { Task } from "@machbar/shared";
import { randomUUID } from "node:crypto";

const memberIds = new WeakMap<Page, number>();
test.beforeEach(async ({ page, request }) => {
  const response = await request.post("/api/members", { data: { name: `Feedback ${randomUUID()}` } });
  expect(response.status()).toBe(201);
  const member = await response.json();
  memberIds.set(page, member.id);
  await page.addInitScript(id => {
    localStorage.setItem("machbar:identity-member-id", String(id));
    localStorage.setItem("machbar:locale", "de");
    sessionStorage.setItem("machbar:today-scope", "mine");
  }, member.id);
});

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

async function waitingTask(page: Page, extra: Partial<Task> = {}): Promise<Task> {
  const response = await page.request.post("/api/tasks", {
    data: { title: `Feedback task ${randomUUID()}`, status: "actionable", ownerMemberId: memberIds.get(page), ownerInheritanceMode: "explicit", ...extra },
  });
  expect(response.status()).toBe(201);
  const task = await response.json();
  const waiting = await page.request.put(`/api/tasks/${task.id}/external-wait`, {
    data: { waitingFor: "Supplier", expectedRevision: task.revision },
  });
  expect(waiting.ok()).toBe(true);
  return waiting.json();
}

function row(page: Page, task: Task) {
  return page.locator(`.waiting-page [data-workitem-id="${task.id}"]`);
}

async function completeRow(page: Page, task: Task, mobile: boolean) {
  const source = row(page, task);
  await expect(source).toBeVisible();
  await source.scrollIntoViewIfNeeded();
  if (!mobile) {
    const complete = source.getByRole("button", { name: "Erledigt", exact: true });
    await complete.focus();
    await page.keyboard.press("Space");
    return;
  }
  const box = await source.locator(".task-row-content").boundingBox();
  expect(box).not.toBeNull();
  const x = box!.x + 50, y = box!.y + box!.height / 2;
  const touch = await page.context().newCDPSession(page);
  await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  for (const distance of [25, 50, 75, 96]) {
    await touch.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x + distance, y }] });
  }
  await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await touch.detach();
}

function confirmation(page: Page) {
  return page.getByRole("status").filter({ hasText: /erledigt\.$/ });
}

test("slow write decorates the live row, then confirms commit before the held refresh", async ({ page, isMobile }) => {
  const task = await waitingTask(page);
  const write = gate(), refresh = gate();
  let committed = false, writes = 0;
  await page.route(`**/api/tasks/${task.id}/complete`, async route => {
    writes++;
    await write.promise;
    const response = await route.fetch();
    committed = true;
    await route.fulfill({ response });
  });
  await page.route("**/api/waiting?**", async route => {
    if (committed) await refresh.promise;
    await route.continue();
  });
  await page.goto("/#/waiting");
  await completeRow(page, task, isMobile);
  await expect(row(page, task).getByRole("status")).toHaveText("Wird erledigt …");
  await expect(row(page, task).locator(".task-row-kebab")).toBeDisabled();
  await expect(confirmation(page)).toHaveCount(0);
  expect((await (await page.request.get(`/api/tasks/${task.id}`)).json()).status).toBe("actionable");
  write.release();
  await expect(confirmation(page)).toHaveText(`„${task.title}“ erledigt.`);
  await expect(row(page, task)).toBeVisible();
  await expect(row(page, task).getByRole("status")).toHaveCount(0);
  await expect(row(page, task).locator(".task-row-kebab")).toBeDisabled();
  expect(writes).toBe(1);
  refresh.release();
  await expect(row(page, task)).toHaveCount(0);
  await expect(confirmation(page)).toBeVisible();
});

test("fast commit leaves a visible accessible confirmation for three seconds without destination scrolling", async ({ page, isMobile }) => {
  const task = await waitingTask(page);
  await page.goto("/#/waiting");
  await expect(row(page, task)).toBeVisible();
  await row(page, task).scrollIntoViewIfNeeded();
  const scroll = await page.evaluate(() => window.scrollY);
  await completeRow(page, task, isMobile);
  await expect(row(page, task)).toHaveCount(0);
  const notice = confirmation(page);
  await expect(notice).toHaveText(`„${task.title}“ erledigt.`);
  await expect(notice).toBeInViewport();
  expect(await notice.evaluate(element => element.closest("[inert], [aria-hidden=true]"))).toBeNull();
  // Removing a row at the document end may naturally clamp the scroll position.
  const after = await page.evaluate(() => ({
    scroll: window.scrollY,
    maximum: Math.max(0, document.documentElement.scrollHeight - window.innerHeight),
  }));
  expect(Math.abs(after.scroll - Math.min(scroll, after.maximum))).toBeLessThanOrEqual(1);
  await page.waitForTimeout(2_500);
  await expect(notice).toBeVisible();
  await expect(notice).toHaveCount(0);
});

test("a real stale-write rejection removes pending, keeps the authoritative row and never confirms success", async ({ page, isMobile }) => {
  const task = await waitingTask(page);
  const write = gate();
  await page.route(`**/api/tasks/${task.id}/complete`, async route => {
    await write.promise;
    const changed = await page.request.patch(`/api/tasks/${task.id}`, {
      data: { notes: "Changed after command acceptance", expectedRevision: task.revision },
    });
    expect(changed.ok()).toBe(true);
    await route.continue();
  });
  await page.goto("/#/waiting");
  await completeRow(page, task, isMobile);
  await expect(row(page, task).getByRole("status")).toHaveText("Wird erledigt …");
  const rejection = page.waitForResponse(response => response.url().endsWith(`/tasks/${task.id}/complete`));
  write.release();
  expect((await rejection).status()).toBe(409);
  await expect(row(page, task).getByRole("status")).toHaveCount(0);
  await expect(row(page, task).getByRole("alert")).toBeVisible();
  await expect(row(page, task)).toBeVisible();
  await expect(confirmation(page)).toHaveCount(0);
  const stored = await (await page.request.get(`/api/tasks/${task.id}`)).json();
  expect(stored.status).toBe("actionable");
  expect(stored.notes).toBe("Changed after command acceptance");
});

test("committed write with failed refresh keeps success separate, blocks stale row commands and retries reads only", async ({ page, isMobile }) => {
  const task = await waitingTask(page);
  let committed = false, failRefresh = true, writes = 0;
  await page.route(`**/api/tasks/${task.id}/complete`, async route => {
    writes++;
    const response = await route.fetch();
    committed = true;
    await route.fulfill({ response });
  });
  await page.route("**/api/waiting?**", async route => {
    if (committed && failRefresh) await route.abort("failed");
    else await route.continue();
  });
  await page.goto("/#/waiting");
  await completeRow(page, task, isMobile);
  await expect(confirmation(page)).toHaveText(`„${task.title}“ erledigt.`);
  await expect(page.locator(".waiting-page > .error-state")).toBeVisible();
  await expect(row(page, task)).toBeVisible();
  await expect(row(page, task).locator("xpath=ancestor::div[@inert]")).toHaveCount(1);
  await expect(row(page, task).getByRole("alert")).toHaveCount(0);
  await page.keyboard.press("m");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const box = await row(page, task).boundingBox();
  await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(writes).toBe(1);
  expect((await (await page.request.get(`/api/tasks/${task.id}`)).json()).status).toBe("done");
  await expect(confirmation(page)).toHaveCount(0);
  await expect(page.locator(".waiting-page > .error-state")).toBeVisible();
  failRefresh = false;
  await page.getByRole("button", { name: "Erneut versuchen", exact: true }).click();
  await expect(row(page, task)).toHaveCount(0);
  await expect(page.locator(".waiting-page > .error-state")).toHaveCount(0);
  await expect(confirmation(page)).toHaveCount(0);
  expect(writes).toBe(1);
});

test("detail completion confirms success above the open modal while the source row disappears", async ({ page }) => {
  const task = await waitingTask(page);
  await page.goto("/#/waiting");
  await row(page, task).getByRole("button", { name: task.title, exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Details", exact: true });
  await dialog.getByRole("button", { name: /^Status / }).click();
  await dialog.getByRole("button", { name: "Aufgabe abschließen", exact: true }).click();
  const notice = confirmation(page);
  await expect(notice).toHaveText(`„${task.title}“ erledigt.`);
  await expect(notice).toBeInViewport();
  expect(await notice.evaluate(element => element.closest("[inert], [aria-hidden=true]"))).toBeNull();
  const stored = await (await page.request.get(`/api/tasks/${task.id}`)).json();
  expect(stored.status).toBe("done");
  await expect(row(page, task)).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await page.route(`**/api/tasks/${task.id}`, route =>
    route.fulfill({ status: 403, json: { error: { code: "forbidden", message: "Access revoked" } } }));
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(confirmation(page)).toHaveCount(0);
  await expect(dialog.getByRole("alert")).toBeVisible();
});

test("route retirement during detail completion still invalidates the current view without a late notice", async ({ page }) => {
  const task = await waitingTask(page);
  const write = gate();
  await page.route(`**/api/tasks/${task.id}/complete`, async route => {
    await write.promise;
    await route.continue();
  });
  await page.goto("/#/waiting");
  await row(page, task).getByRole("button", { name: task.title, exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Details", exact: true });
  await dialog.getByRole("button", { name: /^Status / }).click();
  await dialog.getByRole("button", { name: "Aufgabe abschließen", exact: true }).click();
  await expect(dialog.getByRole("status")).toHaveText("Wird erledigt …");
  await page.evaluate(() => { window.location.hash = "#/today"; });
  await expect(page.locator(".today-page")).toBeVisible();
  await expect(page.locator(".today-page .loading-state")).toHaveCount(0);
  const refresh = page.waitForResponse(response => new URL(response.url()).pathname === "/api/agenda/today");
  write.release();
  expect((await refresh).ok()).toBe(true);
  await expect(dialog.getByRole("status")).toHaveCount(0);
  await expect(confirmation(page)).toHaveCount(0);
  await dialog.getByRole("button", { name: "Schließen", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole("link", { name: "Wartet", exact: true }).click();
  await expect(row(page, task)).toHaveCount(0);
  await expect(confirmation(page)).toHaveCount(0);
});

for (const retirement of ["view", "scope", "access"] as const) {
  test(`completion feedback retires on ${retirement} loss and cannot reappear`, async ({ page, isMobile }) => {
    const task = await waitingTask(page);
    const write = gate();
    let denyReads = false;
    await page.route(`**/api/tasks/${task.id}/complete`, async route => {
      await write.promise;
      await route.continue();
    });
    await page.route("**/api/waiting?**", async route => {
      if (denyReads) await route.fulfill({ status: 403, json: { error: { code: "forbidden", message: "Access revoked" } } });
      else await route.continue();
    });
    await page.goto("/#/waiting");
    await completeRow(page, task, isMobile);
    await expect(row(page, task).getByRole("status")).toBeVisible();
    if (retirement === "view") {
      await page.getByRole("link", { name: "Heute", exact: true }).click();
    } else if (retirement === "scope") {
      await page.getByRole("button", { name: "Wartende Aufgaben aller Personen anzeigen", exact: true }).click();
    } else {
      denyReads = true;
      // The app's existing focus invalidation is independent of the pending write.
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await expect(page.locator(".waiting-page > .error-state")).toBeVisible();
      await expect(row(page, task)).toHaveCount(0);
    }
    const completion = page.waitForResponse(response => response.url().endsWith(`/tasks/${task.id}/complete`));
    write.release();
    expect((await completion).ok()).toBe(true);
    await expect(confirmation(page)).toHaveCount(0);
    if (retirement === "view") {
      await page.getByRole("link", { name: "Wartet", exact: true }).click();
      await expect(page.locator(".waiting-page")).toBeVisible();
    }
    await expect(confirmation(page)).toHaveCount(0);
  });
}
