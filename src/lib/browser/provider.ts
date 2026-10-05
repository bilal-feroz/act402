import type { BrowserContext, Page } from "playwright-core";

export interface SessionOptions {
  taskId: string;
  viewport: { width: number; height: number };
}

/** One isolated browser session (cookies, storage and cache are never shared between tasks). */
export interface BrowserSession {
  id: string;
  provider: string;
  context: BrowserContext;
  /** The page actions run on; switches automatically when a click opens a new tab. */
  page: Page;
  /** Messages from alert/confirm/prompt dialogs, which are dismissed automatically. */
  dialogs: string[];
  /**
   * Browser-initiated downloads are cancelled unless a download action is
   * running — a page can never fill the disk on its own.
   */
  allowDownloads: boolean;
  liveViewUrl?: string;
  createdAt: number;
}

export interface ProviderStatus {
  name: string;
  configured: boolean;
  ready: boolean;
  activeSessions: number;
  browserVersion?: string;
  detail?: string;
}

/**
 * Where browsers come from. The hackathon build runs Chromium locally
 * (LocalPlaywrightProvider); a managed provider such as Browserbase can be
 * added later by implementing this interface.
 */
export interface BrowserProvider {
  readonly name: string;
  isConfigured(): boolean;
  createSession(options: SessionOptions): Promise<BrowserSession>;
  closeSession(sessionId: string): Promise<void>;
  status(): ProviderStatus;
  shutdown(): Promise<void>;
}
