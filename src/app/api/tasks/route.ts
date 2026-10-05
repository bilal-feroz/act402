import { json } from "@/lib/http";
import { getTaskStore } from "@/lib/storage/tasks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Recent executions for the dashboard. Full task ids are capability tokens for
 * evidence URLs, so only a short prefix is exposed — never URLs or results.
 */
export function GET(): Response {
  const store = getTaskStore();
  const tasks = store.recent(25).map((t) => ({
    task: `${t.task_id.slice(0, 10)}…`,
    created_at: t.created_at,
    status: t.status,
    success: t.success === null ? null : t.success === 1,
    mode: t.mode,
    source: t.source,
    domain: t.domain,
    actions: t.action_count,
    duration_ms: t.duration_ms,
    error_code: t.error_code,
  }));
  return json({ stats: store.stats(), tasks });
}
