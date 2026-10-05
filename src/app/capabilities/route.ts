import { capabilities } from "@/lib/capabilities";
import { baseUrlFrom, json } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(req: Request): Response {
  return json(capabilities(baseUrlFrom(req)), 200, {
    "cache-control": "public, max-age=300",
    "access-control-allow-origin": "*",
  });
}
