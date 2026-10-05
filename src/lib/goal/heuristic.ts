import type { Page } from "playwright-core";
import { Act402Error } from "../errors";
import type { TaskRunner } from "../act/runner";
import type { ActRequest } from "../act/schema";
import type { GoalAnswer } from "../act/types";
import { looksLikeFileLink } from "../browser/page-helpers";
import { checkClickName } from "../security/action-policy";
import { hostnameOf, preview } from "../util";
import { getDomain } from "tldts";

/**
 * Goal mode without an LLM. A deterministic planner that:
 *   1. extracts keywords, concepts and the expected answer type from the goal,
 *   2. uses the site's search box when the goal names a query,
 *   3. follows the link whose name best matches the goal (same site only),
 *   4. scores text blocks on each page and quotes the best one as evidence.
 * Callers that need precise control should send explicit `actions` instead.
 */

type AnswerType = "price" | "date" | "number" | "email" | "phone" | "text";

interface Intent {
  keywords: string[];
  concepts: Set<string>;
  answerType: AnswerType;
  searchQuery?: string;
  wantsDownload: boolean;
  phrases: string[];
}

const STOPWORDS = new Set(
  "a an the and or of to for in on at by with from into onto is are was were be been it its this that these those what which who whom whose when where why how me my i you your our we us please tell return give show find get go open navigate click visit check look up see page site website then and also current currently today now there here their them can could would should will do does did just only about out over any some all each per vs versus using via same"
    .split(" "),
);

const CONCEPTS: Record<string, string[]> = {
  pricing: ["price", "prices", "pricing", "plan", "plans", "cost", "costs", "subscription", "tariff", "tariffs", "fee", "fees", "billing", "rates", "rate", "cheapest"],
  docs: ["doc", "docs", "documentation", "api", "reference", "guide", "guides", "developer", "developers", "sdk", "quickstart"],
  contact: ["contact", "email", "phone", "telephone", "address", "support", "help"],
  about: ["about", "company", "team", "mission", "story"],
  careers: ["career", "careers", "job", "jobs", "hiring", "vacancies", "openings"],
  download: ["download", "downloads", "pdf", "file", "files", "brochure", "specification", "spec", "datasheet", "whitepaper", "report"],
  news: ["blog", "news", "press", "article", "articles", "announcement", "announcements", "updates"],
  products: ["product", "products", "shop", "store", "catalog", "catalogue", "collection"],
  booking: ["room", "rooms", "availability", "available", "booking", "book", "stay", "reservation", "reservations"],
  events: ["event", "events", "calendar", "schedule", "agenda"],
  tenders: ["tender", "tenders", "procurement", "rfp", "rfq", "bid", "bids", "opportunities"],
  results: ["result", "results", "score", "scores", "standings", "leaderboard", "ranking", "rankings"],
  faq: ["faq", "faqs", "questions", "answers"],
  limits: ["limit", "limits", "quota", "quotas", "rate-limit"],
};

const PRICE_RE = /(?:US\$|\$|€|£|¥|₹|AED|USD|EUR|GBP|INR|SAR|QAR|Dhs?)\s?\d[\d,]*(?:\.\d+)?(?:\s?(?:\/|per)\s?(?:user|seat|member|month|mo|year|yr|night|hour|hr|day|unit|license|person))?(?:\s?\/\s?(?:month|mo|year|yr))?|\d[\d,]*(?:\.\d+)?\s?(?:USD|EUR|GBP|AED|INR|SAR|QAR)\b/i;
const DATE_RE = /\b(?:\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}|\d{4}-\d{2}-\d{2}|(?:\d{1,2}\s)?(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s\d{1,2}(?:st|nd|rd|th)?(?:,?\s\d{4})?|\d{1,2}(?:st|nd|rd|th)?\s(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?(?:,?\s\d{4})?)\b/i;
const NUMBER_RE = /\b\d[\d,]*(?:\.\d+)?\s?(?:%|k|m|bn|million|billion|thousand|ms|s|sec|seconds|minutes|hours|days|requests|req|rpm|rps|gb|mb|tb|kb|m|ft|km|kg|lbs)?\b/i;
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const PHONE_RE = /\+?\d[\d\s().-]{7,}\d/;

/** Registrable domain, or the bare host for IPs and single-label names. */
function siteOf(url: string): string {
  const host = hostnameOf(url);
  return getDomain(host) ?? host;
}

function stem(word: string): string {
  return word.length > 4 ? word.replace(/(ings|ing|ies|es|s|ed)$/, "") : word;
}

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9$€£%-]+/g, " ")
    .split(" ")
    .filter((w) => w.length > 1 && !STOPWORDS.has(w));
}

