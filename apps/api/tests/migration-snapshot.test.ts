import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

it("keeps the latest migration snapshot chained and produces no duplicate schema migration", () => {
  const output = mkdtempSync(join(tmpdir(), "machbar-schema-drift-"));
  try {
    cpSync(resolve("drizzle"), output, { recursive: true });
    const journal = JSON.parse(readFileSync(join(output, "meta/_journal.json"), "utf8"));
    const latest = journal.entries.at(-1);
    const prior = journal.entries.at(-2);
    const snapshot = JSON.parse(readFileSync(join(output, `meta/${String(latest.idx).padStart(4, "0")}_snapshot.json`), "utf8"));
    const preceding = JSON.parse(readFileSync(join(output, `meta/${String(prior.idx).padStart(4, "0")}_snapshot.json`), "utf8"));
    expect(snapshot.prevId).toBe(preceding.id);
    const before = readdirSync(output).filter(name => name.endsWith(".sql")).sort();
    execFileSync("drizzle-kit", ["generate", "--dialect", "sqlite", "--schema", "./src/db/schema.ts", "--out", output], {
      cwd: process.cwd(), timeout: 8000, stdio: ["ignore", "pipe", "pipe"],
    });
    expect(readdirSync(output).filter(name => name.endsWith(".sql")).sort()).toEqual(before);
  } finally { rmSync(output, { recursive: true, force: true }); }
}, 10000);
