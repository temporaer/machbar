#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const DEFAULT_CONFIG = resolve(
  homedir(),
  ".config/machbar/pr-tracker.json",
);
const ROOT_MARKER = "[machbar-pr-tracker:root]";
const REPO_MARKER_PREFIX = "[machbar-pr-tracker:repo=";
const PR_MARKER_PREFIX = "[machbar-pr-tracker:pr=";
const STATE_MARKER_PREFIX = "[machbar-pr-tracker:state=";

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  }).trim();
}

function loadConfig(path) {
  try {
    const config = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(config.repositories) || config.repositories.length === 0) {
      throw new Error("repositories must be a non-empty array");
    }
    return {
      mcpServer: config.mcpServer ?? "machbar",
      rootTitle: config.rootTitle ?? "Pull requests",
      trackOpenedAfter: config.trackOpenedAfter ?? null,
      repositories: config.repositories,
      exceptions: Array.isArray(config.exceptions) ? config.exceptions : [],
    };
  } catch (error) {
    throw new Error(`Could not load ${path}: ${error.message}`);
  }
}

function saveConfig(path, config) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
  });
  renameSync(temporary, path);
}

function githubToken(account) {
  return run("gh", ["auth", "token", "--user", account]);
}

function ghJson(account, args) {
  const token = githubToken(account);
  return JSON.parse(
    run("gh", args, {
      env: { ...process.env, GH_TOKEN: token },
    }),
  );
}

function parsePullRequestUrl(url) {
  const parsed = new URL(url);
  const match = parsed.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/);
  if (parsed.hostname !== "github.com" || !match) {
    throw new Error(`Not a GitHub pull request URL: ${url}`);
  }
  return {
    repository: `${match[1]}/${match[2]}`,
    number: Number(match[3]),
    url: `https://github.com/${match[1]}/${match[2]}/pull/${match[3]}`,
  };
}

function repositoryFromRemote(remote) {
  const normalized = remote.trim().replace(/\.git$/, "");
  const match =
    normalized.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)$/) ??
    normalized.match(/^(?:git@)?[^:]+:([^/]+\/[^/]+)$/);
  if (!match) {
    throw new Error(`Unsupported GitHub origin URL: ${remote}`);
  }
  return match[1];
}

function repositoryFromPath(path) {
  return repositoryFromRemote(
    run("git", ["-C", resolve(path), "remote", "get-url", "origin"]),
  );
}

function repoConfig(config, repository) {
  const found = config.repositories.find(
    (candidate) => candidate.repository === repository,
  );
  if (!found) {
    throw new Error(
      `No GitHub account mapping configured for ${repository}`,
    );
  }
  return found;
}

function authoredOpenPullRequests(repository) {
  const pulls = ghJson(repository.account, [
    "pr",
    "list",
    "--repo",
    repository.repository,
    "--state",
    "open",
    "--author",
    "@me",
    "--limit",
    "100",
    "--json",
    "number,title,url,isDraft,author,state,mergedAt,createdAt",
  ]);
  return pulls.filter(
    (pull) =>
      pull.author?.login !== "dependabot[bot]" &&
      pull.author?.login !== "dependabot-preview[bot]" &&
      (repository.trackOpenedAfter === null ||
        pull.createdAt >= repository.trackOpenedAfter),
  );
}

const PULL_REQUEST_FIELDS = [
  "number",
  "title",
  "url",
  "isDraft",
  "author",
  "state",
  "mergedAt",
  "createdAt",
  "reviewDecision",
  "reviews",
  "reviewRequests",
  "statusCheckRollup",
  "mergeable",
  "mergeStateStatus",
].join(",");

function pullRequest(config, url) {
  const parsed = parsePullRequestUrl(url);
  const repository = repoConfig(config, parsed.repository);
  return ghJson(repository.account, [
    "pr",
    "view",
    parsed.url,
    "--json",
    PULL_REQUEST_FIELDS,
  ]);
}

function unresolvedReviewThreads(config, url) {
  const parsed = parsePullRequestUrl(url);
  const repository = repoConfig(config, parsed.repository);
  const [owner, name] = parsed.repository.split("/");
  const result = ghJson(repository.account, [
    "api",
    "graphql",
    "-f",
    "query=query($owner:String!, $name:String!, $number:Int!) { repository(owner:$owner, name:$name) { pullRequest(number:$number) { reviewThreads(first:100) { nodes { isResolved } } } } }",
    "-F",
    `owner=${owner}`,
    "-F",
    `name=${name}`,
    "-F",
    `number=${parsed.number}`,
  ]);
  // GitHub returns at most the first 100 threads here; this is a display hint,
  // not a completeness guarantee for unusually large reviews.
  return (
    result.data?.repository?.pullRequest?.reviewThreads?.nodes?.filter(
      (thread) => !thread.isResolved,
    ).length ?? 0
  );
}

