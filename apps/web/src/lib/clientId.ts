const STORAGE_KEY = "machbar-client-id";

function createClientId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function getClientId(): string {
  try {
    const existing = window.sessionStorage.getItem(STORAGE_KEY);
    if (existing) return existing;
    const created = createClientId();
    window.sessionStorage.setItem(STORAGE_KEY, created);
    return created;
  } catch {
    return createClientId();
  }
}
