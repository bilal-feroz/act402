import type { ErrorCode } from "../errors";

export interface StepRecord {
  /** Position in the caller's `actions` array; -1 for steps Act402 adds (initial navigation, cookie banner). */
  index: number;
  id?: string;
  type: string;
  status: "ok" | "failed" | "skipped";
  duration_ms: number;
  detail?: string;
  url?: string;
  error?: { code: ErrorCode; message: string };
}

export interface ExtractRecord {
  action_index: number;
  name?: string;
  format: "text" | "html" | "links" | "table" | "attribute";
  target: string;
  count: number;
  text?: string;
  items?: unknown[];
  table?: { headers: string[]; rows: string[][] };
  tables?: Array<{ headers: string[]; rows: string[][] }>;
  truncated: boolean;
  source_url: string;
}

export interface EvidenceRecord {
  type: "screenshot" | "download";
  name: string;
  url: string;
  path: string;
  source_url: string;
  captured_at: string;
  bytes: number;
  full_page?: boolean;
  target?: string;
  /** For downloads. */
  filename?: string;
  mime_type?: string;
  size_bytes?: number;
  sha256?: string;
  download_url?: string;
  /** Goal mode: the evidence quote that was highlighted on the screenshot. */
  text_excerpt?: string;
}

export interface GoalAnswer {
  answer: string;
  summary: string;
  confidence: number;
  evidence_text: string;
  candidates: Array<{ text: string; score: number; url: string }>;
  planner: "heuristic";
}

export type TaskEvent =
  | { type: "queued"; at_ms: number; message: string }
  | { type: "started"; at_ms: number; task_id: string; provider: string }
  | { type: "step"; at_ms: number; step: StepRecord; frame_url?: string }
  | { type: "log"; at_ms: number; level: "info" | "warn"; message: string }
  | { type: "frame"; at_ms: number; url: string };
