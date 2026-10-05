import { Act402Error } from "../errors";

/**
 * Single-purpose paid endpoints (/screenshot, /extract, /download) are thin
 * shapes over POST /act: each builds an /act request body that then goes
 * through the same validation, limits, safety checks, and browser engine.
 */
export type RawBody = Record<string, unknown>;

export interface BuiltTask {
  raw: RawBody;
  openUrl?: boolean;
  requireDownload?: boolean;
}

const PASS_THROUGH = ["url", "timeout_seconds", "viewport", "wait_until", "dismiss_cookie_banners"];

function asObject(body: unknown): RawBody {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Act402Error("INVALID_REQUEST", "Request body must be a JSON object with at least a `url`.");
  }
  return body as RawBody;
}

function optionalString(value: unknown, field: string, max = 1000): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.length > max) {
    throw new Act402Error("INVALID_REQUEST", `\`${field}\` must be a string of at most ${max} characters.`);
  }
  return value;
}

function base(body: RawBody): RawBody {
  const out: RawBody = {};
  for (const key of PASS_THROUGH) if (body[key] !== undefined) out[key] = body[key];
  return out;
}

/** Optional waits before the main step: wait_for_selector, wait_for_text, wait_ms. */
function waits(body: RawBody): unknown[] {
  const steps: unknown[] = [];
  const selector = optionalString(body.wait_for_selector, "wait_for_selector");
  const text = optionalString(body.wait_for_text, "wait_for_text", 500);
  if (selector) steps.push({ type: "wait", target: { selector } });
  if (text) steps.push({ type: "wait", text });
  if (body.wait_ms !== undefined) steps.push({ type: "wait", milliseconds: body.wait_ms });
  return steps;
}

/** POST /screenshot {url, selector?, full_page?, wait_for_selector?, wait_for_text?, wait_ms?} */
export function buildScreenshot(input: unknown): BuiltTask {
  const body = asObject(input);
  const selector = optionalString(body.selector, "selector");
  const shot: RawBody = { type: "screenshot", name: "screenshot" };
  if (selector) shot.target = { selector };
  if (body.full_page !== undefined) shot.full_page = body.full_page;
  return {
    raw: { ...base(body), actions: [...waits(body), shot], final_screenshot: false, return: ["final_url", "title", "screenshots"] },
  };
}

/** POST /extract {url, selector?="body", format?="text", attribute?, all?, max_chars?, screenshot?, wait_*?} */
export function buildExtract(input: unknown): BuiltTask {
  const body = asObject(input);
  const selector = optionalString(body.selector, "selector") ?? "body";
  const format = body.format ?? "text";
  const extract: RawBody = { type: "extract", target: { selector }, format };
  for (const key of ["attribute", "all", "max_chars"]) if (body[key] !== undefined) extract[key] = body[key];
  const structured = format !== "text" || body.all === true;
  const screenshot = body.screenshot === true;
  return {
    raw: {
      ...base(body),
      actions: [...waits(body), extract],
      final_screenshot: screenshot,
      return: ["text", "final_url", "title", ...(structured ? ["extracts"] : []), ...(screenshot ? ["screenshots"] : [])],
    },
  };
}

/**
 * POST /download {url, target?, selector?, filename?}
 * Without a target, `url` itself must be the file. With a target, Act402 opens
 * `url` and downloads the file the link or button leads to.
 */
export function buildDownload(input: unknown): BuiltTask {
  const body = asObject(input);
  const filename = optionalString(body.filename, "filename", 120);
  const selector = optionalString(body.selector, "selector");
  const target = body.target ?? (selector ? { selector } : undefined);
  const extra = filename ? { filename } : {};
  if (target === undefined) {
    return {
      raw: { ...base(body), actions: [{ type: "download", url: body.url, ...extra }], final_screenshot: false, return: ["final_url", "downloads"] },
      openUrl: false,
      requireDownload: true,
    };
  }
  return {
    raw: { ...base(body), actions: [...waits(body), { type: "download", target, ...extra }], final_screenshot: false, return: ["final_url", "downloads"] },
    requireDownload: true,
  };
}
