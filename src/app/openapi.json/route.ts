import { baseUrlFrom, json } from "@/lib/http";
import { openApiDocument } from "@/lib/openapi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(req: Request): Response {
  return json(openApiDocument(baseUrlFrom(req)), 200, {
    "cache-control": "public, max-age=300",
    "access-control-allow-origin": "*",
  });
}
