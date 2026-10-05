import { capabilities } from "@/lib/capabilities";
import { json, methodNotAllowed } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /capabilities — free, machine-readable description for calling agents. */
export function GET(): Response {
  return json(capabilities(), 200, { "cache-control": "public, max-age=300", "access-control-allow-origin": "*" });
}

export const POST = methodNotAllowed("GET /capabilities");
export const PUT = methodNotAllowed("GET /capabilities");
export const PATCH = methodNotAllowed("GET /capabilities");
export const DELETE = methodNotAllowed("GET /capabilities");
