import { useCallback, useEffect, useState } from "react";
import type { PushConfig } from "@machbar/shared";
import { api } from "../lib/api";
import { localizedErrorMessage } from "../lib/errorMessage";
import { useIdentity } from "../lib/identity";
import { useLocale } from "../lib/locale";
import {
  pushSupported,
  sameApplicationServerKey,
  serializePushSubscription,
  urlBase64ToUint8Array,
} from "../lib/pushNotifications";
import {
  currentServiceWorkerRegistration,
  ensureServiceWorkerRegistration,
} from "../lib/serviceWorker";
import { useStrings } from "../lib/strings";

type State =
  | "loading"
  | "unsupported"
  | "unconfigured"
  | "denied"
  | "permission-pending"
  | "disabled"
  | "enabled";

export function PushNotificationSettings() {
  const strings = useStrings();
  const { locale } = useLocale();
  const { currentMemberId } = useIdentity();
  const [config, setConfig] = useState<PushConfig | null>(null);
  const [subscription, setSubscription] = useState<PushSubscription | null>(null);
  const [state, setState] = useState<State>("loading");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!pushSupported()) {
      setState("unsupported");
      return;
    }
    const nextConfig = await api.getPushConfig();
    setConfig(nextConfig);
    if (!nextConfig.enabled || !nextConfig.publicKey) {
      setState("unconfigured");
      return;
    }
    if (Notification.permission === "denied") {
      setState("denied");
      return;
    }
    const registration = await currentServiceWorkerRegistration();
    const nextSubscription =
      (await registration?.pushManager.getSubscription()) ?? null;
    setSubscription(nextSubscription);
    setState(nextSubscription ? "enabled" : "disabled");
  }, []);

  useEffect(() => {
    void refresh().catch((cause: unknown) => {
      setError(localizedErrorMessage(cause, strings));
      setState("disabled");
    });
  }, [refresh, strings]);

  useEffect(() => {
    if (!subscription || currentMemberId === null) return;
    void api
      .registerPushSubscription(
        serializePushSubscription(subscription, locale),
      )
      .catch((cause: unknown) =>
        setError(localizedErrorMessage(cause, strings)),
      );
  }, [currentMemberId, locale, strings, subscription]);

  const enable = async () => {
    if (!config?.publicKey || currentMemberId === null) return;
    setBusy(true);
    setError(null);
    try {
      const permission =
        Notification.permission === "granted"
          ? "granted"
          : await Notification.requestPermission();
      if (permission === "denied") {
        setState("denied");
        return;
      }
      if (permission === "default") {
        setState("permission-pending");
        return;
      }
      const registration = await ensureServiceWorkerRegistration();
      const existing = await registration.pushManager.getSubscription();
      const applicationServerKey = urlBase64ToUint8Array(config.publicKey);
      if (
        existing &&
        !sameApplicationServerKey(existing, applicationServerKey)
      ) {
        await api.unregisterPushSubscription(existing.endpoint);
        await existing.unsubscribe();
      }
      const reusable =
        existing !== null &&
        sameApplicationServerKey(existing, applicationServerKey);
      const nextSubscription =
        reusable
          ? existing
          : await registration.pushManager.subscribe({
              userVisibleOnly: true,
              applicationServerKey,
            });
      await api.registerPushSubscription(
        serializePushSubscription(nextSubscription, locale),
      );
      setSubscription(nextSubscription);
      setState("enabled");
    } catch (cause) {
      setError(localizedErrorMessage(cause, strings));
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    if (!subscription) return;
    setBusy(true);
    setError(null);
    try {
      await api.unregisterPushSubscription(subscription.endpoint);
      await subscription.unsubscribe();
      setSubscription(null);
      setState("disabled");
    } catch (cause) {
      setError(localizedErrorMessage(cause, strings));
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const stateText = {
    loading: strings.pushLoading,
    unsupported: strings.pushUnsupported,
    unconfigured: strings.pushUnconfigured,
    denied: strings.pushDenied,
    "permission-pending": strings.pushPermissionPending,
    disabled: strings.pushDisabled,
    enabled: strings.pushEnabled,
  }[state];

  return (
    <div className="card push-settings">
      <h3>{strings.pushTitle}</h3>
      <p className="text-muted">{strings.pushDeviceHint}</p>
    <p className="push-settings-state" role="status">{stateText}</p>
    {state === "disabled" || state === "permission-pending" ? (
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || currentMemberId === null}
          onClick={() => void enable()}
        >
          {strings.pushEnable}
        </button>
      ) : null}
      {state === "enabled" ? (
        <button
          type="button"
          className="btn"
          disabled={busy}
          onClick={() => void disable()}
        >
          {strings.pushDisable}
        </button>
      ) : null}
      {error ? <p role="alert" className="text-muted">{error}</p> : null}
    </div>
  );
}
