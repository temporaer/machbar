import {
  authorizationCodeGrant,
  buildAuthorizationUrl,
  calculatePKCECodeChallenge,
  ClientSecretPost,
  discovery,
  fetchUserInfo,
  randomNonce,
  randomPKCECodeVerifier,
  randomState,
  type Configuration,
} from "openid-client";
import type { OidcConfig } from "../env.js";
import type { OidcIdentityClaims } from "./repository.js";

export interface AuthorizationRequest {
  url: URL;
  state: string;
  nonce: string;
  pkceVerifier: string;
}

export interface OidcProvider {
  createAuthorizationRequest(): Promise<AuthorizationRequest>;
  exchangeCallback(
    callbackUrl: URL,
    checks: { state: string; nonce: string; pkceVerifier: string },
  ): Promise<OidcIdentityClaims>;
}

export function normalizePictureUrl(
  value: unknown,
  issuerUrl: string,
): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    const pictureUrl = new URL(value);
    const issuer = new URL(issuerUrl);
    if (
      (pictureUrl.protocol !== "https:" && pictureUrl.protocol !== "http:") ||
      pictureUrl.origin !== issuer.origin
    ) {
      return undefined;
    }
    return pictureUrl.toString();
  } catch {
    return undefined;
  }
}

export class PocketIdProvider implements OidcProvider {
  private configurationPromise: Promise<Configuration> | null = null;

  constructor(private readonly oidc: OidcConfig) {}

  private configuration(): Promise<Configuration> {
    if (!this.configurationPromise) {
      this.configurationPromise = discovery(
        new URL(this.oidc.issuerUrl),
        this.oidc.clientId,
        { client_secret: this.oidc.clientSecret },
        ClientSecretPost(this.oidc.clientSecret),
      ).catch((cause: unknown) => {
        this.configurationPromise = null;
        throw cause;
      });
    }
    return this.configurationPromise;
  }

  async createAuthorizationRequest(): Promise<AuthorizationRequest> {
    const configuration = await this.configuration();
    const state = randomState();
    const nonce = randomNonce();
    const pkceVerifier = randomPKCECodeVerifier();
    const codeChallenge = await calculatePKCECodeChallenge(pkceVerifier);
    const url = buildAuthorizationUrl(configuration, {
      redirect_uri: `${this.oidc.publicUrl}/api/auth/callback`,
      scope: "openid profile email",
      response_type: "code",
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      state,
      nonce,
    });
    return { url, state, nonce, pkceVerifier };
  }

  async exchangeCallback(
    callbackUrl: URL,
    checks: { state: string; nonce: string; pkceVerifier: string },
  ): Promise<OidcIdentityClaims> {
    const configuration = await this.configuration();
    const tokens = await authorizationCodeGrant(configuration, callbackUrl, {
      expectedState: checks.state,
      expectedNonce: checks.nonce,
      pkceCodeVerifier: checks.pkceVerifier,
      idTokenExpected: true,
    });
    const idTokenClaims = tokens.claims();
    if (!idTokenClaims?.sub || !tokens.access_token) {
      throw new Error("Pocket ID hat keine vollständige Identität geliefert.");
    }
    const userInfo = await fetchUserInfo(
      configuration,
      tokens.access_token,
      idTokenClaims.sub,
    );
    const name =
      typeof userInfo.name === "string" && userInfo.name.trim()
        ? userInfo.name
        : typeof userInfo.preferred_username === "string"
          ? userInfo.preferred_username
          : "";
    const pictureUrl = normalizePictureUrl(
      userInfo.picture,
      this.oidc.issuerUrl,
    );
    return {
      issuer: this.oidc.issuerUrl,
      subject: idTokenClaims.sub,
      name,
      ...(typeof userInfo.email === "string" ? { email: userInfo.email } : {}),
      ...(typeof userInfo.preferred_username === "string"
        ? { preferredUsername: userInfo.preferred_username }
        : {}),
      ...(pictureUrl ? { pictureUrl } : {}),
    };
  }
}
