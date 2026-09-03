import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../test/testUtils";
import { PushNotificationSettings } from "./PushNotificationSettings";
import { api, ApiError } from "../lib/api";

const pushManager = {
  getSubscription: vi.fn(),
  subscribe: vi.fn(),
};
const registration = { pushManager } as unknown as ServiceWorkerRegistration;

vi.mock("../lib/serviceWorker", () => ({
  currentServiceWorkerRegistration: vi.fn(async () => registration),
  ensureLatestServiceWorkerRegistration: vi.fn(async () => registration),
  ensureServiceWorkerRegistration: vi.fn(async () => registration),
}));

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return {
    ...actual,
    api: {
      getAuthStatus: vi.fn(),
      getMembers: vi.fn(),
      getPushConfig: vi.fn(),
      getPushNotificationPreferences: vi.fn(),
      updatePushNotificationPreferences: vi.fn(),
      registerPushSubscription: vi.fn(),
      unregisterPushSubscription: vi.fn(),
      sendTestPushNotification: vi.fn(),
    },
  };
});

const mockedApi = vi.mocked(api);

function installBrowserSupport(
  permission: NotificationPermission,
  requestedPermission: NotificationPermission = permission,
) {
  const requestPermission = vi.fn(async () => requestedPermission);
  vi.stubGlobal("Notification", { permission, requestPermission });
  vi.stubGlobal("PushManager", class PushManager {});
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: {},
  });
  return requestPermission;
}

function subscription(endpoint = "https://push.example/device") {
  return {
    endpoint,
    options: {
      applicationServerKey: new Uint8Array([1, 0, 1]).buffer,
      userVisibleOnly: true,
    },
    toJSON: () => ({
      endpoint,
      keys: { p256dh: "key", auth: "auth" },
    }),
    unsubscribe: vi.fn(async () => true),
  } as unknown as PushSubscription;
}

