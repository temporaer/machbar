let registrationPromise: Promise<ServiceWorkerRegistration> | null = null;

export function ensureServiceWorkerRegistration(): Promise<ServiceWorkerRegistration> {
  if (!("serviceWorker" in navigator)) {
    return Promise.reject(new Error("Service workers are not supported."));
  }
  registrationPromise ??= navigator.serviceWorker.register(
    `${import.meta.env.BASE_URL}sw.js`,
    { type: "module" },
  ).then(async () => navigator.serviceWorker.ready);
  return registrationPromise;
}

export async function currentServiceWorkerRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (!("serviceWorker" in navigator)) return null;
  return (await navigator.serviceWorker.getRegistration()) ?? null;
}
