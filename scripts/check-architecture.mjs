import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const WEB_SOURCE = "apps/web/src/";
const API_SOURCE = "apps/api/src/";

const TASK_MUTATIONS = new Set([
  "updateTask",
  "transitionTaskStatus",
  "clarifyTask",
  "completeTask",
  "cancelTask",
  "reopenTask",
  "setExternalWait",
  "resolveExternalWait",
  "followUpExternalWait",
  "acknowledgeTaskReview",
]);

const PROJECT_MUTATIONS = new Set([
  "updateProject",
  "activateProject",
  "returnProjectToBacklog",
  "completeProject",
  "reopenProject",
  "archiveProject",
  "acknowledgeProjectReview",
]);

const ALLOWED_MUTATION_CALLERS = new Map([
  [
    "apps/web/src/lib/taskMutations.ts",
    new Set(["updateTask"]),
  ],
  [
    "apps/web/src/lib/useTaskActions.tsx",
    new Set(TASK_MUTATIONS),
  ],
  [
    "apps/web/src/lib/useProjectActions.tsx",
    new Set(PROJECT_MUTATIONS),
  ],
  [
    "apps/web/src/lib/useOutlineOrganize.tsx",
    new Set(["moveTask"]),
  ],
  [
    "apps/web/src/components/MoveTaskSheet.tsx",
    new Set(["moveTask"]),
  ],
  [
    "apps/web/src/components/QuickAdd.tsx",
    new Set(["moveTask"]),
  ],
  [
    "apps/web/src/pages/SharePage.tsx",
    new Set(["updateTask", "updateProject"]),
  ],
]);

const DEPRECATED_NAMES = new Map([
  ["AssignOwnerSheet", "Use MemberSelectionSheet with useTaskActions."],
  ["AssignDriverSheet", "Use MemberSelectionSheet with useProjectActions."],
  ["ActivationReadinessSheet", "Use MemberSelectionSheet and useProjectActions.activate."],
  ["CaptureProjectBreakdownSheet", "Use InlineTaskComposer or the existing capture classification flow."],
  ["TaskQuickActionSheet", "Dispatch the semantic task command and let TaskWorkflowHost render its focused sheet."],
  ["useProjectWorkflowActions", "Use useProjectActions."],
  ["reorderTask", "Calculate a destination and call api.moveTask."],
  ["indentTask", "Calculate a destination and call api.moveTask."],
  ["outdentTask", "Calculate a destination and call api.moveTask."],
  ["changeTaskParent", "Calculate a destination and call api.moveTask."],
  ["moveSubtreeToProject", "Calculate a destination and call api.moveTask."],
]);

/**
 * Focused workflow sheets: the concrete implementation of exactly one
 * semantic `task.*`/`story.*` command. Only the workflow host may import
 * one, so "same intent -> same semantic command -> same focused workflow"
 * cannot be quietly broken by a surface rendering its own copy.
 *
 * Generic primitives composed by several workflows (MemberSelectionSheet,
 * MoveTaskSheet, BottomSheet, HumanDateInput) are deliberately absent: they
 * implement no command by themselves.
 */
const WORKFLOW_SHEET_HOSTS = new Map([
  ["TaskPlanSheet", "TaskWorkflowHost"],
  ["TaskWaitSheet", "TaskWorkflowHost"],
  ["WaitingFollowUpSheet", "TaskWorkflowHost"],
  ["TaskSplitSheet", "TaskWorkflowHost"],
  ["TaskSuccessorSheet", "TaskWorkflowHost"],
  ["TaskRecurrenceSheet", "TaskWorkflowHost"],
  ["TaskPrioritySheet", "TaskWorkflowHost"],
  ["TaskTagsSheet", "TaskWorkflowHost"],
  ["TaskContextsSheet", "TaskWorkflowHost"],
  ["TaskConvertToProjectSheet", "TaskWorkflowHost"],
  ["ProjectDeferSheet", "ProjectWorkflowHost"],
  ["ProjectTagsSheet", "ProjectWorkflowHost"],
  ["ProjectContextsSheet", "ProjectWorkflowHost"],
  ["StoryCriteriaSheet", "ProjectWorkflowHost"],
  ["PlanDatesSheet", "ProjectWorkflowHost"],
]);

