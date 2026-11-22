import { test, expect, type Page } from "@playwright/test";
import type { Task } from "@machbar/shared";
import { randomUUID } from "node:crypto";

const memberIds = new WeakMap<Page, number>();

test.beforeEach(async ({ page, request }) => {
  const response = await request.post("/api/members", {
    data: { name: `Completion ${randomUUID()}` },
  });
  expect(response.status()).toBe(201);
  const member = await response.json();
  memberIds.set(page, member.id);
  await page.addInitScript(id => {
    localStorage.setItem("machbar:identity-member-id", String(id));
    localStorage.setItem("machbar:locale", "de");
    sessionStorage.setItem("machbar:today-scope", "mine");
  }, member.id);
});

async function createTask(page: Page, title: string, extra: Record<string, unknown> = {}): Promise<Task> {
  const response = await page.request.post("/api/tasks", {
    data: {
      title,
      status: "actionable",
      ownerMemberId: memberIds.get(page),
      ownerInheritanceMode: "explicit",
      ...extra,
    },
  });
  expect(response.status()).toBe(201);
  return response.json();
}

async function completeRow(page: Page, taskId: number, mobile: boolean) {
  const source = page.locator(`[data-workitem-id="${taskId}"]`).first();
  await expect(source).toBeVisible();
  await source.scrollIntoViewIfNeeded();
  if (!mobile) {
    await source.getByRole("button", { name: "Erledigt", exact: true }).click();
    return;
  }
  const box = await source.locator(".task-row-content").boundingBox();
  expect(box).not.toBeNull();
  const x = box!.x + 50;
  const y = box!.y + box!.height / 2;
  const touch = await page.context().newCDPSession(page);
  await touch.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x, y }],
  });
  for (const distance of [25, 50, 75, 96]) {
    await touch.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: x + distance, y }],
    });
  }
  await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await touch.detach();
}

const views = [
  {
    name: "Today",
    setup: async (page: Page) => ({
      path: "/#/today",
      task: await createTask(page, `Today ${randomUUID()}`, { dueDate: "2000-01-01" }),
    }),
  },
  {
    name: "Inbox",
    setup: async (page: Page) => ({
      path: "/#/inbox",
      task: await createTask(page, `Inbox ${randomUUID()}`, { needsClarification: true }),
    }),
  },
  {
    name: "All",
    setup: async (page: Page) => ({
      path: "/#/more/all",
      task: await createTask(page, `All ${randomUUID()}`),
    }),
  },
  {
    name: "Discussion",
    setup: async (page: Page) => {
      const task = await createTask(page, `Discussion ${randomUUID()}`);
      const response = await page.request.patch(`/api/tasks/${task.id}`, {
        data: { discussionRequested: true, expectedRevision: task.revision },
      });
      expect(response.ok()).toBe(true);
      return { path: "/#/more/discussion", task: await response.json() as Task };
    },
  },
  {
    name: "project outline",
    setup: async (page: Page) => {
      const response = await page.request.post("/api/projects", {
        data: { title: `Project ${randomUUID()}` },
      });
      expect(response.status()).toBe(201);
      const project = await response.json();
      const task = await createTask(page, `Project task ${randomUUID()}`, {
        projectId: project.id,
      });
      return { path: `/#/projects/${project.id}`, task };
    },
  },
] as const;

