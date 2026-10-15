import type { CoachRequestStatus } from "@machbar/shared";

const POLL_DELAYS_MS = [300, 600, 1_200, 2_400, 3_000, 3_000, 3_000] as const;

export interface CoachProposalStatus {
  status: CoachRequestStatus;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

export async function pollCoachProposal<T extends CoachProposalStatus>(
  initial: T,
  read: () => Promise<T>,
): Promise<T> {
  let proposal = initial;
  for (const milliseconds of POLL_DELAYS_MS) {
    if (proposal.status === "ready" || proposal.status === "failed") return proposal;
    await delay(milliseconds);
    proposal = await read();
  }
  return proposal;
}
