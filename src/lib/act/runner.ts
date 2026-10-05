import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Locator, Page, Response as PwResponse } from "playwright-core";
import { getConfig } from "../config";
import { Act402Error, firstLine, type ErrorCode } from "../errors";
import type { BrowserSession } from "../browser/provider";
import { inspectElement, primaryLocator, resolveTarget, type ElementInfo } from "../browser/targets";
import { detectBotWall, dismissCookieBanner, looksLikeFileLink, pageLinks, pageText, settle, type LinkInfo } from "../browser/page-helpers";
import { checkClickName, checkFieldForTyping, checkTypedValue } from "../security/action-policy";
import { checkUrl, type UrlPolicy } from "../security/url-guard";
import { evidencePublicPath, mimeForFilename, writeEvidence } from "../storage/evidence";
import { hostnameOf, normalizeText, preview, sanitizeFilename, truncate } from "../util";
import { chooseFilename, safeDownload } from "./download";
import { describeTarget, type Action, type ActionOf, type Target, type WaitUntil } from "./schema";
import type { EvidenceRecord, ExtractRecord, StepRecord, TaskEvent } from "./types";

export interface RunnerOptions {
  taskId: string;
  session: BrowserSession;
  /** Epoch ms when the task must be finished. */
  deadline: number;
  /** Epoch ms when the task was accepted (for event timestamps). */
  startedAt: number;
  /** Origin for absolute evidence URLs ("" for relative paths). */
  baseUrl: string;
  policy: UrlPolicy;
  /** Demo only: capture a small JPEG after each step for the live view. */
  captureFrames: boolean;
  emit?: (event: TaskEvent) => void;
  viewport: { width: number; height: number };
}

export interface CollectedResult {
  final_url: string;
  title: string;
  text: string;
  text_source: "extract" | "page";
  text_truncated: boolean;
  links?: LinkInfo[];
  download_links?: LinkInfo[];
  page_text?: string;
}

// Failures an `optional: true` action may NOT swallow.
const FATAL: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  "TIMEOUT",
  "BROWSER_PROVIDER_ERROR",
  "ACTION_REQUIRES_AUTHORIZATION",
  "SENSITIVE_INPUT_REJECTED",
  "POLICY_VIOLATION",
  "BLOCKED_URL",
  "SITE_BLOCKED_AUTOMATION",
  "INVALID_REQUEST",
]);

