import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";

test.use({ viewport: { width: 360, height: 740 } });

async function createReference(
  page: Page,
  title: string,
  projectId: number,
  parentTaskId: number | null,
  actorHeaders: Record<string, string>,
) {
  const response = await page.request.post("/api/tasks", {
    headers: actorHeaders,
    data: { title, kind: "reference", projectId, parentTaskId },
  });
  expect(response.status()).toBe(201);
  return response.json();
}

async function stageShare(
  page: Page,
  memberId: number,
  options: { title: string; url: string; recentTargetIds?: number[] },
) {
  const id = `share-${randomUUID()}`;
  await page.addInitScript(({ identity, recentTargetIds }) => {
    localStorage.setItem("machbar:identity-member-id", String(identity));
    localStorage.setItem("machbar:locale", "de");
    localStorage.setItem(
      "machbar:recent-share-targets",
      JSON.stringify(recentTargetIds.map((targetId) => ({ kind: "task", id: targetId }))),
    );
  }, {
    identity: memberId,
    recentTargetIds: options.recentTargetIds ?? [],
  });
  await page.goto("/");
  await page.evaluate(
    async ({ shareId, title, url }) =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.open("machbar-share-targets", 1);
        request.onupgradeneeded = () => {
          if (!request.result.objectStoreNames.contains("pending-shares")) {
            request.result.createObjectStore("pending-shares", { keyPath: "id" });
          }
        };
        request.onsuccess = () => {
          const database = request.result;
          const transaction = database.transaction("pending-shares", "readwrite");
          transaction.objectStore("pending-shares").put({
            id: shareId,
            createdAt: new Date().toISOString(),
            title,
            text: "",
            url,
            files: [],
          });
          transaction.oncomplete = () => {
            database.close();
            resolve();
          };
          transaction.onerror = () => reject(transaction.error);
        };
        request.onerror = () => reject(request.error);
      }),
    { shareId: id, title: options.title, url: options.url },
  );
  await page.goto(`/?shareId=${id}#/share`);
}

test("a recent nested material destination fits the phone viewport and files exactly", async ({
  page,
  request,
}) => {
  const memberResponse = await request.post("/api/members", {
    data: { name: `Share ${randomUUID()}` },
  });
  expect(memberResponse.status()).toBe(201);
  const member = await memberResponse.json();
  const actorHeaders = { "x-machbar-actor-member-id": String(member.id) };

  const projectResponse = await request.post("/api/projects", {
    headers: actorHeaders,
    data: { title: `Sommerurlaub ${randomUUID()}` },
  });
  expect(projectResponse.status()).toBe(201);
  const project = await projectResponse.json();
  const parent = await createReference(page, "Unterkunft", project.id, null, actorHeaders);
  const destination = await createReference(
    page,
    "Unterkunft B",
    project.id,
    parent.id,
    actorHeaders,
  );
  const secondRecent = await createReference(
    page,
    "Restaurant",
    project.id,
    null,
    actorHeaders,
  );
  const thirdRecent = await createReference(
    page,
    "Ausflug",
    project.id,
    null,
    actorHeaders,
  );
  const longTitle =
    "Eine sehr lange Überschrift für einen geteilten Reiseartikel ohne sichtbares Ende";

  if (test.info().project.name === "mobile-chrome") {
    await page.setViewportSize({ width: 360, height: 740 });
  }
  await stageShare(page, member.id, {
    title: longTitle,
    url: "https://example.test/article",
    recentTargetIds: [destination.id, secondRecent.id, thirdRecent.id],
  });

  await expect(page.getByRole("heading", { name: longTitle })).toBeVisible();
  await expect(page.getByText("example.test", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /Unterkunft B/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Restaurant/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Ausflug/ })).toBeVisible();
  const recentGrid = page.locator(".share-recent-section .share-target-list");
  await expect(recentGrid).toHaveCSS("display", "grid");
  expect(
    (await recentGrid.evaluate((element) => getComputedStyle(element).gridTemplateColumns))
      .split(" "),
  ).toHaveLength(2);
  const saveButton = page.getByRole("button", { name: "Als Material speichern" });
  await expect(saveButton).toBeVisible();
  const saveBounds = await saveButton.boundingBox();
  expect(saveBounds).not.toBeNull();
  expect(saveBounds!.y + saveBounds!.height).toBeLessThanOrEqual(
    page.viewportSize()!.height,
  );
  await expect(page.getByLabel("Titel")).toBeHidden();
  await expect(page.getByLabel("Aufgaben und Projekte durchsuchen")).toBeHidden();

  const moreActions = page.locator(".share-more-actions > summary");
  await moreActions.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "An Notizen anhängen" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Als Aufgabe erfassen" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Mit KI verarbeiten" })).toBeVisible();
  await page.keyboard.press("Enter");
  await page.evaluate(() => window.scrollTo(0, 0));

  await page.getByRole("button", { name: /Unterkunft B/ }).click();
  await expect(page.locator(".share-current-destination")).toContainText(
    `${project.title} › Unterkunft › Unterkunft B`,
  );
  await saveButton.click();
  await expect(page.getByRole("button", { name: "Ansehen" })).toBeVisible();

  await page.getByRole("button", { name: "Ansehen" }).click();
  await expect(page).toHaveURL(/#\/tasks\/\d+$/);
  const savedId = Number(page.url().match(/#\/tasks\/(\d+)$/)?.[1]);
  const savedResponse = await page.request.get(`/api/tasks/${savedId}`, {
    headers: actorHeaders,
  });
  expect(savedResponse.status()).toBe(200);
  const saved = await savedResponse.json();
  expect(saved.parentTaskId).toBe(destination.id);
  expect(saved.projectId).toBe(project.id);
});

test("a deleted recent target never becomes a standalone material save", async ({
  page,
  request,
}) => {
  const memberResponse = await request.post("/api/members", {
    data: { name: `Stale share ${randomUUID()}` },
  });
  expect(memberResponse.status()).toBe(201);
  const member = await memberResponse.json();
  const actorHeaders = { "x-machbar-actor-member-id": String(member.id) };
  const projectResponse = await request.post("/api/projects", {
    headers: actorHeaders,
    data: { title: `Stale target ${randomUUID()}` },
  });
  expect(projectResponse.status()).toBe(201);
  const project = await projectResponse.json();
  const destination = await createReference(
    page,
    "Delete before filing",
    project.id,
    null,
    actorHeaders,
  );
  const title = `Shared link ${randomUUID()}`;

  await stageShare(page, member.id, {
    title,
    url: "https://example.test/stale",
    recentTargetIds: [destination.id],
  });
  const recent = page.getByRole("button", { name: /Delete before filing/ });
  await expect(recent).toBeVisible();
  await recent.click();

  const deletion = await request.delete(`/api/tasks/${destination.id}`, {
    headers: actorHeaders,
  });
  expect(deletion.status()).toBe(204);

  await expect(page.locator(".share-current-destination")).toContainText(
    "Dieses Ziel ist nicht mehr verfügbar",
  );
  await expect(
    page.getByRole("button", { name: "Als Material speichern" }),
  ).toBeDisabled();
  const search = await request.get(`/api/search?text=${encodeURIComponent(title)}`, {
    headers: actorHeaders,
  });
  expect(search.status()).toBe(200);
  expect(await search.json()).toEqual([]);
});
