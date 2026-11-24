import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";

test.beforeEach(async ({ page }) => {
  const member = await (await page.request.post("/api/members", {
    data: { name: `Conversion ${randomUUID()}` },
  })).json();
  await page.addInitScript(id => {
    localStorage.setItem("machbar:identity-member-id", String(id));
    localStorage.setItem("machbar:locale", "de");
  }, member.id);
});

test("converts from project actions, replaces history, and keeps stale project errors specific", async ({ page }) => {
  const response = await page.request.post("/api/projects", {
    data: { title: `Convert ${randomUUID()}` },
  });
  expect(response.status()).toBe(201);
  const project = await response.json();

  await page.goto("/#/projects");
  await page.goto(`/#/projects/${project.id}`);
  await expect(page.getByRole("heading", { name: project.title })).toBeVisible();
  await page.getByRole("button", { name: "Weitere Aktionen", exact: true }).click();
  const actions = page.getByRole("dialog", { name: "Weitere Aktionen" });
  await actions.getByRole("button", { name: "Zur Aufgabe machen", exact: true }).click();

  const conversion = page.getByRole("dialog", { name: "Projekt zur Aufgabe machen" });
  await expect(conversion).toBeVisible();
  await conversion.getByRole("button", { name: "Zur Aufgabe machen", exact: true }).click();

  await expect(page).toHaveURL(new RegExp(`#\\/tasks\\/${project.id}$`));
  const taskDetails = page.getByRole("dialog", { name: "Details" });
  await expect(taskDetails).toBeVisible();
  await expect(taskDetails.getByRole("heading", { name: project.title })).toBeVisible();
  await expect(page.getByText("Projekt nicht gefunden")).toHaveCount(0);

  await page.goBack();
  await expect(page).toHaveURL(/#\/projects$/);
  await expect(page.getByRole("heading", { name: "Vorhaben" })).toBeVisible();
  await page.goForward();
  await expect(page).toHaveURL(new RegExp(`#\\/tasks\\/${project.id}$`));
  await expect(page.getByRole("dialog", { name: "Details" })).toBeVisible();

  await page.goto(`/#/projects/${project.id}`);
  await expect(page).toHaveURL(new RegExp(`#\\/projects\\/${project.id}$`));
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByRole("heading", { name: project.title })).toHaveCount(0);
  await expect(page.getByRole("dialog", { name: "Projekt zur Aufgabe machen" })).toHaveCount(0);
});

test("groups deferred projects and standalone tasks in Later and removes a reactivated task", async ({ page }) => {
  const marker = randomUUID();
  const projectResponse = await page.request.post("/api/projects", {
    data: { title: `Deferred plan ${marker}` },
  });
  expect(projectResponse.status()).toBe(201);
  const project = await projectResponse.json();
  const childResponse = await page.request.post("/api/projects", {
    data: { title: `Nested plan ${marker}`, parentId: project.id },
  });
  expect(childResponse.status()).toBe(201);
  const child = await childResponse.json();
  const taskResponse = await page.request.post("/api/tasks", {
    data: { title: `Deferred task ${marker}`, status: "someday" },
  });
  expect(taskResponse.status()).toBe(201);
  const task = await taskResponse.json();

  await page.goto("/#/projects");
  await page.getByLabel("Suchen").fill(marker);
  const later = page.getByRole("heading", { name: "Später (2)" });
  await expect(later).toBeVisible();
  await expect(page.getByRole("heading", { name: "Projekte (1)" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Einzelaufgaben (1)" })).toBeVisible();
  await expect(page.getByText(project.title)).toBeVisible();
  await expect(page.getByText(child.title)).toHaveCount(0);
  await page.locator(`[data-workitem-id="${project.id}"]`)
    .getByRole("button", { name: project.title })
    .click();
  await expect(page).toHaveURL(new RegExp(`#\\/projects\\/${project.id}$`));
  await expect(page.getByText(child.title)).toBeVisible();
  await page.goBack();
  await expect(page.getByRole("heading", { name: "Vorhaben" })).toBeVisible();
  await page.getByLabel("Suchen").fill(marker);

  const row = page.locator(`[data-workitem-id="${task.id}"]`);
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: task.title }).click();
  const detail = page.getByRole("dialog", { name: "Details", exact: true });
  await detail.getByRole("button", { name: /^Status / }).click();
  await detail.getByRole("button", { name: "Machbar", exact: true }).click();
  await expect.poll(async () =>
    (await (await page.request.get(`/api/tasks/${task.id}`)).json()).status,
  ).toBe("actionable");

  await detail.getByRole("button", { name: "Schließen", exact: true }).click();
  await page.getByLabel("Suchen").fill(marker);
  await expect(page.getByRole("heading", { name: "Später (1)" })).toBeVisible();
  await expect(row).toHaveCount(0);
  await expect(page.getByText(project.title)).toBeVisible();
});
