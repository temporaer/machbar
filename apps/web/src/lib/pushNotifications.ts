import type {
  PushSubscriptionRegistration,
} from "@machbar/shared";

export function urlBase64ToUint8Array(value: string): ArrayBuffer {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const base64 = (value + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(base64);
  return Uint8Array.from(
    raw,
    (character) => character.charCodeAt(0),
  ).buffer as ArrayBuffer;
}

export function serializePushSubscription(
  subscription: PushSubscription,
  locale: PushSubscriptionRegistration["locale"],
): PushSubscriptionRegistration {
  const json = subscription.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) {
    throw new Error("The browser returned an incomplete Push subscription.");
  }
  return {
    endpoint: json.endpoint,
    p256dh: json.keys.p256dh,
    auth: json.keys.auth,
    locale,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || null,
  };
}

export function pushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "Notification" in window &&
    "serviceWorker" in navigator &&
    "PushManager" in window
  );
}

export function sameApplicationServerKey(
  subscription: PushSubscription,
  configuredKey: ArrayBuffer,
): boolean {
  const existing = subscription.options.applicationServerKey;
  if (existing === null) return false;
  const left = new Uint8Array(existing);
  const right = new Uint8Array(configuredKey);
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}
