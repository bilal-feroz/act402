import fs from "node:fs";
import path from "node:path";
import { getConfig } from "../config";
import { log } from "../logger";

/** What Act402 remembers about a task. No page content, cookies or typed values are stored. */
export interface TaskRow {
  task_id: string;
  created_at: string;
  finished_at: string | null;
  status: string;
  success: number | null;
  mode: string;
  source: string;
  url: string;
  domain: string;
  action_count: number;
  duration_ms: number | null;
  error_code: string | null;
  result: string | null;
}

export interface TaskStats {
  total: number;
  completed: number;
  failed: number;
  last_24h: number;
  avg_duration_ms: number | null;
}

export interface TaskStore {
  readonly kind: "sqlite" | "memory";
  insert(row: TaskRow): void;
  finish(taskId: string, patch: Pick<TaskRow, "finished_at" | "status" | "success" | "duration_ms" | "error_code" | "result" | "action_count">): void;
  recent(limit: number): TaskRow[];
  stats(): TaskStats;
  prune(olderThanDays: number): void;
}

type SqliteModule = typeof import("node:sqlite");

class SqliteTaskStore implements TaskStore {
  readonly kind = "sqlite" as const;
  private readonly db: InstanceType<SqliteModule["DatabaseSync"]>;

  constructor(sqlite: SqliteModule, file: string) {
    this.db = new sqlite.DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 3000;
      CREATE TABLE IF NOT EXISTS tasks (
        task_id      TEXT PRIMARY KEY,
        created_at   TEXT NOT NULL,
        finished_at  TEXT,
        status       TEXT NOT NULL,
        success      INTEGER,
        mode         TEXT NOT NULL,
        source       TEXT NOT NULL,
        url          TEXT NOT NULL,
        domain       TEXT NOT NULL,
        action_count INTEGER NOT NULL DEFAULT 0,
        duration_ms  INTEGER,
        error_code   TEXT,
        result       TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON tasks (created_at DESC);
    `);
  }

  insert(row: TaskRow): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO tasks (task_id, created_at, finished_at, status, success, mode, source, url, domain, action_count, duration_ms, error_code, result)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(row.task_id, row.created_at, row.finished_at, row.status, row.success, row.mode, row.source, row.url, row.domain, row.action_count, row.duration_ms, row.error_code, row.result);
  }

  finish(taskId: string, p: Parameters<TaskStore["finish"]>[1]): void {
    this.db
      .prepare(`UPDATE tasks SET finished_at = ?, status = ?, success = ?, duration_ms = ?, error_code = ?, result = ?, action_count = ? WHERE task_id = ?`)
      .run(p.finished_at, p.status, p.success, p.duration_ms, p.error_code, p.result, p.action_count, taskId);
  }

  recent(limit: number): TaskRow[] {
    return this.db.prepare(`SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?`).all(limit) as unknown as TaskRow[];
  }

  stats(): TaskStats {
    const since = new Date(Date.now() - 24 * 3600_000).toISOString();
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) AS completed,
                SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) AS failed,
                SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS last_24h,
                AVG(CASE WHEN success = 1 THEN duration_ms END) AS avg_duration_ms
         FROM tasks`,
      )
      .get(since) as Record<string, number | null>;
    return {
      total: Number(row.total ?? 0),
      completed: Number(row.completed ?? 0),
      failed: Number(row.failed ?? 0),
      last_24h: Number(row.last_24h ?? 0),
      avg_duration_ms: row.avg_duration_ms === null ? null : Math.round(Number(row.avg_duration_ms)),
    };
  }

  prune(olderThanDays: number): void {
    const cutoff = new Date(Date.now() - olderThanDays * 86_400_000).toISOString();
    this.db.prepare(`DELETE FROM tasks WHERE created_at < ?`).run(cutoff);
  }
}

/** Fallback when node:sqlite is unavailable (Node < 22.5): keeps recent tasks in memory. */
class MemoryTaskStore implements TaskStore {
  readonly kind = "memory" as const;
  private rows: TaskRow[] = [];

  insert(row: TaskRow): void {
    this.rows = [row, ...this.rows.filter((r) => r.task_id !== row.task_id)].slice(0, 1000);
  }

  finish(taskId: string, patch: Parameters<TaskStore["finish"]>[1]): void {
    const row = this.rows.find((r) => r.task_id === taskId);
    if (row) Object.assign(row, patch);
  }

  recent(limit: number): TaskRow[] {
    return this.rows.slice(0, limit);
  }

  stats(): TaskStats {
    const since = Date.now() - 24 * 3600_000;
    const done = this.rows.filter((r) => r.success === 1);
    return {
      total: this.rows.length,
      completed: done.length,
      failed: this.rows.filter((r) => r.success === 0).length,
      last_24h: this.rows.filter((r) => Date.parse(r.created_at) >= since).length,
      avg_duration_ms: done.length ? Math.round(done.reduce((s, r) => s + (r.duration_ms ?? 0), 0) / done.length) : null,
    };
  }

  prune(): void {
    // bounded by construction
  }
}

const globalStore = globalThis as unknown as { __act402TaskStore?: TaskStore };

export function getTaskStore(): TaskStore {
  if (globalStore.__act402TaskStore) return globalStore.__act402TaskStore;
  let store: TaskStore;
  try {
    // getBuiltinModule keeps bundlers from trying to resolve node:sqlite.
    const sqlite = process.getBuiltinModule?.("node:sqlite") as SqliteModule | undefined;
    if (!sqlite) throw new Error("node:sqlite unavailable");
    const dir = getConfig().dataDir;
    fs.mkdirSync(dir, { recursive: true });
    store = new SqliteTaskStore(sqlite, path.join(dir, "act402.sqlite"));
    store.prune(getConfig().taskRetentionDays);
  } catch (err) {
    log("task_store_fallback", { reason: err instanceof Error ? err.message : String(err) }, "warn");
    store = new MemoryTaskStore();
  }
  globalStore.__act402TaskStore = store;
  return store;
}
