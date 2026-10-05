type Level = "info" | "warn" | "error";

// Field names whose values must never reach the logs.
const SENSITIVE_KEY = /(api[_-]?key|secret|token|password|passwd|authorization|cookie|credential|x-act402-key)/i;

function redact(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[depth]";
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY.test(k) ? "[redacted]" : redact(v, depth + 1);
    }
    return out;
  }
  if (typeof value === "string" && value.length > 500) return `${value.slice(0, 500)}…`;
  return value;
}

/** One JSON object per line, e.g. {"event":"browser_action","task_id":"act_…","action":"click","duration_ms":382}. */
export function log(event: string, fields: Record<string, unknown> = {}, level: Level = "info"): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    event,
    ...(redact(fields) as Record<string, unknown>),
  });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}