/**
 * Surfaces that still render a focused workflow themselves. Each entry is
 * outstanding migration work, not an accepted pattern: TaskDetailSheet and
 * ProjectDetailPage are still inspectors whose values must become semantic
 * command dispatches. Shrink this map; never add to it.
 */
const WORKFLOW_SHEET_EXCEPTIONS = new Map([
  [
    `${WEB_SOURCE}components/TaskDetailSheet.tsx`,
    new Set(["TaskSplitSheet"]),
  ],
  [
    `${WEB_SOURCE}pages/ProjectDetailPage.tsx`,
    new Set(["ProjectTagsSheet", "StoryCriteriaSheet", "PlanDatesSheet"]),
  ],
]);

/**
 * Opening a workflow or the task detail sheet is command dispatch, not
 * something an individual surface decides. Both belong to the one
 * dispatcher; `InboxPage` is the narrow clarification-queue exception that
 * `docs/architecture-rules.md` documents.
 */
const WORKFLOW_OPENERS = new Set(["taskWorkflow", "projectWorkflow", "taskDetail"]);

const ALLOWED_WORKFLOW_OPENER_CALLERS = new Map([
  [`${WEB_SOURCE}lib/useWorkItemCommands.ts`, WORKFLOW_OPENERS],
  [`${WEB_SOURCE}pages/InboxPage.tsx`, new Set(["taskDetail"])],
]);

const LEGACY_TASK_ROUTE =
  /\/(?:api\/)?tasks\/[^"'`\s]+\/(?:reorder|indent|outdent|parent|move-subtree)(?:[/?#"'`]|\s|$)/;

function normalizeFilePath(filePath) {
  return filePath.split(path.sep).join("/");
}

function isTestFile(filePath) {
  return (
    /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(filePath) ||
    filePath.includes("/__tests__/") ||
    filePath.includes("/test-fixtures/")
  );
}

function sourceKind(filePath) {
  return filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

function diagnostic(sourceFile, filePath, node, rule, message) {
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return {
    filePath,
    line: position.line + 1,
    column: position.character + 1,
    rule,
    message,
  };
}

function calledApiMethod(node) {
  if (!ts.isCallExpression(node)) return null;
  const expression = node.expression;

  if (
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === "api"
  ) {
    return expression.name.text;
  }

  if (
    ts.isElementAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === "api" &&
    expression.argumentExpression &&
    ts.isStringLiteralLike(expression.argumentExpression)
  ) {
    return expression.argumentExpression.text;
  }

  return null;
}

function mutationDiagnostic(sourceFile, filePath, node, method) {
  const allowed = ALLOWED_MUTATION_CALLERS.get(filePath);
  if (allowed?.has(method)) return null;

  if (TASK_MUTATIONS.has(method)) {
    return diagnostic(
      sourceFile,
      filePath,
      node,
      "canonical-task-mutations",
      `calls api.${method} directly. Standard task mutations must go through taskMutations.ts or useTaskActions.ts. See docs/architecture-rules.md#task-mutations.`,
    );
  }

  if (PROJECT_MUTATIONS.has(method)) {
    return diagnostic(
      sourceFile,
      filePath,
      node,
      "canonical-project-mutations",
      `calls api.${method} directly. Standard project mutations must go through useProjectActions.ts. See docs/architecture-rules.md#project-mutations.`,
    );
  }

  if (method === "moveTask") {
    return diagnostic(
      sourceFile,
      filePath,
      node,
      "canonical-task-hierarchy",
      "calls api.moveTask from a new location. Reuse an existing move surface or add a narrow, documented exception. See docs/architecture-rules.md#task-hierarchy.",
    );
  }

  return null;
}

function importedHookName(node) {
  if (!ts.isImportDeclaration(node) && !ts.isExportDeclaration(node)) return null;
  if (!node.moduleSpecifier || !ts.isStringLiteral(node.moduleSpecifier)) return null;

  const specifier = node.moduleSpecifier.text;
  if (!specifier.startsWith(".")) return null;
  const basename = path.posix.basename(specifier).replace(/\.(?:tsx?|jsx?)$/, "");
  return /^use[A-Z]/.test(basename) ? basename : null;
}

function importedDomainHelperFromHook(node) {
  if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) {
    return null;
  }
  const clause = node.importClause;
  if (!clause || clause.isTypeOnly || !clause.namedBindings || !ts.isNamedImports(clause.namedBindings)) {
    return null;
  }
  const basename = path.posix
    .basename(node.moduleSpecifier.text)
    .replace(/\.(?:tsx?|jsx?)$/, "");
  if (!/^use[A-Z]/.test(basename)) return null;

  return clause.namedBindings.elements.find((element) => {
    if (element.isTypeOnly) return false;
    const name = element.propertyName?.text ?? element.name.text;
    return (
      !/^use[A-Z]/.test(name) &&
      !/^[A-Z][A-Z0-9_]*$/.test(name) &&
      !/Provider$/.test(name)
    );
  }) ?? null;
}

function isPresentationModule(filePath) {
  return (
    filePath.startsWith(`${WEB_SOURCE}components/`) ||
    filePath.startsWith(`${WEB_SOURCE}pages/`)
  );
}

/** The focused workflow sheet a relative import pulls in, if any. */
function importedWorkflowSheet(node) {
  if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) {
    return null;
  }
  const specifier = node.moduleSpecifier.text;
  if (!specifier.startsWith(".")) return null;
  const basename = path.posix.basename(specifier).replace(/\.(?:tsx?|jsx?)$/, "");
  return WORKFLOW_SHEET_HOSTS.has(basename) ? basename : null;
}

