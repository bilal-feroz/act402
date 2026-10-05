import { Act402Error, toAct402Error } from "../errors";
import { log } from "../logger";
import { getRuntime } from "../runtime";
import type { Semaphore } from "../browser/limiter";
import type { BrowserProvider, BrowserSession } from "../browser/provider";
import { checkClickName, checkGoal, checkTypedValue } from "../security/action-policy";
import { checkUrl, checkUrlSyntax, type UrlPolicy } from "../security/url-guard";
import { getTaskStore } from "../storage/tasks";
import { hostnameOf, newTaskId, preview } from "../util";
import { buildResponse } from "./response";
import { TaskRunner, type CollectedResult } from "./runner";
import type { ActRequest } from "./schema";
import type { GoalAnswer, TaskEvent } from "./types";

export interface RunTaskOptions {
  source: "api" | "demo";
  /** Origin used for absolute evidence URLs. */
  baseUrl: string;
  emit?: (event: TaskEvent) => void;
  captureFrames?: boolean;
  /** Aborts the task early (e.g. the demo viewer closed the stream). */
  signal?: AbortSignal;
  /** Extra slot pools to hold (the demo pool). */
  extraSlots?: Semaphore[];
  /** Tests inject a permissive policy and their own provider. */
  policy?: UrlPolicy;
  provider?: BrowserProvider;
  slots?: Semaphore;
  taskId?: string;
}

export interface TaskOutcome {
  httpStatus: number;
  body: Record<string, unknown>;
  taskId: string;
}

/** Cheap checks before any browser time is spent. */
async function preflight(request: ActRequest, policy: UrlPolicy): Promise<void> {
  const check = await checkUrl(request.url, policy);
  if (!check.ok) throw new Act402Error(check.code, check.reason, { url: request.url });
  if (request.mode === "goal" && request.goal) {
    const verdict = checkGoal(request.goal);
    if (!verdict.allowed) throw new Act402Error(verdict.code, verdict.reason);
  }
  request.actions.forEach((action, i) => {
    if (action.type === "type") {
      const verdict = checkTypedValue(action.value);
      if (!verdict.allowed) throw new Act402Error(verdict.code, `actions[${i}]: ${verdict.reason}`, { action_index: i });
    }
    if ((action.type === "click" || action.type === "download") && action.target) {
      for (const name of [action.target.text, action.target.name]) {
        if (!name) continue;
        const verdict = checkClickName(name);
        if (!verdict.allowed) throw new Act402Error(verdict.code, `actions[${i}]: ${verdict.reason}`, { action_index: i });
      }
    }
    const url = action.type === "navigate" ? action.url : action.type === "download" ? action.url : undefined;
    if (url) {
      let absolute: string;
      try {
        absolute = new URL(url, request.url).href;
      } catch {
        throw new Act402Error("INVALID_URL", `actions[${i}].url is not a valid URL.`, { action_index: i });
      }
      const syntax = checkUrlSyntax(absolute, policy);
      if (!syntax.ok) throw new Act402Error(syntax.code, `actions[${i}].url: ${syntax.reason}`, { action_index: i });
    }
  });
}

/**
 * Run one Act402 task end to end: validate, wait for a browser slot, execute
 * in an isolated context (retrying once if Chromium crashes), collect the
 * result, record it, and always close the context.
 */
