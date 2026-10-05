import path from "node:path";

export const SERVICE_NAME = "Act402";
export const SERVICE_VERSION = "1.0.0";
export const CAPABILITY = "browser.execute";
export const PRICE_USDC = "0.50";

function intEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function boolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

export interface Act402Config {
  /** Concurrent browser contexts (one shared Chromium process). */
  maxBrowserSessions: number;
  /** Requests allowed to wait for a free browser slot. */
  maxQueueLength: number;
  /** Hard ceiling for one task, including queue time. */
  maxTaskDurationMs: number;
  maxActions: number;
  maxScreenshots: number;
  maxDownloads: number;
  maxDownloadBytes: number;
  /** Goal mode: maximum navigation hops the heuristic planner may take. */
  maxGoalSteps: number;
  evidenceTtlMs: number;
  taskRetentionDays: number;
  dataDir: string;
  /** Shared secret the x402 gateway injects; when set, POST /act requires it. */
  gatewaySecret: string;
  /** Public origin used to build absolute evidence URLs. */
  publicBaseUrl: string;
  /** Public x402 URL agents pay through (shown in docs/dashboard). */
  gatewayUrl: string;
  chromiumPath: string;
  chromiumSandbox: boolean;
  /** Recycle the Chromium process after this many tasks (memory hygiene). */
  browserRecycleAfter: number;
  demo: {
    enabled: boolean;
    perIpPerHour: number;
    dailyLimit: number;
    maxActions: number;
    maxDurationMs: number;
    concurrent: number;
  };
}

let cached: Act402Config | undefined;

export function getConfig(): Act402Config {
  if (cached) return cached;
  cached = {
    maxBrowserSessions: intEnv("MAX_BROWSER_SESSIONS", 2, 1, 8),
    maxQueueLength: intEnv("MAX_QUEUE_LENGTH", 6, 0, 50),
    maxTaskDurationMs: intEnv("MAX_TASK_DURATION_SECONDS", 60, 10, 300) * 1000,
    maxActions: intEnv("MAX_ACTIONS", 20, 1, 100),
    maxScreenshots: intEnv("MAX_SCREENSHOTS", 3, 0, 10),
    maxDownloads: intEnv("MAX_DOWNLOADS", 3, 0, 10),
    maxDownloadBytes: intEnv("MAX_DOWNLOAD_SIZE_MB", 15, 1, 100) * 1024 * 1024,
    maxGoalSteps: intEnv("MAX_GOAL_STEPS", 4, 1, 10),
    evidenceTtlMs: intEnv("EVIDENCE_TTL_HOURS", 24, 1, 720) * 3600_000,
    taskRetentionDays: intEnv("TASK_RETENTION_DAYS", 30, 1, 365),
    dataDir: process.env.DATA_DIR?.trim() || path.join(process.cwd(), ".data"),
    gatewaySecret: process.env.ACT402_GATEWAY_SECRET?.trim() || "",
    publicBaseUrl: (process.env.APP_BASE_URL?.trim() || "").replace(/\/+$/, ""),
    gatewayUrl: (process.env.XDC_GATEWAY_URL?.trim() || "").replace(/\/+$/, ""),
    chromiumPath: process.env.CHROMIUM_PATH?.trim() || "",
    chromiumSandbox: boolEnv("CHROMIUM_SANDBOX", false),
    browserRecycleAfter: intEnv("BROWSER_RECYCLE_AFTER_TASKS", 100, 5, 10_000),
    demo: {
      enabled: boolEnv("DEMO_ENABLED", true),
      perIpPerHour: intEnv("DEMO_RUNS_PER_IP_PER_HOUR", 10, 1, 1000),
      dailyLimit: intEnv("DEMO_DAILY_LIMIT", 300, 1, 100_000),
      maxActions: intEnv("DEMO_MAX_ACTIONS", 12, 1, 100),
      maxDurationMs: intEnv("DEMO_MAX_DURATION_SECONDS", 45, 10, 300) * 1000,
      concurrent: intEnv("DEMO_CONCURRENT_SESSIONS", 1, 1, 8),
    },
  };
  return cached;
}

/** Test hook: drop the cached config so env changes take effect. */
export function resetConfigForTests(): void {
  cached = undefined;
}
