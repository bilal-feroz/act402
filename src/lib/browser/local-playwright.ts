import fs from "node:fs";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { getConfig } from "../config";
import { Act402Error } from "../errors";
import { log } from "../logger";
import { startEgressProxy, type EgressProxy } from "../security/egress-proxy";
import type { UrlPolicy } from "../security/url-guard";
import type { BrowserProvider, BrowserSession, ProviderStatus, SessionOptions } from "./provider";

interface Executable {
  /** Undefined means "let Playwright use its own managed Chromium". */
  path?: string;
  source: "CHROMIUM_PATH" | "system" | "playwright";
}

const LAUNCH_ARGS = [
  "--disable-dev-shm-usage",
  "--disable-background-networking",
  "--disable-component-update",
  "--disable-default-apps",
  "--disable-extensions",
  "--disable-sync",
  "--disable-breakpad",
  "--metrics-recording-only",
  "--no-first-run",
  "--no-default-browser-check",
  "--mute-audio",
  "--disable-features=Translate,MediaRouter,OptimizationHints,AutofillServerCommunication,CalculateNativeWinOcclusion",
  // Keep WebRTC from opening UDP sockets that bypass the egress proxy.
  "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
  "--webrtc-ip-handling-policy=disable_non_proxied_udp",
  "--js-flags=--max-old-space-size=512",
];

export function findChromium(): Executable | null {
  const configured = getConfig().chromiumPath;
  if (configured) return fs.existsSync(configured) ? { path: configured, source: "CHROMIUM_PATH" } : null;
  if (process.platform !== "win32") {
    const names = ["chromium", "chromium-browser", "google-chrome-stable", "google-chrome"];
    for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
      if (!dir) continue;
      for (const name of names) {
        const candidate = path.join(dir, name);
        if (fs.existsSync(candidate)) return { path: candidate, source: "system" };
      }
    }
  }
  try {
    const managed = chromium.executablePath();
    if (managed && fs.existsSync(managed)) return { source: "playwright" };
  } catch {
    // Playwright browsers not installed
  }
  return null;
}

