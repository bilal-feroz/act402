import { randomBytes } from "node:crypto";

export const TASK_ID_RE = /^act_[a-f0-9]{24}$/;

export function newTaskId(): string {
  return `act_${randomBytes(12).toString("hex")}`;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/** Collapse runs of spaces and blank lines the way a human reads rendered text. */
export function normalizeText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[\t\f\v  ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function truncate(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: text.slice(0, maxChars), truncated: true };
}

/** Single-line, bounded preview of untrusted text for logs and step summaries. */
export function preview(text: string | null | undefined, maxChars = 80): string {
  if (!text) return "";
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > maxChars ? `${flat.slice(0, maxChars - 1)}…` : flat;
}

/** Keep only filesystem-safe characters; never allow path separators or dot-dot. */
export function sanitizeFilename(name: string, fallback = "file"): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const cleaned = base
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+/, "")
    .replace(/\.{2,}/g, ".")
    .slice(0, 100);
  return cleaned.length > 0 ? cleaned : fallback;
}

export function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}
