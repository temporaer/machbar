import { describe, expect, it } from "vitest";
import type { Task } from "@machbar/shared";
import { makeTask } from "../test/fixtures";
import {
  INDENT_WIDTH,
  applyMove,
  isDescendantOf,
  locateTask,
  outlineRootGroup,
  planMove,
  projectDrop,
  rowsExcludingSubtree,
  slotFromPointer,
} from "./taskTreeMove";
import type { OutlineRow } from "./taskTreeMove";

/** `[A, [B, [C]], D]`-style shorthand for readable tree fixtures. */
function tree(
  id: number,
  position: number,
  parentTaskId: number | null,
  children: Task[] = [],
): Task {
  return makeTask({ id, position, parentTaskId, title: `T${id}`, projectId: 7, children });
}

function ids(tasks: Task[]): number[] {
  return tasks.map((t) => t.id);
}

function positions(tasks: Task[]): number[] {
  return tasks.map((t) => t.position);
}

function rowsOf(entries: [number, number | null, number][]): OutlineRow[] {
  return entries.map(([taskId, parentId, depth]) => ({ taskId, parentId, depth }));
}

/** Uniform 20px-high rows starting at y=0, matching `rowsOf` order. */
function rects(count: number) {
  return Array.from({ length: count }, (_, i) => ({ top: i * 20, height: 20 }));
}

describe("visible rows", () => {
  it("blendet die gezogene Aufgabe samt ihres sichtbaren Teilbaums als Ziel aus", () => {
    const rows = rowsOf([
      [1, null, 0],
      [2, 1, 1],
      [3, 2, 2],
      [4, null, 0],
    ]);
    expect(rowsExcludingSubtree(rows, 1).map((r) => r.taskId)).toEqual([4]);
    expect(rowsExcludingSubtree(rows, 2).map((r) => r.taskId)).toEqual([1, 4]);
    expect(rowsExcludingSubtree(rows, 4).map((r) => r.taskId)).toEqual([1, 2, 3]);
  });

  it("bestimmt den Einfügeschlitz aus der Zeigerposition", () => {
    const measured = rects(3);
    expect(slotFromPointer(measured, -5)).toBe(0);
    expect(slotFromPointer(measured, 9)).toBe(0);
    expect(slotFromPointer(measured, 11)).toBe(1);
    expect(slotFromPointer(measured, 31)).toBe(2);
    expect(slotFromPointer(measured, 999)).toBe(3);
  });
});

describe("projectDrop", () => {
  const rows = rowsOf([
    [1, null, 0],
    [2, null, 0],
    [3, null, 0],
  ]);

  it("hält die Ebene ohne waagerechte Bewegung", () => {
    const drop = projectDrop({ rows, slot: 2, activeDepth: 0, offsetX: 0, rootParentId: null });
    expect(drop).toEqual({ parentId: null, depth: 0, index: 2, beforeTaskId: 3 });
  });

  it("rückt nach rechts unter die vorangehende Aufgabe ein", () => {
    const drop = projectDrop({ rows, slot: 2, activeDepth: 0, offsetX: INDENT_WIDTH, rootParentId: null });
    expect(drop).toEqual({ parentId: 2, depth: 1, index: 0, beforeTaskId: 3 });
  });

  it("begrenzt die Ebene auf höchstens eine Stufe unter der Vorgängerzeile", () => {
    const drop = projectDrop({
      rows,
      slot: 1,
      activeDepth: 0,
      offsetX: INDENT_WIDTH * 5,
      rootParentId: null,
    });
    expect(drop.depth).toBe(1);
    expect(drop.parentId).toBe(1);
  });

  it("rückt nach links wieder aus, aber nie flacher als die Folgezeile", () => {
    const nested = rowsOf([
      [1, null, 0],
      [2, 1, 1],
      [3, 1, 1],
    ]);
    const out = projectDrop({
      rows: nested,
      slot: 3,
      activeDepth: 1,
      offsetX: -INDENT_WIDTH,
      rootParentId: null,
    });
    expect(out).toEqual({ parentId: null, depth: 0, index: 1, beforeTaskId: null });

    // Vor Zeile 3 (Ebene 1) darf nicht auf Ebene 0 abgelegt werden.
    const blocked = projectDrop({
      rows: nested,
      slot: 2,
      activeDepth: 1,
      offsetX: -INDENT_WIDTH * 3,
      rootParentId: null,
    });
    expect(blocked.depth).toBe(1);
    expect(blocked.parentId).toBe(1);
  });

  it("zählt den Index nur innerhalb der Zielgeschwister", () => {
    const nested = rowsOf([
      [1, null, 0],
      [2, 1, 1],
      [3, 1, 1],
      [4, null, 0],
    ]);
    const drop = projectDrop({
      rows: nested,
      slot: 3,
      activeDepth: 1,
      offsetX: 0,
      rootParentId: null,
    });
    expect(drop).toEqual({ parentId: 1, depth: 1, index: 2, beforeTaskId: 4 });
  });

  it("erkennt den Wurzel-Elternknoten eines Teilbaum-Ausschnitts", () => {
    const drop = projectDrop({
      rows: rowsOf([
        [10, 99, 0],
        [11, 99, 0],
      ]),
      slot: 1,
      activeDepth: 0,
      offsetX: 0,
      rootParentId: 99,
    });
    expect(drop.parentId).toBe(99);
    expect(drop.depth).toBe(0);
  });
});

