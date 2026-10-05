import fs from "node:fs/promises";
import path from "node:path";
import { getConfig } from "../config";
import { log } from "../logger";
import { TASK_ID_RE } from "../util";

/**
 * Screenshots and downloaded files live on the local disk under
 * DATA_DIR/evidence/<task_id>/<file> and are deleted after EVIDENCE_TTL_HOURS.
 */
const FILE_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,120}$/;

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  txt: "text/plain",
  csv: "text/csv",
  json: "application/json",
  xml: "application/xml",
  html: "text/html",
  htm: "text/html",
  zip: "application/zip",
  gz: "application/gzip",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
};

const EXT_FOR_MIME: Record<string, string> = Object.fromEntries(
  Object.entries(MIME)
    .filter(([ext]) => !["jpeg", "htm"].includes(ext))
    .map(([ext, mime]) => [mime, ext]),
);

export function mimeForFilename(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return MIME[ext] ?? "application/octet-stream";
}

export function extensionForMime(mime: string): string | undefined {
  return EXT_FOR_MIME[mime.split(";")[0].trim().toLowerCase()];
}

export function evidenceRoot(): string {
  return path.join(getConfig().dataDir, "evidence");
}

export function isValidEvidenceName(taskId: string, filename: string): boolean {
  return TASK_ID_RE.test(taskId) && FILE_RE.test(filename) && !filename.includes("..");
}

export function evidencePath(taskId: string, filename: string): string | null {
  if (!isValidEvidenceName(taskId, filename)) return null;
  return path.join(evidenceRoot(), taskId, filename);
}

/** Write a file for a task, adding -2, -3… if the name is taken. Returns the final filename. */
export async function writeEvidence(taskId: string, desiredName: string, data: Buffer): Promise<{ filename: string; bytes: number }> {
  if (!TASK_ID_RE.test(taskId)) throw new Error("invalid task id");
  const dir = path.join(evidenceRoot(), taskId);
  await fs.mkdir(dir, { recursive: true });
  const dot = desiredName.lastIndexOf(".");
  const stem = dot > 0 ? desiredName.slice(0, dot) : desiredName;
  const ext = dot > 0 ? desiredName.slice(dot) : "";
  for (let i = 1; i < 100; i++) {
    const filename = i === 1 ? desiredName : `${stem}-${i}${ext}`;
    if (!FILE_RE.test(filename)) throw new Error("invalid evidence filename");
    try {
      await fs.writeFile(path.join(dir, filename), data, { flag: "wx" });
      return { filename, bytes: data.length };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
  throw new Error("could not allocate evidence filename");
}

/** Move a file the browser already saved into the task's evidence folder. */
export async function adoptEvidenceFile(taskId: string, desiredName: string, sourcePath: string): Promise<{ filename: string; bytes: number }> {
  const data = await fs.readFile(sourcePath);
  const result = await writeEvidence(taskId, desiredName, data);
  await fs.rm(sourcePath, { force: true }).catch(() => undefined);
  return result;
}

export function evidencePublicPath(taskId: string, filename: string): string {
  return `/evidence/${taskId}/${encodeURIComponent(filename)}`;
}

/** Delete task folders older than the TTL. Returns how many were removed. */
export async function cleanupEvidence(ttlMs = getConfig().evidenceTtlMs): Promise<number> {
  const root = evidenceRoot();
  let removed = 0;
  let entries: string[];
  try {
    entries = await fs.readdir(root);
  } catch {
    return 0;
  }
  const cutoff = Date.now() - ttlMs;
  for (const entry of entries) {
    if (!TASK_ID_RE.test(entry)) continue;
    const dir = path.join(root, entry);
    try {
      const stat = await fs.stat(dir);
      if (stat.mtimeMs < cutoff) {
        await fs.rm(dir, { recursive: true, force: true });
        removed++;
      }
    } catch {
      // already gone
    }
  }
  if (removed > 0) log("evidence_cleanup", { removed });
  return removed;
}
