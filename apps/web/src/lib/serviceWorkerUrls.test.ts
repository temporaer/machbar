import { describe, expect, it, vi } from "vitest";
// The service worker exports pure helpers while guarding its worker listeners.
// @ts-ignore public JavaScript has no declaration file
const swModule = await import("../../public/sw.js");
const {
  handleNotificationClick,
  notificationDocumentUrl,
  notificationIconUrl,
  validPayload,
} = swModule;

const payload = {
  version: 1,
  title: "Jetzt machbar",
  body: "Erinnerung: Paket abholen",
  tag: "task:1:reminder:now",
  recipientMemberId: 2,
  entity: { type: "task", id: 42 },
  actions: [],
};

describe("service worker notification URLs", () => {
  it("builds HashRouter links under a non-root registration scope", () => {
    expect(
      notificationDocumentUrl(
        "https://machbar.example/household/",
        { type: "task", id: 42 },
      ),
    ).toBe("https://machbar.example/household/#/tasks/42");
    expect(
      notificationDocumentUrl(
        "https://machbar.example/household/",
        { type: "project", id: 7 },
      ),
    ).toBe("https://machbar.example/household/#/projects/7");
    expect(
      notificationIconUrl("https://machbar.example/household/"),
    ).toBe("https://machbar.example/household/icon-192.png");
  });

  it("rejects malformed payloads", () => {
    expect(validPayload({ version: 1 })).toBe(false);
    expect(validPayload(payload)).toBe(true);
  });

  it("opens the scoped task route for a body click without action buttons", async () => {
    const clientManager = {
      matchAll: vi.fn(async () => []),
      openWindow: vi.fn(async () => null),
    };

    await handleNotificationClick(
      payload,
      "",
      "https://machbar.example/household/",
      clientManager,
    );

    expect(clientManager.openWindow).toHaveBeenCalledWith(
      "https://machbar.example/household/#/tasks/42",
    );
  });

  it("navigates and focuses an existing scoped Machbar window", async () => {
    const existingClient = {
      url: "https://machbar.example/household/#/today",
      navigate: vi.fn(async () => null),
      focus: vi.fn(async () => null),
    };
    const clientManager = {
      matchAll: vi.fn(async () => [existingClient]),
      openWindow: vi.fn(async () => null),
    };

    await handleNotificationClick(
      payload,
      "",
      "https://machbar.example/household/",
      clientManager,
    );

    expect(existingClient.navigate).toHaveBeenCalledWith(
      "https://machbar.example/household/#/tasks/42",
    );
    expect(existingClient.focus).toHaveBeenCalledTimes(1);
    expect(clientManager.openWindow).not.toHaveBeenCalled();
  });
});
