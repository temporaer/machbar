import { afterEach, describe, expect, it, vi } from "vitest";
import { pushSupported } from "./pushNotifications";

const originalUserAgent = navigator.userAgent;

function installPushFeatures() {
  vi.stubGlobal("Notification", {
    permission: "default",
    requestPermission: vi.fn(),
  });
  vi.stubGlobal("PushManager", class PushManager {});
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: {},
  });
}

describe("pushSupported", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete (navigator as { serviceWorker?: unknown }).serviceWorker;
    Object.defineProperty(navigator, "userAgent", {
      configurable: true,
      value: originalUserAgent,
    });
  });

  it("accepts a desktop Chromium-style browser through feature detection", () => {
    Object.defineProperty(navigator, "userAgent", {
      configurable: true,
      value:
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/128.0.0.0 Safari/537.36",
    });
    installPushFeatures();

    expect(pushSupported()).toBe(true);
  });

  it("rejects browsers missing any required Web Push primitive", () => {
    installPushFeatures();
    delete (window as { PushManager?: unknown }).PushManager;

    expect(pushSupported()).toBe(false);
  });
});