/**
 * `taskWorkflow.open(...)`, `projectWorkflow.open(...)`,
 * `taskDetail.open(...)` and `taskDetail.openQueue(...)`.
 */
function calledWorkflowOpener(node) {
  if (!ts.isCallExpression(node)) return null;
  const expression = node.expression;
  if (!ts.isPropertyAccessExpression(expression)) return null;
  if (expression.name.text !== "open" && expression.name.text !== "openQueue") return null;
  const target = expression.expression;
  if (!ts.isIdentifier(target) || !WORKFLOW_OPENERS.has(target.text)) return null;
  return target.text;
}

function isPureLibraryModule(filePath) {
  if (!filePath.startsWith(`${WEB_SOURCE}lib/`) || !filePath.endsWith(".ts")) return false;
  const basename = path.posix.basename(filePath, ".ts");
  return !/^use[A-Z]/.test(basename);
}

function deprecatedName(node) {
  if (ts.isIdentifier(node)) {
    return DEPRECATED_NAMES.has(node.text) ? node.text : null;
  }

  if (ts.isStringLiteralLike(node)) {
    for (const name of DEPRECATED_NAMES.keys()) {
      if (node.text.includes(name)) return name;
    }
  }

  return null;
}

function legacyRouteText(node, sourceFile) {
  if (
    !ts.isStringLiteralLike(node) &&
    !ts.isTemplateExpression(node)
  ) {
    return null;
  }
  const text = ts.isStringLiteralLike(node) ? node.text : node.getText(sourceFile);
  return LEGACY_TASK_ROUTE.test(text) ? text : null;
}

