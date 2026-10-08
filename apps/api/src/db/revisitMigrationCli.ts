import { loadEnv } from "../env.js";
import { openDb } from "./client.js";
import { runMigrations } from "./migrate.js";
import { applyRevisitMigration, inspectRevisitMigration } from "./revisitMigration.js";

const env = loadEnv();
const handle = openDb(env.databasePath);
try {
  runMigrations(handle.db);
  const shouldApply = process.argv.includes("--apply");
  const allowConflicts = process.argv.includes("--allow-conflicts");
  const report = shouldApply
    ? applyRevisitMigration(handle.sqlite, { allowConflicts })
    : inspectRevisitMigration(handle.sqlite);
  console.log(JSON.stringify(report, null, 2));
  console.log(
    `Revisit migration: ${report.changedCount} changed, ` +
      `${report.conflictCount} conflict rows, ` +
      `${report.alreadyApplied ? "already applied" : shouldApply ? "applied" : "not applied"}.`,
  );
} finally {
  handle.close();
}
