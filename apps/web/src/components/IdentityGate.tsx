import type { ReactNode } from "react";
import { useIdentity } from "../lib/identity";
import { useStrings } from "../lib/strings";
import { IdentitySelector } from "./IdentitySelector";
import { ErrorState, LoadingState } from "./AsyncStates";

export function IdentityGate({ children }: { children: ReactNode }) {
  const strings = useStrings();
  const {
    currentMemberId,
    membersLoading,
    authEnabled,
    authenticated,
    authLoading,
    authError,
    loginError,
    reloadAuth,
    login,
  } = useIdentity();

  if (authLoading) return <LoadingState />;
  if (authError) return <ErrorState message={authError} onRetry={reloadAuth} />;

  if (authEnabled && !authenticated) {
    return (
      <div className="identity-gate">
        <h1>{strings.signInTitle}</h1>
        <p className="text-muted">{strings.signInBody}</p>
        {loginError ? <p className="text-muted" role="alert">{loginError}</p> : null}
        <button type="button" className="btn btn-primary" onClick={login}>
          {strings.signInWithPocketId}
        </button>
      </div>
    );
  }

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
