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
}

function normalizeBasePath(input: string | undefined): string {
  if (!input || input === "/") return "/";
  let value = input.trim();
  if (!value.startsWith("/")) value = `/${value}`;
  if (value.length > 1 && value.endsWith("/")) value = value.slice(0, -1);
  return value;
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

  return {
    port: Number.isNaN(port) ? 3000 : port,
    host,
    dataDir,
    databaseFile,
    databasePath: path.join(dataDir, databaseFile),
    basePath,
    seedDatabase,
    webDistDir,
  };
}
