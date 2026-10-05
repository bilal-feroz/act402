
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
  readonly kind: "memory";
  insert(row: TaskRow): void;
  finish(taskId: string, patch: Pick<TaskRow, "finished_at" | "status" | "success" | "duration_ms" | "error_code" | "result" | "action_count">): void;
  recent(limit: number): TaskRow[];
  stats(): TaskStats;
  prune(olderThanDays: number): void;
}

/** Recent tasks kept in memory only (no database). */
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
  globalStore.__act402TaskStore ??= new MemoryTaskStore();
  return globalStore.__act402TaskStore;
}
