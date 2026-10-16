import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TestProject } from "vitest/node";
import { openDb } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";

export default function setup(project: TestProject) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "machbar-test-db-"));
  const templatePath = path.join(directory, "template.sqlite");
  function rebuildTemplate() {
    const handle = openDb(":memory:");
    try {
      runMigrations(handle.db);
      fs.writeFileSync(templatePath, handle.sqlite.serialize());
    } finally {
      handle.close();
    }
  }
  try {
    rebuildTemplate();
    project.provide("databaseTemplatePath", templatePath);
    // A watch rerun must see migration edits rather than the initial schema.
    project.onTestsRerun(rebuildTemplate);
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  return () => fs.rmSync(directory, { recursive: true, force: true });
}