describe("PushNotificationSettings", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.localStorage.setItem("machbar:identity-member-id", "1");
    mockedApi.getAuthStatus.mockResolvedValue({
      enabled: false,
      authenticated: false,
      member: null,
    });
    mockedApi.getMembers.mockResolvedValue([
      { id: 1, name: "Hannes", color: "#123456", pictureUrl: null },
    ]);
    mockedApi.getPushConfig.mockResolvedValue({
      enabled: true,
      publicKey: "AQAB",
    });
    mockedApi.getPushNotificationPreferences.mockResolvedValue({
      project_assigned: true,
      task_reminder: true,
      context_entered: true,
    });
    mockedApi.updatePushNotificationPreferences.mockImplementation(
      async (preferences) => preferences,
    );
    mockedApi.registerPushSubscription.mockResolvedValue(undefined);
    mockedApi.unregisterPushSubscription.mockResolvedValue(undefined);
    mockedApi.sendTestPushNotification.mockResolvedValue(undefined);
    pushManager.getSubscription.mockResolvedValue(null);
    pushManager.subscribe.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete (navigator as { serviceWorker?: unknown }).serviceWorker;
    vi.clearAllMocks();
  });

  it("shows unsupported and server-unconfigured states", async () => {
    renderWithProviders(<PushNotificationSettings />);
    expect(
      await screen.findByText(/unterstützt keine Push-Benachrichtigungen/),
    ).toBeInTheDocument();

    installBrowserSupport("default");
    mockedApi.getPushConfig.mockResolvedValue({
      enabled: false,
      publicKey: null,
    });
    renderWithProviders(<PushNotificationSettings />);
    expect(
      await screen.findByText(/auf dem Server nicht eingerichtet/),
    ).toBeInTheDocument();
  });

  it("shows denied and actual missing-subscription states", async () => {
    installBrowserSupport("denied");
    renderWithProviders(<PushNotificationSettings />);
    expect(
      await screen.findByText(/Browser- bzw. Website-Einstellungen blockiert/),
    ).toBeInTheDocument();

    cleanup();
    installBrowserSupport("granted");
    pushManager.getSubscription.mockResolvedValue(null);
    renderWithProviders(<PushNotificationSettings />);
    expect(
      await screen.findByText("Auf diesem Gerät nicht aktiviert."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Test senden" })).toBeDisabled();
  });

  it("requests permission from the enable action and registers the device", async () => {
    const requestPermission = installBrowserSupport("default", "granted");
    const created = subscription();
    pushManager.subscribe.mockResolvedValue(created);
    renderWithProviders(<PushNotificationSettings />);

    await userEvent.click(await screen.findByRole("button", { name: "Aktivieren" }));

    expect(requestPermission).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(mockedApi.registerPushSubscription).toHaveBeenCalledWith(
        expect.objectContaining({
          endpoint: created.endpoint,
          locale: "de",
        }),
      ),
    );
    expect(screen.getByText("Auf diesem Gerät aktiviert.")).toBeInTheDocument();
  });

  it("lets the current member toggle notification types independently", async () => {
    installBrowserSupport("granted");
    renderWithProviders(<PushNotificationSettings />);

    const contextNotifications = await screen.findByRole("switch", {
      name: /Ortsaufgaben/,
    });
    expect(contextNotifications).toBeChecked();
    await userEvent.click(contextNotifications);

    await waitFor(() =>
      expect(mockedApi.updatePushNotificationPreferences).toHaveBeenCalledWith({
        project_assigned: true,
        task_reminder: true,
        context_entered: false,
      }),
    );
    expect(contextNotifications).not.toBeChecked();
  });

  it("keeps Chromium's quiet default result visible and actionable", async () => {
    const requestPermission = installBrowserSupport("default", "default");
    renderWithProviders(<PushNotificationSettings />);

    await userEvent.click(
      await screen.findByRole("button", { name: "Aktivieren" }),
    );

    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(
      screen.getByText(/Browser wartet auf deine Freigabe/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Adressleiste bzw. Website-Einstellungen/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Aktivieren" }),
    ).toBeInTheDocument();
    expect(pushManager.subscribe).not.toHaveBeenCalled();
    expect(mockedApi.registerPushSubscription).not.toHaveBeenCalled();
  });

  it("explains a denied permission result without attempting to subscribe", async () => {
    const requestPermission = installBrowserSupport("default", "denied");
    renderWithProviders(<PushNotificationSettings />);

    await userEvent.click(
      await screen.findByRole("button", { name: "Aktivieren" }),
    );

    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(
      screen.getByText(/Browser- bzw. Website-Einstellungen blockiert/),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Aktivieren" })).toBeNull();
    expect(pushManager.subscribe).not.toHaveBeenCalled();
    expect(mockedApi.registerPushSubscription).not.toHaveBeenCalled();
  });

  it("reuses this browser's matching subscription instead of replacing it", async () => {
    installBrowserSupport("granted");
    const existing = subscription();
    pushManager.getSubscription
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(existing);
    renderWithProviders(<PushNotificationSettings />);

    await userEvent.click(
      await screen.findByRole("button", { name: "Aktivieren" }),
    );

    await waitFor(() =>
      expect(mockedApi.registerPushSubscription).toHaveBeenCalledWith(
        expect.objectContaining({ endpoint: existing.endpoint }),
      ),
    );
    expect(pushManager.subscribe).not.toHaveBeenCalled();
    expect(existing.unsubscribe).not.toHaveBeenCalled();
    expect(screen.getByText("Auf diesem Gerät aktiviert.")).toBeInTheDocument();
  });

  it("reflects and disables an existing subscription", async () => {
    installBrowserSupport("granted");
    const existing = subscription();
    pushManager.getSubscription.mockResolvedValue(existing);
    renderWithProviders(<PushNotificationSettings />);

    await userEvent.click(await screen.findByRole("button", { name: "Deaktivieren" }));

    expect(mockedApi.unregisterPushSubscription).toHaveBeenCalledWith(
      existing.endpoint,
    );
    expect(existing.unsubscribe).toHaveBeenCalled();
    expect(
      screen.getByText("Auf diesem Gerät nicht aktiviert."),
    ).toBeInTheDocument();
  });

  it("sends a test through this browser's active subscription", async () => {
    installBrowserSupport("granted");
    const existing = subscription();
    pushManager.getSubscription.mockResolvedValue(existing);
    renderWithProviders(<PushNotificationSettings />);

    await userEvent.click(
      await screen.findByRole("button", { name: "Test senden" }),
    );

    expect(mockedApi.sendTestPushNotification).toHaveBeenCalledWith(
      existing.endpoint,
    );
    expect(
      await screen.findByText("Testbenachrichtigung gesendet."),
    ).toBeInTheDocument();
  });

  it("returns an expired browser subscription to the disabled state", async () => {
    installBrowserSupport("granted");
    const existing = subscription();
    pushManager.getSubscription.mockResolvedValue(existing);
    mockedApi.sendTestPushNotification.mockRejectedValue(
      new ApiError(
        409,
        "Browser subscription expired.",
        "push_subscription_missing",
      ),
    );
    renderWithProviders(<PushNotificationSettings />);

    await userEvent.click(
      await screen.findByRole("button", { name: "Test senden" }),
    );

    expect(existing.unsubscribe).toHaveBeenCalledTimes(1);
    expect(
      await screen.findByText("Auf diesem Gerät nicht aktiviert."),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Anmeldung dieses Browsers ist abgelaufen/),
    ).toBeInTheDocument();
  });
});
