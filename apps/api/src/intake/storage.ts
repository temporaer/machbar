import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { Env } from "../env.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function intakeRoot(env: Env): string {
  return path.join(env.dataDir, "intake");
}

function assertUuid(value: string): void {
  if (!UUID.test(value)) throw new Error("Invalid intake identifier.");
}

export function attachmentPath(env: Env, jobId: string, attachmentId: string): string {
  assertUuid(jobId);
  assertUuid(attachmentId);
  const jobRoot = path.resolve(intakeRoot(env), jobId);
  const target = path.resolve(jobRoot, attachmentId);
  if (!target.startsWith(`${jobRoot}${path.sep}`)) throw new Error("Invalid attachment path.");
  return target;
}

export async function writeAttachment(
  env: Env,
  jobId: string,
  attachmentId: string,
  buffer: Buffer,
): Promise<void> {
  const target = attachmentPath(env, jobId, attachmentId);
  await fsp.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await fsp.writeFile(target, buffer, { mode: 0o600 });
}

export function readAttachmentStream(
  env: Env,
  jobId: string,
  attachmentId: string,
): fs.ReadStream {
  return fs.createReadStream(attachmentPath(env, jobId, attachmentId));
}

export async function deleteJobFiles(env: Env, jobId: string): Promise<void> {
  assertUuid(jobId);
  const root = path.resolve(intakeRoot(env), jobId);
  if (!root.startsWith(`${path.resolve(intakeRoot(env))}${path.sep}`)) {
    throw new Error("Invalid intake path.");
  }
  await fsp.rm(root, { recursive: true, force: true });
}