function conceptsOf(words: string[]): Set<string> {
  const found = new Set<string>();
  for (const [concept, list] of Object.entries(CONCEPTS)) {
    if (words.some((w) => list.includes(w))) found.add(concept);
  }
  return found;
}

export function analyzeGoal(goal: string): Intent {
  const lower = goal.toLowerCase();
  const phrases = [...goal.matchAll(/["“']([^"”']{2,80})["”']/g)].map((m) => m[1].trim());
  const search =
    /\bsearch(?:\s+(?:the\s+site|for|it))?(?:\s+for)?\s+["“']?([^"”'.,;]{2,80})["”']?/i.exec(goal) ?? /\blook\s+up\s+["“']?([^"”'.,;]{2,80})["”']?/i.exec(goal);
  let searchQuery = search?.[1]?.replace(/\s+(and|then)\s.*$/i, "").trim();
  if (searchQuery && searchQuery.split(" ").length > 8) searchQuery = undefined;
  const words = tokens(goal);
  let answerType: AnswerType = "text";
  if (/\b(price|pricing|cost|costs|how much|fee|fees|cheapest|most expensive|rate per|\$|usd|aed|eur|gbp)\b/i.test(lower)) answerType = "price";
  else if (/\b(date|when|deadline|closing|closes|due|expiry|expires|opening date|launch date)\b/i.test(lower)) answerType = "date";
  else if (/\b(email address|e-mail|email)\b/i.test(lower)) answerType = "email";
  else if (/\b(phone|telephone|call us)\b/i.test(lower)) answerType = "phone";
  else if (/\b(how many|number of|count|total|limit|height|how tall|how long|how big|population|percentage|percent|score)\b/i.test(lower)) answerType = "number";
  return {
    keywords: [...new Set(words.map(stem))],
    concepts: conceptsOf(words),
    answerType,
    searchQuery,
    wantsDownload: /\b(download|pdf|save the file|get the file)\b/i.test(lower),
    phrases,
  };
}

interface Block {
  text: string;
  heading: string;
}

interface Control {
  name: string;
  href: string;
  kind: "link" | "button";
  index: number;
}

interface Snapshot {
  url: string;
  title: string;
  blocks: Block[];
  controls: Control[];
  hasSearchBox: boolean;
}

async function snapshot(page: Page): Promise<Snapshot> {
  return page.evaluate(() => {
    const visible = (el: Element) => {
      const r = (el as HTMLElement).getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return false;
      const s = window.getComputedStyle(el);
      return s.visibility !== "hidden" && s.display !== "none";
    };
    const blocks: Array<{ text: string; heading: string }> = [];
    let heading = "";
    const all = Array.from(document.body?.querySelectorAll("h1,h2,h3,h4,h5,h6,p,li,tr,td,th,dt,dd,div,section,article,span,label,figcaption,blockquote,pre,strong,b") ?? []);
    for (const el of all) {
      if (blocks.length >= 3000) break;
      const tag = el.tagName;
      const text = ((el as HTMLElement).innerText ?? "").replace(/\s+/g, " ").trim();
      if (/^H[1-6]$/.test(tag) && text) heading = text.slice(0, 120);
      if (text.length < 2 || text.length > 700) continue;
      if (!visible(el)) continue;
      blocks.push({ text, heading });
    }
    const controls: Array<{ name: string; href: string; kind: "link" | "button"; index: number }> = [];
    const nodes = Array.from(document.querySelectorAll('a[href], button, [role="tab"], [role="button"], [role="link"]'));
    nodes.forEach((node, index) => {
      if (controls.length >= 600 || !visible(node)) return;
      const el = node as HTMLElement;
      const name = (el.getAttribute("aria-label") || el.innerText || el.getAttribute("title") || "").replace(/\s+/g, " ").trim().slice(0, 120);
      const href = el instanceof HTMLAnchorElement ? el.href : "";
      if (!name && !href) return;
      controls.push({ name, href, kind: href ? "link" : "button", index });
    });
    const hasSearchBox = Boolean(
      document.querySelector('input[type="search"], [role="searchbox"], input[name="q"], input[name*="search" i], input[placeholder*="search" i], input[aria-label*="search" i]'),
    );
    return { url: location.href, title: document.title, blocks, controls, hasSearchBox };
  });
}

