import { json, methodNotAllowed } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /health — free liveness check. */
export function GET(): Response {
  return json({ status: "ok", service: "Act402" }, 200, { "access-control-allow-origin": "*" });
}

export const POST = methodNotAllowed("GET /health");
export const PUT = methodNotAllowed("GET /health");
export const PATCH = methodNotAllowed("GET /health");
export const DELETE = methodNotAllowed("GET /health");
