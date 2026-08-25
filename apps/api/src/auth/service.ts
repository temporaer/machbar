import type { Member } from "@machbar/shared";
import type { Db } from "../db/client.js";
import type { OidcConfig } from "../env.js";
import { AppError } from "../errors.js";
import type { OidcProvider } from "./oidcClient.js";
import {
  consumeAuthFlow,
  createSession,
  deleteSession,
  getSessionMember,
  resolveOidcMember,
  storeAuthFlow,
} from "./repository.js";

export interface CompletedLogin {
  member: Member;
  sessionToken: string;
  sessionExpiresAt: Date;
  returnTo: string;
}

export interface BegunLogin {
  authorizationUrl: URL;
  correlationState: string;
}

export class AuthService {
  constructor(
    private readonly db: Db,
    private readonly oidc: OidcConfig,
    private readonly provider: OidcProvider,
  ) {}

  async beginLogin(returnTo: string): Promise<BegunLogin> {
    const request = await this.provider.createAuthorizationRequest();
    storeAuthFlow(this.db, {
      state: request.state,
      nonce: request.nonce,
      pkceVerifier: request.pkceVerifier,
      returnTo,
    });
    return {
      authorizationUrl: request.url,
      correlationState: request.state,
    };
  }

  async completeLogin(callbackUrl: URL, state: string): Promise<CompletedLogin> {
    const flow = consumeAuthFlow(this.db, state);
    if (!flow) {
      throw AppError.badRequest(
        "Die Anmeldung ist abgelaufen oder wurde bereits verwendet. Bitte erneut anmelden.",
      );
    }

    let claims;
    try {
      claims = await this.provider.exchangeCallback(callbackUrl, {
        state,
        nonce: flow.nonce,
        pkceVerifier: flow.pkceVerifier,
      });
    } catch {
      throw AppError.badRequest(
        "Pocket ID konnte die Anmeldung nicht bestätigen. Bitte erneut versuchen.",
      );
    }
    const member = resolveOidcMember(this.db, claims);
    const session = createSession(
      this.db,
      member.id,
      this.oidc.sessionTtlDays,
    );
    return {
      member,
      sessionToken: session.token,
      sessionExpiresAt: session.expiresAt,
      returnTo: flow.returnTo,
    };
  }

  cancelLogin(state: string): void {
    consumeAuthFlow(this.db, state);
  }

  memberForSession(token: string | undefined): Member | null {
    return token ? getSessionMember(this.db, token) : null;
  }

  logout(token: string | undefined): void {
    if (token) deleteSession(this.db, token);
  }
}
