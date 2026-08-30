const ACTOR_HEADER = "x-machbar-actor-member-id";

export function notificationDocumentUrl(scope, entity) {
  const url = new URL(scope);
  url.hash = `#/${entity.type === "task" ? "tasks" : "projects"}/${entity.id}`;
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
    value.entity !== null &&
    typeof value.entity === "object" &&
    (value.entity.type === "task" || value.entity.type === "project") &&
    Number.isSafeInteger(value.entity.id) &&
    value.entity.id > 0 &&
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

async function openEntity(payload) {
  const url = notificationDocumentUrl(self.registration.scope, payload.entity);
  const scopeUrl = new URL(self.registration.scope);
  const windows = await clients.matchAll({
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
  return clients.openWindow(url);
}

if (typeof self !== "undefined" && "addEventListener" in self) {
  self.addEventListener("fetch", () => {
    // A fetch handler enables PWA installation; uncaught requests continue.
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
    event.waitUntil(
      (async () => {
        if (event.action && event.action !== "open") {
          try {
            await runQuickAction(payload, event.action);
            return;
          } catch {
            // A failed quick action must leave the user in the normal UI.
          }
        }
        await openEntity(payload);
      })(),
    );
  });
}
