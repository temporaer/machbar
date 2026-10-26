import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

// Each run gets a disposable database; never reuse a developer/prod server.
const dataDir = mkdtempSync(path.join(tmpdir(), "machbar-e2e-"));
const child = spawn(process.execPath, ["apps/api/dist/index.js"], {
  stdio: "inherit",
  env: { PATH: process.env.PATH, LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH, NODE_ENV: "test", ALLOW_UNAUTHENTICATED: "true", PORT: "4173", HOST: "127.0.0.1", DATA_DIR: dataDir,
    WEB_DIST_DIR: path.resolve("apps/web/dist"), SEED_DATABASE: "false",
    OIDC_ISSUER_URL: "", OIDC_CLIENT_ID: "", OIDC_CLIENT_SECRET: "", OIDC_PUBLIC_URL: "" },
});
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => child.kill(signal));
child.on("exit", code => { rmSync(dataDir, { recursive: true, force: true }); process.exit(code ?? 0); });
