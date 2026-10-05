#!/usr/bin/env node
// Smoke tests for a running Act402 deployment.
//   node scripts/smoke.mjs                         -> http://localhost:3000
//   node scripts/smoke.mjs https://act402.replit.app
//   ACT402_KEY=... node scripts/smoke.mjs <url>    -> sends the gateway key
//   node scripts/smoke.mjs <url> dynamic_loading    -> run one scenario

const base = (process.argv[2] || process.env.ACT402_URL || "http://localhost:3000").replace(/\/+$/, "");
const only = process.argv[3];
const key = process.env.ACT402_KEY || "";

const scenarios = [
  {
    name: "click_extract_screenshot",
    body: {
      url: "https://example.com",
      actions: [
        { type: "click", target: { text: "Learn more" } },
        { type: "extract", selector: "body" },
        { type: "screenshot" },
      ],
    },
    expect: (r, s) => s === 200 && r.result.final_url.includes("iana.org") && /Example Domains/.test(r.result.text) && r.evidence.length >= 1,
  },
  {
    name: "delayed_js_content_wait",
    body: {
      url: "https://quotes.toscrape.com/js-delayed/",
      actions: [
        { type: "wait", target: { selector: ".quote" }, timeout_ms: 20000 },
        { type: "extract", target: { selector: ".quote .text" }, all: true, name: "quotes" },
      ],
    },
    expect: (r, s) => s === 200 && (r.result.extracts?.[0]?.items?.length ?? 0) >= 5,
  },
  {
    name: "search_form_table",
    body: {
      url: "https://www.scrapethissite.com/pages/forms/",
      actions: [
        { type: "type", target: { placeholder: "Search for Teams" }, value: "Boston", submit: true },
        { type: "wait", target: { selector: "tr.team" } },
        { type: "extract", target: { selector: "table.table" }, format: "table" },
      ],
    },
    expect: (r, s) => s === 200 && JSON.stringify(r.result.extracts ?? r.result).includes("Boston Bruins"),
  },
  {
    name: "javascript_tab",
    body: {
      url: "https://www.scrapethissite.com/pages/ajax-javascript/",
      actions: [
        { type: "click", target: { text: "2012" } },
        { type: "wait", target: { selector: "#table-body tr" } },
        { type: "extract", target: { selector: "table" }, format: "table" },
      ],
    },
    expect: (r, s) => s === 200 && JSON.stringify(r.result.extracts ?? r.result).includes("Argo"),
  },
  {
    name: "category_filter_all_titles",
    body: {
      url: "https://books.toscrape.com",
      actions: [
        { type: "click", target: { text: "Travel" } },
        { type: "extract", target: { selector: "article.product_pod h3 a" }, format: "attribute", attribute: "title", all: true, name: "titles" },
        { type: "extract", target: { selector: "article.product_pod .price_color" }, all: true, name: "prices" },
      ],
    },
    expect: (r, s) => s === 200 && r.result.final_url.includes("travel") && (r.result.extracts?.[0]?.items?.length ?? 0) > 3,
  },
  {
    name: "select_dropdown",
    body: {
      url: "https://www.scrapethissite.com/pages/forms/",
      actions: [
        { type: "select", target: { selector: "#per_page" }, value: "100" },
        { type: "wait", url_contains: "per_page=100" },
        { type: "extract", target: { selector: "table.table" }, format: "table" },
      ],
    },
    expect: (r, s) => s === 200 && r.result.final_url.includes("per_page=100") && (r.result.extracts?.[0]?.table?.rows?.length ?? 0) >= 100,
  },
  {
    name: "download_public_pdf",
    body: {
      url: "https://arxiv.org/abs/1706.03762",
      actions: [{ type: "download", target: { text: "View PDF" } }],
    },
    expect: (r, s) => s === 200 && r.download?.mime_type === "application/pdf" && r.download.size_bytes > 100_000,
  },
  {
    name: "goal_mode_heuristic",
    body: { url: "https://books.toscrape.com", goal: "Open the Travel category and return the price of the first book" },
    expect: (r, s) => s === 200 && /£\s?\d/.test(r.result.answer ?? ""),
  },
  {
    name: "visit_mode",
    body: { url: "https://example.com" },
    expect: (r, s) => s === 200 && /documentation examples/.test(r.result.text) && r.evidence?.[0]?.name === "final.png",
  },
  // ---- safety: these must be refused ----
  {
    name: "ssrf_localhost_blocked",
    body: { url: "http://127.0.0.1:3000/health", actions: [{ type: "extract" }] },
    expect: (r, s) => s === 403 && r.error.code === "BLOCKED_URL",
  },
  {
    name: "ssrf_metadata_blocked",
    body: { url: "http://169.254.169.254/latest/meta-data/" },
    expect: (r, s) => s === 403 && r.error.code === "BLOCKED_URL",
  },
  {
    name: "ssrf_redirect_blocked",
    body: { url: "https://httpbin.org/redirect-to?url=http%3A%2F%2F127.0.0.1%3A8080%2F", actions: [{ type: "extract" }] },
    expect: (r, s) => s === 403 && r.error.code === "BLOCKED_URL",
  },
  {
    name: "scheme_blocked",
    body: { url: "file:///etc/passwd" },
    expect: (r, s) => s === 403 && r.error.code === "BLOCKED_URL",
  },
  {
    name: "purchase_refused",
    body: { url: "https://books.toscrape.com", actions: [{ type: "click", target: { text: "Buy now" } }] },
    expect: (r, s) => s === 403 && r.error.code === "ACTION_REQUIRES_AUTHORIZATION",
  },
  {
    name: "card_number_refused",
    body: { url: "https://example.com", actions: [{ type: "type", target: { selector: "input" }, value: "4111 1111 1111 1111" }] },
    expect: (r, s) => s === 403 && r.error.code === "SENSITIVE_INPUT_REJECTED",
  },
  {
    name: "unsupported_action",
    body: { url: "https://example.com", actions: [{ type: "evaluate", script: "alert(1)" }] },
    expect: (r, s) => s === 400 && r.error.code === "UNSUPPORTED_ACTION",
  },
];

async function run(s) {
  const started = Date.now();
  try {
    const res = await fetch(`${base}/act`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(key ? { "x-act402-key": key } : {}) },
      body: JSON.stringify(s.body),
      signal: AbortSignal.timeout(90_000),
    });
    const json = await res.json();
    const ok = Boolean(s.expect(json, res.status));
    return { name: s.name, ok, status: res.status, ms: Date.now() - started, code: json.error?.code ?? "", note: json.error?.message ?? json.result?.answer ?? "" };
  } catch (err) {
    return { name: s.name, ok: false, status: 0, ms: Date.now() - started, code: "CLIENT_ERROR", note: String(err) };
  }
}

const selected = only ? scenarios.filter((s) => s.name.includes(only)) : scenarios;
console.log(`Act402 smoke tests against ${base} (${selected.length} scenarios)\n`);
let failed = 0;
for (const s of selected) {
  const r = await run(s);
  if (!r.ok) failed++;
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name.padEnd(28)} HTTP ${String(r.status).padEnd(4)} ${String(r.ms).padStart(6)} ms  ${r.code} ${String(r.note).slice(0, 110)}`);
}
console.log(`\n${selected.length - failed}/${selected.length} passed`);
process.exit(failed > 0 ? 1 : 0);