function userAgentFor(version: string): string {
  const major = version.split(".")[0] || "140";
  const platform =
    process.platform === "win32" ? "Windows NT 10.0; Win64; x64" : process.platform === "darwin" ? "Macintosh; Intel Mac OS X 10_15_7" : "X11; Linux x86_64";
  return process.env.BROWSER_USER_AGENT?.trim() || `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

/**
 * One shared headless Chromium process; every task gets its own BrowserContext
 * (fresh cookies, storage and cache) that is closed when the task ends.
 */
export class LocalPlaywrightProvider implements BrowserProvider {
  readonly name = "local-playwright";
  private browser?: Browser;
  private launching?: Promise<Browser>;
  private proxy?: EgressProxy;
  private proxyStarting?: Promise<EgressProxy>;
  private executable: Executable | null | undefined;
  private tasksSinceLaunch = 0;
  private readonly sessions = new Map<string, BrowserSession>();
  private lastError?: string;

  constructor(private readonly policy: UrlPolicy = {}) {}

  isConfigured(): boolean {
    if (this.executable === undefined) this.executable = findChromium();
    return this.executable !== null;
  }

  status(): ProviderStatus {
    return {
      name: this.name,
      configured: this.isConfigured(),
      ready: Boolean(this.browser?.isConnected()),
      activeSessions: this.sessions.size,
      browserVersion: this.browser?.isConnected() ? this.browser.version() : undefined,
      detail: this.lastError,
    };
  }

  private async getProxy(): Promise<EgressProxy> {
    if (this.proxy) return this.proxy;
    this.proxyStarting ??= startEgressProxy(this.policy, (blocked) => log("egress_blocked", { ...blocked }, "warn"));
    this.proxy = await this.proxyStarting;
    return this.proxy;
  }

  private async launch(): Promise<Browser> {
    if (!this.isConfigured()) {
      throw new Act402Error(
        "BROWSER_PROVIDER_NOT_CONFIGURED",
        "No Chromium executable found. Install one (`npx playwright-core install chromium`, or add `chromium` via Nix on Replit) or set CHROMIUM_PATH.",
      );
    }
    const proxy = await this.getProxy();
    const config = getConfig();
    const started = Date.now();
    try {
      const browser = await chromium.launch({
        headless: true,
        executablePath: this.executable?.path,
        chromiumSandbox: config.chromiumSandbox,
        proxy: { server: proxy.url },
        args: LAUNCH_ARGS,
        timeout: 30_000,
      });
      browser.on("disconnected", () => {
        if (this.browser === browser) this.browser = undefined;
        log("browser_disconnected", {}, "warn");
      });
      this.tasksSinceLaunch = 0;
      this.lastError = undefined;
      log("browser_launched", { version: browser.version(), source: this.executable?.source, duration_ms: Date.now() - started });
      return browser;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message.split("\n")[0] : String(err);
      log("browser_launch_failed", { error: this.lastError }, "error");
      throw new Act402Error("BROWSER_PROVIDER_ERROR", "Chromium failed to start on this server.");
    }
  }

  private async getBrowser(): Promise<Browser> {
    const current = this.browser;
    if (current?.isConnected()) {
      const recycle = this.tasksSinceLaunch >= getConfig().browserRecycleAfter && this.sessions.size === 0;
      if (!recycle) return current;
      this.browser = undefined;
      await current.close().catch(() => undefined);
      log("browser_recycled", {});
    }
    this.launching ??= this.launch()
      .then((b) => {
        this.browser = b;
        return b;
      })
      .finally(() => {
        this.launching = undefined;
      });
    return this.launching;
  }

  async createSession(options: SessionOptions): Promise<BrowserSession> {
    let browser = await this.getBrowser();
    let context;
    try {
      context = await browser.newContext({
        viewport: options.viewport,
        deviceScaleFactor: 1,
        locale: "en-US",
        timezoneId: "UTC",
        userAgent: userAgentFor(browser.version()),
        acceptDownloads: true,
        serviceWorkers: "block",
        permissions: [],
        ignoreHTTPSErrors: false,
      });
    } catch {
      // The shared browser may have died between tasks; relaunch once.
      this.browser = undefined;
      browser = await this.getBrowser();
      context = await browser.newContext({ viewport: options.viewport, userAgent: userAgentFor(browser.version()), acceptDownloads: true, serviceWorkers: "block" });
    }
    context.setDefaultTimeout(15_000);
    context.setDefaultNavigationTimeout(30_000);

    const page = await context.newPage();
    const session: BrowserSession = {
      id: options.taskId,
      provider: this.name,
      context,
      page,
      dialogs: [],
      allowDownloads: false,
      createdAt: Date.now(),
    };
    const watchPage = (p: Page) => {
      p.on("dialog", (dialog) => {
        session.dialogs.push(`${dialog.type()}: ${dialog.message().slice(0, 300)}`);
        dialog.dismiss().catch(() => undefined);
      });
      p.on("download", (download) => {
        if (!session.allowDownloads) download.cancel().catch(() => undefined);
      });
      p.on("close", () => {
        if (session.page !== p) return;
        const open = context.pages().filter((x) => !x.isClosed());
        if (open.length > 0) session.page = open[open.length - 1];
      });
    };
    watchPage(page);
    context.on("page", (p) => {
      watchPage(p);
      session.page = p; // follow links that open a new tab
    });
    this.sessions.set(session.id, session);
    return session;
  }

  async closeSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    this.tasksSinceLaunch++;
    await Promise.race([session.context.close().catch(() => undefined), new Promise((r) => setTimeout(r, 5000))]);
  }

  async shutdown(): Promise<void> {
    for (const id of [...this.sessions.keys()]) await this.closeSession(id);
    await this.browser?.close().catch(() => undefined);
    this.browser = undefined;
    await this.proxy?.close().catch(() => undefined);
    this.proxy = undefined;
    this.proxyStarting = undefined;
  }
}
