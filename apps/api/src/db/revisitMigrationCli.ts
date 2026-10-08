import { loadEnv } from "../env.js";
import { openDb } from "./client.js";
import { inspectRevisitMigration } from "./revisitMigration.js";

const env = loadEnv();
const handle = openDb(env.databasePath);
try {
  const report = inspectRevisitMigration(handle.sqlite);
  console.log(JSON.stringify(report, null, 2));
  console.log(
    `Revisit migration: ${report.changedCount} changed, ` +
      `${report.conflictCount} conflict rows, ` +
      `${report.alreadyApplied ? "already applied" : "not applied"}.`,
  );
} finally {
  handle.close();
}