export async function runTask(request: ActRequest, warnings: string[], opts: RunTaskOptions): Promise<TaskOutcome> {
  const runtime = getRuntime();
  const provider = opts.provider ?? runtime.provider;
  const slots = opts.slots ?? runtime.browserSlots;
  const policy = opts.policy ?? {};
  const taskId = opts.taskId ?? newTaskId();
  const startedAt = Date.now();
  const deadline = startedAt + request.timeoutMs;
  const store = getTaskStore();
  const emit = (event: TaskEvent) => {
    try {
      opts.emit?.(event);
    } catch {
      // a broken stream must never break the task
    }
  };

  store.insert({
    task_id: taskId,
    created_at: new Date(startedAt).toISOString(),
    finished_at: null,
    status: "running",
    success: null,
    mode: request.mode,
    source: opts.source,
    url: preview(request.url, 500),
    domain: hostnameOf(request.url),
    action_count: request.actions.length,
    duration_ms: null,
    error_code: null,
    result: null,
  });
  log("task_started", { task_id: taskId, source: opts.source, mode: request.mode, domain: hostnameOf(request.url), actions: request.actions.length });

  let runner: TaskRunner | undefined;
  let collected: CollectedResult | undefined;
  let answer: GoalAnswer | undefined;
  let error: Act402Error | undefined;
  let queueMs = 0;
  let browserVersion: string | undefined;
  const dialogs: string[] = [];

  try {
    await preflight(request, policy);
    if (opts.signal?.aborted) throw new Act402Error("TASK_NOT_COMPLETED", "The request was cancelled.");

    // Keep enough of the time budget to actually run after waiting for a slot.
    const minRunMs = Math.min(8000, Math.round(request.timeoutMs * 0.6));
    const releases: Array<() => void> = [];
    try {
      for (const pool of [...(opts.extraSlots ?? []), slots]) {
        if (pool.stats.active >= pool.stats.max) emit({ type: "queued", at_ms: Date.now() - startedAt, message: "Waiting for a free browser slot…" });
        releases.push(await pool.acquire(Math.max(0, deadline - Date.now() - minRunMs)));
      }
      queueMs = Date.now() - startedAt;
      if (deadline - Date.now() < minRunMs) throw new Act402Error("AT_CAPACITY", "Not enough time left after waiting for a browser slot. Retry in a few seconds.", { retry_after_seconds: 10 });

      for (let attempt = 1; attempt <= 2; attempt++) {
        const session: BrowserSession = await provider.createSession({ taskId, viewport: request.viewport });
        browserVersion = provider.status().browserVersion;
        let timedOut = false;
        const watchdog = setTimeout(() => {
          timedOut = true;
          provider.closeSession(session.id).catch(() => undefined);
        }, Math.max(0, deadline - Date.now()) + 250);
        const onAbort = () => provider.closeSession(session.id).catch(() => undefined);
        opts.signal?.addEventListener("abort", onAbort);

        runner = new TaskRunner({
          taskId,
          session,
          deadline,
          startedAt,
          baseUrl: opts.baseUrl,
          policy,
          captureFrames: Boolean(opts.captureFrames),
          emit,
          viewport: request.viewport,
        });
        emit({ type: "started", at_ms: Date.now() - startedAt, task_id: taskId, provider: provider.name });
        try {
          await runner.open(request.url, request.waitUntil, request.dismissCookieBanners);
          for (let i = 0; i < request.actions.length; i++) {
            if (opts.signal?.aborted) throw new Act402Error("TASK_NOT_COMPLETED", "The request was cancelled.");
            await runner.run(request.actions[i], i);
          }
          if (request.finalScreenshot) await runner.captureFinal();
          collected = await runner.collect({
            links: request.returnFields.has("links"),
            downloadLinks: request.returnFields.has("download_links"),
            pageText: request.returnFields.has("page_text"),
          });
          dialogs.push(...session.dialogs);
          break;
        } catch (err) {
          let e = toAct402Error(err);
          if (timedOut || (Date.now() >= deadline && e.code !== "SITE_BLOCKED_AUTOMATION")) {
            e = new Act402Error("TIMEOUT", `The task exceeded its ${Math.round(request.timeoutMs / 1000)} s limit.`, e.details);
          }
          if (opts.signal?.aborted) e = new Act402Error("TASK_NOT_COMPLETED", "The request was cancelled.");
          const crashed = e.code === "BROWSER_PROVIDER_ERROR";
          if (crashed && attempt === 1 && deadline - Date.now() > 15_000) {
            log("task_retry_after_crash", { task_id: taskId }, "warn");
            warnings.push("The browser crashed once; the task was retried in a fresh session.");
            continue;
          }
          dialogs.push(...session.dialogs);
          throw e;
        } finally {
          clearTimeout(watchdog);
          opts.signal?.removeEventListener("abort", onAbort);
          await provider.closeSession(session.id);
        }
      }
    } finally {
      for (const release of releases.reverse()) release();
    }
  } catch (err) {
    error = toAct402Error(err);
    if (error.code === "INTERNAL_ERROR") {
      // The response stays generic; the log keeps the cause for debugging.
      log("task_internal_error", { task_id: taskId, error: err instanceof Error ? `${err.message}\n${err.stack ?? ""}`.slice(0, 1500) : String(err) }, "error");
    }
  }

  const durationMs = Date.now() - startedAt;
  const body = buildResponse({
    taskId,
    request,
    warnings: [...warnings, ...(runner?.warnings ?? [])],
    steps: runner?.steps ?? [],
    extracts: runner?.extracts ?? [],
    evidence: runner?.evidence ?? [],
    domains: runner ? [...runner.domains] : [],
    dialogs,
    collected,
    answer,
    error,
    durationMs,
    queueMs,
    navigationMs: runner?.navigationMs ?? 0,
    provider: provider.name,
    browserVersion,
  });

  const summary = error
    ? { error: error.message.slice(0, 300) }
    : {
        final_url: collected?.final_url,
        answer: answer?.answer?.slice(0, 200),
        text_excerpt: collected?.text?.slice(0, 200),
        screenshots: runner?.screenshotsTaken ?? 0,
        downloads: runner?.downloadsTaken ?? 0,
      };
  try {
    store.finish(taskId, {
      finished_at: new Date().toISOString(),
      status: error ? (body.status as string) : "completed",
      success: error ? 0 : 1,
      duration_ms: durationMs,
      error_code: error?.code ?? null,
      result: JSON.stringify(summary),
      action_count: request.actions.length,
    });
  } catch (err) {
    log("task_store_write_failed", { task_id: taskId, error: String(err) }, "warn");
  }
  log("task_finished", {
    task_id: taskId,
    source: opts.source,
    mode: request.mode,
    success: !error,
    error_code: error?.code,
    duration_ms: durationMs,
    queue_ms: queueMs,
    steps: runner?.steps.length ?? 0,
  });

  return { httpStatus: error ? error.httpStatus : 200, body, taskId };
}
