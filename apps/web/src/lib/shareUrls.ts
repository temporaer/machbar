/**
 * Builds absolute hash-router URLs from the current document base. This keeps
 * links valid when the static app is deployed below a non-root path.
 */
export function buildProjectShareUrl(id: number, baseUrl?: string): string {
  return buildHashShareUrl(`/projects/${id}`, baseUrl);
}

/** Builds a direct link to the task detail route. */
export function buildTaskShareUrl(id: number, baseUrl?: string): string {
  return buildHashShareUrl(`/tasks/${id}`, baseUrl);
}

export function buildHashShareUrl(hashPath: string, baseUrl?: string): string {
  const path = hashPath.startsWith("/") ? hashPath : `/${hashPath}`;
  const base = baseUrl ?? (typeof document === "undefined" ? undefined : document.baseURI);
  return base ? new URL(`#${path}`, base).href : `#${path}`;
}
