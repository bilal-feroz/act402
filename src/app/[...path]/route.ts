import { errorJson } from "@/lib/http";

export const dynamic = "force-dynamic";

// Any path that is not a real endpoint gets a JSON 404 an agent can parse.
function notFound(): Response {
  return errorJson("NOT_FOUND", "Unknown endpoint. Available: GET /health, GET /capabilities, POST /act.");
}

export const GET = notFound;
export const POST = notFound;
export const PUT = notFound;
export const PATCH = notFound;
export const DELETE = notFound;
