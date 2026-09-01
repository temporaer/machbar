import { describe, expect, it, vi } from "vitest";
// The service worker exports pure helpers while guarding its worker listeners.
// @ts-ignore public JavaScript has no declaration file
const swModule = await import("../../public/sw.js");
const {
  handleNotificationClick,
  handleShareTargetFetch,
  handleShareTargetRequest,
  isShareTargetRequest,
  notificationDocumentUrl,
  notificationIconUrl,
  shareTargetDocumentUrl,
  shareTargetFailureUrl,
  validPayload,
} = swModule;

const payload = {
  version: 1,
  kind: "task_reminder",
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

  describe("service worker share target", () => {
    it("matches only the scoped POST endpoint and builds a subpath-safe redirect", () => {
      const scope = "https://machbar.example/household/";
      expect(
        isShareTargetRequest(
          { method: "POST", url: "https://machbar.example/household/share-target" },
          scope,
        ),
      ).toBe(true);
      expect(
        isShareTargetRequest(
          { method: "GET", url: "https://machbar.example/household/share-target" },
          scope,
        ),
      ).toBe(false);
      expect(
        isShareTargetRequest(
          { method: "POST", url: "https://machbar.example/share-target" },
          scope,
        ),
      ).toBe(false);
      expect(shareTargetDocumentUrl(scope, "share-1")).toBe(
        "https://machbar.example/household/?shareId=share-1#/share",
      );
      expect(shareTargetFailureUrl(scope)).toBe(
        "https://machbar.example/household/?shareError=storage#/share",
      );
    });

    it("stages mixed text and multiple files before redirecting", async () => {
      const first = new File(["one"], "one.jpg", { type: "image/jpeg" });
      const second = new File(["two"], "two.pdf", { type: "application/pdf" });
      const form = new FormData();
      form.set("title", "Shared title");
      form.set("text", "Shared text");
      form.set("url", "https://example.test");
      form.append("files", first);
      form.append("files", second);
      const store = vi.fn(async () => undefined);
      const request = {
        method: "POST",
        url: "https://machbar.example/share-target",
        formData: vi.fn(async () => form),
      };

      const response = await handleShareTargetRequest(
        request,
        "https://machbar.example/",
        store,
        () => "share-2",
      );

      expect(store).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "share-2",
          title: "Shared title",
          text: "Shared text",
          url: "https://example.test",
          files: [first, second],
        }),
      );
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe(
        "https://machbar.example/?shareId=share-2#/share",
      );
    });

    it("redirects into a visible error state when staging fails", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const response = await handleShareTargetFetch(
        { method: "POST" },
        "https://machbar.example/household/",
        vi.fn().mockRejectedValue(new Error("IndexedDB unavailable")),
      );

      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe(
        "https://machbar.example/household/?shareError=storage#/share",
      );
      expect(errorSpy).toHaveBeenCalled();
      errorSpy.mockRestore();
    });
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

  it("opens Today for a test notification body click", async () => {
    const clientManager = {
      matchAll: vi.fn(async () => []),
      openWindow: vi.fn(async () => null),
    };
    const testPayload = {
      ...payload,
      kind: "test",
      entity: null,
      body: "Benachrichtigungen funktionieren auf diesem Gerät.",
    };

    expect(validPayload(testPayload)).toBe(true);
    await handleNotificationClick(
      testPayload,
      "",
      "https://machbar.example/household/",
      clientManager,
    );

    expect(clientManager.openWindow).toHaveBeenCalledWith(
      "https://machbar.example/household/#/today",
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
