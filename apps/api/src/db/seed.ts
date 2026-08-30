import { loadEnv } from "../env.js";
import { colorForTag } from "../domain/mutations.js";
import { openDb, type Db } from "./client.js";
import { runMigrations } from "./migrate.js";
import * as schema from "./schema.js";

function todayIso(offsetDays = 0): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

function nowIso(): string {
  return new Date().toISOString();
}

interface SeedTaskInput {
  title: string;
  notes?: string;
  status?: (typeof schema.tasks.$inferInsert)["status"];
  ownerMemberId?: number | null;
  ownerInheritanceMode?: (typeof schema.tasks.$inferInsert)["ownerInheritanceMode"];
  dueDate?: string | null;
  scheduledDate?: string | null;
  externalWait?: { waitingFor: string | null } | null;
  priority?: number | null;
  size?: (typeof schema.tasks.$inferInsert)["size"];
  tagNames?: string[];
  dependsOn?: string[]; // titles of sibling/earlier tasks within the same seed run
  children?: SeedTaskInput[];
}

interface SeedCriterionInput {
  text: string;
  checked?: boolean;
}

/**
 * Clears all application tables (in FK-safe order) and inserts a small,
 * realistic German household/team dataset covering every status, stuck
 * classification, inheritance mode and dependency scenario the API needs
 * to demonstrate.
 */
