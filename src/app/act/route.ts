import { json, methodNotAllowed } from "@/lib/http";
import { handlePaidTask } from "@/lib/act/endpoint";
import type { RawBody } from "@/lib/act/quick";
import { EXAMPLE_REQUEST } from "@/lib/capabilities";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /act — run a list of browser actions and return structured JSON ($0.50). */
export function POST(req: Request): Promise<Response> {
  return handlePaidTask(req, (body) => ({ raw: body as RawBody }), { example: EXAMPLE_REQUEST });
}

export function GET(): Response {
  return json(
    {
      success: false,
      error: { code: "METHOD_NOT_ALLOWED", message: "Use POST /act with a JSON body. See GET /capabilities for the full contract." },
      example: EXAMPLE_REQUEST,
    },
    405,
    { allow: "POST, OPTIONS" },
  );
}

export function OPTIONS(): Response {
  return new Response(null, { status: 204, headers: { allow: "POST, OPTIONS" } });
}

export const PUT = methodNotAllowed("POST /act");
export const PATCH = methodNotAllowed("POST /act");
export const DELETE = methodNotAllowed("POST /act");