export function checkSource({ filePath, sourceText }) {
  const normalizedPath = normalizeFilePath(filePath);
  if (isTestFile(normalizedPath)) return [];

  const sourceFile = ts.createSourceFile(
    normalizedPath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    sourceKind(normalizedPath),
  );
  const diagnostics = [];

  function visit(node) {
    if (normalizedPath.startsWith(WEB_SOURCE)) {
      const method = calledApiMethod(node);
      if (method) {
        const result = mutationDiagnostic(sourceFile, normalizedPath, node, method);
        if (result) diagnostics.push(result);
      }

      if (isPureLibraryModule(normalizedPath)) {
        const hookName = importedHookName(node);
        if (hookName) {
          diagnostics.push(
            diagnostic(
              sourceFile,
              normalizedPath,
              node,
              "pure-helper-dependency",
              `imports ${hookName} from a React hook module. Move shared domain semantics into a React-free module. See docs/architecture-rules.md#dependency-direction.`,
            ),
          );
        }
      }

      if (isPresentationModule(normalizedPath)) {
        const importedHelper = importedDomainHelperFromHook(node);
        if (importedHelper) {
          diagnostics.push(
            diagnostic(
              sourceFile,
              normalizedPath,
              importedHelper,
              "hook-module-domain-export",
              `imports domain helper ${importedHelper.name.text} from a React hook module. Move the helper into a React-free module and import it there. See docs/architecture-rules.md#dependency-direction.`,
            ),
          );
        }
      }

      const sheet = importedWorkflowSheet(node);
      if (sheet) {
        const host = WORKFLOW_SHEET_HOSTS.get(sheet);
        const isHost = path.posix.basename(normalizedPath, ".tsx") === host;
        if (!isHost && !WORKFLOW_SHEET_EXCEPTIONS.get(normalizedPath)?.has(sheet)) {
          diagnostics.push(
            diagnostic(
              sourceFile,
              normalizedPath,
              node,
              "canonical-workflow-host",
              `imports focused workflow ${sheet}. Only ${host} may render it — dispatch the semantic command instead, so every entry point reaches the same workflow. See docs/architecture-rules.md#focused-workflows.`,
            ),
          );
        }
      }

      const opener = calledWorkflowOpener(node);
      if (opener && !ALLOWED_WORKFLOW_OPENER_CALLERS.get(normalizedPath)?.has(opener)) {
        diagnostics.push(
          diagnostic(
            sourceFile,
            normalizedPath,
            node,
            "canonical-workflow-routing",
            `calls ${opener}.open directly. Deciding which workflow implements an intent belongs to useWorkItemCommands(); dispatch the semantic command instead. See docs/architecture-rules.md#focused-workflows.`,
          ),
        );
      }
    }

    if (
      normalizedPath.startsWith(WEB_SOURCE) ||
      normalizedPath.startsWith(API_SOURCE)
    ) {
      const name = deprecatedName(node);
      if (name) {
        diagnostics.push(
          diagnostic(
            sourceFile,
            normalizedPath,
            node,
            "deprecated-architecture",
            `reintroduces deprecated architecture name ${name}. ${DEPRECATED_NAMES.get(name)} See docs/architecture-rules.md#deletion-and-deprecation.`,
          ),
        );
      }

      if (legacyRouteText(node, sourceFile)) {
        diagnostics.push(
          diagnostic(
            sourceFile,
            normalizedPath,
            node,
            "deprecated-task-route",
            "reintroduces a legacy task hierarchy endpoint. Calculate a destination and use POST /api/tasks/:id/move. See docs/architecture-rules.md#task-hierarchy.",
          ),
        );
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return diagnostics;
}

function collectSourceFiles(rootDir, relativeDirectory) {
  const absoluteDirectory = path.join(rootDir, relativeDirectory);
  const entries = fs.readdirSync(absoluteDirectory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const relativePath = path.posix.join(relativeDirectory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(rootDir, relativePath));
    } else if (
      entry.isFile() &&
      /\.tsx?$/.test(entry.name) &&
      !entry.name.endsWith(".d.ts") &&
      !isTestFile(relativePath)
    ) {
      files.push(relativePath);
    }
  }

  return files;
}

export function checkRepository(rootDir = process.cwd()) {
  const files = [
    ...collectSourceFiles(rootDir, WEB_SOURCE.slice(0, -1)),
    ...collectSourceFiles(rootDir, API_SOURCE.slice(0, -1)),
  ].sort();
  const diagnostics = files.flatMap((filePath) =>
    checkSource({
      filePath,
      sourceText: fs.readFileSync(path.join(rootDir, filePath), "utf8"),
    }),
  );
  return { diagnostics, filesChecked: files.length };
}

export function formatDiagnostic(result) {
  return `${result.filePath}:${result.line}:${result.column} [${result.rule}] ${result.message}`;
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const { diagnostics, filesChecked } = checkRepository();
  if (diagnostics.length > 0) {
    console.error(diagnostics.map(formatDiagnostic).join("\n"));
    process.exitCode = 1;
  } else {
    console.log(`Architecture check passed (${filesChecked} source files).`);
  }
}