describe("locateTask", () => {
  const roots = [tree(1, 0, null, [tree(2, 0, 1, [tree(3, 0, 2)])]), tree(4, 1, null)];

  it("findet Aufgaben samt Geschwistern und Tiefe", () => {
    expect(locateTask(roots, 3, null)).toMatchObject({ parentId: 2, index: 0, depth: 2 });
    expect(locateTask(roots, 4, null)).toMatchObject({ parentId: null, index: 1, depth: 0 });
    expect(locateTask(roots, 999, null)).toBeNull();
  });

  it("erkennt Nachkommen", () => {
    expect(isDescendantOf(roots, 1, 3, null)).toBe(true);
    expect(isDescendantOf(roots, 2, 1, null)).toBe(false);
    expect(isDescendantOf(roots, 1, null, null)).toBe(false);
  });
});

describe("planMove", () => {
  const roots = [
    tree(1, 0, null, [tree(3, 0, 1), tree(4, 1, 1)]),
    tree(2, 1, null),
  ];
  const base = { roots, rootParentId: null, rootProjectId: 7 } as const;

  it("plant Geschwister-Umsortierung als kanonischen Zug", () => {
    expect(planMove({ ...base, taskId: 1, targetParentId: null, targetIndex: 1 })).toEqual({
      kind: "move",
      taskId: 1,
      parentTaskId: null,
      projectId: 7,
      position: 1,
      expectedRevision: 1,
    });
  });

  it("tut nichts, wenn sich nichts ändert", () => {
    expect(planMove({ ...base, taskId: 1, targetParentId: null, targetIndex: 0 })).toEqual({
      kind: "none",
    });
    expect(planMove({ ...base, taskId: 99, targetParentId: null, targetIndex: 0 })).toEqual({
      kind: "none",
    });
  });

  it("plant Einrücken als kanonischen Zug", () => {
    expect(planMove({ ...base, taskId: 2, targetParentId: 1, targetIndex: 2 })).toEqual({
      kind: "move",
      taskId: 2,
      parentTaskId: 1,
      position: 2,
      expectedRevision: 1,
    });
  });

  it("plant Ausrücken als kanonischen Zug", () => {
    expect(planMove({ ...base, taskId: 3, targetParentId: null, targetIndex: 1 })).toEqual({
      kind: "move",
      taskId: 3,
      parentTaskId: null,
      projectId: 7,
      position: 1,
      expectedRevision: 1,
    });
  });

  it("plant Umhängen an jeder Position gleich", () => {
    const wide = [tree(1, 0, null), tree(2, 1, null, [tree(5, 0, 2), tree(6, 1, 2)]), tree(3, 2, null)];
    expect(
      planMove({ roots: wide, rootParentId: null, rootProjectId: 7, taskId: 1, targetParentId: 2, targetIndex: 2 }),
    ).toEqual({
      kind: "move",
      taskId: 1,
      parentTaskId: 2,
      position: 2,
      expectedRevision: 1,
    });
    expect(
      planMove({ roots: wide, rootParentId: null, rootProjectId: 7, taskId: 1, targetParentId: 2, targetIndex: 1 }),
    ).toEqual({
      kind: "move",
      taskId: 1,
      parentTaskId: 2,
      position: 1,
      expectedRevision: 1,
    });
  });
});

