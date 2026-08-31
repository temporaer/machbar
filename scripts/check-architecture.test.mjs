import assert from "node:assert/strict";
import test from "node:test";
import { checkSource } from "./check-architecture.mjs";

function rules(filePath, sourceText) {
  return checkSource({ filePath, sourceText }).map((result) => result.rule);
}

test("rejects a standard task mutation from a component", () => {
  const results = checkSource({
    filePath: "apps/web/src/components/TaskDetailFoo.tsx",
    sourceText: "const save = () => api.updateTask(1, {});",
  });
  assert.deepEqual(results.map((result) => result.rule), ["canonical-task-mutations"]);
  assert.match(results[0].message, /useTaskActions\.ts/);
  assert.match(results[0].message, /#task-mutations/);
});

test("rejects a standard project mutation from a page", () => {
  assert.deepEqual(
    rules(
      "apps/web/src/pages/ProjectFoo.tsx",
      "const archive = () => api.archiveProject(1, { expectedRevision: 2 });",
    ),
    ["canonical-project-mutations"],
  );
});

test("rejects a new direct task move caller", () => {
  assert.deepEqual(
    rules(
      "apps/web/src/components/NewMoveButton.tsx",
      "const move = () => api.moveTask(1, { parentTaskId: null });",
    ),
    ["canonical-task-hierarchy"],
  );
});

test("rejects a pure helper importing a React hook", () => {
  assert.deepEqual(
    rules(
      "apps/web/src/lib/taskPolicy.ts",
      'import { useTaskActions } from "./useTaskActions";',
    ),
    ["pure-helper-dependency"],
  );
});

test("allows hooks to compose hooks", () => {
  assert.deepEqual(
    rules(
      "apps/web/src/lib/useTaskPolicy.ts",
      'import { useTaskActions } from "./useTaskActions";',
    ),
    [],
  );
});

test("rejects presentation importing domain semantics from a hook module", () => {
  assert.deepEqual(
    rules(
      "apps/web/src/components/RefinementFoo.tsx",
      'import { nextSizeInCycle } from "../lib/useRefinementActions";',
    ),
    ["hook-module-domain-export"],
  );
});

test("allows presentation to import hooks, providers, constants, and types", () => {
  assert.deepEqual(
    rules(
      "apps/web/src/components/TaskFoo.tsx",
      [
        'import { RETENTION_MS, useTaskActions } from "../lib/useTaskActions";',
        'import { OutlineOrganizeProvider } from "../lib/useOutlineOrganize";',
        'import type { ChildPolicy } from "../lib/useTaskActions";',
      ].join("\n"),
    ),
    [],
  );
});

test("rejects deprecated primitives and hierarchy routes", () => {
  assert.deepEqual(
    rules(
      "apps/api/src/routes/tasks.ts",
      [
        "const oldSheet = 'AssignOwnerSheet';",
        "const oldRoute = '/api/tasks/:id/indent';",
      ].join("\n"),
    ),
    ["deprecated-architecture", "deprecated-task-route"],
  );
});

test("allows canonical action and pure mutation modules", () => {
  assert.deepEqual(
    rules(
      "apps/web/src/lib/useTaskActions.ts",
      [
        "api.completeTask(1);",
        "api.setExternalWait(1, {});",
      ].join("\n"),
    ),
    [],
  );
  assert.deepEqual(
    rules(
      "apps/web/src/lib/taskMutations.ts",
      "api.updateTask(1, {});",
    ),
    [],
  );
  assert.deepEqual(
    rules(
      "apps/web/src/lib/useProjectActions.ts",
      "api.updateProject(1, {});",
    ),
    [],
  );
});

test("allows reads, unique operations, and explicit exceptions", () => {
  assert.deepEqual(
    rules(
      "apps/web/src/pages/TodayPage.tsx",
      [
        "api.getAgenda();",
        "api.createTask({});",
        "api.addTaskDependency(1, 2);",
      ].join("\n"),
    ),
    [],
  );
  assert.deepEqual(
    rules(
      "apps/web/src/pages/SharePage.tsx",
      "api.updateTask(1, {}); api.updateProject(2, {});",
    ),
    [],
  );
  for (const filePath of [
    "apps/web/src/lib/useOutlineOrganize.tsx",
    "apps/web/src/components/MoveTaskSheet.tsx",
    "apps/web/src/components/QuickAdd.tsx",
  ]) {
    assert.deepEqual(rules(filePath, "api.moveTask(1, {});"), []);
  }
});
