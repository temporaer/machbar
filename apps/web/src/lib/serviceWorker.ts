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

function waitForActivation(worker: ServiceWorker): Promise<void> {
  if (worker.state === "activated") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onStateChange = () => {
      if (worker.state === "activated") {
        worker.removeEventListener("statechange", onStateChange);
        resolve();
      } else if (worker.state === "redundant") {
        worker.removeEventListener("statechange", onStateChange);
        reject(new Error("The updated service worker could not be activated."));
      }
    };
    worker.addEventListener("statechange", onStateChange);
    onStateChange();
  });
}

export async function ensureLatestServiceWorkerRegistration(): Promise<ServiceWorkerRegistration> {
  const registration = await ensureServiceWorkerRegistration();
  await registration.update();
  const updatedWorker = registration.installing ?? registration.waiting;
  if (updatedWorker) await waitForActivation(updatedWorker);
  return registration;
}

export async function currentServiceWorkerRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (!("serviceWorker" in navigator)) return null;
  return (await navigator.serviceWorker.getRegistration()) ?? null;
}