function blockScore(block: Block, intent: Intent): number {
  const words = new Set(tokens(block.text).map(stem));
  const headingWords = new Set(tokens(block.heading).map(stem));
  let score = 0;
  let hits = 0;
  for (const k of intent.keywords) {
    if (words.has(k)) {
      score += 1;
      hits++;
    } else if (headingWords.has(k)) score += 0.4;
  }
  for (const phrase of intent.phrases) {
    if (block.text.toLowerCase().includes(phrase.toLowerCase())) {
      score += 3;
      hits++;
    }
  }
  // A bare value ("$9") with nothing tying it to the goal is not evidence.
  if (hits === 0 && intent.keywords.length > 0) return 0;
  const typed =
    intent.answerType === "price" ? PRICE_RE : intent.answerType === "date" ? DATE_RE : intent.answerType === "email" ? EMAIL_RE : intent.answerType === "phone" ? PHONE_RE : intent.answerType === "number" ? NUMBER_RE : null;
  if (typed) score += typed.test(block.text) ? 2 : -1;
  return score / (1 + block.text.length / 350);
}

function extractValue(text: string, type: AnswerType): string | undefined {
  const re = type === "price" ? PRICE_RE : type === "date" ? DATE_RE : type === "email" ? EMAIL_RE : type === "phone" ? PHONE_RE : type === "number" ? NUMBER_RE : null;
  return re ? re.exec(text)?.[0]?.trim() : undefined;
}

function controlScore(control: Control, intent: Intent, startSite: string, visited: Set<string>): number {
  if (!control.name) return 0;
  if (control.href) {
    if (!/^https?:/i.test(control.href)) return 0;
    if (siteOf(control.href) !== startSite) return 0;
    if (visited.has(control.href.split("#")[0])) return 0;
  }
  if (!checkClickName(control.name).allowed) return 0;
  if (control.name.length > 80) return 0;
  const nameWords = tokens(control.name);
  const hrefWords = control.href ? tokens(new URL(control.href).pathname.replace(/[/_.-]+/g, " ")) : [];
  const stems = new Set([...nameWords, ...hrefWords].map(stem));
  let score = 0;
  for (const k of intent.keywords) if (stems.has(k)) score += 1;
  const linkConcepts = conceptsOf([...nameWords, ...hrefWords]);
  for (const c of intent.concepts) if (linkConcepts.has(c)) score += 1.5;
  for (const phrase of intent.phrases) if (control.name.toLowerCase().includes(phrase.toLowerCase())) score += 2;
  return score / (1 + Math.max(0, nameWords.length - 3) * 0.15);
}

function confidenceFor(score: number, hasValue: boolean, intent: Intent): number {
  const base = Math.min(0.9, 0.25 + score * 0.12);
  return Math.round((intent.answerType !== "text" && hasValue ? Math.min(0.95, base + 0.1) : base) * 100) / 100;
}

