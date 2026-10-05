import { getConfig } from "../config";
import { toAct402Error } from "../errors";
import { baseUrlFrom, errorFrom, errorJson, isGatewayAuthorized, json, readJson } from "../http";
import type { BuiltTask } from "./quick";
import { runTask } from "./run-task";
import { parseActRequest } from "./schema";

/**
 * Shared handler for every paid endpoint: gateway auth, JSON parsing,
 * validation, execution, and the response. `decorate` adds endpoint-specific
 * convenience fields to a successful body.
 */
export async function handlePaidTask(
  req: Request,
  build: (body: unknown) => BuiltTask,
  options: { decorate?: (body: Record<string, unknown>) => void; example?: unknown } = {},
): Promise<Response> {
  const { decorate, example } = options;
  if (!isGatewayAuthorized(req)) {
    return errorJson("UNAUTHORIZED", "Missing or invalid gateway key. Call Act402 through its x402 marketplace URL.", undefined, {
      "www-authenticate": 'Bearer realm="act402"',
    });
  }
  const body = await readJson(req);
  if (!body.ok) return errorJson("INVALID_REQUEST", body.reason, example ? { example } : undefined);

  let parsed;
  try {
    const built = build(body.value);
    parsed = parseActRequest(built.raw, getConfig());
    parsed.request.openUrl = built.openUrl ?? true;
    parsed.request.requireDownload = built.requireDownload ?? false;
  } catch (err) {
    return errorFrom(toAct402Error(err, "INVALID_REQUEST"));
  }

  try {
    const outcome = await runTask(parsed.request, parsed.warnings, { source: "api", baseUrl: baseUrlFrom(req) });
    if (outcome.body.success === true) decorate?.(outcome.body);
    return json(outcome.body, outcome.httpStatus, { "x-act402-task-id": outcome.taskId });
  } catch (err) {
    return errorFrom(toAct402Error(err));
  }
}
