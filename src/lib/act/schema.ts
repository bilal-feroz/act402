import { z } from "zod";
import { Act402Error } from "../errors";
import type { Act402Config } from "../config";

export const ARIA_ROLES = [
  "alert", "alertdialog", "application", "article", "banner", "blockquote", "button", "caption", "cell",
  "checkbox", "code", "columnheader", "combobox", "complementary", "contentinfo", "definition", "deletion",
  "dialog", "directory", "document", "emphasis", "feed", "figure", "form", "generic", "grid", "gridcell",
  "group", "heading", "img", "insertion", "link", "list", "listbox", "listitem", "log", "main", "marquee",
  "math", "meter", "menu", "menubar", "menuitem", "menuitemcheckbox", "menuitemradio", "navigation", "none",
  "note", "option", "paragraph", "presentation", "progressbar", "radio", "radiogroup", "region", "row",
  "rowgroup", "rowheader", "scrollbar", "search", "searchbox", "separator", "slider", "spinbutton", "status",
  "strong", "subscript", "superscript", "switch", "tab", "table", "tablist", "tabpanel", "term", "textbox",
  "time", "timer", "toolbar", "tooltip", "tree", "treegrid", "treeitem",
] as const;
export type AriaRole = (typeof ARIA_ROLES)[number];

export const ACTION_TYPES = [
  "navigate", "click", "type", "select", "check", "uncheck", "hover", "press",
  "scroll", "wait", "extract", "screenshot", "download", "back",
] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

const ACTION_ALIASES: Record<string, ActionType> = {
  goto: "navigate", open: "navigate", visit: "navigate", go: "navigate",
  fill: "type", input: "type", type_text: "type", enter_text: "type",
  select_option: "select", choose: "select",
  keypress: "press", key: "press", press_key: "press",
  sleep: "wait", wait_for: "wait", pause: "wait",
  get_text: "extract", extract_text: "extract", read: "extract", scrape: "extract", get: "extract",
  capture: "screenshot", snapshot: "screenshot", screen_shot: "screenshot",
  go_back: "back",
};

export const KEYS = [
  "Enter", "Escape", "Tab", "Backspace", "Delete", "Space", "ArrowUp", "ArrowDown",
  "ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End",
] as const;

export const WAIT_UNTIL = ["load", "domcontentloaded", "networkidle", "commit"] as const;
export type WaitUntil = (typeof WAIT_UNTIL)[number];

export const RETURN_FIELDS = [
  "answer", "text", "final_url", "title", "extracts", "screenshots", "downloads",
  "steps", "links", "download_links", "page_text", "metadata",
] as const;
export type ReturnField = (typeof RETURN_FIELDS)[number];

const RETURN_ALIASES: Record<string, ReturnField> = {
  screenshot: "screenshots", evidence: "screenshots", actions: "steps", step: "steps",
  download: "downloads", files: "downloads", url: "final_url", result: "answer",
};

export const DEFAULT_RETURN: ReadonlySet<ReturnField> = new Set<ReturnField>([
  "answer", "text", "final_url", "title", "extracts", "screenshots", "downloads", "steps",
]);

const LOCATOR_KEYS = ["selector", "text", "role", "name", "label", "placeholder", "alt", "title", "test_id"] as const;

const TargetSchema = z
  .object({
    selector: z.string().min(1).max(1000).optional(),
    text: z.string().min(1).max(500).optional(),
    role: z.enum(ARIA_ROLES).optional(),
    name: z.string().min(1).max(500).optional(),
    label: z.string().min(1).max(500).optional(),
    placeholder: z.string().min(1).max(500).optional(),
    alt: z.string().min(1).max(500).optional(),
    title: z.string().min(1).max(500).optional(),
    test_id: z.string().min(1).max(200).optional(),
    exact: z.boolean().optional(),
    nth: z.number().int().min(0).max(1000).optional(),
  })
  .refine((t) => LOCATOR_KEYS.some((k) => t[k] !== undefined), {
    message: `target needs at least one of: ${LOCATOR_KEYS.join(", ")}`,
  });
