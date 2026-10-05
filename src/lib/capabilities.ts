import { getConfig } from "./config";

export const EXAMPLE_REQUEST = {
  url: "https://example.com",
  actions: [
    { type: "click", target: { text: "Learn more" } },
    { type: "extract", target: { selector: "body" } },
    { type: "screenshot" },
  ],
};

/** Paid endpoints, their prices, and a minimal example body for each. */
export const PAID_ENDPOINTS = [
  {
    method: "POST",
    path: "/act",
    price_usdc: "0.50",
    description: "Run up to 20 browser actions in order and return the result, final URL and screenshot evidence.",
    example: EXAMPLE_REQUEST,
  },
  {
    method: "POST",
    path: "/extract",
    price_usdc: "0.15",
    description: "Text, links, tables or attributes from a page after its JavaScript has run.",
    fields: "url, selector (default body), format (text|links|table|html|attribute), attribute, all, max_chars, wait_for_selector, wait_for_text, wait_ms, screenshot",
    example: { url: "https://www.scrapethissite.com/pages/ajax-javascript/", selector: "table", format: "table", wait_for_selector: "table" },
  },
  {
    method: "POST",
    path: "/screenshot",
    price_usdc: "0.10",
    description: "PNG screenshot of a rendered page or one element.",
    fields: "url, selector, full_page, wait_for_selector, wait_for_text, wait_ms",
    example: { url: "https://example.com", full_page: true },
  },
  {
    method: "POST",
    path: "/download",
    price_usdc: "0.25",
    description: "A public file, directly by URL or behind a link/button on a page (max 15 MB). Returns filename, MIME type, size, SHA-256 and a link.",
    fields: "url, target (link/button text or {selector|text|role+name}), selector, filename",
    example: { url: "https://arxiv.org/abs/1706.03762", target: "View PDF" },
  },
];

/** What GET /capabilities returns: the contract a calling agent needs, nothing more. */
export function capabilities() {
  const config = getConfig();
  return {
    service: "Act402",
    capability: "browser.execute",
    description: "Execute browser actions in a real Chromium session.",
    actions: ["navigate", "click", "type", "select", "scroll", "wait", "extract", "screenshot"],
    endpoints: PAID_ENDPOINTS,
    free_endpoints: ["GET /health", "GET /capabilities"],
    targets: ["selector", "text", "role + name", "label", "placeholder"],
    billing: "Charged only on success (HTTP 200). Failed or blocked runs are free.",
    limits: {
      max_actions: config.maxActions,
      max_task_seconds: config.maxTaskDurationMs / 1000,
      max_screenshots: config.maxScreenshots,
      max_download_mb: config.maxDownloadBytes / 1048576,
      max_concurrent_browsers: config.maxBrowserSessions,
    },
    example_request: EXAMPLE_REQUEST,
  };
}