for (const view of views) {
  test(`${view.name} shows the completion acknowledgement in its source view`, async ({ page, isMobile }) => {
    const { task, path } = await view.setup(page);
    await page.clock.install();
    await page.goto(path);
    if (isMobile && view.name === "All") {
      const row = page.locator(`[data-workitem-id="${task.id}"]`);
      await row.getByRole("button", { name: task.title, exact: true }).click();
      const detail = page.getByRole("dialog", { name: "Details", exact: true });
      await detail.getByRole("button", { name: /^Status / }).click();
      await detail.getByRole("button", { name: "Aufgabe abschließen", exact: true }).click();
    } else {
      await completeRow(page, task.id, isMobile);
    }
    const notice = page.locator(".view-completion-notice");
    const inlineAcknowledgement = !(view.name === "All" && isMobile);
    if (inlineAcknowledgement) {
      const source = page.locator(`[data-workitem-id="${task.id}"]`).first();
      await expect(source.locator(".task-row-title")).toHaveClass(/done/);
      await expect(notice).toHaveCount(0);
    } else {
      await expect(notice).toHaveText(`„${task.title}“ erledigt.`);
      await expect(notice).toBeInViewport();
      expect(await notice.evaluate(element => element.closest("[inert], [aria-hidden=true]"))).toBeNull();
    }
    expect((await (await page.request.get(`/api/tasks/${task.id}`)).json()).status).toBe("done");

    if (view.name === "Inbox") {
      if (inlineAcknowledgement) await expect(page.locator(`[data-workitem-id="${task.id}"]`)).toHaveCount(1);
      else {
        await expect(page.locator(`[data-workitem-id="${task.id}"]`)).toHaveCount(0);
        if (await page.locator(".inbox-page [data-workitem-id]").count() === 0) {
          await expect(page.getByText("Der Eingang ist leer. Gute Arbeit!")).toBeVisible();
        }
      }
    } else if (view.name !== "Today") {
      await expect(page.locator(`[data-workitem-id="${task.id}"]`)).toHaveCount(1);
    }
    if (inlineAcknowledgement) {
      await page.clock.runFor(3_000);
      await expect(notice).toHaveCount(0);
      if (view.name === "Inbox") await expect(page.locator(`[data-workitem-id="${task.id}"]`)).toHaveCount(0);
    } else await expect(notice).toHaveCount(1);
  });
}

test("a swipe completion stays struck through inside a narrow Today row", async ({ page, isMobile }) => {
  test.skip(!isMobile, "this exercises the touch swipe interaction");
  const task = await createTask(page, `Narrow ${randomUUID()}`, { dueDate: "2000-01-01" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.clock.install();
  await page.goto("/#/today");
  const source = page.locator(`[data-workitem-id="${task.id}"]`).first();
  await expect(source).toBeVisible();
  const title = source.locator(".task-row-title");
  await completeRow(page, task.id, true);
  await expect(title).toHaveClass(/done/);
  await expect(source.locator(".task-row-checkbox")).toBeDisabled();
  await expect(source.getByRole("status")).toHaveText(`„${task.title}“ erledigt.`);
  await expect(page.locator(".view-completion-notice")).toHaveCount(0);
  const bounds = await source.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  await page.clock.runFor(3_000);
  await expect.poll(async () => (await (await page.request.get(`/api/tasks/${task.id}`)).json()).status).toBe("done");
});

test("a criteria completion begun in Inbox cannot notify the replacement All view", async ({ page }) => {
  const task = await createTask(page, `Criteria ${randomUUID()}`, {
    needsClarification: true,
  });
  const added = await page.request.post(`/api/tasks/${task.id}/criteria`, {
    data: { text: "Check the result" },
  });
  expect(added.status()).toBe(201);

  let releaseWrite!: () => void;
  const write = new Promise<void>(resolve => { releaseWrite = resolve; });
  let writing = false;
  await page.route(`**/api/tasks/${task.id}/complete`, async route => {
    writing = true;
    await write;
    await route.continue();
  });

  await page.goto("/#/inbox");
  const source = page.locator(`[data-workitem-id="${task.id}"]`);
  await source.getByRole("button", { name: task.title, exact: true }).click();
  const detail = page.getByRole("dialog", { name: "Details", exact: true });
  await detail.getByRole("button", { name: /^Status / }).click();
  await detail.getByRole("button", { name: "Aufgabe abschließen", exact: true }).click();
  const criteria = page.getByRole("dialog", { name: new RegExp(task.title) });
  await criteria.getByRole("checkbox", { name: "Check the result" }).check();
  await criteria.getByRole("button", { name: "Aufgabe abschließen", exact: true }).click();
  await expect.poll(() => writing).toBe(true);

  await page.evaluate(() => { window.location.hash = "#/more/all"; });
  await expect(page.locator("#all-tasks-heading")).toBeVisible();
  await expect(page.locator(".view-completion-notice")).toHaveCount(0);
  releaseWrite();
  await expect.poll(async () => (await (await page.request.get(`/api/tasks/${task.id}`)).json()).status).toBe("done");
  await expect(page.locator(".view-completion-notice")).toHaveCount(0);
});

test("an All completion finishing after a same-route filter change cannot notify the replacement view", async ({ page, isMobile }) => {
  const task = await createTask(page, `Filtered ${randomUUID()}`);
  let releaseWrite!: () => void;
  const write = new Promise<void>(resolve => { releaseWrite = resolve; });
  let writing = false;
  await page.route(`**/api/tasks/${task.id}/complete`, async route => {
    writing = true;
    await write;
    await route.continue();
  });

  await page.goto("/#/more/all");
  await completeRow(page, task.id, isMobile);
  await expect.poll(() => writing).toBe(true);

  await page.getByRole("button", { name: "Filter", exact: true }).click();
  const replacementQuery = `replacement-${randomUUID()}`;
  const replacementSearch = page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.pathname === "/api/search" && url.searchParams.get("text") === replacementQuery;
  });
  await page.getByRole("textbox", { name: "Suchen" }).fill(replacementQuery);
  expect((await replacementSearch).ok()).toBe(true);
  await expect(page.locator(`[data-workitem-id="${task.id}"]`)).toHaveCount(0);
  await expect(page.locator(".view-completion-notice")).toHaveCount(0);

  const completionRefresh = page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.pathname === "/api/search" && url.searchParams.get("text") === replacementQuery;
  });
  releaseWrite();
  await expect.poll(async () =>
    (await (await page.request.get(`/api/tasks/${task.id}`)).json()).status,
  ).toBe("done");
  expect((await completionRefresh).ok()).toBe(true);
  await expect(page.locator(".view-completion-notice")).toHaveCount(0);
});