const EXTRACT_BUDGET_CHARS = 200_000;
const MAX_FRAMES = 40;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(2)} MB`;
}

function netError(message: string): string {
  const code = /net::(ERR_[A-Z_]+)/.exec(message)?.[1];
  switch (code) {
    case "ERR_NAME_NOT_RESOLVED":
      return "DNS lookup failed";
    case "ERR_CONNECTION_REFUSED":
      return "connection refused";
    case "ERR_CONNECTION_RESET":
      return "connection reset";
    case "ERR_CONNECTION_TIMED_OUT":
    case "ERR_TIMED_OUT":
      return "connection timed out";
    case "ERR_INTERNET_DISCONNECTED":
      return "no network";
    case "ERR_TOO_MANY_REDIRECTS":
      return "too many redirects";
    case undefined:
      return firstLine(message);
    default:
      return code.startsWith("ERR_CERT") || code.startsWith("ERR_SSL") ? `TLS error (${code})` : code;
  }
}

function elementLabel(info: ElementInfo | null, target: Target): string {
  if (!info) return describeTarget(target);
  const kind = info.role || (info.tag === "a" ? "link" : info.tag);
  const name = info.text || info.label || info.placeholder || info.name;
  return name ? `${kind} "${preview(name, 60)}"` : kind;
}

/** Executes actions against one browser session and records steps, extracts and evidence. */
export class TaskRunner {
  readonly steps: StepRecord[] = [];
  readonly extracts: ExtractRecord[] = [];
  readonly evidence: EvidenceRecord[] = [];
  readonly warnings: string[] = [];
  readonly domains = new Set<string>();
  screenshotsTaken = 0;
  downloadsTaken = 0;
  navigationMs = 0;
  private frameCount = 0;
  private extractedChars = 0;
  private lastFailedNavigation?: { url: string; error: string };
  private blockedNavigation?: string;

  constructor(private readonly o: RunnerOptions) {
    o.session.context.on("requestfailed", (request) => {
      if (request.isNavigationRequest()) this.lastFailedNavigation = { url: request.url(), error: request.failure()?.errorText ?? "" };
    });
    // Plain-HTTP destinations refused by the egress proxy come back as a 403 page carrying this header.
    o.session.context.on("response", (response) => {
      if (response.headers()["x-act402-blocked"] && response.request().isNavigationRequest() && response.frame().parentFrame() === null) {
        this.blockedNavigation = response.url();
      }
    });
  }

  /** Read-and-clear the blocked navigation flag (set from an event listener). */
  private takeBlockedNavigation(): string | undefined {
    const url = this.blockedNavigation;
    this.blockedNavigation = undefined;
    return url;
  }

  get page(): Page {
    return this.o.session.page;
  }

  /** Set by the context's requestfailed listener, possibly during an await. */
  private failedNavigation(): { url: string; error: string } | undefined {
    return this.lastFailedNavigation;
  }

  remaining(): number {
    return this.o.deadline - Date.now();
  }

  /** Per-operation timeout that never outlives the task deadline. */
  timeout(requested: number | undefined, fallback: number): number {
    const left = this.remaining() - 300;
    if (left <= 0) throw new Act402Error("TIMEOUT", "The task ran out of time.");
    return Math.max(100, Math.min(requested ?? fallback, left));
  }

  private at(): number {
    return Date.now() - this.o.startedAt;
  }

  private absolute(publicPath: string): string {
    return this.o.baseUrl ? `${this.o.baseUrl}${publicPath}` : publicPath;
  }

  private trackDomain(): void {
    const url = this.page.url();
    if (/^https?:/i.test(url)) this.domains.add(hostnameOf(url));
  }

  log(message: string, level: "info" | "warn" = "info"): void {
    this.o.emit?.({ type: "log", at_ms: this.at(), level, message });
  }

  private async emitStep(step: StepRecord): Promise<void> {
    let frameUrl: string | undefined;
    if (this.o.captureFrames && this.frameCount < MAX_FRAMES && this.remaining() > 2000 && !this.page.isClosed()) {
      try {
        const buffer = await this.page.screenshot({ type: "jpeg", quality: 50, timeout: 3000 });
        this.frameCount++;
        const { filename } = await writeEvidence(this.o.taskId, `frame-${String(this.frameCount).padStart(2, "0")}.jpg`, buffer);
        frameUrl = evidencePublicPath(this.o.taskId, filename);
      } catch {
        // frames are best-effort
      }
    }
    this.o.emit?.({ type: "step", at_ms: this.at(), step, frame_url: frameUrl });
  }

  private mapError(err: unknown): Act402Error {
    if (err instanceof Act402Error) return err;
    const message = err instanceof Error ? err.message : String(err);
    if (this.remaining() <= 300) return new Act402Error("TIMEOUT", "The task ran out of time.");
    if (/Target page, context or browser has been closed|Browser has been closed|Target closed|browser has disconnected/i.test(message)) {
      return new Act402Error("BROWSER_PROVIDER_ERROR", "The browser session closed unexpectedly.");
    }
    if (/intercepts pointer events/i.test(message)) {
      return new Act402Error("ACTION_FAILED", 'Another element (often a modal or cookie banner) covers the target. Dismiss it first, or set "force": true.');
    }
    if (/element is not enabled|element is disabled/i.test(message)) return new Act402Error("ACTION_FAILED", "The element is disabled.");
    if (/not a <select>|Element is not a <select> element/i.test(message)) {
      return new Act402Error("ACTION_FAILED", "The target is not a <select>. For custom dropdowns, click the dropdown and then click the option.");
    }
    if (/Element is not an <input>|not editable|Cannot type text into input/i.test(message)) return new Act402Error("ACTION_FAILED", "The target is not an editable field.");
    if (/did not find some options/i.test(message)) return new Act402Error("ACTION_FAILED", "No option matched the requested value, label, or index.");
    if (/Not a checkbox or radio button/i.test(message)) return new Act402Error("ACTION_FAILED", "The target is not a checkbox or radio button.");
    if (/element is not visible|element is not stable|outside of the viewport/i.test(message)) {
      return new Act402Error("ACTION_FAILED", "The element is not visible or keeps moving. Scroll to it or wait for the page to settle first.");
    }
    if (/detached/i.test(message)) return new Act402Error("ACTION_FAILED", "The element was removed from the page during the action.");
    if (/Timeout \d+ms exceeded/i.test(message)) return new Act402Error("ACTION_FAILED", "The action did not complete within its timeout.");
    return new Act402Error("ACTION_FAILED", firstLine(message));
  }

  /** Load a URL in the current page with SSRF checks, redirect validation and bot-wall detection. */
  async navigate(rawUrl: string, waitUntil: WaitUntil): Promise<string> {
    const started = Date.now();
    const check = await checkUrl(rawUrl, this.o.policy);
    if (!check.ok) throw new Act402Error(check.code, check.reason, { url: rawUrl });
    const page = this.page;
    this.lastFailedNavigation = undefined;
    let response: PwResponse | null = null;
    try {
      // Phase 1 (hard limit): the document arrives and its DOM is parsed.
      response = await page.goto(check.url.href, { waitUntil: waitUntil === "commit" ? "commit" : "domcontentloaded", timeout: this.timeout(undefined, 30_000) });
      // Phase 2 (best effort): one hung third-party resource must not fail the task.
      if (waitUntil === "load" || waitUntil === "networkidle") {
        const budget = Math.min(waitUntil === "load" ? 10_000 : 15_000, this.remaining() - 3000);
        if (budget > 0) {
          const reached = await page.waitForLoadState(waitUntil, { timeout: budget }).then(
            () => true,
            () => false,
          );
          if (!reached) this.warnings.push(`${check.url.hostname} did not reach "${waitUntil}" within ${Math.round(budget / 1000)} s; continued with the rendered page.`);
          else if (waitUntil === "load") await page.waitForLoadState("networkidle", { timeout: Math.min(1500, Math.max(1, this.remaining() - 3000)) }).catch(() => undefined);
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/Download is starting/i.test(message)) {
        // The URL is a file rather than a page — fetch it as a download.
        this.navigationMs += Date.now() - started;
        const detail = await this.downloadUrl(check.url.href);
        return `URL is a file; ${detail}`;
      }
      const failed = this.failedNavigation();
      if (failed && failed.url !== check.url.href) {
        const redirect = await checkUrl(failed.url, this.o.policy);
        if (!redirect.ok && redirect.code === "BLOCKED_URL") {
          throw new Act402Error("BLOCKED_URL", `A redirect to ${hostnameOf(failed.url) || failed.url} was blocked: ${redirect.reason}`);
        }
      }
      if (/ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY_CONNECTION_FAILED/.test(message)) {
        throw new Act402Error("BLOCKED_URL", `The connection to ${check.url.hostname} was refused by Act402's egress policy.`);
      }
      if (/Timeout \d+ms exceeded/i.test(message)) {
        if (this.remaining() < 1000) throw new Act402Error("TIMEOUT", "The task ran out of time while the page was loading.");
        if (page.url() === "about:blank") throw new Act402Error("NAVIGATION_FAILED", `${check.url.hostname} did not load in time.`);
        this.warnings.push(`The page did not reach "${waitUntil}" in time; continued with what had rendered.`);
      } else {
        throw new Act402Error("NAVIGATION_FAILED", `Could not load ${check.url.hostname}: ${netError(message)}.`);
      }
    } finally {
      this.navigationMs += Date.now() - started;
    }

    if (response?.headers()["x-act402-blocked"]) {
      throw new Act402Error("BLOCKED_URL", "The page redirected to a destination blocked by Act402's egress policy.");
    }
    const status = response?.status();
    const wall = await detectBotWall(page, status);
    if (wall) {
      throw new Act402Error("SITE_BLOCKED_AUTOMATION", `${hostnameOf(page.url())} presented an anti-bot or CAPTCHA challenge (${wall}). Act402 does not bypass bot protection.`, {
        final_url: page.url(),
      });
    }
    if (status !== undefined && status >= 400) {
      throw new Act402Error("NAVIGATION_FAILED", `${check.url.hostname} answered HTTP ${status}.`, { http_status: status, final_url: page.url() });
    }
    this.trackDomain();
    return `opened ${preview(page.url(), 100)}${status ? ` (HTTP ${status})` : ""}`;
  }

  /** Initial navigation plus optional cookie-banner dismissal, recorded as steps with index -1. */
  async open(url: string, waitUntil: WaitUntil, dismissBanners: boolean): Promise<void> {
    const started = Date.now();
    try {
      const detail = await this.navigate(url, waitUntil);
      const step: StepRecord = { index: -1, type: "open", status: "ok", duration_ms: Date.now() - started, detail, url: this.page.url() };
      this.steps.push(step);
      await this.emitStep(step);
    } catch (err) {
      const e = this.mapError(err);
      const step: StepRecord = { index: -1, type: "open", status: "failed", duration_ms: Date.now() - started, detail: preview(url, 100), error: { code: e.code, message: e.message } };
      this.steps.push(step);
      await this.emitStep(step);
      throw e;
    }
    if (dismissBanners && this.remaining() > 3000) {
      const bannerStarted = Date.now();
      const dismissed = await dismissCookieBanner(this.page);
      if (dismissed) {
        const step: StepRecord = { index: -1, type: "dismiss_cookie_banner", status: "ok", duration_ms: Date.now() - bannerStarted, detail: `cookie banner: ${dismissed}`, url: this.page.url() };
        this.steps.push(step);
        await this.emitStep(step);
      }
    }
  }

  /** Run one caller action; optional actions record a failure and continue. */
  async run(action: Action, index: number): Promise<void> {
    const started = Date.now();
    const urlBefore = this.page.url();
    try {
      const detail = await this.execute(action, index);
      const blocked = this.takeBlockedNavigation();
      if (blocked) throw new Act402Error("BLOCKED_URL", `Navigation to ${hostnameOf(blocked) || blocked} was blocked by Act402's egress policy.`);
      this.trackDomain();
      if (this.page.url().startsWith("chrome-error://")) {
        const failed = this.failedNavigation();
        if (failed) {
          const check = await checkUrl(failed.url, this.o.policy);
          if (!check.ok && check.code === "BLOCKED_URL") throw new Act402Error("BLOCKED_URL", `Navigation to ${hostnameOf(failed.url)} was blocked: ${check.reason}`);
          throw new Act402Error("NAVIGATION_FAILED", `The page failed to load: ${netError(failed.error)}.`);
        }
        throw new Act402Error("NAVIGATION_FAILED", "The page failed to load.");
      }
      if (this.page.url() !== urlBefore) {
        const wall = await detectBotWall(this.page);
        if (wall) {
          throw new Act402Error("SITE_BLOCKED_AUTOMATION", `${hostnameOf(this.page.url())} presented an anti-bot or CAPTCHA challenge (${wall}). Act402 does not bypass bot protection.`, {
            final_url: this.page.url(),
          });
        }
      }
      const step: StepRecord = { index, id: action.id, type: action.type, status: "ok", duration_ms: Date.now() - started, detail, url: this.page.url() };
      this.steps.push(step);
      await this.emitStep(step);
    } catch (err) {
      let e = this.mapError(err);
      // A failure in the last second was caused by the task deadline cutting the action short.
      if (this.remaining() < 1000 && !FATAL.has(e.code)) e = new Act402Error("TIMEOUT", `The task ran out of time during this action (${e.message})`);
      const step: StepRecord = {
        index,
        id: action.id,
        type: action.type,
        status: "failed",
        duration_ms: Date.now() - started,
        url: this.page.isClosed() ? undefined : this.page.url(),
        error: { code: e.code, message: e.message },
      };
      this.steps.push(step);
      await this.emitStep(step).catch(() => undefined);
      if (action.optional && !FATAL.has(e.code)) {
        this.warnings.push(`actions[${index}] (${action.type}) failed and was skipped because it is optional: ${e.message}`);
        return;
      }
      throw new Act402Error(e.code, `actions[${index}] (${action.type}): ${e.message}`, { ...e.details, action_index: index, action_type: action.type });
    }
  }

  private async execute(action: Action, index: number): Promise<string> {
    switch (action.type) {
      case "navigate": {
        let target: string;
        try {
          target = new URL(action.url, this.page.url()).href;
        } catch {
          throw new Act402Error("INVALID_URL", `"${preview(action.url, 80)}" is not a valid URL.`);
        }
        return this.navigate(target, action.wait_until ?? "load");
      }
      case "click":
        return this.click(action);
      case "type":
        return this.type(action);
      case "select":
        return this.select(action);
      case "check":
      case "uncheck": {
        const r = await resolveTarget(this.page, action.target, { timeoutMs: this.timeout(action.timeout_ms, 10_000), field: true });
        const info = await inspectElement(r.locator, 3000).catch(() => null);
        if (action.type === "check") await r.locator.check({ timeout: this.timeout(action.timeout_ms, 10_000) });
        else await r.locator.uncheck({ timeout: this.timeout(action.timeout_ms, 10_000) });
        await settle(this.page, this.timeout(undefined, 5_000));
        return `${action.type === "check" ? "checked" : "unchecked"} ${elementLabel(info, action.target)}`;
      }
      case "hover": {
        const r = await resolveTarget(this.page, action.target, { timeoutMs: this.timeout(action.timeout_ms, 10_000), interactive: true });
        const info = await inspectElement(r.locator, 3000).catch(() => null);
        await r.locator.hover({ timeout: this.timeout(action.timeout_ms, 10_000) });
        await this.page.waitForTimeout(Math.min(400, this.timeout(undefined, 400)));
        return `hovered ${elementLabel(info, action.target)}`;
      }
      case "press": {
        const key = action.key === "Space" ? " " : action.key;
        if (action.target) {
          const r = await resolveTarget(this.page, action.target, { timeoutMs: this.timeout(action.timeout_ms, 10_000) });
          await r.locator.press(key, { timeout: this.timeout(action.timeout_ms, 10_000) });
        } else {
          await this.page.keyboard.press(key);
        }
        if (action.key === "Enter") await settle(this.page, this.timeout(undefined, 10_000));
        else await this.page.waitForTimeout(150);
        return `pressed ${action.key}${action.target ? ` on ${describeTarget(action.target)}` : ""}`;
      }
      case "scroll":
        return this.scroll(action);
      case "wait":
        return this.wait(action);
      case "extract":
        return this.extract(action, index);
      case "screenshot":
        return this.screenshot(action);
      case "download":
        return this.download(action);
      case "back": {
        const before = this.page.url();
        const res = await this.page.goBack({ waitUntil: "domcontentloaded", timeout: this.timeout(action.timeout_ms, 15_000) });
        if (!res && this.page.url() === before) throw new Act402Error("ACTION_FAILED", "There is no previous page in this session.");
        await settle(this.page, this.timeout(undefined, 5_000));
        return `went back to ${preview(this.page.url(), 100)}`;
      }
    }
  }

  private assertClickAllowed(info: ElementInfo): void {
    if (info.tag === "input" && info.type === "file") {
      throw new Act402Error("SENSITIVE_INPUT_REJECTED", "File inputs are not allowed; Act402 never uploads files.");
    }
    for (const name of [info.text, info.label]) {
      const verdict = checkClickName(name);
      if (!verdict.allowed) throw new Act402Error(verdict.code, verdict.reason);
    }
  }

  private async click(action: ActionOf<"click">): Promise<string> {
    const r = await resolveTarget(this.page, action.target, { timeoutMs: this.timeout(action.timeout_ms, 10_000), interactive: true });
    const info = await inspectElement(r.locator, 3000).catch(() => null);
    if (info) this.assertClickAllowed(info);
    await r.locator.click({ timeout: this.timeout(action.timeout_ms, 10_000), force: action.force, clickCount: action.double ? 2 : 1 });
    await settle(this.page, this.timeout(undefined, 10_000));
    return `${action.double ? "double-clicked" : "clicked"} ${elementLabel(info, action.target)}${r.frameUrl ? " (in iframe)" : ""}`;
  }

  private async type(action: ActionOf<"type">): Promise<string> {
    const valueVerdict = checkTypedValue(action.value);
    if (!valueVerdict.allowed) throw new Act402Error(valueVerdict.code, valueVerdict.reason);
    const r = await resolveTarget(this.page, action.target, { timeoutMs: this.timeout(action.timeout_ms, 10_000), field: true });
    const info = await inspectElement(r.locator, 3000);
    const fieldVerdict = checkFieldForTyping({ ...info });
    if (!fieldVerdict.allowed) throw new Act402Error(fieldVerdict.code, fieldVerdict.reason);
    if (info.tag === "select") throw new Act402Error("ACTION_FAILED", 'The target is a <select>; use a "select" action instead.');
    if (!info.editable) throw new Act402Error("ACTION_FAILED", `The target ${elementLabel(info, action.target)} is not an editable field.`);
    const t = this.timeout(action.timeout_ms, 10_000);
    if (action.delay_ms || action.clear === false) {
      if (action.clear !== false) await r.locator.fill("", { timeout: t });
      await r.locator.pressSequentially(action.value, { delay: action.delay_ms ?? 0, timeout: t });
    } else {
      await r.locator.fill(action.value, { timeout: t });
    }
    if (action.submit) {
      await r.locator.press("Enter", { timeout: this.timeout(action.timeout_ms, 10_000) });
      await settle(this.page, this.timeout(undefined, 10_000));
    }
    return `typed "${preview(action.value, 40)}" into ${elementLabel(info, action.target)}${action.submit ? " and pressed Enter" : ""}`;
  }

  private async select(action: ActionOf<"select">): Promise<string> {
    const r = await resolveTarget(this.page, action.target, { timeoutMs: this.timeout(action.timeout_ms, 10_000), field: true });
    const info = await inspectElement(r.locator, 3000);
    if (info.tag !== "select") {
      throw new Act402Error("ACTION_FAILED", `The target is a <${info.tag}>, not a <select>. For custom dropdowns, click the dropdown and then click the option.`);
    }
    const option = action.label !== undefined ? { label: action.label } : action.index !== undefined ? { index: action.index } : action.value!;
    const selected = await r.locator.selectOption(option, { timeout: this.timeout(action.timeout_ms, 10_000) });
    await settle(this.page, this.timeout(undefined, 8_000));
    return `selected ${selected.map((s) => `"${preview(s, 40)}"`).join(", ")} in ${elementLabel(info, action.target)}`;
  }

  private async scroll(action: ActionOf<"scroll">): Promise<string> {
    if (action.target) {
      const r = await resolveTarget(this.page, action.target, { timeoutMs: this.timeout(action.timeout_ms, 10_000), visible: false });
      await r.locator.scrollIntoViewIfNeeded({ timeout: this.timeout(action.timeout_ms, 10_000) });
      await this.page.waitForTimeout(300);
      return `scrolled to ${describeTarget(action.target)}`;
    }
    const amount = action.amount ?? Math.round(this.o.viewport.height * 0.85);
    const pos = await this.page.evaluate(
      ([direction, px]) => {
        if (direction === "top") window.scrollTo(0, 0);
        else if (direction === "bottom") window.scrollTo(0, document.documentElement.scrollHeight);
        else window.scrollBy(0, direction === "up" ? -px : px);
        return { y: Math.round(window.scrollY), height: document.documentElement.scrollHeight };
      },
      [action.direction ?? "down", amount] as const,
    );
    await this.page.waitForTimeout(400);
    await this.page.waitForLoadState("networkidle", { timeout: Math.min(1500, this.timeout(undefined, 1500)) }).catch(() => undefined);
    return `scrolled ${action.direction} to y=${pos.y} of ${pos.height}px`;
  }

  private async wait(action: ActionOf<"wait">): Promise<string> {
    const t = this.timeout(action.timeout_ms, 15_000);
    if (action.milliseconds !== undefined) {
      if (action.milliseconds > this.remaining() - 500) {
        throw new Act402Error("TIMEOUT", `Waiting ${action.milliseconds} ms would exceed the task's remaining time (${Math.max(0, this.remaining())} ms).`);
      }
      await this.page.waitForTimeout(action.milliseconds);
      return `waited ${action.milliseconds} ms`;
    }
    if (action.target) {
      const state = action.state ?? "visible";
      if (state === "visible" || state === "attached") {
        await resolveTarget(this.page, action.target, { timeoutMs: t, visible: state === "visible" });
      } else {
        await primaryLocator(this.page, action.target)
          .waitFor({ state, timeout: t })
          .catch(() => {
            throw new Act402Error("ACTION_FAILED", `${describeTarget(action.target)} did not become ${state} within ${t} ms.`);
          });
      }
      return `${describeTarget(action.target)} is ${state}`;
    }
    if (action.text) {
      await resolveTarget(this.page, { text: action.text }, { timeoutMs: t });
      return `text "${preview(action.text, 60)}" appeared`;
    }
    if (action.url_contains) {
      const needle = action.url_contains;
      await this.page.waitForURL((u) => u.href.includes(needle), { timeout: t }).catch(() => {
        throw new Act402Error("ACTION_FAILED", `The URL did not contain "${preview(needle, 60)}" within ${t} ms (now ${preview(this.page.url(), 100)}).`);
      });
      return `URL now contains "${preview(needle, 60)}"`;
    }
    const loadState = action.load_state ?? "load";
    await this.page.waitForLoadState(loadState, { timeout: t }).catch(() => {
      throw new Act402Error("ACTION_FAILED", `The page did not reach "${loadState}" within ${t} ms.`);
    });
    return `page reached ${loadState}`;
  }

  private budgetFor(requested: number | undefined): number {
    const left = EXTRACT_BUDGET_CHARS - this.extractedChars;
    if (left <= 0) throw new Act402Error("STEP_LIMIT_REACHED", `Extraction limit reached (${EXTRACT_BUDGET_CHARS} characters per task).`);
    return Math.min(requested ?? 20_000, left);
  }

  private async extract(action: ActionOf<"extract">, index: number): Promise<string> {
    const format = action.format ?? "text";
    const maxChars = this.budgetFor(action.max_chars);
    const page = this.page;
    const targetDesc = describeTarget(action.target);
    let locator: Locator | null = null;
    let all: Locator | null = null;
    let count = 1;
    if (action.target) {
      const r = await resolveTarget(page, action.target, { timeoutMs: this.timeout(action.timeout_ms, 10_000), visible: false });
      locator = r.locator;
      count = r.matches;
      if (action.all) all = r.all;
    }
    const record: ExtractRecord = { action_index: index, name: action.name, format, target: targetDesc, count, truncated: false, source_url: page.url() };
    const t = this.timeout(action.timeout_ms, 10_000);

    if (format === "text") {
      if (all) {
        const texts = await all.evaluateAll((els, limit) => els.slice(0, 200).map((e) => ((e as HTMLElement).innerText ?? e.textContent ?? "").slice(0, limit)), maxChars);
        let used = 0;
        const items: string[] = [];
        for (const raw of texts) {
          const text = normalizeText(raw);
          if (used + text.length > maxChars) {
            record.truncated = true;
            break;
          }
          used += text.length;
          items.push(text);
        }
        record.items = items;
        record.count = texts.length;
        this.extractedChars += used;
      } else {
        const raw = locator
          ? await locator.evaluate((e, limit) => ((e as HTMLElement).innerText ?? e.textContent ?? "").slice(0, limit), maxChars * 2, { timeout: t })
          : await pageText(page, maxChars);
        const { text, truncated } = truncate(normalizeText(raw), maxChars);
        record.text = text;
        record.truncated = truncated;
        this.extractedChars += text.length;
      }
    } else if (format === "html") {
      if (all) {
        const htmls = await all.evaluateAll((els, limit) => els.slice(0, 100).map((e) => e.outerHTML.slice(0, limit)), maxChars);
        record.items = htmls;
        record.count = htmls.length;
        this.extractedChars += htmls.reduce((s, h) => s + h.length, 0);
      } else {
        const raw = locator ? await locator.evaluate((e) => e.outerHTML, undefined, { timeout: t }) : await page.content();
        const { text, truncated } = truncate(raw, maxChars);
        record.text = text;
        record.truncated = truncated;
        this.extractedChars += text.length;
      }
    } else if (format === "attribute") {
      const attr = action.attribute!;
      if (all) {
        const values = await all.evaluateAll((els, name) => els.slice(0, 500).map((e) => e.getAttribute(name)), attr);
        record.items = values;
        record.count = values.length;
        this.extractedChars += values.reduce((s, v) => s + (v?.length ?? 0), 0);
      } else if (locator) {
        const value = await locator.getAttribute(attr, { timeout: t });
        record.text = value ?? "";
        this.extractedChars += record.text.length;
      } else {
        throw new Act402Error("INVALID_REQUEST", 'format "attribute" needs a target.');
      }
    } else if (format === "links") {
      const links = locator
        ? await locator.evaluate((root) => {
            const anchors = (root.matches("a[href]") ? [root] : Array.from(root.querySelectorAll("a[href]"))) as HTMLAnchorElement[];
            return anchors.map((a) => ({ text: (a.innerText || a.getAttribute("aria-label") || a.title || "").replace(/\s+/g, " ").trim().slice(0, 200), href: a.href }));
          })
        : await pageLinks(page, 500);
      const seen = new Set<string>();
      const unique = links.filter((l) => /^https?:/i.test(l.href) && !seen.has(l.href) && seen.add(l.href)).slice(0, 500);
      record.items = unique;
      record.count = unique.length;
      this.extractedChars += unique.reduce((s, l) => s + l.href.length + l.text.length, 0);
    } else {
      const tables = await (locator ?? page.locator("body")).evaluate(
        (root, wantAll) => {
          const found = (root.matches("table") ? [root] : Array.from(root.querySelectorAll("table"))) as HTMLTableElement[];
          const pick = wantAll ? found.slice(0, 10) : found.slice(0, 1);
          return pick.map((table) => {
            const rows = Array.from(table.rows).slice(0, 500);
            const cell = (c: Element) => ((c as HTMLElement).innerText ?? "").replace(/\s+/g, " ").trim().slice(0, 500);
            let headers: string[] = [];
            let body = rows;
            const head = table.tHead?.rows[0] ?? (rows[0] && Array.from(rows[0].cells).every((c) => c.tagName === "TH") ? rows[0] : undefined);
            if (head) {
              headers = Array.from(head.cells).map(cell);
              body = rows.filter((r) => r !== head);
            }
            return { headers, rows: body.map((r) => Array.from(r.cells).slice(0, 50).map(cell)) };
          });
        },
        Boolean(action.all),
      );
      if (tables.length === 0) throw new Act402Error("TARGET_NOT_FOUND", `No <table> found in ${targetDesc}.`);
      if (action.all) {
        record.tables = tables;
        record.count = tables.length;
      } else {
        record.table = tables[0];
        record.count = tables[0].rows.length;
      }
      this.extractedChars += JSON.stringify(tables).length;
    }

    this.extracts.push(record);
    const summary = record.text !== undefined ? `${record.text.length} chars` : record.items ? `${record.items.length} items` : record.table ? `${record.table.rows.length} rows` : `${record.tables?.length ?? 0} tables`;
    return `extracted ${format} from ${targetDesc} (${summary}${record.truncated ? ", truncated" : ""})`;
  }

  private async saveScreenshot(desiredName: string, buffer: Buffer, extra: Partial<EvidenceRecord>): Promise<EvidenceRecord> {
    const { filename, bytes } = await writeEvidence(this.o.taskId, desiredName, buffer);
    const publicPath = evidencePublicPath(this.o.taskId, filename);
    const record: EvidenceRecord = {
      type: "screenshot",
      name: filename,
      url: this.absolute(publicPath),
      path: publicPath,
      source_url: this.page.url(),
      captured_at: new Date().toISOString(),
      bytes,
      ...extra,
    };
    this.evidence.push(record);
    this.screenshotsTaken++;
    return record;
  }

  private async screenshot(action: ActionOf<"screenshot">): Promise<string> {
    const max = getConfig().maxScreenshots;
    if (this.screenshotsTaken >= max) throw new Act402Error("STEP_LIMIT_REACHED", `Screenshot limit reached (${max} per task).`);
    const fullPage = Boolean(action.full_page) && !action.target;
    const base = sanitizeFilename(action.name ?? `screenshot-${this.screenshotsTaken + 1}`, "screenshot").replace(/\.(png|jpe?g)$/i, "");
    const t = this.timeout(action.timeout_ms, 15_000);
    let buffer: Buffer;
    if (action.target) {
      const r = await resolveTarget(this.page, action.target, { timeoutMs: t });
      buffer = await r.locator.screenshot({ type: "png", timeout: this.timeout(action.timeout_ms, 15_000) });
    } else if (fullPage) {
      const height = await this.page.evaluate(() => document.documentElement.scrollHeight).catch(() => 0);
      buffer = await this.page.screenshot({
        type: "jpeg",
        quality: 70,
        fullPage: true,
        timeout: t,
        clip: height > 12_000 ? { x: 0, y: 0, width: this.o.viewport.width, height: 12_000 } : undefined,
      });
    } else {
      buffer = await this.page.screenshot({ type: "png", timeout: t });
    }
    const record = await this.saveScreenshot(`${base}.${fullPage ? "jpg" : "png"}`, buffer, {
      full_page: fullPage || undefined,
      target: action.target ? describeTarget(action.target) : undefined,
    });
    return `captured ${record.name} (${formatBytes(record.bytes)})`;
  }

  /** Final evidence screenshot, if the quota allows and the final page was not already captured. */
  async captureFinal(name = "final.png"): Promise<void> {
    if (this.screenshotsTaken >= getConfig().maxScreenshots || this.remaining() < 1500 || this.page.isClosed()) return;
    const url = this.page.url();
    if (!/^https?:/i.test(url)) return;
    const lastShot = [...this.evidence].reverse().find((e) => e.type === "screenshot");
    if (lastShot && lastShot.source_url === url) return;
    try {
      const buffer = await this.page.screenshot({ type: "png", timeout: Math.min(8000, this.remaining() - 500) });
      await this.saveScreenshot(name, buffer, {});
    } catch {
      this.warnings.push("The final screenshot could not be captured.");
    }
  }

  private assertDownloadQuota(): void {
    const max = getConfig().maxDownloads;
    if (this.downloadsTaken >= max) throw new Act402Error("STEP_LIMIT_REACHED", `Download limit reached (${max} per task).`);
  }

  private async saveDownload(data: Buffer, filename: string, mimeType: string, downloadUrl: string, sourceUrl: string): Promise<string> {
    const { filename: stored, bytes } = await writeEvidence(this.o.taskId, filename, data);
    const publicPath = evidencePublicPath(this.o.taskId, stored);
    this.evidence.push({
      type: "download",
      name: stored,
      url: this.absolute(publicPath),
      path: publicPath,
      source_url: sourceUrl,
      captured_at: new Date().toISOString(),
      bytes,
      filename: stored,
      mime_type: mimeType,
      size_bytes: bytes,
      sha256: createHash("sha256").update(data).digest("hex"),
      download_url: downloadUrl,
    });
    this.downloadsTaken++;
    return `downloaded ${stored} (${formatBytes(bytes)}, ${mimeType})`;
  }

  /** Server-side fetch of a public file, sending only this task's own cookies. */
  async downloadUrl(url: string, preferredName?: string): Promise<string> {
    this.assertDownloadQuota();
    const page = this.page;
    const cookies = await this.o.session.context.cookies(url).catch(() => []);
    const headers: Record<string, string> = {};
    if (cookies.length > 0) headers.cookie = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const ua = await page.evaluate(() => navigator.userAgent).catch(() => "");
    if (ua) headers["user-agent"] = ua;
    if (/^https?:/i.test(page.url())) headers.referer = page.url();
    const file = await safeDownload(url, {
      maxBytes: getConfig().maxDownloadBytes,
      timeoutMs: this.timeout(undefined, 30_000),
      policy: this.o.policy,
      headers,
      preferredName,
    });
    return this.saveDownload(file.data, file.filename, file.mimeType, file.finalUrl, /^https?:/i.test(page.url()) ? page.url() : url);
  }

  private async download(action: ActionOf<"download">): Promise<string> {
    this.assertDownloadQuota();
    if (action.url) {
      let url: string;
      try {
        url = new URL(action.url, this.page.url()).href;
      } catch {
        throw new Act402Error("INVALID_URL", `"${preview(action.url, 80)}" is not a valid URL.`);
      }
      return this.downloadUrl(url, action.filename);
    }
    const target = action.target!;
    const r = await resolveTarget(this.page, target, { timeoutMs: this.timeout(action.timeout_ms, 10_000), interactive: true, visible: false });
    const info = await inspectElement(r.locator, 3000);
    this.assertClickAllowed(info);
    if (info.href && /^https?:/i.test(info.href)) return this.downloadUrl(info.href, action.filename);

    // No href: the control triggers the download with JavaScript. Capture it from the browser.
    const t = this.timeout(action.timeout_ms, 15_000);
    this.o.session.allowDownloads = true;
    try {
      const downloadPromise = this.page.waitForEvent("download", { timeout: t });
      await r.locator.click({ timeout: t });
      const download = await downloadPromise.catch(() => {
        throw new Act402Error("DOWNLOAD_FAILED", `Clicking ${elementLabel(info, target)} did not start a download.`);
      });
      const url = download.url();
      if (/^https?:/i.test(url)) {
        // Re-fetch through the size-limited, SSRF-checked downloader instead of letting Chromium write an unbounded file.
        await download.cancel().catch(() => undefined);
        return this.downloadUrl(url, action.filename ?? download.suggestedFilename());
      }
      const tmp = path.join(os.tmpdir(), `act402-${this.o.taskId}-${Date.now()}`);
      await download.saveAs(tmp);
      try {
        const { size } = await fs.stat(tmp);
        if (size > getConfig().maxDownloadBytes) throw new Act402Error("DOWNLOAD_FAILED", `The file exceeds the ${getConfig().maxDownloadBytes / 1048576} MB limit.`);
        const suggested = download.suggestedFilename();
        const mime = mimeForFilename(suggested);
        const name = chooseFilename([action.filename, suggested], mime);
        return this.saveDownload(await fs.readFile(tmp), name, mime, url.slice(0, 100), this.page.url());
      } finally {
        await fs.rm(tmp, { force: true }).catch(() => undefined);
      }
    } finally {
      this.o.session.allowDownloads = false;
    }
  }

  /** Gather the final page facts the response needs. */
  async collect(want: { links: boolean; downloadLinks: boolean; pageText: boolean }): Promise<CollectedResult> {
    const page = this.page;
    const finalUrl = page.isClosed() ? "" : page.url();
    const title = page.isClosed() ? "" : await page.title().catch(() => "");
    const lastText = [...this.extracts].reverse().find((e) => e.format === "text");
    let text = "";
    let textSource: CollectedResult["text_source"] = "page";
    let textTruncated = false;
    if (lastText) {
      text = lastText.text ?? (lastText.items as string[] | undefined)?.join("\n\n") ?? "";
      textSource = "extract";
      textTruncated = lastText.truncated;
    } else if (!page.isClosed() && /^https?:/i.test(finalUrl)) {
      const t = truncate(normalizeText(await pageText(page, 8000)), 8000);
      text = t.text;
      textTruncated = t.truncated;
    }
    const result: CollectedResult = { final_url: finalUrl, title, text, text_source: textSource, text_truncated: textTruncated };
    if ((want.links || want.downloadLinks) && !page.isClosed()) {
      const links = await pageLinks(page, 500);
      if (want.links) result.links = links;
      if (want.downloadLinks) result.download_links = links.filter((l) => looksLikeFileLink(l.href));
    }
    if (want.pageText && !page.isClosed()) {
      result.page_text = truncate(normalizeText(await pageText(page, 50_000)), 50_000).text;
    }
    return result;
  }
}
