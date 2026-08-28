import path from "node:path";

export interface Env {
  port: number;
  host: string;
  dataDir: string;
  databaseFile: string;
  databasePath: string;
  basePath: string;
  seedDatabase: boolean;
  webDistDir: string;
  oidc: OidcConfig | null;
}

export interface OidcConfig {
  issuerUrl: string;
  clientId: string;
  clientSecret: string;
  publicUrl: string;
  sessionTtlDays: number;
}

function normalizeBasePath(input: string | undefined): string {
  if (!input || input === "/") return "/";
  let value = input.trim();
  if (!value.startsWith("/")) value = `/${value}`;
  if (value.length > 1 && value.endsWith("/")) value = value.slice(0, -1);
  return value;
}

function parseHttpsUrl(name: string, input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error(`${name} must be a valid URL.`);
  }
  if (url.protocol !== "https:") {
    throw new Error(`${name} must be an HTTPS URL.`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`${name} must not contain credentials, a query, or a fragment.`);
  }
  return url.href.replace(/\/$/, "");
}

function loadOidcConfig(source: NodeJS.ProcessEnv): OidcConfig | null {
  const required = [
    "OIDC_ISSUER_URL",
    "OIDC_CLIENT_ID",
    "OIDC_CLIENT_SECRET",
    "OIDC_PUBLIC_URL",
  ] as const;
  const configured = required.filter((key) => source[key]?.trim());
  if (configured.length === 0) return null;
  if (configured.length !== required.length) {
    const missing = required.filter((key) => !source[key]?.trim()).join(", ");
    throw new Error(`OIDC configuration is incomplete. Missing: ${missing}.`);
  }

  const sessionTtlDays = Number.parseInt(source.OIDC_SESSION_TTL_DAYS ?? "30", 10);
  if (!Number.isInteger(sessionTtlDays) || sessionTtlDays < 1 || sessionTtlDays > 365) {
    throw new Error("OIDC_SESSION_TTL_DAYS must be between 1 and 365.");
  }

  const publicUrl = new URL(parseHttpsUrl("OIDC_PUBLIC_URL", source.OIDC_PUBLIC_URL!));
  if (publicUrl.pathname !== "/") {
    throw new Error("OIDC_PUBLIC_URL must not contain a path.");
  }

  return {
    issuerUrl: parseHttpsUrl("OIDC_ISSUER_URL", source.OIDC_ISSUER_URL!),
    clientId: source.OIDC_CLIENT_ID!.trim(),
    clientSecret: source.OIDC_CLIENT_SECRET!.trim(),
    publicUrl: publicUrl.origin,
    sessionTtlDays,
  };
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const port = Number.parseInt(source.PORT ?? "3000", 10);
  const host = source.HOST ?? "0.0.0.0";
  const dataDir = source.DATA_DIR ?? "./data";
  const databaseFile = source.DATABASE_FILE ?? "machbar.db";
  const basePath = normalizeBasePath(source.BASE_PATH);
  const seedDatabase = (source.SEED_DATABASE ?? "true") === "true";
  const webDistDir = path.resolve(
    process.cwd(),
    source.WEB_DIST_DIR ?? "../web/dist",
  );
  const oidc = loadOidcConfig(source);
  if ((source.NODE_ENV ?? "development") === "production" && oidc === null) {
    throw new Error("OIDC configuration is required in production.");
  }

  return {
    port: Number.isNaN(port) ? 3000 : port,
    host,
    dataDir,
    databaseFile,
    databasePath: path.join(dataDir, databaseFile),
    basePath,
    seedDatabase,
    webDistDir,
    oidc,
  };
}
