const ACTOR_HEADER = "x-machbar-actor-member-id";
const SHARE_DATABASE = "machbar-share-targets";
const SHARE_STORE = "pending-shares";
const SHARE_DATABASE_VERSION = 1;
const SHARE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function openShareDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(SHARE_DATABASE, SHARE_DATABASE_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(SHARE_STORE)) {
        request.result.createObjectStore(SHARE_STORE, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("Could not open pending shares."));
  });
}

export async function storePendingShareTarget(record) {
  const database = await openShareDatabase();
  try {
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(SHARE_STORE, "readwrite");
      const store = transaction.objectStore(SHARE_STORE);
      const cutoff = Date.now() - SHARE_MAX_AGE_MS;
      const cursorRequest = store.openCursor();
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor) return;
        if (Date.parse(cursor.value.createdAt) < cutoff) cursor.delete();
        cursor.continue();
      };
      store.put(record);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () =>
        reject(transaction.error ?? new Error("Could not store pending share."));
      transaction.onabort = transaction.onerror;
    });
  } finally {
    database.close();
  }
}

export function shareTargetDocumentUrl(scope, id) {
  const url = new URL(scope);
  url.searchParams.set("shareId", id);
  url.hash = "#/share";
  return url.href;
}

export function shareTargetFailureUrl(scope) {
  const url = new URL(scope);
  url.searchParams.set("shareError", "storage");
  url.hash = "#/share";
  return url.href;
}

export function isShareTargetRequest(request, scope) {
  if (request.method !== "POST") return false;
  const requestUrl = new URL(request.url);
  const targetUrl = new URL("share-target", scope);
  return (
    requestUrl.origin === targetUrl.origin &&
    requestUrl.pathname === targetUrl.pathname
  );
}

export async function handleShareTargetRequest(
  request,
  scope = self.registration.scope,
  store = storePendingShareTarget,
  createId = () => crypto.randomUUID(),
) {
  const form = await request.formData();
  const id = createId();
  const files = form
    .getAll("files")
    .filter((value) => typeof File !== "undefined" && value instanceof File);
  await store({
    id,
    createdAt: new Date().toISOString(),
    title: String(form.get("title") ?? ""),
    text: String(form.get("text") ?? ""),
    url: String(form.get("url") ?? ""),
    files,
  });
  return Response.redirect(shareTargetDocumentUrl(scope, id), 303);
}

export async function handleShareTargetFetch(
  request,
  scope = self.registration.scope,
  handle = handleShareTargetRequest,
) {
  try {
    return await handle(request, scope);
  } catch (cause) {
    console.error("Could not stage incoming shared content.", cause);
    return Response.redirect(shareTargetFailureUrl(scope), 303);
  }
}

export function notificationDocumentUrl(scope, entity) {
  const url = new URL(scope);
  url.hash = entity
    ? `#/${entity.type === "task" ? "tasks" : "projects"}/${entity.id}`
    : "#/today";
  return url.href;
}

export function notificationIconUrl(scope) {
  return new URL("icon-192.png", scope).href;
}

export function validPayload(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    value.version === 1 &&
    typeof value.title === "string" &&
    typeof value.body === "string" &&
    typeof value.tag === "string" &&
    Number.isSafeInteger(value.recipientMemberId) &&
    value.recipientMemberId > 0 &&
    (value.entity === null ||
      (typeof value.entity === "object" &&
        (value.entity.type === "task" || value.entity.type === "project") &&
        Number.isSafeInteger(value.entity.id) &&
        value.entity.id > 0)) &&
    Array.isArray(value.actions) &&
    value.actions.every(
      (item) =>
        item !== null &&
        typeof item === "object" &&
        (item.action === "today" ||
          item.action === "open" ||
          item.action === "complete") &&
        typeof item.title === "string",
    )
  );
}

function localCalendarDate(date = new Date()) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

async function runQuickAction(payload, action) {
  const headers = {
    "Content-Type": "application/json",
    [ACTOR_HEADER]: String(payload.recipientMemberId),
  };
  if (
    action === "today" &&
    payload.entity.type === "task" &&
    Number.isSafeInteger(payload.taskRevision) &&
    payload.recurringTask === false
  ) {
    const response = await fetch(`/api/tasks/${payload.entity.id}`, {
      method: "PATCH",
      credentials: "same-origin",
      headers,
      body: JSON.stringify({
        scheduledDate: localCalendarDate(),
        expectedRevision: payload.taskRevision,
      }),
    });
    if (!response.ok) throw new Error(`Today action failed: ${response.status}`);
    return;
  }
  if (
    action === "complete" &&
    payload.entity.type === "task" &&
    Number.isSafeInteger(payload.taskRevision) &&
    payload.recurringTask === false
  ) {
    const response = await fetch(`/api/tasks/${payload.entity.id}/complete`, {
      method: "POST",
      credentials: "same-origin",
      headers,
      body: JSON.stringify({
        descendantsPolicy: "leave_open",
        expectedRevision: payload.taskRevision,
      }),
    });
    if (!response.ok) {
      throw new Error(`Complete action failed: ${response.status}`);
    }
    return;
  }
  throw new Error("Unsupported notification action.");
}

async function openEntity(payload, scope, clientManager) {
  const url = notificationDocumentUrl(scope, payload.entity);
  const scopeUrl = new URL(scope);
  const windows = await clientManager.matchAll({
    type: "window",
    includeUncontrolled: true,
  });
  const existing = windows.find((client) => {
    const clientUrl = new URL(client.url);
    return (
      clientUrl.origin === scopeUrl.origin &&
      clientUrl.pathname.startsWith(scopeUrl.pathname)
    );
  });
  if (existing) {
    if ("navigate" in existing) await existing.navigate(url);
    return existing.focus();
  }
  return clientManager.openWindow(url);
}

export async function handleNotificationClick(
  payload,
  action,
  scope = self.registration.scope,
  clientManager = clients,
) {
  if (action && action !== "open") {
    try {
      await runQuickAction(payload, action);
      return;
    } catch {
      // A failed quick action must leave the user in the normal UI.
    }
  }
  await openEntity(payload, scope, clientManager);
}

if (typeof self !== "undefined" && "addEventListener" in self) {
  self.addEventListener("install", (event) => {
    event.waitUntil(self.skipWaiting());
  });

  self.addEventListener("activate", (event) => {
    event.waitUntil(self.clients.claim());
  });

  self.addEventListener("fetch", (event) => {
    if (isShareTargetRequest(event.request, self.registration.scope)) {
      event.respondWith(handleShareTargetFetch(event.request));
    }
  });

  self.addEventListener("push", (event) => {
    let payload;
    try {
      payload = event.data?.json();
    } catch {
      return;
    }
    if (!validPayload(payload)) return;
    event.waitUntil(
      self.registration.showNotification(payload.title, {
        body: payload.body,
        icon: notificationIconUrl(self.registration.scope),
        tag: payload.tag,
        actions: payload.actions,
        data: payload,
      }),
    );
  });

  self.addEventListener("notificationclick", (event) => {
    const payload = event.notification.data;
    event.notification.close();
    if (!validPayload(payload)) return;
    event.waitUntil(handleNotificationClick(payload, event.action));
  });
}
