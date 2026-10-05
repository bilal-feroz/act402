import type { Frame, Locator, Page } from "playwright-core";
import { Act402Error, firstLine } from "../errors";
import { describeTarget, type AriaRole, type Target } from "../act/schema";
import { sleep } from "../util";

type Root = Page | Frame;

export interface ResolveOptions {
  timeoutMs: number;
  /** Click/hover: prefer links, buttons, tabs and menu items over plain text. */
  interactive?: boolean;
  /** Type/select/check: look for form fields (label, placeholder, textbox roles). */
  field?: boolean;
  /** Require a visible element (default true). */
  visible?: boolean;
}

export interface ResolvedTarget {
  /** The chosen element (the nth match). */
  locator: Locator;
  /** Every match of the winning strategy, for `all: true` extraction. */
  all: Locator;
  strategy: string;
  matches: number;
  frameUrl?: string;
}

const INTERACTIVE_ROLES: AriaRole[] = ["link", "button", "menuitem", "tab", "option", "checkbox", "radio", "switch", "treeitem", "menuitemcheckbox", "menuitemradio"];
const FIELD_ROLES: AriaRole[] = ["textbox", "searchbox", "combobox", "spinbutton", "checkbox", "radio", "switch", "listbox", "slider"];

function cssString(value: string): string {
  return value.replace(/["\\]/g, "\\$&").replace(/\n/g, " ");
}

function anyRole(root: Root, roles: AriaRole[], name: string, exact: boolean): Locator {
  let loc = root.getByRole(roles[0], { name, exact });
  for (const role of roles.slice(1)) loc = loc.or(root.getByRole(role, { name, exact }));
  return loc;
}

/** Ordered locator strategies for one target inside one frame. */
function strategies(root: Root, t: Target, opts: ResolveOptions): Array<{ strategy: string; locator: Locator }> {
  const exact = t.exact ?? false;
  if (t.selector) {
    const loc = root.locator(t.selector);
    return [{ strategy: "selector", locator: t.text ? loc.filter({ hasText: t.text }) : loc }];
  }
  if (t.role) {
    const name = t.name ?? t.text;
    return [{ strategy: "role", locator: root.getByRole(t.role, name ? { name, exact } : {}) }];
  }

  const list: Array<{ strategy: string; locator: Locator }> = [];
  if (t.label) list.push({ strategy: "label", locator: root.getByLabel(t.label, { exact }) });
  if (t.placeholder) list.push({ strategy: "placeholder", locator: root.getByPlaceholder(t.placeholder, { exact }) });
  if (t.alt) list.push({ strategy: "alt", locator: root.getByAltText(t.alt, { exact }) });
  if (t.title) list.push({ strategy: "title", locator: root.getByTitle(t.title, { exact }) });
  if (t.test_id) list.push({ strategy: "test_id", locator: root.getByTestId(t.test_id) });

  const text = t.text ?? t.name;
  if (text) {
    const quoted = cssString(text);
    if (opts.field) {
      list.push({ strategy: "label", locator: root.getByLabel(text, { exact }) });
      list.push({ strategy: "placeholder", locator: root.getByPlaceholder(text, { exact }) });
      list.push({ strategy: "role", locator: anyRole(root, FIELD_ROLES, text, exact) });
      list.push({ strategy: "name-attr", locator: root.locator(`input[name="${quoted}" i], textarea[name="${quoted}" i], select[name="${quoted}" i]`) });
    } else {
      const interactive = { strategy: "role", locator: anyRole(root, INTERACTIVE_ROLES, text, exact) };
      const byText = { strategy: "text", locator: root.getByText(text, { exact }) };
      if (opts.interactive || t.name !== undefined) list.push(interactive, byText);
      else list.push(byText, interactive);
      list.push({ strategy: "aria-label", locator: root.locator(`[aria-label*="${quoted}" i]`) });
      list.push({ strategy: "title-attr", locator: root.locator(`[title*="${quoted}" i]`) });
      list.push({ strategy: "button-value", locator: root.locator(`input[type="submit" i][value*="${quoted}" i], input[type="button" i][value*="${quoted}" i]`) });
    }
  }
  return list;
}

function isSelectorSyntaxError(message: string): boolean {
  return /not a valid selector|Unexpected token|Unknown engine|Unsupported token|while parsing (css )?selector|Invalid selector/i.test(message);
}

/** The first strategy's raw locator (no visibility filter) — for wait-until-hidden/detached. */
export function primaryLocator(page: Page, target: Target, opts: Omit<ResolveOptions, "timeoutMs"> = {}): Locator {
  const first = strategies(page, target, { timeoutMs: 0, ...opts })[0];
  if (!first) throw new Act402Error("INVALID_REQUEST", "target has no locator fields.");
  return first.locator.first();
}

/**
 * Find the element a target describes, polling until it appears or the timeout
 * passes. Searches the main frame first, then child iframes.
 */
export async function resolveTarget(page: Page, target: Target, opts: ResolveOptions): Promise<ResolvedTarget> {
  const deadline = Date.now() + Math.max(0, opts.timeoutMs);
  const wantVisible = opts.visible !== false;
  const nth = target.nth ?? 0;
  let fewerThanNth: number | undefined;

  for (;;) {
    const main = page.mainFrame();
    const frames = page.frames().filter((f) => f !== main && !f.isDetached()).slice(0, 8);
    const roots: Root[] = [page, ...frames];
    for (let ri = 0; ri < roots.length; ri++) {
      const root = roots[ri];
      for (const s of strategies(root, target, opts)) {
        const loc = wantVisible ? s.locator.filter({ visible: true }) : s.locator;
        let count = 0;
        try {
          count = await loc.count();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (isSelectorSyntaxError(message)) {
            throw new Act402Error("INVALID_REQUEST", `Invalid selector "${target.selector ?? ""}": ${firstLine(message)}`);
          }
          continue; // frame navigated or detached mid-query
        }
        if (count === 0) continue;
        if (nth >= count) {
          fewerThanNth = Math.max(fewerThanNth ?? 0, count);
          continue;
        }
        return {
          locator: loc.nth(nth),
          all: loc,
          strategy: s.strategy,
          matches: count,
          frameUrl: ri > 0 ? (root as Frame).url() : undefined,
        };
      }
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(300, remaining));
  }

  const what = describeTarget(target);
  if (fewerThanNth !== undefined) {
    throw new Act402Error("TARGET_NOT_FOUND", `Only ${fewerThanNth} element(s) matched ${what}; nth=${nth} is out of range.`, { matches: fewerThanNth });
  }
  const suggestions = await suggestElements(page, target).catch(() => []);
  throw new Act402Error("TARGET_NOT_FOUND", `No ${wantVisible ? "visible " : ""}element matched ${what} within ${opts.timeoutMs} ms.`, {
    target,
    suggestions,
  });
}

export interface Suggestion {
  role: string;
  name: string;
}

/** List visible controls whose names resemble the requested text, to help the caller fix the target. */
export async function suggestElements(page: Page, target: Target): Promise<Suggestion[]> {
  const wanted = (target.text ?? target.name ?? target.label ?? target.placeholder ?? target.title ?? "").toLowerCase().trim();
  const items = await page.evaluate(() => {
    const out: Array<{ role: string; name: string }> = [];
    const seen = new Set<string>();
    const nodes = document.querySelectorAll(
      'a[href], button, input, select, textarea, summary, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="option"], [role="checkbox"], [role="combobox"], [role="searchbox"], [role="textbox"]',
    );
    for (const node of Array.from(nodes)) {
      const el = node as HTMLElement;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      const style = window.getComputedStyle(el);
      if (style.visibility === "hidden" || style.display === "none") continue;
      const tag = el.tagName.toLowerCase();
      const input = el as HTMLInputElement;
      let role = el.getAttribute("role") || "";
      if (!role) {
        if (tag === "a") role = "link";
        else if (tag === "button" || tag === "summary" || (tag === "input" && ["submit", "button", "reset"].includes(input.type))) role = "button";
        else if (tag === "select") role = "combobox";
        else if (tag === "input" && input.type === "checkbox") role = "checkbox";
        else if (tag === "input" && input.type === "radio") role = "radio";
        else if (tag === "input" && input.type === "search") role = "searchbox";
        else role = "textbox";
      }
      const labelled = input.labels && input.labels.length > 0 ? input.labels[0].innerText : "";
      const name = (
        el.getAttribute("aria-label") ||
        labelled ||
        (tag === "input" || tag === "textarea" ? input.placeholder || (["submit", "button"].includes(input.type) ? input.value : "") : el.innerText) ||
        el.getAttribute("title") ||
        ""
      )
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 80);
      if (!name) continue;
      const key = `${role}|${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ role, name });
      if (out.length >= 400) break;
    }
    return out;
  });

  if (!wanted) return items.slice(0, 8);
  const wantedTokens = new Set(wanted.split(/\W+/).filter(Boolean));
  const scored = items
    .map((item) => {
      const name = item.name.toLowerCase();
      let score = 0;
      if (name === wanted) score += 5;
      if (name.includes(wanted) || wanted.includes(name)) score += 3;
      const tokens = name.split(/\W+/).filter(Boolean);
      const overlap = tokens.filter((tok) => wantedTokens.has(tok)).length;
      score += overlap / Math.max(1, wantedTokens.size);
      if (name.startsWith(wanted.slice(0, 3))) score += 0.5;
      return { item, score };
    })
    .filter((s) => s.score > 0.3)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, 8).map((s) => s.item);
}

export interface ElementInfo {
  tag: string;
  type: string;
  role: string;
  autocomplete: string;
  name: string;
  id: string;
  placeholder: string;
  label: string;
  text: string;
  href: string;
  editable: boolean;
}

/** Facts about a resolved element that the safety policy needs. */
export async function inspectElement(locator: Locator, timeoutMs: number): Promise<ElementInfo> {
  return locator.evaluate(
    (node) => {
      const el = node as HTMLElement;
      const input = el as HTMLInputElement;
      const tag = el.tagName.toLowerCase();
      const labelledBy = (el.getAttribute("aria-labelledby") || "")
        .split(/\s+/)
        .map((id) => (id ? document.getElementById(id)?.innerText ?? "" : ""))
        .join(" ");
      const label = [input.labels ? Array.from(input.labels).map((l) => l.innerText).join(" ") : "", el.getAttribute("aria-label") || "", labelledBy]
        .join(" ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 200);
      const visibleText = (
        el.getAttribute("aria-label") ||
        (tag === "input" ? input.value : el.innerText) ||
        el.getAttribute("title") ||
        el.getAttribute("alt") ||
        ""
      )
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 200);
      const anchor = el.closest("a[href]") as HTMLAnchorElement | null;
      return {
        tag,
        type: (input.type || "").toLowerCase(),
        role: el.getAttribute("role") || "",
        autocomplete: el.getAttribute("autocomplete") || "",
        name: el.getAttribute("name") || "",
        id: el.id || "",
        placeholder: el.getAttribute("placeholder") || "",
        label,
        text: visibleText,
        href: anchor ? anchor.href : "",
        editable: el.isContentEditable || tag === "input" || tag === "textarea" || tag === "select",
      };
    },
    undefined,
    { timeout: timeoutMs },
  );
}
