import { timingSafeEqual } from "node:crypto";
import { getConfig } from "./config";
import { ERROR_STATUS, type Act402Error, type ErrorCode } from "./errors";

const BASE_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "x-content-type-options": "nosniff",
};

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { ...BASE_HEADERS, "cache-control": "no-store", ...headers },
  });
}

export function errorJson(code: ErrorCode, message: string, details?: Record<string, unknown>, headers: Record<string, string> = {}): Response {
  return json(
    {
      success: false,
      status: "failed",
      error: { code, message, ...(details ? { details } : {}) },
    },
    ERROR_STATUS[code],
    headers,
  );
}

export function errorFrom(err: Act402Error): Response {
  return json(
    {
      success: false,
      status: ["ACTION_REQUIRES_AUTHORIZATION", "POLICY_VIOLATION", "SENSITIVE_INPUT_REJECTED", "BLOCKED_URL"].includes(err.code) ? "blocked" : "failed",
      error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) },
      notice: "Failed executions are not charged: the x402 gateway settles payment only on HTTP 2xx.",
    },
    err.httpStatus,
  );
}

/** JSON 405 for methods an endpoint does not support. */
export function methodNotAllowed(usage: string): () => Response {
  const allow = `${usage.split(" ")[0]}, OPTIONS`;
  return () => errorJson("METHOD_NOT_ALLOWED", `Use ${usage}.`, undefined, { allow });
}

/**
 * Public origin of this deployment, for absolute evidence URLs. On a Replit
 * deployment the app's own domain is used, so URLs stay correct even when the
 * request arrived through the x402 gateway.
 */
export function baseUrlFrom(req: Request): string {
  const configured = getConfig().publicBaseUrl;
  if (configured) return configured;
  if (process.env.REPLIT_DEPLOYMENT) {
    const domain = (process.env.REPLIT_DOMAINS ?? "").split(",")[0]?.trim();
    if (domain) return `https://${domain}`;
  }
  const headers = req.headers;
  const host = headers.get("x-forwarded-host")?.split(",")[0].trim() || headers.get("host") || "";
  if (!host) return "";
  const proto = headers.get("x-forwarded-proto")?.split(",")[0].trim() || (host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https");
  return `${proto}://${host}`;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

/**
 * POST /act is paid through the XDC AI x402 gateway, which injects the shared
 * secret on every forwarded call. Direct callers without it are refused.
 */
export function isGatewayAuthorized(req: Request): boolean {
  const secret = getConfig().gatewaySecret;
  if (!secret) return true;
  const header = req.headers.get("x-act402-key") ?? "";
  const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.get("authorization") ?? "")?.[1] ?? "";
  return (header !== "" && safeEqual(header, secret)) || (bearer !== "" && safeEqual(bearer, secret));
}

export function clientIp(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return req.headers.get("x-real-ip") ?? "unknown";
}

const MAX_BODY_BYTES = 256 * 1024;

/** Read a JSON body with a size limit. Returns undefined when the body is not valid JSON. */
export async function readJson(req: Request): Promise<{ ok: true; value: unknown } | { ok: false; reason: string }> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) return { ok: false, reason: `Body exceeds ${MAX_BODY_BYTES / 1024} KB.` };
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) return { ok: false, reason: `Body exceeds ${MAX_BODY_BYTES / 1024} KB.` };
  if (!text.trim()) return { ok: false, reason: "Body is empty; send a JSON object." };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, reason: "Body is not valid JSON." };
  }
}