/** Drive the browser toward the goal and return the best-supported answer. */
export async function runHeuristicGoal(runner: TaskRunner, request: ActRequest): Promise<GoalAnswer> {
  const goal = request.goal ?? "";
  const intent = analyzeGoal(goal);
  await runner.open(request.url, request.waitUntil, request.dismissCookieBanners);
  const startSite = siteOf(runner.page.url());
  const visited = new Set<string>([runner.page.url().split("#")[0]]);
  let searched = false;
  let best: { text: string; score: number; url: string; value?: string } | null = null;
  const candidates: Array<{ text: string; score: number; url: string }> = [];
  let actionIndex = 0;

  for (let hop = 0; hop <= request.maxSteps; hop++) {
    if (runner.remaining() < 4000) break;
    const snap = await snapshot(runner.page).catch(() => null);
    if (!snap) break;

    // Score the current page.
    const scored = snap.blocks
      .map((b) => ({ text: b.text, score: blockScore(b, intent) }))
      .filter((b) => b.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);
    for (const s of scored) {
      candidates.push({ text: preview(s.text, 300), score: Math.round(s.score * 100) / 100, url: snap.url });
      if (!best || s.score > best.score) best = { ...s, url: snap.url, value: extractValue(s.text, intent.answerType) };
    }

    // Download goals: fetch the best-matching file link on this page.
    if (intent.wantsDownload && runner.downloadsTaken === 0) {
      const files = snap.controls.filter((c) => c.href && looksLikeFileLink(c.href)).map((c) => ({ c, s: controlScore(c, intent, startSite, new Set()) + 1 }));
      files.sort((a, b) => b.s - a.s);
      if (files.length > 0) {
        const file = files[0].c;
        await runner.run({ type: "download", url: file.href }, actionIndex++);
        return {
          answer: `Downloaded ${runner.evidence.find((e) => e.type === "download")?.filename ?? "file"}`,
          summary: `Found the file link "${preview(file.name || file.href, 80)}" on ${hostnameOf(snap.url)} and downloaded it.`,
          confidence: Math.min(0.9, 0.5 + files[0].s * 0.1),
          evidence_text: preview(file.name || file.href, 200),
          candidates: candidates.slice(0, 5),
          planner: "heuristic",
        };
      }
    }

    const strong = best && best.score >= 1.6 && (intent.answerType === "text" || best.value);
    if (strong && hop > 0) break;
    if (hop >= request.maxSteps) break;

    // Use the site's search when the goal names a query.
    if (intent.searchQuery && !searched && snap.hasSearchBox) {
      searched = true;
      try {
        await runner.run(
          { type: "type", target: { selector: 'input[type="search"], [role="searchbox"], input[name="q"], input[name*="search" i], input[placeholder*="search" i], input[aria-label*="search" i]' }, value: intent.searchQuery, submit: true },
          actionIndex++,
        );
        visited.add(runner.page.url().split("#")[0]);
        continue;
      } catch {
        // fall through to link navigation
      }
    }

    // Follow the best-matching same-site link or tab.
    const next = snap.controls
      .map((c) => ({ c, s: controlScore(c, intent, startSite, visited) }))
      .filter((x) => x.s >= 1)
      .sort((a, b) => b.s - a.s)[0];
    if (!next) break;
    try {
      if (next.c.href) {
        visited.add(next.c.href.split("#")[0]);
        await runner.run({ type: "navigate", url: next.c.href }, actionIndex++);
      } else {
        await runner.run({ type: "click", target: { role: "button", name: next.c.name, exact: true } }, actionIndex++);
      }
      visited.add(runner.page.url().split("#")[0]);
    } catch (err) {
      if (err instanceof Act402Error && ["SITE_BLOCKED_AUTOMATION", "BLOCKED_URL", "TIMEOUT", "BROWSER_PROVIDER_ERROR"].includes(err.code)) throw err;
      runner.warnings.push(`Goal planner could not follow "${preview(next.c.name, 60)}".`);
    }
  }

  if (!best || best.score < 0.9) {
    throw new Act402Error(
      "TASK_NOT_COMPLETED",
      "Goal mode could not find text on the site that answers the goal. Send explicit `actions` (click/type/extract) for precise control.",
      { planner: "heuristic", pages_checked: visited.size },
    );
  }
  const answer = best.value ?? preview(best.text, 300);
  return {
    answer,
    summary: best.value ? `Found "${best.value}" in: "${preview(best.text, 220)}"` : preview(best.text, 300),
    confidence: confidenceFor(best.score, Boolean(best.value), intent),
    evidence_text: preview(best.text, 300),
    candidates: candidates.sort((a, b) => b.score - a.score).slice(0, 5),
    planner: "heuristic",
  };
}

/** Outline the evidence text on the page so the final screenshot shows where the answer came from. */
export async function highlightEvidence(page: Page, excerpt: string): Promise<boolean> {
  const needle = excerpt.replace(/…$/, "").slice(0, 120).toLowerCase();
  if (needle.length < 2) return false;
  return page
    .evaluate((n) => {
      let bestEl: HTMLElement | null = null;
      for (const el of Array.from(document.body.querySelectorAll("*")) as HTMLElement[]) {
        const text = (el.innerText ?? "").replace(/\s+/g, " ").trim().toLowerCase();
        if (text.length > 0 && text.length < 1500 && text.includes(n.slice(0, 60))) {
          if (!bestEl || text.length < (bestEl.innerText ?? "").length) bestEl = el;
        }
      }
      if (!bestEl) return false;
      bestEl.scrollIntoView({ block: "center" });
      bestEl.style.outline = "3px solid #f59e0b";
      bestEl.style.outlineOffset = "3px";
      bestEl.style.backgroundColor = "rgba(245, 158, 11, 0.18)";
      return true;
    }, needle)
    .catch(() => false);
}
