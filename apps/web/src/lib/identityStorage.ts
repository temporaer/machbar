export const SELECTED_MEMBER_STORAGE_KEY = "machbar:identity-member-id";

let requestActorMemberId: number | null = null;

export function parseSelectedMemberStorageValue(
  value: string | null,
): number | null {
  if (value === null || !/^[1-9]\d*$/.test(value)) return null;
  const memberId = Number(value);
  return Number.isSafeInteger(memberId) ? memberId : null;
}

export function setRequestActorMemberId(memberId: number | null): void {
  requestActorMemberId = memberId;
}

export function readRequestActorMemberId(): number | null {
  return requestActorMemberId;
}