describe("applyMove", () => {
  it("sortiert Geschwister um und nummeriert die Positionen neu", () => {
    const roots = [tree(1, 0, null), tree(2, 1, null), tree(3, 2, null)];
    const next = applyMove(roots, 1, null, 2, null);
    expect(ids(next)).toEqual([2, 3, 1]);
    expect(positions(next)).toEqual([0, 1, 2]);
    expect(next[2]!.revision).toBe(2);
    expect(next[0]!.revision).toBe(1);
    expect(next[1]!.revision).toBe(1);
    // Das Original bleibt unangetastet (Rollback-fähig).
    expect(ids(roots)).toEqual([1, 2, 3]);
  });

  it("rückt unter eine bisher kinderlose Aufgabe ein", () => {
    const roots = [tree(1, 0, null), tree(2, 1, null)];
    const next = applyMove(roots, 2, 1, 0, null);
    expect(ids(next)).toEqual([1]);
    expect(ids(next[0]!.children)).toEqual([2]);
    expect(next[0]!.children[0]!.parentTaskId).toBe(1);
  });

  it("rückt wieder aus und schließt die Lücke in der Quellgruppe", () => {
    const roots = [tree(1, 0, null, [tree(3, 0, 1), tree(4, 1, 1)]), tree(2, 1, null)];
    const next = applyMove(roots, 3, null, 1, null);
    expect(ids(next)).toEqual([1, 3, 2]);
    expect(positions(next)).toEqual([0, 1, 2]);
    expect(ids(next[0]!.children)).toEqual([4]);
    expect(positions(next[0]!.children)).toEqual([0]);
  });

  it("verweigert Züge in den eigenen Teilbaum", () => {
    const roots = [tree(1, 0, null, [tree(2, 0, 1)])];
    expect(applyMove(roots, 1, 2, 0, null)).toBe(roots);
    expect(applyMove(roots, 1, 1, 0, null)).toBe(roots);
    expect(applyMove(roots, 404, null, 0, null)).toBe(roots);
  });

  it("bewahrt die Identität unberührter Zweige", () => {
    const untouched = tree(9, 2, null, [tree(10, 0, 9)]);
    const roots = [tree(1, 0, null), tree(2, 1, null), untouched];
    const next = applyMove(roots, 1, null, 1, null);
    expect(next[2]).toBe(untouched);
  });

  it("bewältigt sehr tiefe Bäume ohne Stapelüberlauf", () => {
    const depth = 400;
    let node = tree(depth, 0, depth - 1);
    for (let id = depth - 1; id >= 2; id -= 1) node = tree(id, 0, id - 1, [node]);
    const roots = [tree(1, 0, null, [node]), tree(9000, 1, null)];

    expect(locateTask(roots, depth, null)).toMatchObject({ depth: depth - 1 });

    const next = applyMove(roots, 9000, 1, 1, null);
    expect(ids(next)).toEqual([1]);
    expect(ids(next[0]!.children)).toEqual([2, 9000]);
    // Der tiefe Zweig wird dabei unverändert weitergereicht.
    expect(next[0]!.children[0]).toBe(node);
  });
});

describe("outlineRootGroup", () => {
  it("erkennt eine echte Geschwistergruppe", () => {
    expect(outlineRootGroup([tree(1, 0, null), tree(2, 1, null)])).toEqual({
      parentId: null,
      projectId: 7,
    });
  });

  it("schaltet gemischte Ansichten ab", () => {
    const mixed = [makeTask({ id: 1, projectId: 7 }), makeTask({ id: 2, projectId: 8 })];
    expect(outlineRootGroup(mixed)).toBeNull();
    expect(outlineRootGroup([])).toBeNull();
  });
});
