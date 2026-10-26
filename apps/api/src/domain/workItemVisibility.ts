/** The shared read/write visibility policy. Callers resolve effective task
 * ownership through the existing inheritance projection before invoking it. */
export function workItemVisibleToViewer(
  row: { role: string; scope: string; ownerMemberId: number | null; privacyOwnerMemberId: number | null },
  viewerMemberId: number | undefined,
  effectiveTaskOwnerId: number | null = null,
): boolean {
  if (row.privacyOwnerMemberId !== null && row.privacyOwnerMemberId !== viewerMemberId) return false;
  if (row.scope !== "work") return true;
  const ownerId = row.role === "task" ? effectiveTaskOwnerId : row.ownerMemberId;
  return viewerMemberId !== undefined && ownerId === viewerMemberId;
}
