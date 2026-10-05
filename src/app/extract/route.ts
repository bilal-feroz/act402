import { methodNotAllowed } from "@/lib/http";
import { handlePaidTask } from "@/lib/act/endpoint";
import { buildExtract } from "@/lib/act/quick";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /extract — text, links, tables or attributes from a page after its JavaScript ran ($0.15). */
export function POST(req: Request): Promise<Response> {
  return handlePaidTask(req, buildExtract);
}

export const GET = methodNotAllowed("POST /extract");
export const PUT = methodNotAllowed("POST /extract");
export const PATCH = methodNotAllowed("POST /extract");
export const DELETE = methodNotAllowed("POST /extract");
