import { methodNotAllowed } from "@/lib/http";
import { handlePaidTask } from "@/lib/act/endpoint";
import { buildScreenshot } from "@/lib/act/quick";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /screenshot — PNG of a rendered page or one element ($0.10). */
export function POST(req: Request): Promise<Response> {
  return handlePaidTask(req, buildScreenshot, {
    decorate: (body) => {
      const evidence = body.evidence as unknown[] | undefined;
      if (evidence?.[0]) body.screenshot = evidence[0];
    },
  });
}

export const GET = methodNotAllowed("POST /screenshot");
export const PUT = methodNotAllowed("POST /screenshot");
export const PATCH = methodNotAllowed("POST /screenshot");
export const DELETE = methodNotAllowed("POST /screenshot");