export type Target = z.infer<typeof TargetSchema>;

const common = {
  id: z.string().max(64).optional(),
  optional: z.boolean().optional(),
  timeout_ms: z.number().int().min(100).max(60_000).optional(),
};

const ActionSchemas = {
  navigate: z.object({ type: z.literal("navigate"), url: z.string().min(1).max(2048), wait_until: z.enum(WAIT_UNTIL).optional(), ...common }),
  click: z.object({ type: z.literal("click"), target: TargetSchema, double: z.boolean().optional(), force: z.boolean().optional(), ...common }),
  type: z.object({
    type: z.literal("type"),
    target: TargetSchema,
    value: z.string().max(5000),
    clear: z.boolean().optional(),
    submit: z.boolean().optional(),
    delay_ms: z.number().int().min(0).max(250).optional(),
    ...common,
  }),
  select: z
    .object({
      type: z.literal("select"),
      target: TargetSchema,
      value: z.union([z.string().max(500), z.array(z.string().max(500)).min(1).max(20)]).optional(),
      label: z.string().max(500).optional(),
      index: z.number().int().min(0).max(1000).optional(),
      ...common,
    })
    .refine((a) => a.value !== undefined || a.label !== undefined || a.index !== undefined, { message: "select needs `value`, `label`, or `index`" }),
  check: z.object({ type: z.literal("check"), target: TargetSchema, ...common }),
  uncheck: z.object({ type: z.literal("uncheck"), target: TargetSchema, ...common }),
  hover: z.object({ type: z.literal("hover"), target: TargetSchema, ...common }),
  press: z.object({ type: z.literal("press"), key: z.enum(KEYS), target: TargetSchema.optional(), ...common }),
  scroll: z
    .object({
      type: z.literal("scroll"),
      direction: z.enum(["up", "down", "top", "bottom"]).optional(),
      amount: z.number().int().min(1).max(50_000).optional(),
      target: TargetSchema.optional(),
      ...common,
    })
    .refine((a) => a.direction !== undefined || a.target !== undefined, { message: "scroll needs `direction` or `target`" }),
  wait: z
    .object({
      type: z.literal("wait"),
      milliseconds: z.number().int().min(0).max(15_000).optional(),
      target: TargetSchema.optional(),
      state: z.enum(["visible", "hidden", "attached", "detached"]).optional(),
      text: z.string().min(1).max(500).optional(),
      url_contains: z.string().min(1).max(500).optional(),
      load_state: z.enum(["load", "domcontentloaded", "networkidle"]).optional(),
      ...common,
    })
    .refine(
      (a) => [a.milliseconds, a.target, a.text, a.url_contains, a.load_state].filter((v) => v !== undefined).length === 1,
      { message: "wait needs exactly one of `milliseconds`, `target`, `text`, `url_contains`, `load_state`" },
    ),
  extract: z
    .object({
      type: z.literal("extract"),
      target: TargetSchema.optional(),
      format: z.enum(["text", "html", "links", "table", "attribute"]).optional(),
      attribute: z.string().regex(/^[a-zA-Z_:][-a-zA-Z0-9_:.]{0,60}$/).optional(),
      all: z.boolean().optional(),
      max_chars: z.number().int().min(100).max(50_000).optional(),
      name: z.string().max(64).optional(),
      ...common,
    })
    .refine((a) => a.format !== "attribute" || a.attribute !== undefined, { message: "format \"attribute\" needs `attribute`" }),
  screenshot: z.object({ type: z.literal("screenshot"), target: TargetSchema.optional(), full_page: z.boolean().optional(), name: z.string().max(64).optional(), ...common }),
  download: z
    .object({ type: z.literal("download"), target: TargetSchema.optional(), url: z.string().min(1).max(2048).optional(), filename: z.string().max(120).optional(), ...common })
    .refine((a) => a.target !== undefined || a.url !== undefined, { message: "download needs `target` or `url`" }),
  back: z.object({ type: z.literal("back"), ...common }),
} satisfies Record<ActionType, z.ZodType>;