test("Inbox row and detail share one completion notice", async ({ page }) => {
  const task = await createTask(page, `Detail ${randomUUID()}`, {
    needsClarification: true,
  });
  await page.goto("/#/inbox");
  const row = page.locator(`[data-workitem-id="${task.id}"]`);
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: task.title, exact: true }).click();
  const detail = page.getByRole("dialog", { name: "Details", exact: true });
  await detail.getByRole("button", { name: /^Status / }).click();
  await detail.getByRole("button", { name: "Aufgabe abschließen", exact: true }).click();
  await expect(source.getByRole("status")).toHaveText(`„${task.title}“ erledigt.`);
  await expect(page.locator(".view-completion-notice")).toHaveCount(0);
  await expect(notice).toHaveCount(1);
  await expect(notice).toBeInViewport();
});

test("a rejected Inbox completion keeps its row and never shows success", async ({ page, isMobile }) => {
  const task = await createTask(page, `Rejected ${randomUUID()}`, {
    needsClarification: true,
  });
  await page.route(`**/api/tasks/${task.id}/complete`, route =>
    route.fulfill({
      status: 503,
      json: { error: { code: "internal_error", message: "Write unavailable" } },
    }));
  await page.goto("/#/inbox");
  const row = page.locator(`[data-workitem-id="${task.id}"]`);
  await completeRow(page, task.id, isMobile);
  await expect(row).toBeVisible();
  await expect(row.getByRole("alert")).toBeVisible();
  await expect(page.locator(".view-completion-notice")).toHaveCount(0);
  expect((await (await page.request.get(`/api/tasks/${task.id}`)).json()).status).toBe("actionable");
});

