import { useCallback, useEffect, useState } from "react";
import type {
  PushConfig,
  PushNotificationPreferenceKind,
  PushNotificationPreferences,
} from "@machbar/shared";
import { api } from "../lib/api";
import {
  hasApiErrorCode,
  localizedErrorMessage,
} from "../lib/errorMessage";
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
  ensureLatestServiceWorkerRegistration,
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
  const [preferences, setPreferences] =
    useState<PushNotificationPreferences | null>(null);
  const [subscription, setSubscription] = useState<PushSubscription | null>(null);
  const [state, setState] = useState<State>("loading");
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [busyPreference, setBusyPreference] =
    useState<PushNotificationPreferenceKind | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [testFeedback, setTestFeedback] = useState<string | null>(null);

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
    let active = true;
    if (currentMemberId === null) {
      setPreferences(null);
      return () => {
        active = false;
      };
    }
    void api
      .getPushNotificationPreferences()
      .then((nextPreferences) => {
        if (active) setPreferences(nextPreferences);
      })
      .catch((cause: unknown) => {
        if (active) setError(localizedErrorMessage(cause, strings));
      });
    return () => {
      active = false;
    };
  }, [currentMemberId, strings]);

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
    setTestFeedback(null);
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
    setTestFeedback(null);
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

  const sendTest = async () => {
    if (!subscription) return;
    setTesting(true);
    setError(null);
    setTestFeedback(null);
    try {
      await ensureLatestServiceWorkerRegistration();
      await api.sendTestPushNotification(subscription.endpoint);
      setTestFeedback(strings.pushTestSent);
    } catch (cause) {
      if (hasApiErrorCode(cause, "push_subscription_missing")) {
        await subscription.unsubscribe();
        setSubscription(null);
        setState("disabled");
      }
      setError(localizedErrorMessage(cause, strings));
    } finally {
      setTesting(false);
    }
  };

  const updatePreference = async (
    kind: PushNotificationPreferenceKind,
    enabled: boolean,
  ) => {
    if (!preferences) return;
    const previous = preferences;
    const next = { ...preferences, [kind]: enabled };
    setPreferences(next);
    setBusyPreference(kind);
    setError(null);
    try {
      setPreferences(await api.updatePushNotificationPreferences(next));
    } catch (cause) {
      setPreferences(previous);
      setError(localizedErrorMessage(cause, strings));
    } finally {
      setBusyPreference(null);
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
      {state === "disabled" ||
      state === "permission-pending" ||
      state === "enabled" ? (
        <div className="row push-settings-actions">
          {state === "enabled" ? (
            <button
              type="button"
              className="btn"
              disabled={busy || testing}
              onClick={() => void disable()}
            >
              {strings.pushDisable}
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || testing || currentMemberId === null}
              onClick={() => void enable()}
            >
              {strings.pushEnable}
            </button>
          )}
          <button
            type="button"
            className="btn"
            disabled={state !== "enabled" || busy || testing}
            onClick={() => void sendTest()}
          >
            {testing ? strings.pushTestSending : strings.pushTest}
          </button>
        </div>
      ) : null}
      {testFeedback ? (
        <p className="text-muted" role="status">{testFeedback}</p>
      ) : null}
      {preferences ? (
        <div className="push-preferences">
          <div>
            <h4>{strings.pushTypesTitle}</h4>
            <p className="text-muted">{strings.pushTypesHint}</p>
          </div>
          <div className="push-preference-list">
            {(
              [
                {
                  kind: "project_assigned",
                  label: strings.pushProjectAssignments,
                  hint: strings.pushProjectAssignmentsHint,
                },
                {
                  kind: "task_reminder",
                  label: strings.pushTaskReminders,
                  hint: strings.pushTaskRemindersHint,
                },
                {
                  kind: "context_entered",
                  label: strings.pushContextEntered,
                  hint: strings.pushContextEnteredHint,
                },
              ] as const
            ).map(({ kind, label, hint }) => (
              <label className="setting-switch" key={kind}>
                <span>
                  <strong>{label}</strong>
                  <small>{hint}</small>
                </span>
                <input
                  type="checkbox"
                  role="switch"
                  checked={preferences[kind]}
                  disabled={busyPreference !== null}
                  onChange={(event) =>
                    void updatePreference(kind, event.target.checked)
                  }
                />
              </label>
            ))}
          </div>
        </div>
      ) : null}
      {error ? <p role="alert" className="text-muted">{error}</p> : null}
    </div>
  );
}