export type Action = { [K in ActionType]: z.infer<(typeof ActionSchemas)[K]> }[ActionType];
export type ActionOf<T extends ActionType> = Extract<Action, { type: T }>;

export type ActMode = "actions" | "goal" | "visit";

export interface ActRequest {
  url: string;
  mode: ActMode;
  actions: Action[];
  goal?: string;
  timeoutMs: number;
  returnFields: ReadonlySet<ReturnField>;
  viewport: { width: number; height: number };
  waitUntil: WaitUntil;
  dismissCookieBanners: boolean;
  finalScreenshot: boolean;
  maxSteps: number;
  /** false = do not load `url` first (direct file download). */
  openUrl?: boolean;
  /** Fail (and so never charge) unless a file was downloaded. */
  requireDownload?: boolean;
}

export interface ValidationIssue {
  path: string;
  message: string;
}

const TOP_LEVEL_KEYS = new Set([
  "url", "actions", "goal", "timeout_seconds", "return", "viewport", "wait_until",
  "dismiss_cookie_banners", "final_screenshot", "max_steps",
]);

// Accept `target` shorthands so agents can write {"selector": "body"} or {"target": "Pricing"}.
function normalizeTarget(raw: unknown): unknown {
  if (typeof raw === "string") return { text: raw };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const t = { ...(raw as Record<string, unknown>) };
  const alias = (from: string, to: string, map?: (v: unknown) => unknown) => {
    if (t[from] !== undefined && t[to] === undefined) t[to] = map ? map(t[from]) : t[from];
    delete t[from];
  };
  alias("css", "selector");
  alias("xpath", "selector", (v) => (typeof v === "string" && !v.startsWith("xpath=") ? `xpath=${v}` : v));
  alias("aria_label", "label");
  alias("ariaLabel", "label");
  alias("testId", "test_id");
  alias("data_testid", "test_id");
  alias("index", "nth");
  alias("contains", "text");
  if (typeof t.role === "string") t.role = t.role.toLowerCase();
  return t;
}

const TARGET_SHORTHAND_TYPES = new Set<ActionType>(["click", "hover", "check", "uncheck", "extract", "screenshot", "download", "select", "scroll"]);

function normalizeAction(raw: unknown, index: number, issues: ValidationIssue[]): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    issues.push({ path: `actions[${index}]`, message: "each action must be an object with a `type`" });
    return null;
  }
  const a = { ...(raw as Record<string, unknown>) };
  const rawType = typeof a.type === "string" ? a.type.trim().toLowerCase() : a.action ?? a.op;
  const typeName = typeof rawType === "string" ? rawType.trim().toLowerCase() : "";
  delete a.action;
  delete a.op;
  const type = (ACTION_TYPES as readonly string[]).includes(typeName) ? (typeName as ActionType) : ACTION_ALIASES[typeName];
  if (!type) {
    throw new Act402Error("UNSUPPORTED_ACTION", `actions[${index}].type "${String(rawType ?? "")}" is not supported.`, {
      supported_actions: ACTION_TYPES,
      action_index: index,
    });
  }
  a.type = type;

  if (type === "type") {
    if (a.value === undefined && typeof a.text === "string") a.value = a.text;
    delete a.text;
  }
  if (a.target === undefined && typeof a.selector === "string") a.target = { selector: a.selector };
  delete a.selector;
  if (a.target === undefined && TARGET_SHORTHAND_TYPES.has(type) && typeof a.text === "string") {
    a.target = { text: a.text };
    delete a.text;
  }
  if (a.target !== undefined) a.target = normalizeTarget(a.target);
  if (type === "wait" && a.milliseconds === undefined && typeof a.ms === "number") {
    a.milliseconds = a.ms;
    delete a.ms;
  }
  if (type === "press" && typeof a.key === "string") {
    const match = KEYS.find((k) => k.toLowerCase() === (a.key as string).toLowerCase());
    if (match) a.key = match;
  }
  return a;
}

function zodIssues(prefix: string, error: z.ZodError): ValidationIssue[] {
  return error.issues.map((issue) => ({
    path: [prefix, ...issue.path.map((p) => (typeof p === "number" ? `[${p}]` : `.${String(p)}`))].join("").replace(/^\./, ""),
    message: issue.message,
  }));
}