test("committed Inbox completion with failed refresh keeps stale task rows inert with Retry", async ({ page, isMobile }) => {
  const task = await createTask(page, `Retry ${randomUUID()}`, {
    needsClarification: true,
  });
  let committed = false;
  let failRefresh = false;
  let writes = 0;
  await page.route(`**/api/tasks/${task.id}/complete`, async route => {
    writes++;
    const response = await route.fetch();
    committed = response.ok();
    await route.fulfill({ response });
  });
  await page.route("**/api/inbox?**", async route => {
    if (committed && failRefresh) await route.abort("failed");
    else await route.continue();
  });
  await page.clock.install();
  await page.goto("/#/inbox");
  const source = page.locator(`[data-workitem-id="${task.id}"]`);
  await expect(source).toBeVisible();
  failRefresh = true;
  await completeRow(page, task.id, isMobile);
  await expect(source.getByRole("status")).toHaveText(`„${task.title}“ erledigt.`);
  await expect(page.locator(".view-completion-notice")).toHaveCount(0);
  await page.clock.runFor(3_000);
  await expect(page.locator(".inbox-page > .error-state")).toBeVisible();
  await expect(source.locator("xpath=ancestor::div[@inert]")).toHaveCount(1);
  expect(writes).toBe(1);

  failRefresh = false;
  await page.getByRole("button", { name: "Erneut versuchen", exact: true }).click();
  await expect(page.locator(`[data-workitem-id="${task.id}"]`)).toHaveCount(0);
  await expect(page.locator(".inbox-page > .error-state")).toHaveCount(0);
  expect(writes).toBe(1);
});

test("a recurring task confirms an occurrence rather than terminal completion", async ({ page, isMobile }) => {
  const task = await createTask(page, `Recurring ${randomUUID()}`, {
    repeatAfterDays: 7,
    allowedDeviationDays: 0,
    scheduledDate: new Date().toISOString().slice(0, 10),
  });
  await page.clock.install();
  await page.goto("/#/more/all");
  await completeRow(page, task.id, isMobile);
  const source = page.locator(`[data-workitem-id="${task.id}"]`).first();
  await expect(source.locator(".task-row-title")).toHaveClass(/done/);
  await expect(source.getByRole("status")).toHaveText(`Durchgang von „${task.title}“ erledigt.`);
  await expect(page.locator(".view-completion-notice")).toHaveCount(0);
  expect((await (await page.request.get(`/api/tasks/${task.id}`)).json()).status).toBe("actionable");
});

test("Review detail completion confirms in its initiating view", async ({ page }) => {
  const task = await createTask(page, `Review ${randomUUID()}`, {
    size: "XL",
  });
  await page.goto("/#/more/review");
  const card = page.locator(".review-item").filter({ hasText: task.title });
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "Details öffnen", exact: true }).click();
  const detail = page.getByRole("dialog", { name: "Details", exact: true });
  await detail.getByRole("button", { name: /^Status / }).click();
  await detail.getByRole("button", { name: "Aufgabe abschließen", exact: true }).click();
  await expect(page.locator(".view-completion-notice")).toHaveText(`„${task.title}“ erledigt.`);
  await expect.poll(async () => (await (await page.request.get(`/api/tasks/${task.id}`)).json()).status).toBe("done");
  await expect(card).toHaveCount(0);
});

test("Review cancellation confirms its own action after the card disappears", async ({ page }) => {
  const task = await createTask(page, `Cancel ${randomUUID()}`, { size: "XL" });
  await page.goto("/#/more/review");
  const card = page.locator(".review-item").filter({ hasText: task.title });
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "Verwerfen", exact: true }).click();
  await expect(page.locator(".view-completion-notice")).toHaveText(`„${task.title}“ verworfen.`);
  await expect(card).toHaveCount(0);
  expect((await (await page.request.get(`/api/tasks/${task.id}`)).json()).status).toBe("cancelled");
});

for (const { from, to, button, message } of [
  { from: "actionable", to: "someday", button: "Irgendwann", message: "auf Irgendwann gesetzt." },
  { from: "someday", to: "actionable", button: "Machbar", message: "als machbar markiert." },
] as const) {
test(`a ${from} to ${to} detail transition confirms in its initiating view`, async ({ page }) => {
  let task = await createTask(page, `Status ${randomUUID()}`);
  if (from !== "actionable") {
    const response = await page.request.patch(`/api/tasks/${task.id}`, {
      data: { status: from, expectedRevision: task.revision },
    });
    expect(response.ok()).toBe(true);
    task = await response.json() as Task;
  }
  await page.goto("/#/more/all");
  const row = page.locator(`[data-workitem-id="${task.id}"]`).first();
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: task.title, exact: true }).click();
  const detail = page.getByRole("dialog", { name: "Details", exact: true });
  await detail.getByRole("button", { name: /^Status / }).click();
  await detail.getByRole("button", { name: button, exact: true }).click();
  await expect(page.locator(".view-completion-notice")).toHaveText(`„${task.title}“ ${message}`);
  expect((await (await page.request.get(`/api/tasks/${task.id}`)).json()).status).toBe(to);
});
}