export function seedDatabase(db: Db): void {
  db.transaction((tx) => {
    tx.delete(schema.taskExternalWaits).run();
    tx.delete(schema.taskDependencies).run();
    tx.delete(schema.taskExcludedTags).run();
    tx.delete(schema.taskTags).run();
    tx.delete(schema.tasks).run();
    tx.delete(schema.projectAcceptanceCriteria).run();
    tx.delete(schema.projectTags).run();
    tx.delete(schema.projects).run();
    tx.delete(schema.tags).run();
    tx.delete(schema.members).run();

    const anna = tx
      .insert(schema.members)
      .values({ name: "Anna Weber", color: "#f97316" })
      .returning()
      .get();
    const jonas = tx
      .insert(schema.members)
      .values({ name: "Jonas Weber", color: "#3b82f6" })
      .returning()
      .get();
    const mia = tx
      .insert(schema.members)
      .values({ name: "Mia Weber", color: "#10b981" })
      .returning()
      .get();

    const tagNames = [
      "Zuhause",
      "Büro",
      "Telefon",
      "Erledigungen",
      "Finanzen",
      "Gesundheit",
      "Online",
      "Lars",
      "Lea",
      "Jonas",
      "Hannes",
      "Sarah",
      "Schule",
      "Kita",
      "Urlaub",
      "Haus",
      "Garten",
    ];
    const areaTagNames = new Set(["Finanzen", "Gesundheit", "Urlaub", "Haus", "Garten"]);
    const actorTagNames = new Set(["Lars", "Lea", "Jonas", "Hannes", "Sarah", "Schule", "Kita"]);
    const contextTagNames = new Set(["Zuhause", "Büro", "Telefon", "Erledigungen", "Online"]);
    const tagsByName = new Map<string, typeof schema.tags.$inferSelect>();
    for (const name of tagNames) {
      const kind = areaTagNames.has(name)
        ? "area"
        : actorTagNames.has(name)
          ? "actor"
          : contextTagNames.has(name)
            ? "context"
            : "plain";
      const tag = tx
        .insert(schema.tags)
        .values({ name, color: colorForTag(name), kind })
        .returning()
        .get();
      tagsByName.set(name, tag);
    }
    const tagIds = (names: string[]) =>
      names.map((n) => tagsByName.get(n)!.id);

    function insertTaskTree(
      inputs: SeedTaskInput[],
      projectId: number | null,
      parentTaskId: number | null,
    ): Map<string, number> {
      const idsByTitle = new Map<string, number>();
      inputs.forEach((input, index) => {
        const now = nowIso();
        const status = input.status ?? "actionable";
        const row = tx
          .insert(schema.tasks)
          .values({
            projectId,
            parentTaskId,
            title: input.title,
            notes: input.notes ?? "",
            status,
            needsClarification: status === "captured",
            ownerMemberId: input.ownerMemberId ?? null,
            ownerInheritanceMode: input.ownerInheritanceMode ?? "inherit",
            createdByMemberId: anna.id,
            dueDate: input.dueDate ?? null,
            scheduledDate: input.scheduledDate ?? null,
            priority: input.priority ?? null,
            size: input.size ?? null,
            position: index,
            completedAt: input.status === "done" ? now : null,
            cancelledAt: input.status === "cancelled" ? now : null,
          })
          .returning()
          .get();
        if (input.externalWait) {
          tx.insert(schema.taskExternalWaits)
            .values({
              taskId: row.id,
              waitingFor: input.externalWait.waitingFor,
            })
            .run();
        }
        idsByTitle.set(input.title, row.id);

        if (input.tagNames && input.tagNames.length > 0) {
          for (const tagId of tagIds(input.tagNames)) {
            tx.insert(schema.taskTags).values({ taskId: row.id, tagId }).run();
          }
        }

        if (input.children && input.children.length > 0) {
          const childIds = insertTaskTree(input.children, projectId, row.id);
          for (const [title, id] of childIds) idsByTitle.set(title, id);
        }
      });

      // Second pass: wire up dependencies now that all sibling ids exist.
      inputs.forEach((input) => {
        if (!input.dependsOn || input.dependsOn.length === 0) return;
        const taskId = idsByTitle.get(input.title)!;
        for (const dependsOnTitle of input.dependsOn) {
          const dependsOnId = idsByTitle.get(dependsOnTitle);
          if (dependsOnId === undefined) continue;
          tx.insert(schema.taskDependencies)
            .values({ taskId, dependsOnTaskId: dependsOnId })
            .run();
        }
      });

      return idsByTitle;
    }

    function createProject(input: {
      title: string;
      criteria?: SeedCriterionInput[];
      status?: (typeof schema.projects.$inferInsert)["status"];
      ownerMemberId: number | null;
      dueDate?: string | null;
      tagNames?: string[];
      position: number;
      tasks: SeedTaskInput[];
    }) {
      const project = tx
        .insert(schema.projects)
        .values({
          title: input.title,
          status: input.status ?? "active",
          ownerMemberId: input.ownerMemberId,
          dueDate: input.dueDate ?? null,
          position: input.position,
        })
        .returning()
        .get();
      if (input.tagNames) {
        for (const tagId of tagIds(input.tagNames)) {
          tx.insert(schema.projectTags)
            .values({ projectId: project.id, tagId })
            .run();
        }
      }
      (input.criteria ?? []).forEach((criterion, index) => {
        tx.insert(schema.projectAcceptanceCriteria)
          .values({
            projectId: project.id,
            text: criterion.text,
            checked: criterion.checked ?? false,
            position: index,
          })
          .run();
      });
      insertTaskTree(input.tasks, project.id, null);
      return project;
    }

    // 1. Umzug nach Leipzig — mix of statuses, a waiting dependency chain,
    //    and a due date soon for the "Heute" agenda's dueSoon bucket.
    createProject({
      title: "Umzug nach Leipzig",
      criteria: [
        { text: "Umzugsunternehmen ist beauftragt", checked: false },
        { text: "Kartons und Material sind organisiert", checked: true },
        { text: "Ummeldung des Wohnsitzes ist erledigt", checked: false },
      ],
      ownerMemberId: anna.id,
      dueDate: todayIso(10),
      tagNames: ["Zuhause", "Finanzen"],
      position: 0,
      tasks: [
        {
          title: "Umzugsunternehmen beauftragen",
          status: "actionable",
          ownerMemberId: jonas.id,
          ownerInheritanceMode: "explicit",
          size: "M",
          tagNames: ["Telefon"],
          children: [
            {
              title: "Angebote einholen",
              status: "done",
              size: "S",
            },
            {
              title: "Vertrag unterschreiben",
              status: "actionable",
              externalWait: {
                waitingFor: "Umzugsunternehmen Rückmeldung",
              },
              dependsOn: ["Angebote einholen"],
            },
          ],
        },
        {
          title: "Ummeldung Wohnsitz",
          status: "captured",
        },
        {
          title: "Kartons besorgen",
          status: "actionable",
          scheduledDate: todayIso(0),
          dueDate: todayIso(2),
          size: "S",
        },
        {
          title: "Nebenkostenabrechnung klären",
          status: "actionable",
          externalWait: { waitingFor: "Vermieter" },
        },
      ],
    });

    // 2. Garten winterfest machen — a dependency that blocks one actionable
    //    task while another actionable task in the same project stays free,
    //    so the project itself is NOT stuck.
    createProject({
      title: "Garten winterfest machen",
      criteria: [
        { text: "Laub ist entfernt", checked: false },
        { text: "Gartenmöbel sind eingelagert", checked: false },
      ],
      ownerMemberId: jonas.id,
      dueDate: todayIso(-1),
      tagNames: ["Garten"],
      position: 1,
      tasks: [
        {
          title: "Laub entfernen",
          status: "actionable",
          scheduledDate: todayIso(0),
          size: "S",
        },
        {
          title: "Rasen mähen",
          status: "done",
          size: "S",
        },
        {
          title: "Gartenmöbel einlagern",
          status: "actionable",
          dependsOn: ["Laub entfernen"],
        },
      ],
    });

    // 3. Steuererklärung 2025 — an actionable task with an explicit "none"
    //    owner override to demonstrate the "unassigned_actionable" stuck
    //    reason even though the project itself has an owner.
    createProject({
      title: "Steuererklärung 2025",
      criteria: [
        { text: "Belege sind vollständig gesammelt", checked: false },
        { text: "Formular ist eingereicht", checked: false },
      ],
      ownerMemberId: anna.id,
      dueDate: todayIso(30),
      tagNames: ["Finanzen", "Büro"],
      position: 2,
      tasks: [
        {
          title: "Belege sammeln",
          status: "actionable",
          ownerInheritanceMode: "none",
        },
        {
          title: "Formular ausfüllen",
          status: "actionable",
          dependsOn: ["Belege sammeln"],
          size: "L",
        },
        {
          title: "Steuerberater kontaktieren",
          status: "actionable",
          externalWait: { waitingFor: "Steuerberater Rückruf" },
        },
      ],
    });

    // 4. Küche renovieren — every open task is "someday", so there is no
    //    next action at all ("no_next_action").
    createProject({
      title: "Küche renovieren",
      criteria: [
        { text: "Fliesen sind ausgesucht", checked: false },
        { text: "Budget ist festgelegt", checked: true },
      ],
      ownerMemberId: anna.id,
      tagNames: ["Zuhause"],
      position: 3,
      tasks: [
        { title: "Fliesen aussuchen", status: "someday", size: "M" },
        { title: "Handwerker anfragen", status: "someday" },
      ],
    });

    // 5. Wartungsplan Auto — every open task has an unresolved external wait.
    createProject({
      title: "Wartungsplan Auto",
      criteria: [
        { text: "Werkstatttermin ist vereinbart", checked: true },
        { text: "Ersatzteile sind bestellt", checked: false },
      ],
      ownerMemberId: jonas.id,
      position: 4,
      tasks: [
        {
          title: "Werkstatt Rückmeldung abwarten",
          status: "actionable",
          externalWait: { waitingFor: "Werkstatt" },
        },
        {
          title: "Ersatzteil Lieferung abwarten",
          status: "actionable",
          externalWait: { waitingFor: "Zulieferer" },
        },
      ],
    });

    // 6. Bücherregal aufbauen — the only actionable task is blocked by a
    //    dependency that is itself externally blocked.
    createProject({
      title: "Bücherregal aufbauen",
      criteria: [
        { text: "Farbe ist ausgesucht", checked: true },
        { text: "Regal steht am vorgesehenen Platz", checked: false },
      ],
      ownerMemberId: mia.id,
      position: 5,
      tasks: [
        {
          title: "Farbe kaufen",
          status: "actionable",
          externalWait: { waitingFor: "Baumarkt Lieferung" },
        },
        {
          title: "Regal aufbauen",
          status: "actionable",
          ownerMemberId: jonas.id,
          ownerInheritanceMode: "explicit",
          dependsOn: ["Farbe kaufen"],
          size: "M",
        },
      ],
    });

    // 7. Wohnzimmer neu einrichten — a Backlog story: not yet started, no
    //    driver assigned yet, and its acceptance criteria are still fully
    //    open (unchecked).
    createProject({
      title: "Wohnzimmer neu einrichten",
      status: "backlog",
      criteria: [
        { text: "Einrichtungsideen sind gesammelt", checked: false },
        { text: "Budget ist geschätzt", checked: false },
      ],
      ownerMemberId: null,
      tagNames: ["Zuhause"],
      position: 6,
      tasks: [
        { title: "Einrichtungsstile recherchieren", status: "someday" },
        { title: "Möbelhäuser vergleichen", status: "someday" },
      ],
    });

    // 8. Fahrrad Sommer-Check — a Completed story: it has a driver, every
    //    task is done, and every acceptance criterion is checked off.
    createProject({
      title: "Fahrrad Sommer-Check",
      status: "completed",
      criteria: [
        { text: "Reifen sind geprüft", checked: true },
        { text: "Bremsen sind eingestellt", checked: true },
        { text: "Kette ist geölt", checked: true },
      ],
      ownerMemberId: mia.id,
      dueDate: todayIso(-14),
      tagNames: ["Zuhause"],
      position: 7,
      tasks: [
        { title: "Reifen prüfen", status: "done", size: "S" },
        { title: "Bremsen einstellen", status: "done", size: "S" },
        { title: "Kette ölen", status: "done", size: "S" },
      ],
    });

    // 9. Altes Gartenhaus abreißen — an Archived story: shelved with no
    //    driver, and a mix of checked/unchecked criteria left behind from
    //    before it was abandoned.
    createProject({
      title: "Altes Gartenhaus abreißen",
      status: "archived",
      criteria: [
        { text: "Genehmigung wurde eingeholt", checked: true },
        { text: "Abriss wurde durchgeführt", checked: false },
      ],
      ownerMemberId: null,
      tagNames: ["Garten"],
      position: 8,
      tasks: [{ title: "Entsorgung organisieren", status: "cancelled" }],
    });

    // 10. Homeoffice-Ecke einrichten — an Active story with a driver where
    //     every task is already done/cancelled but its acceptance criteria
    //     are still open: the "completion_review" stuck scenario (ready
    //     for a human to complete/reopen/archive it).
    createProject({
      title: "Homeoffice-Ecke einrichten",
      status: "active",
      criteria: [
        { text: "Schreibtisch und Stuhl sind eingerichtet", checked: true },
        { text: "Beleuchtung ist abgenommen", checked: false },
      ],
      ownerMemberId: jonas.id,
      tagNames: ["Zuhause"],
      position: 9,
      tasks: [
        { title: "Schreibtisch aufbauen", status: "done", size: "M" },
        { title: "Monitorarm montieren", status: "done", size: "S" },
        { title: "Kabel verlegen", status: "cancelled" },
      ],
    });

    // Free-standing capture tasks (Eingang) with no project yet.
    insertTaskTree(
      [
        { title: "Zahnarzttermin ausmachen", status: "captured" },
        { title: "Geschenk für Oma kaufen", status: "captured" },
        { title: "Nachbarn wegen Leiter fragen", status: "captured" },
        {
          title: "Fahrrad reparieren",
          status: "actionable",
          dueDate: todayIso(0),
        },
        // Blocked (depends on the still-open "Nachbarn wegen Leiter fragen"
        // above) but scheduled for today: demonstrates the "Heute" revisit
        // reminder — normally-excluded blocked tasks reappear when their
        // own scheduledDate is today or earlier.
        {
          title: "Leiter zurückbringen",
          status: "actionable",
          scheduledDate: todayIso(0),
          dependsOn: ["Nachbarn wegen Leiter fragen"],
        },
      ],
      null,
      null,
    );
  });
}

async function main() {
  const env = loadEnv();
  const { db, close } = openDb(env.databasePath);
  runMigrations(db);
  seedDatabase(db);
  console.log(`Seeded database at ${env.databasePath}`);
  close();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
