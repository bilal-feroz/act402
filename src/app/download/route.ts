import { methodNotAllowed } from "@/lib/http";
import { handlePaidTask } from "@/lib/act/endpoint";
import { buildDownload } from "@/lib/act/quick";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /download — a public file, directly or behind a link/button on a page ($0.25). */
export function POST(req: Request): Promise<Response> {
  return handlePaidTask(req, buildDownload);
}

export const GET = methodNotAllowed("POST /download");
export const PUT = methodNotAllowed("POST /download");
export const PATCH = methodNotAllowed("POST /download");
export const DELETE = methodNotAllowed("POST /download");
