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

function pullRequest(config, url) {
  const parsed = parsePullRequestUrl(url);
  const repository = repoConfig(config, parsed.repository);
  return ghJson(repository.account, [
    "pr",
    "view",
    parsed.url,
    "--json",
    "number,title,url,isDraft,author,state,mergedAt,createdAt",
  ]);
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

function markerValue(notes, prefix) {
  const start = notes.indexOf(prefix);
  if (start === -1) return null;
  const end = notes.indexOf("]", start);
  return end === -1 ? null : notes.slice(start + prefix.length, end);
}

function prTitle(repository, pull) {
  return `PR ${repository}#${pull.number}: ${pull.title}`;
}

async function ensureHierarchy(client, config, tracked) {
  let root = tracked.find((task) => task.notes.includes(ROOT_MARKER));
  if (!root) {
    root = await call(client, "machbar_create_task", {
      title: config.rootTitle,
      notes: ROOT_MARKER,
      status: "someday",
    });
    console.log(`Created group: ${root.title}`);
  }

  const groups = new Map();
  for (const task of tracked) {
    const repository = markerValue(task.notes, REPO_MARKER_PREFIX);
    if (repository) groups.set(repository, task);
  }
  for (const repository of config.repositories) {
    if (groups.has(repository.repository)) continue;
    const group = await call(client, "machbar_create_task", {
      title: repository.repository,
      notes: `${REPO_MARKER_PREFIX}${repository.repository}]`,
      parentTaskId: root.id,
      status: "someday",
    });
    groups.set(repository.repository, group);
    console.log(`Created repository group: ${repository.repository}`);
  }
  return groups;
}

async function sync(configPath) {
  const config = loadConfig(configPath);
  const client = await connectMachbar(config.mcpServer);
  try {
    const tracked = await call(client, "machbar_search", {
      text: "machbar-pr-tracker:",
      includeTerminal: true,
    });
    const groups = await ensureHierarchy(client, config, tracked);
    const trackedByUrl = new Map();
    for (const task of tracked) {
      const url = markerValue(task.notes, PR_MARKER_PREFIX);
      if (url) trackedByUrl.set(url, task);
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
      if (trackedByUrl.has(pull.url)) continue;
      const task = await call(client, "machbar_create_task", {
        title: prTitle(pull.repository, pull),
        notes: `${pull.url}\n\n${PR_MARKER_PREFIX}${pull.url}]`,
        parentTaskId: groups.get(pull.repository).id,
        status: "actionable",
      });
      trackedByUrl.set(pull.url, task);
      console.log(`Tracking ${pull.url}`);
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
      } else if (pull.state === "CLOSED") {
        await call(client, "machbar_cancel_task", {
          taskId: task.id,
          expectedRevision: task.revision,
        });
        console.log(`Cancelled closed PR ${url}`);
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
