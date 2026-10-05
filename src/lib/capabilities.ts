import { getConfig } from "./config";

export const EXAMPLE_REQUEST = {
  url: "https://example.com",
  actions: [
    { type: "click", target: { text: "Learn more" } },
    { type: "extract", target: { selector: "body" } },
    { type: "screenshot" },
  ],
};

/** What GET /capabilities returns: the contract a calling agent needs, nothing more. */
export function capabilities() {
  const config = getConfig();
  return {
    service: "Act402",
    capability: "browser.execute",
    description: "Execute browser actions in a real Chromium session.",
    actions: ["navigate", "click", "type", "select", "scroll", "wait", "extract", "screenshot"],
    endpoint: { method: "POST", path: "/act", price_usdc: "0.50" },
    targets: ["selector", "text", "role + name", "label", "placeholder"],
    limits: {
      max_actions: config.maxActions,
      max_task_seconds: config.maxTaskDurationMs / 1000,
      max_screenshots: config.maxScreenshots,
      max_concurrent_browsers: config.maxBrowserSessions,
    },
    example_request: EXAMPLE_REQUEST,
  };
}
