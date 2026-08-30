import { describe, expect, it } from "vitest";
// The service worker exports pure helpers while guarding its worker listeners.
// @ts-ignore public JavaScript has no declaration file
const swModule = await import("../../public/sw.js");
const {
  notificationDocumentUrl,
  notificationIconUrl,
  validPayload,
} = swModule;

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
    expect(
      validPayload({
        version: 1,
        title: "Jetzt machbar",
        body: "Erinnerung: Paket abholen",
        tag: "task:1:reminder:now",
        recipientMemberId: 2,
        entity: { type: "task", id: 1 },
        actions: [],
      }),
    ).toBe(true);
  });
});
