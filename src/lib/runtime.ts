import { getConfig } from "./config";
import { log } from "./logger";
import { LocalPlaywrightProvider } from "./browser/local-playwright";
import { Semaphore } from "./browser/limiter";
import type { BrowserProvider } from "./browser/provider";
import { cleanupEvidence } from "./storage/evidence";

/**
 * Process-wide singletons. Next.js bundles each route separately, so shared
 * state lives on globalThis to guarantee one Chromium and one slot pool.
 */
interface Runtime {
  provider: BrowserProvider;
  /** Every task (API or demo) holds one of these while its browser context is open. */
  browserSlots: Semaphore;
  /** Demo runs additionally hold one of these, so the public demo can never take every slot. */
  demoSlots: Semaphore;
  startedAt: number;
  cleanupTimer?: ReturnType<typeof setInterval>;
}

const g = globalThis as unknown as { __act402Runtime?: Runtime };

export function getRuntime(): Runtime {
  if (g.__act402Runtime) return g.__act402Runtime;
  const config = getConfig();
  const runtime: Runtime = {
    provider: new LocalPlaywrightProvider(),
    browserSlots: new Semaphore(config.maxBrowserSessions, config.maxQueueLength),
    demoSlots: new Semaphore(Math.min(config.demo.concurrent, config.maxBrowserSessions), 2),
    startedAt: Date.now(),
  };
  runtime.cleanupTimer = setInterval(() => {
    cleanupEvidence().catch((err) => log("evidence_cleanup_failed", { error: String(err) }, "warn"));
  }, 15 * 60_000);
  runtime.cleanupTimer.unref?.();
  cleanupEvidence().catch(() => undefined);

  const shutdown = () => {
    runtime.provider.shutdown().catch(() => undefined);
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);

  g.__act402Runtime = runtime;
  return runtime;
}
