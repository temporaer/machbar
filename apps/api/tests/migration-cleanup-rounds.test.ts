import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/client.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const drizzleDir = path.join(__dirname, "..", "drizzle");

describe("cleanup rounds migration", () => {
  it("preserves pending Home Assistant requests while making their owner nullable", () => {
    const { sqlite, close } = openDb(":memory:");
    try {
      const migrations = readdirSync(drizzleDir).filter((file) => file.endsWith(".sql")).sort();
      const target = "0015_add_cleanup_rounds.sql";
      for (const file of migrations.slice(0, migrations.indexOf(target))) {
        sqlite.exec(readFileSync(path.join(drizzleDir, file), "utf8"));
      }
      sqlite.exec(`
        INSERT INTO home_assistant_integrations (id, instance_id, token_hash, protocol_version, connected_at)
        VALUES (1, 'ha', 'hash', 3, '2026-01-01T00:00:00.000Z');
        INSERT INTO intake_jobs (id, status, created_at, updated_at, expires_at)
        VALUES ('job', 'queued', 'now', 'now', '2999-01-01T00:00:00.000Z');
        INSERT INTO home_assistant_requests (id, integration_id, intake_job_id, kind, payload_json, status, attempts, created_at)
        VALUES ('req', 1, 'job', 'intake_analyze', '{}', 'queued', 1, 'now');
      `);

      sqlite.pragma("foreign_keys = OFF");
      sqlite.exec(readFileSync(path.join(drizzleDir, target), "utf8"));
      sqlite.pragma("foreign_keys = ON");

      expect(sqlite.prepare("SELECT id, intake_job_id, cleanup_round_id, kind, attempts FROM home_assistant_requests").all())
        .toEqual([{ id: "req", intake_job_id: "job", cleanup_round_id: null, kind: "intake_analyze", attempts: 1 }]);
      sqlite.exec(`
        INSERT INTO cleanup_rounds (id, status, context_json, created_at, updated_at, expires_at)
        VALUES ('round', 'queued', '[]', 'now', 'now', '2999-01-01T00:00:00.000Z');
        INSERT INTO home_assistant_requests (id, integration_id, cleanup_round_id, kind, payload_json, created_at)
        VALUES ('req2', 1, 'round', 'cleanup_round_analyze', '{}', 'now');
        DELETE FROM cleanup_rounds WHERE id = 'round';
      `);
      expect(sqlite.prepare("SELECT id FROM home_assistant_requests").all()).toEqual([{ id: "req" }]);
      expect(sqlite.pragma("foreign_key_check")).toEqual([]);
    } finally {
      close();
    }
  });
});
