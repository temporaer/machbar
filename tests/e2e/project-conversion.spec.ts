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
  await expect(page.getByRole("heading", { name: "Projekte" })).toBeVisible();
  await page.goForward();
  await expect(page).toHaveURL(new RegExp(`#\\/tasks\\/${project.id}$`));
  await expect(page.getByRole("dialog", { name: "Details" })).toBeVisible();

  await page.goto(`/#/projects/${project.id}`);
  await expect(page).toHaveURL(new RegExp(`#\\/projects\\/${project.id}$`));
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByRole("heading", { name: project.title })).toHaveCount(0);
  await expect(page.getByRole("dialog", { name: "Projekt zur Aufgabe machen" })).toHaveCount(0);
});
