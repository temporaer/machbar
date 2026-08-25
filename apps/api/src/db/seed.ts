import { loadEnv } from "../env.js";
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
  context?: string | null;
  contextInheritanceMode?: (typeof schema.tasks.$inferInsert)["contextInheritanceMode"];
  dueDate?: string | null;
  scheduledDate?: string | null;
  waitingFor?: string | null;
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
      "Garten",
      "Finanzen",
      "Gesundheit",
      "Online",
    ];
    const tagsByName = new Map<string, { id: number; name: string }>();
    for (const name of tagNames) {
      const tag = tx.insert(schema.tags).values({ name }).returning().get();
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
        const row = tx
          .insert(schema.tasks)
          .values({
            projectId,
            parentTaskId,
            title: input.title,
            notes: input.notes ?? "",
            status: input.status ?? "inbox",
            ownerMemberId: input.ownerMemberId ?? null,
            ownerInheritanceMode: input.ownerInheritanceMode ?? "inherit",
            createdByMemberId: anna.id,
            dueDate: input.dueDate ?? null,
            scheduledDate: input.scheduledDate ?? null,
            waitingFor: input.waitingFor ?? null,
            context: input.context ?? null,
            contextInheritanceMode: input.contextInheritanceMode ?? "inherit",
            priority: input.priority ?? null,
            size: input.size ?? null,
            position: index,
            completedAt: input.status === "done" ? now : null,
            cancelledAt: input.status === "cancelled" ? now : null,
          })
          .returning()
          .get();
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
      context: string | null;
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
          context: input.context,
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
      context: "Zuhause",
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
              status: "waiting",
              waitingFor: "Umzugsunternehmen Rückmeldung",
              dependsOn: ["Angebote einholen"],
            },
          ],
        },
        {
          title: "Ummeldung Wohnsitz",
          status: "inbox",
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
          status: "waiting",
          waitingFor: "Vermieter",
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
      context: "Garten",
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
      context: "Büro",
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
          status: "waiting",
          waitingFor: "Steuerberater Rückruf",
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
      context: "Zuhause",
      tagNames: ["Zuhause"],
      position: 3,
      tasks: [
        { title: "Fliesen aussuchen", status: "someday", size: "M" },
        { title: "Handwerker anfragen", status: "someday" },
      ],
    });

    // 5. Wartungsplan Auto — every open task is "waiting" ("only_waiting").
    createProject({
      title: "Wartungsplan Auto",
      criteria: [
        { text: "Werkstatttermin ist vereinbart", checked: true },
        { text: "Ersatzteile sind bestellt", checked: false },
      ],
      ownerMemberId: jonas.id,
      context: "Unterwegs",
      position: 4,
      tasks: [
        {
          title: "Werkstatt Rückmeldung abwarten",
          status: "waiting",
          waitingFor: "Werkstatt",
        },
        {
          title: "Ersatzteil Lieferung abwarten",
          status: "waiting",
          waitingFor: "Zulieferer",
        },
      ],
    });

    // 6. Bücherregal aufbauen — the only actionable task is blocked by a
    //    dependency that is itself not actionable ("blocked_dependencies").
    createProject({
      title: "Bücherregal aufbauen",
      criteria: [
        { text: "Farbe ist ausgesucht", checked: true },
        { text: "Regal steht am vorgesehenen Platz", checked: false },
      ],
      ownerMemberId: mia.id,
      context: "Zuhause",
      position: 5,
      tasks: [
        {
          title: "Farbe kaufen",
          status: "waiting",
          waitingFor: "Baumarkt Lieferung",
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
      context: "Zuhause",
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
      context: "Zuhause",
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
      context: "Garten",
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
      context: "Zuhause",
      tagNames: ["Zuhause"],
      position: 9,
      tasks: [
        { title: "Schreibtisch aufbauen", status: "done", size: "M" },
        { title: "Monitorarm montieren", status: "done", size: "S" },
        { title: "Kabel verlegen", status: "cancelled" },
      ],
    });

    // Free-standing inbox tasks (Eingang) with no project yet.
    insertTaskTree(
      [
        { title: "Zahnarzttermin ausmachen", status: "inbox" },
        { title: "Geschenk für Oma kaufen", status: "inbox" },
        { title: "Nachbarn wegen Leiter fragen", status: "inbox" },
        {
          title: "Fahrrad reparieren",
          status: "actionable",
          context: "Zuhause",
          contextInheritanceMode: "explicit",
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
