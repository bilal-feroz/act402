import type { Page } from "playwright-core";

/**
 * After an interaction: give a navigation a moment to start, then wait for the
 * DOM and a short network-quiet window. Every wait is bounded.
 */
export async function settle(page: Page, budgetMs: number): Promise<void> {
  if (budgetMs <= 0) return;
  await page.waitForTimeout(Math.min(250, budgetMs)).catch(() => undefined);
  await page.waitForLoadState("domcontentloaded", { timeout: Math.max(1, Math.min(10_000, budgetMs - 250)) }).catch(() => undefined);
  await page.waitForLoadState("networkidle", { timeout: Math.max(1, Math.min(1_500, budgetMs - 250)) }).catch(() => undefined);
}

/**
 * Detect CAPTCHA / anti-bot interstitials. Act402 never tries to get past them;
 * it reports SITE_BLOCKED_AUTOMATION instead.
 */
export async function detectBotWall(page: Page, httpStatus?: number): Promise<string | null> {
  const info = await page
    .evaluate(() => {
      const bodyText = document.body?.innerText ?? "";
      const ids = ["challenge-running", "challenge-form", "cf-challenge-running", "cf-turnstile", "px-captcha", "captcha-container", "sec-if-cpt-container"].filter((id) =>
        document.getElementById(id),
      );
      if (document.querySelector('script[src*="captcha-delivery.com"], iframe[src*="captcha-delivery.com"]')) ids.push("datadome");
      return {
        title: document.title ?? "",
        text: bodyText.slice(0, 4000),
        textLength: bodyText.length,
        iframes: Array.from(document.querySelectorAll("iframe"))
          .map((f) => f.src)
          .filter(Boolean)
          .slice(0, 30),
        ids,
      };
    })
    .catch(() => null);
  if (!info) return null;

  const title = info.title.toLowerCase();
  const text = info.text.toLowerCase();
  if (/^(just a moment|attention required|access denied|security check|are you a robot|pardon our interruption|request unsuccessful|one more step|robot check|verify you are human|please verify you are a human)/.test(title)) {
    return `challenge page ("${info.title.slice(0, 60)}")`;
  }
  if (info.ids.length > 0) return `anti-bot challenge (${info.ids[0]})`;
  const challengeText =
    /verify (that )?you are (a )?human|checking if the site connection is secure|checking your browser before|enable javascript and cookies to continue|press (&|and) hold|unusual traffic from your computer network|automated queries|complete the security check to access|incapsula incident id|please solve this captcha|i am not a robot/;
  if (challengeText.test(text) && info.textLength < 3000) return "anti-bot challenge text";
  const captchaFrame = info.iframes.find((src) => /recaptcha\/api2\/anchor|hcaptcha\.com\/captcha|challenges\.cloudflare\.com|captcha-delivery\.com|arkoselabs|funcaptcha/.test(src));
  if (captchaFrame && info.textLength < 1500) return "CAPTCHA challenge";
  if (httpStatus && [403, 429, 503].includes(httpStatus) && /captcha|robot|automated|bot detection|access denied|blocked/.test(text) && info.textLength < 3000) {
    return `HTTP ${httpStatus} access denied`;
  }
  return null;
}

/**
 * Close common cookie/consent banners, preferring the privacy-preserving
 * "reject" choice when one is offered. Returns a description, or null if no
 * banner was found.
 */
export async function dismissCookieBanner(page: Page): Promise<string | null> {
  const clicked = await page
    .evaluate(() => {
      const visible = (el: Element | null): el is HTMLElement => {
        if (!el) return false;
        const e = el as HTMLElement;
        const r = e.getBoundingClientRect();
        const s = window.getComputedStyle(e);
        return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
      };
      const known: Array<[string, string]> = [
        ["#onetrust-reject-all-handler", "reject"],
        ["#CybotCookiebotDialogBodyButtonDecline", "reject"],
        ["#didomi-notice-disagree-button", "reject"],
        ["[data-testid='uc-deny-all-button']", "reject"],
        [".fc-cta-do-not-consent", "reject"],
        ["#truste-consent-required", "reject"],
        [".cc-deny", "reject"],
        ["#onetrust-accept-btn-handler", "accept"],
        ["#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll", "accept"],
        ["#didomi-notice-agree-button", "accept"],
        ["[data-testid='uc-accept-all-button']", "accept"],
        [".fc-cta-consent", "accept"],
        ["#truste-consent-button", "accept"],
        [".cc-allow", "accept"],
        [".cc-dismiss", "accept"],
      ];
      for (const [selector, kind] of known) {
        const el = document.querySelector(selector);
        if (visible(el)) {
          el.click();
          return `${kind} (${selector})`;
        }
      }
      const containers = Array.from(document.querySelectorAll("[id*='cookie' i], [class*='cookie' i], [id*='consent' i], [class*='consent' i], [id*='gdpr' i], [class*='gdpr' i], [aria-label*='cookie' i]")).filter(visible).slice(0, 10);
      const reject = /^(reject all|reject|decline( all)?|deny( all)?|necessary only|only necessary|use necessary cookies only|refuse( all)?|continue without accepting)$/i;
      const accept = /^(accept( all)?( cookies)?|allow( all)?( cookies)?|agree|i agree|got it|ok|okay|understood|i understand)$/i;
      for (const pattern of [reject, accept]) {
        for (const container of containers) {
          const buttons = Array.from(container.querySelectorAll("button, [role='button'], a")).filter(visible);
          const match = buttons.find((b) => pattern.test((b.innerText || b.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim()));
          if (match) {
            const label = (match.innerText || match.getAttribute("aria-label") || "").trim().slice(0, 40);
            match.click();
            return `${pattern === reject ? "reject" : "accept"} ("${label}")`;
          }
        }
      }
      return null;
    })
    .catch(() => null);
  if (clicked) await page.waitForTimeout(300).catch(() => undefined);
  return clicked;
}

/** Visible text of the whole page, bounded in the page before transfer. */
export async function pageText(page: Page, maxChars: number): Promise<string> {
  return page
    .evaluate((limit) => (document.body?.innerText ?? "").slice(0, limit), maxChars * 2)
    .catch(() => "");
}

export interface LinkInfo {
  text: string;
  href: string;
}

/** All links on the page (deduplicated, http/https only). */
export async function pageLinks(page: Page, max = 500): Promise<LinkInfo[]> {
  return page
    .evaluate((limit) => {
      const seen = new Set<string>();
      const out: Array<{ text: string; href: string }> = [];
      for (const a of Array.from(document.querySelectorAll("a[href]")) as HTMLAnchorElement[]) {
        const href = a.href;
        if (!/^https?:/i.test(href) || seen.has(href)) continue;
        seen.add(href);
        out.push({ text: (a.innerText || a.getAttribute("aria-label") || a.title || "").replace(/\s+/g, " ").trim().slice(0, 200), href });
        if (out.length >= limit) break;
      }
      return out;
    }, max)
    .catch(() => []);
}

const FILE_EXT = /\.(pdf|docx?|xlsx?|pptx?|csv|zip|gz|tar|txt|json|xml|rtf|odt|ods|epub|mp3|mp4|png|jpe?g)(\?|#|$)/i;

export function looksLikeFileLink(href: string): boolean {
  try {
    return FILE_EXT.test(new URL(href).pathname);
  } catch {
    return false;
  }
}