export interface ParsedRequest {
  request: ActRequest;
  warnings: string[];
}

/** Validate and normalize a POST /act body. Throws Act402Error on invalid input. */
export function parseActRequest(body: unknown, config: Act402Config, overrides?: { maxActions?: number; maxDurationMs?: number }): ParsedRequest {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Act402Error("INVALID_REQUEST", "Request body must be a JSON object.", {
      example: { url: "https://example.com", actions: [{ type: "extract", selector: "body" }] },
    });
  }
  const raw = body as Record<string, unknown>;
  const issues: ValidationIssue[] = [];
  const warnings: string[] = [];

  for (const key of Object.keys(raw)) {
    if (!TOP_LEVEL_KEYS.has(key)) warnings.push(`Unknown field "${key}" was ignored.`);
  }

  if (typeof raw.url !== "string" || raw.url.trim() === "") {
    issues.push({ path: "url", message: "url is required (absolute http/https URL)" });
  }

  const maxActions = overrides?.maxActions ?? config.maxActions;
  const maxDurationMs = overrides?.maxDurationMs ?? config.maxTaskDurationMs;

  const actions: Action[] = [];
  if (raw.actions !== undefined) {
    if (!Array.isArray(raw.actions)) {
      issues.push({ path: "actions", message: "actions must be an array" });
    } else if (raw.actions.length > maxActions) {
      throw new Act402Error("STEP_LIMIT_REACHED", `Too many actions: ${raw.actions.length} (maximum ${maxActions} per task).`, { max_actions: maxActions });
    } else {
      raw.actions.forEach((item, i) => {
        const normalized = normalizeAction(item, i, issues);
        if (!normalized) return;
        const schema = ActionSchemas[normalized.type as ActionType];
        const parsed = schema.safeParse(normalized);
        if (!parsed.success) {
          issues.push(...zodIssues(`actions[${i}]`, parsed.error));
          return;
        }
        const known = new Set(Object.keys((schema as z.ZodObject<z.ZodRawShape>).shape ?? {}));
        for (const key of Object.keys(normalized)) {
          if (known.size > 0 && !known.has(key)) warnings.push(`actions[${i}]: unknown field "${key}" was ignored.`);
        }
        actions.push(parsed.data as Action);
      });
    }
  }

  let goal: string | undefined;
  if (raw.goal !== undefined) {
    if (typeof raw.goal !== "string" || raw.goal.trim().length < 3 || raw.goal.length > 1000) {
      issues.push({ path: "goal", message: "goal must be a string of 3-1000 characters" });
    } else {
      goal = raw.goal.trim();
    }
  }

  let timeoutMs = maxDurationMs;
  if (raw.timeout_seconds !== undefined) {
    const t = Number(raw.timeout_seconds);
    if (!Number.isFinite(t) || t < 5) issues.push({ path: "timeout_seconds", message: "timeout_seconds must be a number >= 5" });
    else {
      timeoutMs = Math.min(Math.round(t * 1000), maxDurationMs);
      if (t * 1000 > maxDurationMs) warnings.push(`timeout_seconds capped at ${maxDurationMs / 1000}.`);
    }
  }

  let maxSteps = config.maxGoalSteps;
  if (raw.max_steps !== undefined) {
    const s = Number(raw.max_steps);
    if (!Number.isInteger(s) || s < 1) issues.push({ path: "max_steps", message: "max_steps must be a positive integer" });
    else maxSteps = Math.min(s, config.maxGoalSteps);
  }

  const returnFields = new Set<ReturnField>();
  if (raw.return !== undefined) {
    if (!Array.isArray(raw.return)) issues.push({ path: "return", message: "return must be an array of strings" });
    else {
      for (const item of raw.return) {
        const key = typeof item === "string" ? item.trim().toLowerCase() : "";
        const field = (RETURN_FIELDS as readonly string[]).includes(key) ? (key as ReturnField) : RETURN_ALIASES[key];
        if (field) returnFields.add(field);
        else issues.push({ path: "return", message: `unknown return value "${String(item)}" (allowed: ${RETURN_FIELDS.join(", ")})` });
      }
    }
  }

  let viewport = { width: 1280, height: 800 };
  if (raw.viewport !== undefined) {
    const v = raw.viewport as Record<string, unknown> | null;
    const w = Number(v?.width);
    const h = Number(v?.height);
    if (!v || !Number.isInteger(w) || !Number.isInteger(h) || w < 320 || w > 1920 || h < 320 || h > 1440) {
      issues.push({ path: "viewport", message: "viewport must be {width: 320-1920, height: 320-1440}" });
    } else viewport = { width: w, height: h };
  }

  let waitUntil: WaitUntil = "load";
  if (raw.wait_until !== undefined) {
    if (typeof raw.wait_until !== "string" || !(WAIT_UNTIL as readonly string[]).includes(raw.wait_until)) {
      issues.push({ path: "wait_until", message: `wait_until must be one of ${WAIT_UNTIL.join(", ")}` });
    } else waitUntil = raw.wait_until as WaitUntil;
  }

  for (const flag of ["dismiss_cookie_banners", "final_screenshot"] as const) {
    if (raw[flag] !== undefined && typeof raw[flag] !== "boolean") issues.push({ path: flag, message: `${flag} must be a boolean` });
  }

  if (issues.length > 0) {
    throw new Act402Error("INVALID_REQUEST", `Request validation failed: ${issues[0].path} - ${issues[0].message}`, { issues });
  }

  const screenshotActions = actions.filter((a) => a.type === "screenshot").length;
  if (screenshotActions > config.maxScreenshots) {
    throw new Act402Error("STEP_LIMIT_REACHED", `Too many screenshot actions: ${screenshotActions} (maximum ${config.maxScreenshots}).`, { max_screenshots: config.maxScreenshots });
  }
  const downloadActions = actions.filter((a) => a.type === "download").length;
  if (downloadActions > config.maxDownloads) {
    throw new Act402Error("STEP_LIMIT_REACHED", `Too many download actions: ${downloadActions} (maximum ${config.maxDownloads}).`, { max_downloads: config.maxDownloads });
  }

  let mode: ActMode = "visit";
  if (actions.length > 0) {
    mode = "actions";
    if (goal) warnings.push("`goal` is not supported and was ignored; only `actions` were executed.");
  } else if (goal) {
    throw new Act402Error("INVALID_REQUEST", "Act402 executes explicit browser actions; send an `actions` array instead of a natural-language `goal`.", {
      example: { url: raw.url, actions: [{ type: "click", target: { text: "Pricing" } }, { type: "extract", target: { selector: "body" } }] },
    });
  }

  return {
    request: {
      url: (raw.url as string).trim(),
      mode,
      actions,
      goal,
      timeoutMs,
      returnFields: returnFields.size > 0 ? returnFields : DEFAULT_RETURN,
      viewport,
      waitUntil,
      dismissCookieBanners: raw.dismiss_cookie_banners !== false,
      finalScreenshot: raw.final_screenshot !== false,
      maxSteps,
    },
    warnings,
  };
}

/** Human-readable one-liner for a target, used in step logs and errors. */
export function describeTarget(target: Target | undefined): string {
  if (!target) return "page";
  const parts: string[] = [];
  if (target.role) parts.push(target.name ? `${target.role} "${target.name}"` : target.role);
  else if (target.name) parts.push(`"${target.name}"`);
  if (target.text) parts.push(`text "${target.text}"`);
  if (target.label) parts.push(`label "${target.label}"`);
  if (target.placeholder) parts.push(`placeholder "${target.placeholder}"`);
  if (target.alt) parts.push(`alt "${target.alt}"`);
  if (target.title) parts.push(`title "${target.title}"`);
  if (target.test_id) parts.push(`test_id "${target.test_id}"`);
  if (target.selector) parts.push(`selector ${target.selector}`);
  if (target.nth !== undefined) parts.push(`#${target.nth}`);
  return parts.join(", ");
}