function mcpDefinition(serverName) {
  const output = JSON.parse(
    run("copilot", [
      "mcp",
      "get",
      serverName,
      "--show-secrets",
      "--json",
    ]),
  );
  const definition = output[serverName];
  if (!definition || definition.type !== "http") {
    throw new Error(
      `Copilot MCP server ${serverName} is missing or is not HTTP`,
    );
  }
  return definition;
}

async function connectMachbar(serverName) {
  const definition = mcpDefinition(serverName);
  const client = new Client({
    name: "machbar-pr-tracker",
    version: "1.0.0",
  });
  const transport = new StreamableHTTPClientTransport(
    new URL(definition.url),
    {
      requestInit: {
        headers: definition.headers ?? {},
      },
    },
  );
  await client.connect(transport);
  return client;
}

async function call(client, name, args = {}) {
  const response = await client.callTool({ name, arguments: args });
  if (response.isError) {
    const message = response.content
      ?.filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("\n");
    throw new Error(`${name} failed${message ? `: ${message}` : ""}`);
  }
  if (
    response.structuredContent &&
    Object.hasOwn(response.structuredContent, "result")
  ) {
    return response.structuredContent.result;
  }
  const text = response.content?.find((item) => item.type === "text")?.text;
  return text ? JSON.parse(text) : undefined;
}

function taskList(value) {
  const tasks = Array.isArray(value)
    ? value
    : value && Array.isArray(value.result)
      ? value.result
      : value && Array.isArray(value.items)
        ? value.items
        : value && Array.isArray(value.tasks)
          ? value.tasks
          : value && Array.isArray(value.results)
            ? value.results
            : null;
  if (tasks) {
    return tasks.map((task) => {
      const normalized = task?.task ?? task;
      return {
        ...normalized,
        notes: normalized.notes ?? "",
        blockers: normalized.blockers ?? [],
      };
    });
  }
  throw new Error("machbar_search returned an unexpected result shape");
}

async function fullTasks(client, value) {
  return Promise.all(
    taskList(value).map((task) =>
      task.id
        ? call(client, "machbar_get_task", { taskId: task.id })
        : task,
    ),
  );
}

async function findTrackedTask(client, url) {
  const candidates = await fullTasks(
    client,
    await call(client, "machbar_search", {
      text: url,
      includeTerminal: true,
      limit: 25,
    }),
  );
  const matches = candidates.filter(
    (task) => markerValue(task.notes, PR_MARKER_PREFIX) === url,
  );
  const active = matches.filter(
    (task) => task.status !== "done" && task.status !== "cancelled",
  );
  const keep = active[0] ?? matches[0];
  for (const duplicate of matches) {
    if (duplicate.id === keep?.id) continue;
    if (duplicate.status === "done" || duplicate.status === "cancelled") {
      continue;
    }
    await call(client, "machbar_cancel_task", {
      taskId: duplicate.id,
      expectedRevision: duplicate.revision,
      descendantsPolicy: "leave_open",
    });
    console.log(`Removed duplicate PR task: ${duplicate.title}`);
  }
  return keep;
}

function markerValue(notes, prefix) {
  const start = notes.indexOf(prefix);
  if (start === -1) return null;
  const end = notes.indexOf("]", start);
  return end === -1 ? null : notes.slice(start + prefix.length, end);
}

function lastMarkerValue(notes, prefix) {
  const start = notes.lastIndexOf(prefix);
  if (start === -1) return null;
  const end = notes.indexOf("]", start);
  return end === -1 ? null : notes.slice(start + prefix.length, end);
}

function encodeState(state) {
  return Buffer.from(JSON.stringify(state), "utf8").toString("base64url");
}

