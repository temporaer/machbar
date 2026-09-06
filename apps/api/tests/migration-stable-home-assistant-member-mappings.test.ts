import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("stable home-assistant member mapping migration", () => {
  it("de-duplicates mappings that would collide on external_person_id, preferring the active integration", () => {
    const sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    sqlite.exec(`
      CREATE TABLE members (
        id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
        name text NOT NULL UNIQUE,
        color text NOT NULL
      );
      CREATE TABLE home_assistant_integrations (
        id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
        instance_id text NOT NULL UNIQUE,
        token_hash text NOT NULL UNIQUE,
        protocol_version integer NOT NULL,
        connected_at text NOT NULL,
        last_update_at text,
        revoked_at text
      );
      CREATE TABLE home_assistant_people (
        id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
        integration_id integer NOT NULL,
        external_id text NOT NULL,
        name text NOT NULL,
        state text NOT NULL,
        observed_at text NOT NULL,
        FOREIGN KEY (integration_id) REFERENCES home_assistant_integrations(id) ON DELETE cascade
      );
      CREATE TABLE home_assistant_member_mappings (
        member_id integer PRIMARY KEY NOT NULL,
        person_id integer NOT NULL,
        FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE cascade,
        FOREIGN KEY (person_id) REFERENCES home_assistant_people(id) ON DELETE cascade
      );
      CREATE UNIQUE INDEX home_assistant_member_mappings_person_id_unique
        ON home_assistant_member_mappings (person_id);

      INSERT INTO members (id, name, color) VALUES
        (1, 'Revoked integration member', '#111111'),
        (2, 'Active integration member', '#222222'),
        (3, 'Only-stale-integration member', '#333333'),
        (4, 'Only-fresh-integration member', '#444444');

      -- Two past integrations that both re-used the same external person id 'alice'.
      INSERT INTO home_assistant_integrations
        (id, instance_id, token_hash, protocol_version, connected_at, last_update_at, revoked_at) VALUES
        (1, 'revoked-instance', 'hash-revoked', 1, '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', '2026-01-03T00:00:00.000Z'),
        (2, 'active-instance', 'hash-active', 1, '2026-02-01T00:00:00.000Z', '2026-02-02T00:00:00.000Z', NULL),
        (3, 'stale-instance', 'hash-stale', 1, '2026-01-05T00:00:00.000Z', '2026-01-06T00:00:00.000Z', '2026-01-07T00:00:00.000Z'),
        (4, 'fresh-instance', 'hash-fresh', 1, '2026-01-10T00:00:00.000Z', '2026-01-20T00:00:00.000Z', '2026-01-21T00:00:00.000Z');

      INSERT INTO home_assistant_people (id, integration_id, external_id, name, state, observed_at) VALUES
        (1, 1, 'alice', 'Alice', 'known', '2026-01-02T00:00:00.000Z'),
        (2, 2, 'alice', 'Alice', 'known', '2026-02-02T00:00:00.000Z'),
        (3, 3, 'bob', 'Bob', 'known', '2026-01-06T00:00:00.000Z'),
        (4, 4, 'bob', 'Bob', 'known', '2026-01-20T00:00:00.000Z');

      INSERT INTO home_assistant_member_mappings (member_id, person_id) VALUES
        (1, 1),
        (2, 2),
        (3, 3),
        (4, 4);
    `);

    const migration = fs.readFileSync(
      path.resolve(
        __dirname,
        "../drizzle/0022_stable_home_assistant_member_mappings.sql",
      ),
      "utf8",
    );
    for (const statement of migration.split("--> statement-breakpoint")) {
      if (statement.trim()) sqlite.exec(statement);
    }

    expect(
      sqlite
        .prepare(
          `SELECT member_id AS memberId, external_person_id AS externalPersonId
           FROM home_assistant_member_mappings ORDER BY member_id`,
        )
        .all(),
    ).toEqual([
      { memberId: 2, externalPersonId: "alice" },
      { memberId: 4, externalPersonId: "bob" },
    ]);
  });
});