test("reopening a completed row announces reopening, not an undo", async ({ page, isMobile }) => {
  const task = await createTask(page, `Reopen ${randomUUID()}`);
  const response = await page.request.post(`/api/tasks/${task.id}/complete`, { data: { expectedRevision: task.revision } });
  expect(response.ok()).toBe(true);
  await page.goto("/#/more/all");
  const row = page.locator(`[data-workitem-id="${task.id}"]`).first();
  await expect(row).toBeVisible();
  if (isMobile) {
    await row.getByRole("button", { name: task.title, exact: true }).click();
    const detail = page.getByRole("dialog", { name: "Details", exact: true });
    await detail.getByRole("button", { name: /^Status / }).click();
    await detail.getByRole("button", { name: "Machbar", exact: true }).click();
  } else {
    await row.getByRole("button", { name: "Wieder öffnen", exact: true }).focus();
    await page.keyboard.press("Space");
  }
  await expect(page.locator(".view-completion-notice")).toHaveText(`„${task.title}“ wieder geöffnet.`);
  expect((await (await page.request.get(`/api/tasks/${task.id}`)).json()).status).toBe("actionable");
});

test("a rejected status write never confirms, and a committed status survives failed refresh", async ({ page }) => {
  const task = await createTask(page, `Status retry ${randomUUID()}`, { size: "XL" });
  let reject = true;
  let committed = false;
  await page.route(`**/api/tasks/${task.id}`, async route => {
    if (route.request().method() !== "PATCH") return route.continue();
    if (reject) return route.fulfill({ status: 503, json: { error: { code: "internal_error", message: "Unavailable" } } });
    const response = await route.fetch();
    committed = response.ok();
    await route.fulfill({ response });
  });
  await page.route("**/api/review", route => committed ? route.abort("failed") : route.continue());
  await page.goto("/#/more/review");
  const card = page.locator(".review-item").filter({ hasText: task.title });
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "Irgendwann lassen", exact: true }).click();
  await expect(card.getByRole("alert")).toBeVisible();
  await expect(page.locator(".view-completion-notice")).toHaveCount(0);
  reject = false;
  await card.getByRole("button", { name: "Irgendwann lassen", exact: true }).click();
  await expect(page.locator(".view-completion-notice")).toHaveText(`„${task.title}“ auf Irgendwann gesetzt.`);
  await expect(page.locator(".error-state")).toBeVisible();
});

test("a Review status write cannot announce in a replacement view", async ({ page }) => {
  const task = await createTask(page, `Retired status ${randomUUID()}`, { size: "XL" });
  let release!: () => void;
  const write = new Promise<void>(resolve => { release = resolve; });
  let writing = false;
  await page.route(`**/api/tasks/${task.id}`, async route => {
    if (route.request().method() !== "PATCH") return route.continue();
    writing = true;
    await write;
    await route.continue();
  });
  await page.goto("/#/more/review");
  const card = page.locator(".review-item").filter({ hasText: task.title });
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "Irgendwann lassen", exact: true }).click();
  await expect.poll(() => writing).toBe(true);
  await page.goto("/#/more/all");
  await expect(page.locator(`[data-workitem-id="${task.id}"]`).first()).toBeVisible();
  release();
  await expect.poll(async () =>
    (await (await page.request.get(`/api/tasks/${task.id}`)).json()).status,
  ).toBe("someday");
  await expect(page.locator(".view-completion-notice")).toHaveCount(0);
});
