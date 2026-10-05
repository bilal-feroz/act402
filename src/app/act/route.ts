import { getConfig } from "@/lib/config";
import { toAct402Error } from "@/lib/errors";
import { baseUrlFrom, errorFrom, errorJson, isGatewayAuthorized, json, readJson } from "@/lib/http";
import { parseActRequest } from "@/lib/act/schema";
import { runTask } from "@/lib/act/run-task";
import { EXAMPLE_REQUESTS } from "@/lib/capabilities";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /act — the paid endpoint. Runs one browser task and returns structured JSON. */
export async function POST(req: Request): Promise<Response> {
  if (!isGatewayAuthorized(req)) {
    return errorJson("UNAUTHORIZED", "Missing or invalid gateway key. Call Act402 through its x402 marketplace URL.", undefined, {
      "www-authenticate": 'Bearer realm="act402"',
    });
  }
  const body = await readJson(req);
  if (!body.ok) {
    return errorJson("INVALID_REQUEST", body.reason, { example: EXAMPLE_REQUESTS.click_extract_screenshot });
  }
  let parsed;
  try {
    parsed = parseActRequest(body.value, getConfig());
  } catch (err) {
    return errorFrom(toAct402Error(err, "INVALID_REQUEST"));
  }
  try {
    const outcome = await runTask(parsed.request, parsed.warnings, { source: "api", baseUrl: baseUrlFrom(req) });
    return json(outcome.body, outcome.httpStatus, { "x-act402-task-id": outcome.taskId });
  } catch (err) {
    return errorFrom(toAct402Error(err));
  }
}

export function GET(): Response {
  return json(
    {
      success: false,
      error: { code: "METHOD_NOT_ALLOWED", message: "Use POST /act with a JSON body. See GET /capabilities for the full contract." },
      example: EXAMPLE_REQUESTS.click_extract_screenshot,
    },
    405,
    { allow: "POST, OPTIONS" },
  );
}

export function OPTIONS(): Response {
  return new Response(null, { status: 204, headers: { allow: "POST, OPTIONS" } });
}
