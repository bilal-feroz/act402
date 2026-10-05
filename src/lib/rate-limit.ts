import { getConfig } from "./config";

interface DemoLimiterState {
  perIp: Map<string, number[]>;
  day: string;
  dayCount: number;
}

const g = globalThis as unknown as { __act402DemoLimiter?: DemoLimiterState };

function state(): DemoLimiterState {
  g.__act402DemoLimiter ??= { perIp: new Map(), day: "", dayCount: 0 };
  return g.__act402DemoLimiter;
}

/** Sliding one-hour window per IP plus a global daily cap for the free public demo. */
export function takeDemoToken(ip: string): { ok: true } | { ok: false; retryAfterSeconds: number; reason: string } {
  const { demo } = getConfig();
  const s = state();
  const now = Date.now();
  const today = new Date(now).toISOString().slice(0, 10);
  if (s.day !== today) {
    s.day = today;
    s.dayCount = 0;
  }
  if (s.dayCount >= demo.dailyLimit) {
    const tomorrow = Date.parse(`${today}T00:00:00Z`) + 86_400_000;
    return { ok: false, retryAfterSeconds: Math.ceil((tomorrow - now) / 1000), reason: "The free demo reached its daily limit. Use POST /act through the x402 gateway." };
  }
  const windowStart = now - 3600_000;
  const hits = (s.perIp.get(ip) ?? []).filter((t) => t > windowStart);
  if (hits.length >= demo.perIpPerHour) {
    return { ok: false, retryAfterSeconds: Math.ceil((hits[0] + 3600_000 - now) / 1000), reason: `Demo limit is ${demo.perIpPerHour} runs per hour.` };
  }
  hits.push(now);
  s.perIp.set(ip, hits);
  s.dayCount++;
  if (s.perIp.size > 5000) {
    for (const [key, times] of s.perIp) if (times.every((t) => t <= windowStart)) s.perIp.delete(key);
  }
  return { ok: true };
}
