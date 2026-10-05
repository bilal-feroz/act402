/**
 * Machine-readable error codes and the HTTP status each one maps to.
 *
 * Every non-2xx status matters commercially: the x402 gateway settles a
 * payment only when Act402 answers 2xx, so a failed execution is never billed.
 */
export const ERROR_STATUS = {
  INVALID_REQUEST: 400,
  INVALID_URL: 400,
  UNSUPPORTED_ACTION: 400,
  UNAUTHORIZED: 401,
  BLOCKED_URL: 403,
  ACTION_REQUIRES_AUTHORIZATION: 403,
  SENSITIVE_INPUT_REJECTED: 403,
  POLICY_VIOLATION: 403,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  TARGET_NOT_FOUND: 422,
  ACTION_FAILED: 422,
  TASK_NOT_COMPLETED: 422,
  STEP_LIMIT_REACHED: 422,
  DOWNLOAD_FAILED: 422,
  SITE_BLOCKED_AUTOMATION: 422,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
  NAVIGATION_FAILED: 502,
  BROWSER_PROVIDER_ERROR: 502,
  AT_CAPACITY: 503,
  BROWSER_PROVIDER_NOT_CONFIGURED: 503,
  TIMEOUT: 504,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

export const ERROR_DESCRIPTIONS: Record<ErrorCode, string> = {
  INVALID_REQUEST: "The request body failed validation. `error.details` lists each problem.",
  INVALID_URL: "The URL is malformed, not http(s), or its host does not resolve.",
  UNSUPPORTED_ACTION: "An action `type` is not supported. See GET /capabilities.",
  UNAUTHORIZED: "Missing or invalid gateway key. Call Act402 through its x402 marketplace URL.",
  BLOCKED_URL: "The URL (or a redirect) points at localhost, a private network, a metadata endpoint, or a forbidden scheme/port.",
  ACTION_REQUIRES_AUTHORIZATION: "The action could create a financial, destructive, or legally binding effect (purchase, payment, deletion, sign-up, ...).",
  SENSITIVE_INPUT_REJECTED: "Typing into password/payment fields, or typing values that look like secrets, is not allowed.",
  POLICY_VIOLATION: "The request asks for something Act402 never does (CAPTCHA/paywall bypass, credential harvesting, ...).",
  NOT_FOUND: "The requested resource does not exist or has expired.",
  METHOD_NOT_ALLOWED: "Wrong HTTP method for this endpoint.",
  TARGET_NOT_FOUND: "No element matched an action's target within its timeout. `error.details.suggestions` lists similar elements.",
  ACTION_FAILED: "An element was found but the action could not be performed (not editable, not a <select>, covered by an overlay, ...).",
  TASK_NOT_COMPLETED: "Goal mode could not find the requested information. Send explicit `actions` for precise control.",
  STEP_LIMIT_REACHED: "The task used its maximum number of steps before finishing.",
  DOWNLOAD_FAILED: "The file could not be downloaded (not public, too large, or the link did not produce a file).",
  SITE_BLOCKED_AUTOMATION: "The website answered with a CAPTCHA or anti-bot wall. Act402 does not bypass bot protection.",
  RATE_LIMITED: "Too many requests. Retry after the number of seconds in `error.details.retry_after_seconds`.",
  INTERNAL_ERROR: "Unexpected server error. Safe to retry.",
  NAVIGATION_FAILED: "The page could not be loaded (DNS, TLS, connection, or HTTP failure).",
  BROWSER_PROVIDER_ERROR: "The browser crashed or disconnected. Safe to retry.",
  AT_CAPACITY: "All browser slots are busy and the queue is full. Retry in a few seconds.",
  BROWSER_PROVIDER_NOT_CONFIGURED: "No Chromium executable is available on this server.",
  TIMEOUT: "The task exceeded its time limit. Partial progress is reported in `actions`.",
};

export class Act402Error extends Error {
  readonly code: ErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "Act402Error";
    this.code = code;
    this.details = details;
  }

  get httpStatus(): number {
    return ERROR_STATUS[this.code];
  }
}

export function isAct402Error(err: unknown): err is Act402Error {
  return err instanceof Act402Error;
}

/** Map an arbitrary thrown value to an Act402Error without leaking internals. */
export function toAct402Error(err: unknown, fallback: ErrorCode = "INTERNAL_ERROR"): Act402Error {
  if (isAct402Error(err)) return err;
  const message = err instanceof Error ? err.message : String(err);
  if (/Target page, context or browser has been closed|Browser has been closed|browser has disconnected|Target closed/i.test(message)) {
    return new Act402Error("BROWSER_PROVIDER_ERROR", "The browser session closed unexpectedly.");
  }
  return new Act402Error(fallback, fallback === "INTERNAL_ERROR" ? "Unexpected error while executing the task." : firstLine(message));
}

/** Playwright errors carry multi-line call logs; keep the useful first line only. */
export function firstLine(message: string): string {
  const line = message.split("\n").find((l) => l.trim().length > 0) ?? message;
  return line.replace(/^\w+Error:\s*/, "").slice(0, 300);
}
