import { getConfig } from "@/lib/config";
import { toAct402Error } from "@/lib/errors";
import { baseUrlFrom, clientIp, errorFrom, errorJson, readJson } from "@/lib/http";
import { parseActRequest } from "@/lib/act/schema";
import { runTask } from "@/lib/act/run-task";
import { takeDemoToken } from "@/lib/rate-limit";
import { getRuntime } from "@/lib/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Free, rate-limited demo used by the dashboard. Runs the same engine as
 * POST /act and streams real execution events as NDJSON, ending with the
 * exact JSON a paying agent would receive.
 */
export async function POST(req: Request): Promise<Response> {
  const config = getConfig();
  if (!config.demo.enabled) return errorJson("NOT_FOUND", "The public demo is disabled on this deployment.");

  const body = await readJson(req);
  if (!body.ok) return errorJson("INVALID_REQUEST", body.reason);
  let parsed;
  try {
    parsed = parseActRequest(body.value, config, { maxActions: config.demo.maxActions, maxDurationMs: config.demo.maxDurationMs });
  } catch (err) {
    return errorFrom(toAct402Error(err, "INVALID_REQUEST"));
  }
  const token = takeDemoToken(clientIp(req));
  if (!token.ok) {
    return errorJson("RATE_LIMITED", token.reason, { retry_after_seconds: token.retryAfterSeconds }, { "retry-after": String(token.retryAfterSeconds) });
  }

  const encoder = new TextEncoder();
  const abort = new AbortController();
  req.signal?.addEventListener("abort", () => abort.abort());
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true;
      const send = (event: unknown) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        } catch {
          open = false;
        }
      };
      send({ type: "accepted", at_ms: 0, mode: parsed.request.mode });
      try {
        const outcome = await runTask(parsed.request, parsed.warnings, {
          source: "demo",
          baseUrl: baseUrlFrom(req),
          emit: send,
          captureFrames: true,
          signal: abort.signal,
          extraSlots: [getRuntime().demoSlots],
        });
        send({ type: "result", http_status: outcome.httpStatus, body: outcome.body });
      } catch (err) {
        const e = toAct402Error(err);
        send({ type: "result", http_status: e.httpStatus, body: { success: false, status: "failed", error: { code: e.code, message: e.message } } });
      }
      open = false;
      try {
        controller.close();
      } catch {
        // already closed by the client
      }
    },
    cancel() {
      abort.abort();
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store, no-transform",
      "x-accel-buffering": "no",
    },
  });
}
