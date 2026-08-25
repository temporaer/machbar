import type { ReactNode } from "react";
import { useIdentity } from "../lib/identity";
import { strings } from "../lib/strings";
import { IdentitySelector } from "./IdentitySelector";

export function IdentityGate({ children }: { children: ReactNode }) {
  const { currentMemberId, membersLoading } = useIdentity();

  if (!membersLoading && currentMemberId === null) {
    return (
      <div className="identity-gate">
        <h1>{strings.identity}</h1>
        <p className="text-muted">{strings.identityRequiredBody}</p>
        <IdentitySelector />
      </div>
    );
  }

  return <>{children}</>;
}
