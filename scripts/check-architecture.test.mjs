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

test("rejects direct review acknowledgements outside canonical actions", () => {
  assert.deepEqual(
    rules(
      "apps/web/src/pages/ReviewFoo.tsx",
      [
        "api.acknowledgeTaskReview(1, { expectedRevision: 2 });",
        "api.acknowledgeProjectReview(2, { expectedRevision: 3 });",
      ].join("\n"),
    ),
    ["canonical-task-mutations", "canonical-project-mutations"],
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
      "apps/web/src/lib/useTaskActions.tsx",
      [
        "api.completeTask(1);",
        "api.setExternalWait(1, {});",
        "api.acknowledgeTaskReview(1, {});",
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
      "apps/web/src/lib/useProjectActions.tsx",
      "api.updateProject(1, {}); api.acknowledgeProjectReview(1, {});",
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

test("rejects a surface rendering a focused workflow sheet itself", () => {
  const results = checkSource({
    filePath: "apps/web/src/components/SomeRow.tsx",
    sourceText: 'import { TaskPlanSheet } from "./TaskPlanSheet";',
  });
  assert.deepEqual(results.map((result) => result.rule), ["canonical-workflow-host"]);
  assert.match(results[0].message, /Only TaskWorkflowHost may render it/);
});

test("allows the workflow host to import its own focused sheets", () => {
  assert.deepEqual(
    rules(
      "apps/web/src/components/TaskWorkflowHost.tsx",
      [
        'import { TaskPlanSheet } from "./TaskPlanSheet";',
        'import { TaskSplitSheet } from "./TaskSplitSheet";',
      ].join("\n"),
    ),
    [],
  );
  assert.deepEqual(
    rules(
      "apps/web/src/components/ProjectWorkflowHost.tsx",
      'import { ProjectDeferSheet } from "./ProjectDeferSheet";',
    ),
    [],
  );
});

test("treats sheets composed by several workflows as primitives, not workflows", () => {
  assert.deepEqual(
    rules(
      "apps/web/src/components/RefinementTaskRow.tsx",
      'import { MemberSelectionSheet } from "./MemberSelectionSheet";',
    ),
    [],
  );
});

test("rejects a surface deciding which workflow implements an intent", () => {
  const results = checkSource({
    filePath: "apps/web/src/components/SomeRow.tsx",
    sourceText: [
      'const plan = () => taskWorkflow.open("plan", task.id);',
      'const defer = () => projectWorkflow.open("defer", story.id);',
    ].join("\n"),
  });
  assert.deepEqual(results.map((result) => result.rule), [
    "canonical-workflow-routing",
    "canonical-workflow-routing",
  ]);
  assert.match(results[0].message, /useWorkItemCommands/);
});

test("rejects a semantic command borrowing the task detail sheet as its editor", () => {
  assert.deepEqual(
    rules(
      "apps/web/src/pages/ReviewFoo.tsx",
      'const planTask = () => taskDetail.open(taskId, "schedule");',
    ),
    ["canonical-workflow-routing"],
  );
});

test("allows the one dispatcher to route intents into workflows and details", () => {
  assert.deepEqual(
    rules(
      "apps/web/src/lib/useWorkItemCommands.ts",
      [
        'taskWorkflow.open("plan", command.taskId);',
        'projectWorkflow.open("defer", command.story.id);',
        "taskDetail.open(command.taskId, command.focusField);",
      ].join("\n"),
    ),
    [],
  );
});

test("keeps the Inbox clarification queue as the documented detail exception", () => {
  assert.deepEqual(
    rules(
      "apps/web/src/pages/InboxPage.tsx",
      "const clarifyAll = () => taskDetail.openQueue(ids);",
    ),
    [],
  );
  assert.deepEqual(
    rules(
      "apps/web/src/pages/InboxPage.tsx",
      'const plan = () => taskWorkflow.open("plan", id);',
    ),
    ["canonical-workflow-routing"],
  );
});

test("rejects reintroducing the generic quick-action sheet", () => {
  assert.deepEqual(
    rules(
      "apps/web/src/components/TaskRow.tsx",
      "const open = () => setSheet(TaskQuickActionSheet);",
    ),
    ["deprecated-architecture"],
  );
});
