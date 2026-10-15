import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { openDb } from "../src/db/client.js";
it("migrates only proven backing subtrees, retaining identities and historical privacy", () => {
  const handle = openDb(":memory:");
  try {
    const dir = fileURLToPath(new URL("../drizzle/", import.meta.url));
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql") && f < "0026").sort()) handle.sqlite.exec(readFileSync(`${dir}/${file}`, "utf8"));
    handle.sqlite.exec(`
      INSERT INTO members(id,name,color) VALUES(1,'Owner','#123456');
      INSERT INTO work_items(id,role,title,scope,owner_member_id) VALUES(1,'task','Private','work',1),(2,'task','Unrelated','work',1);
      INSERT INTO work_items(id,role,title,parent_id,scope) VALUES(3,'task','Child',1,'work');
      INSERT INTO goals(id,owner_member_id,area,title) VALUES(1,1,'personal','Sleep');
      INSERT INTO interventions(id,goal_id,type,commitment,start_date,revisit_date,source,backing_task_id) VALUES(1,1,'frequency_habit','Sleep','2026-10-01','2026-10-15','manual',1);
      INSERT INTO activity_events(kind,entity_id,entity_type,entity_title) VALUES('task_created',1,'task','Private');
    `);
    handle.sqlite.exec(readFileSync(`${dir}/0026_private_intervention_tasks.sql`, "utf8"));
    expect(handle.sqlite.prepare("SELECT id,scope,privacy_owner_member_id AS owner FROM work_items ORDER BY id").all()).toEqual([
      { id: 1, scope: "household", owner: 1 }, { id: 2, scope: "work", owner: null }, { id: 3, scope: "household", owner: 1 },
    ]);
    expect(JSON.parse((handle.sqlite.prepare("SELECT metadata FROM activity_events").get() as {metadata:string}).metadata).after.privacyOwnerMemberId).toBe(1);
    handle.sqlite.exec("INSERT INTO work_items(id,role,title,parent_id) VALUES(4,'task','New child',1)");
    expect((handle.sqlite.prepare("SELECT privacy_owner_member_id AS owner FROM work_items WHERE id=4").get() as {owner:number}).owner).toBe(1);
    handle.sqlite.exec("UPDATE work_items SET parent_id=NULL WHERE id=4");
    expect(() => handle.sqlite.exec("UPDATE work_items SET privacy_owner_member_id=NULL WHERE id=4")).toThrow();
  } finally { handle.close(); }
});