function decodeState(value) {
  if (!value) return null;
  try {
    return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

function checkState(check) {
  return String(check.state ?? check.status ?? "").toUpperCase();
}

function checkConclusion(check) {
  return String(check.conclusion ?? "").toUpperCase();
}

function classifyPullRequest(pull, unresolvedCount) {
  const checks = Array.isArray(pull.statusCheckRollup)
    ? pull.statusCheckRollup
    : [];
  const hasRunningCheck = checks.some((check) =>
    ["QUEUED", "PENDING", "IN_PROGRESS", "REQUESTED", "WAITING"].includes(
      checkState(check),
    ),
  );
  const hasFailedCheck = checks.some((check) =>
    [
      "FAILURE",
      "ERROR",
      "CANCELLED",
      "TIMED_OUT",
      "STARTUP_FAILURE",
      "ACTION_REQUIRED",
    ].includes(checkConclusion(check)),
  );
  const hasCompletedCheck = checks.some(
    (check) =>
      checkConclusion(check) ||
      ["SUCCESS", "COMPLETED"].includes(checkState(check)),
  );
  const ciState = hasRunningCheck
    ? "running"
    : hasFailedCheck
      ? "failing"
      : hasCompletedCheck
        ? "passing"
        : "none";

  const reviews = Array.isArray(pull.reviews) ? pull.reviews : [];
  const hasAnyReview = reviews.length > 0;
  const reviewDecision = String(pull.reviewDecision ?? "").toUpperCase();
  const reviewState = !hasAnyReview && pull.reviewRequests?.length
    ? "awaiting_first_review"
    : reviewDecision === "CHANGES_REQUESTED"
      ? "changes_requested"
      : reviewDecision === "APPROVED"
        ? "approved"
        : reviewDecision === "REVIEW_REQUIRED"
          ? "review_required"
          : hasAnyReview
            ? "reviewed"
            : "none";
  const requestedReviewers = (Array.isArray(pull.reviewRequests)
    ? pull.reviewRequests
    : [])
    .map((request) => request.login ?? request.name ?? request.slug)
    .filter(Boolean)
    .sort();
  const conflict =
    String(pull.mergeable ?? "").toUpperCase() === "CONFLICTING" ||
    String(pull.mergeStateStatus ?? "").toUpperCase() === "DIRTY";
  const draft = Boolean(pull.isDraft);
  const waitingReasons = [];
  if (ciState === "running") waitingReasons.push("CI running");
  if (!hasAnyReview && requestedReviewers.length > 0) {
    waitingReasons.push(`review from ${requestedReviewers.join(", ")}`);
  }
  const externalWait = waitingReasons.length
    ? waitingReasons.join("; ")
    : null;

  const statusParts = [];
  if (draft) statusParts.push("draft");
  if (reviewState === "awaiting_first_review") {
    statusParts.push(`review requested from ${requestedReviewers.join(", ")}`);
  } else if (reviewState === "changes_requested") {
    statusParts.push("changes requested");
  } else if (reviewState === "approved") {
    statusParts.push("approved");
  } else if (reviewState === "review_required") {
    statusParts.push("review required");
  }
  if (ciState === "running") statusParts.push("CI running");
  else if (ciState === "failing") statusParts.push("CI failing");
  else if (ciState === "passing") statusParts.push("CI passing");
  if (conflict) statusParts.push("merge conflict");
  if (unresolvedCount > 0) {
    statusParts.push(
      `${unresolvedCount} unresolved review comment${unresolvedCount === 1 ? "" : "s"}`,
    );
  }
  if (externalWait) {
    statusParts.push(`waiting: ${externalWait}`);
  } else if (reviewState === "changes_requested" || unresolvedCount > 0) {
    statusParts.push("action: address review feedback");
  } else if (ciState === "failing") {
    statusParts.push("action: fix CI");
  } else if (conflict) {
    statusParts.push("action: resolve merge conflict");
  } else if (reviewState === "approved" && ciState !== "running") {
    statusParts.push("action: merge when ready");
  } else if (draft) {
    statusParts.push("action: continue work or mark ready");
  } else if (statusParts.length === 0) {
    statusParts.push("action: inspect PR");
  }

  const signature = {
    ciState,
    conflict,
    draft,
    reviewState,
    requestedReviewers,
    unresolvedCount,
    externalWait,
  };
  return {
    ciState,
    conflict,
    draft,
    externalWait,
    hasAnyReview,
    requestedReviewers,
    reviewState,
    signature,
    statusLine: statusParts.join(" · "),
  };
}

function prTitle(repository, pull) {
  return `PR ${repository}#${pull.number}: ${pull.title}`;
}

async function flattenTrackerHierarchy(client, tracked) {
  const rootTasks = tracked.filter((task) =>
    task.notes.includes(ROOT_MARKER),
  );
  const repositoryTasks = new Set(
    tracked
      .filter((task) => markerValue(task.notes, REPO_MARKER_PREFIX))
      .map((task) => task.id),
  );

  for (const task of tracked) {
    if (
      markerValue(task.notes, PR_MARKER_PREFIX) &&
      repositoryTasks.has(task.parentTaskId)
    ) {
      await call(client, "machbar_move_task", {
        taskId: task.id,
        expectedRevision: task.revision,
        parentTaskId: null,
      });
      console.log(`Moved PR task to top level: ${task.title}`);
    }
  }

  for (const task of [...tracked].filter(
    (candidate) =>
      repositoryTasks.has(candidate.id) &&
      candidate.status !== "done" &&
      candidate.status !== "cancelled",
  )) {
    await call(client, "machbar_cancel_task", {
      taskId: task.id,
      expectedRevision: task.revision,
      descendantsPolicy: "leave_open",
    });
    console.log(`Removed repository group task: ${task.title}`);
  }

  for (const task of rootTasks.filter(
    (candidate) =>
      candidate.status !== "done" && candidate.status !== "cancelled",
  )) {
    await call(client, "machbar_cancel_task", {
      taskId: task.id,
      expectedRevision: task.revision,
      descendantsPolicy: "leave_open",
    });
    console.log(`Removed tracker root task: ${task.title}`);
  }
}

async function sync(configPath) {
  const config = loadConfig(configPath);
  const client = await connectMachbar(config.mcpServer);
  try {
    const tracked = await fullTasks(
      client,
      await call(client, "machbar_search", {
        text: "machbar-pr-tracker:",
        includeTerminal: true,
        limit: 25,
      }),
    );
    await flattenTrackerHierarchy(client, tracked);
    const trackedByUrl = new Map();
    for (const task of tracked) {
      const url = markerValue(task.notes, PR_MARKER_PREFIX);
      if (!url) continue;
      if (!trackedByUrl.has(url)) trackedByUrl.set(url, task);
    }

    const discovered = new Map();
    for (const repository of config.repositories) {
      for (const pull of authoredOpenPullRequests({
        ...repository,
        trackOpenedAfter: config.trackOpenedAfter,
      })) {
        discovered.set(pull.url, {
          ...pull,
          repository: repository.repository,
        });
      }
    }
    for (const exception of config.exceptions) {
      const parsed = parsePullRequestUrl(exception);
      const pull = pullRequest(config, parsed.url);
      if (pull.state === "OPEN") {
        discovered.set(parsed.url, {
          ...pull,
          repository: parsed.repository,
        });
      }
    }

    for (const pull of discovered.values()) {
      const existing = await findTrackedTask(client, pull.url);
      if (existing) {
        trackedByUrl.set(pull.url, existing);
        console.log(`Found existing tracked PR ${pull.url}`);
      } else {
        const created = await call(client, "machbar_create_task", {
          title: prTitle(pull.repository, pull),
          notes: `${pull.url}\n\n${PR_MARKER_PREFIX}${pull.url}]`,
          activateIfReady: true,
        });
        const task = await call(client, "machbar_get_task", {
          taskId: created.id,
        });
        trackedByUrl.set(pull.url, task);
        console.log(`Tracking ${pull.url}`);
      }
    }

    for (const [url, task] of trackedByUrl) {
      if (task.status === "done" || task.status === "cancelled") continue;
      const pull = pullRequest(config, url);
      if (pull.mergedAt) {
        await call(client, "machbar_complete_task", {
          taskId: task.id,
          expectedRevision: task.revision,
        });
        console.log(`Completed merged PR ${url}`);
        continue;
      } else if (pull.state === "CLOSED") {
        await call(client, "machbar_cancel_task", {
          taskId: task.id,
          expectedRevision: task.revision,
        });
        console.log(`Cancelled closed PR ${url}`);
        continue;
      }

      const classified = classifyPullRequest(
        pull,
        unresolvedReviewThreads(config, url),
      );
      const externalBlocker = task.blockers?.find(
        (blocker) => blocker.type === "external",
      );
      if (classified.externalWait) {
        if (
          task.status === "actionable" &&
          (!externalBlocker ||
            externalBlocker.waitingFor !== classified.externalWait)
        ) {
          await call(client, "machbar_set_waiting", {
            taskId: task.id,
            expectedRevision: task.revision,
            waitingFor: classified.externalWait,
          });
          console.log(`Waiting on ${classified.externalWait}: ${url}`);
        } else if (task.status !== "actionable") {
          console.log(
            `Cannot set external wait on ${task.status} task: ${url}`,
          );
        }
      } else if (externalBlocker) {
        await call(client, "machbar_resolve_waiting", {
          taskId: task.id,
          expectedRevision: task.revision,
        });
        console.log(`Resolved external wait: ${url}`);
      }

      const previousState = decodeState(
        lastMarkerValue(task.notes, STATE_MARKER_PREFIX),
      );
      if (
        !previousState ||
        JSON.stringify(previousState) !== JSON.stringify(classified.signature)
      ) {
        await call(client, "machbar_append_note", {
          entityId: task.id,
          entityType: "task",
          content: `Status: ${classified.statusLine}\n${STATE_MARKER_PREFIX}${encodeState(classified.signature)}]`,
        });
        console.log(`Updated status for ${url}: ${classified.statusLine}`);
      }
    }
  } finally {
    await client.close();
  }
}

function updateException(configPath, url, add) {
  const config = loadConfig(configPath);
  const normalized = parsePullRequestUrl(url).url;
  const exceptions = new Set(config.exceptions);
  if (add) exceptions.add(normalized);
  else exceptions.delete(normalized);
  config.exceptions = [...exceptions].sort();
  saveConfig(configPath, config);
  console.log(`${add ? "Added" : "Removed"} exception: ${normalized}`);
}

function updateRepository(configPath, path, account, add) {
  const config = loadConfig(configPath);
  if (add) {
    const absolutePath = resolve(path);
    const repository = repositoryFromPath(absolutePath);
    ghJson(account, ["api", `repos/${repository}`]);
    const existing = config.repositories.findIndex(
      (candidate) => candidate.repository === repository,
    );
    const entry = { path: absolutePath, repository, account };
    if (existing === -1) config.repositories.push(entry);
    else config.repositories[existing] = entry;
    config.repositories.sort((left, right) =>
      left.repository.localeCompare(right.repository),
    );
    saveConfig(configPath, config);
    console.log(`Added repository: ${repository} (${account})`);
    return;
  }
  const repository = /^[^/]+\/[^/]+$/.test(path)
    ? path
    : repositoryFromPath(path);
  config.repositories = config.repositories.filter(
    (candidate) => candidate.repository !== repository,
  );
  saveConfig(configPath, config);
  console.log(`Removed repository: ${repository}`);
}

function option(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  args.splice(index, 2);
  return value;
}

function usage() {
  console.log(`Usage:
  machbar-pr-tracker sync [--config PATH]
  machbar-pr-tracker add <PR-URL> [--config PATH]
  machbar-pr-tracker remove <PR-URL> [--config PATH]
  machbar-pr-tracker repo add <PATH> --account <GH-USER> [--config PATH]
  machbar-pr-tracker repo remove <OWNER/REPO|PATH> [--config PATH]
  machbar-pr-tracker list [--config PATH]`);
}

async function main() {
  const args = process.argv.slice(2);
  const configIndex = args.indexOf("--config");
  const configPath =
    configIndex === -1
      ? DEFAULT_CONFIG
      : resolve(args.splice(configIndex, 2)[1] ?? "");
  const command = args.shift();
  if (command === "sync") {
    await sync(configPath);
  } else if (command === "add" && args[0]) {
    updateException(configPath, args[0], true);
    await sync(configPath);
  } else if (command === "remove" && args[0]) {
    updateException(configPath, args[0], false);
  } else if (command === "repo" && args[0] === "add" && args[1]) {
    const account = option(args, "--account");
    if (!account) {
      throw new Error("repo add requires --account <GH-USER>");
    }
    updateRepository(configPath, args[1], account, true);
    await sync(configPath);
  } else if (command === "repo" && args[0] === "remove" && args[1]) {
    updateRepository(configPath, args[1], "", false);
  } else if (command === "list") {
    const config = loadConfig(configPath);
    console.log(JSON.stringify(config, null, 2));
  } else if (command === "help" || command === "--help" || command === "-h") {
    usage();
  } else {
    usage();
    process.exitCode = 2;
  }
}

main().catch((error) => fail(error.stack ?? error.message));
