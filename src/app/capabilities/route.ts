import { capabilities } from "@/lib/capabilities";
import { json } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /capabilities — free, machine-readable description for calling agents. */
export function GET(): Response {
  return json(capabilities(), 200, { "cache-control": "public, max-age=300", "access-control-allow-origin": "*" });
}
