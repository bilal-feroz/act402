import { getConfig, PRICE_USDC, SERVICE_VERSION } from "./config";
import { ARIA_ROLES, KEYS, RETURN_FIELDS, WAIT_UNTIL } from "./act/schema";
import { DESCRIPTION, EXAMPLE_REQUESTS } from "./capabilities";
import { ERROR_STATUS } from "./errors";

const common = {
  id: { type: "string", maxLength: 64, description: "Your label for this step, echoed in `steps`." },
  optional: { type: "boolean", description: "Continue the task if this action fails." },
  timeout_ms: { type: "integer", minimum: 100, maximum: 60000 },
};

const target = { $ref: "#/components/schemas/Target" };

function action(type: string, properties: Record<string, unknown>, required: string[] = []) {
  return {
    type: "object",
    required: ["type", ...required],
    properties: { type: { const: type }, ...properties, ...common },
  };
}

export function openApiDocument(origin: string) {
  const config = getConfig();
  return {
    openapi: "3.1.0",
    info: {
      title: "Act402",
      version: SERVICE_VERSION,
      summary: "Give AI agents a browser they can actually control.",
      description: `${DESCRIPTION}\n\nPOST /act costs ${PRICE_USDC} USDC per successful execution through the XDC AI x402 gateway. Failed executions (non-2xx) are not charged.`,
    },
    servers: [...(config.gatewayUrl ? [{ url: config.gatewayUrl, description: "x402 paid gateway (XDC AI marketplace)" }] : []), { url: origin, description: "Origin" }],
    paths: {
      "/act": {
        post: {
          operationId: "act",
          summary: "Execute browser actions in a real Chromium session",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ActRequest" },
                examples: Object.fromEntries(Object.entries(EXAMPLE_REQUESTS).map(([k, v]) => [k, { value: v }])),
              },
            },
          },
          responses: {
            "200": { description: "Execution completed.", content: { "application/json": { schema: { $ref: "#/components/schemas/ActSuccess" } } } },
            ...Object.fromEntries(
              [...new Set(Object.values(ERROR_STATUS))].map((status) => [
                String(status),
                { description: `Error (${Object.entries(ERROR_STATUS).filter(([, s]) => s === status).map(([c]) => c).join(", ")})`, content: { "application/json": { schema: { $ref: "#/components/schemas/ActError" } } } },
              ]),
            ),
          },
        },
      },
      "/health": { get: { operationId: "health", summary: "Service status", responses: { "200": { description: "OK" } } } },
      "/capabilities": { get: { operationId: "capabilities", summary: "Machine-readable capability description", responses: { "200": { description: "OK" } } } },
    },
    components: {
      schemas: {
        Target: {
          description: "Element locator. Provide at least one of selector, text, role, name, label, placeholder, alt, title, test_id. A plain string is treated as {text}.",
          oneOf: [
            { type: "string" },
            {
              type: "object",
              properties: {
                selector: { type: "string", description: "CSS or Playwright selector" },
                text: { type: "string", description: "Visible text (case-insensitive substring unless exact)" },
                role: { type: "string", enum: ARIA_ROLES },
                name: { type: "string", description: "Accessible name (with role)" },
                label: { type: "string" },
                placeholder: { type: "string" },
                alt: { type: "string" },
                title: { type: "string" },
                test_id: { type: "string" },
                exact: { type: "boolean" },
                nth: { type: "integer", minimum: 0 },
              },
            },
          ],
        },
        Action: {
          oneOf: [
            action("navigate", { url: { type: "string" }, wait_until: { type: "string", enum: WAIT_UNTIL } }, ["url"]),
            action("click", { target, selector: { type: "string" }, double: { type: "boolean" }, force: { type: "boolean" } }),
            action("type", { target, selector: { type: "string" }, value: { type: "string" }, clear: { type: "boolean" }, submit: { type: "boolean" }, delay_ms: { type: "integer" } }, ["value"]),
            action("select", { target, selector: { type: "string" }, value: { oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] }, label: { type: "string" }, index: { type: "integer" } }),
            action("check", { target, selector: { type: "string" } }),
            action("uncheck", { target, selector: { type: "string" } }),
            action("hover", { target, selector: { type: "string" } }),
            action("press", { key: { type: "string", enum: KEYS }, target }, ["key"]),
            action("scroll", { direction: { type: "string", enum: ["up", "down", "top", "bottom"] }, amount: { type: "integer" }, target }),
            action("wait", {
              milliseconds: { type: "integer", maximum: 15000 },
              target,
              state: { type: "string", enum: ["visible", "hidden", "attached", "detached"] },
              text: { type: "string" },
              url_contains: { type: "string" },
              load_state: { type: "string", enum: ["load", "domcontentloaded", "networkidle"] },
            }),
            action("extract", {
              target,
              selector: { type: "string" },
              format: { type: "string", enum: ["text", "html", "links", "table", "attribute"] },
              attribute: { type: "string" },
              all: { type: "boolean" },
              max_chars: { type: "integer", minimum: 100, maximum: 50000 },
              name: { type: "string" },
            }),
            action("screenshot", { target, full_page: { type: "boolean" }, name: { type: "string" } }),
            action("download", { target, url: { type: "string" }, filename: { type: "string" } }),
            action("back", {}),
          ],
          discriminator: { propertyName: "type" },
        },
        ActRequest: {
          type: "object",
          required: ["url"],
          properties: {
            url: { type: "string", format: "uri" },
            actions: { type: "array", maxItems: config.maxActions, items: { $ref: "#/components/schemas/Action" } },
            goal: { type: "string", maxLength: 1000 },
            timeout_seconds: { type: "number", minimum: 5, maximum: config.maxTaskDurationMs / 1000 },
            return: { type: "array", items: { type: "string", enum: RETURN_FIELDS } },
            viewport: { type: "object", properties: { width: { type: "integer" }, height: { type: "integer" } } },
            wait_until: { type: "string", enum: WAIT_UNTIL },
            dismiss_cookie_banners: { type: "boolean" },
            final_screenshot: { type: "boolean" },
            max_steps: { type: "integer", minimum: 1, maximum: config.maxGoalSteps },
          },
        },
        Evidence: {
          type: "object",
          properties: {
            type: { const: "screenshot" },
            name: { type: "string" },
            url: { type: "string" },
            source_url: { type: "string" },
            captured_at: { type: "string", format: "date-time" },
            bytes: { type: "integer" },
            text_excerpt: { type: "string" },
          },
        },
        Step: {
          type: "object",
          properties: {
            index: { type: "integer" },
            id: { type: "string" },
            type: { type: "string" },
            status: { type: "string", enum: ["ok", "failed", "skipped"] },
            duration_ms: { type: "integer" },
            detail: { type: "string" },
            url: { type: "string" },
            error: { type: "object", properties: { code: { type: "string" }, message: { type: "string" } } },
          },
        },
        ActSuccess: {
          type: "object",
          properties: {
            success: { const: true },
            status: { const: "completed" },
            task_id: { type: "string", pattern: "^act_[a-f0-9]{24}$" },
            mode: { type: "string", enum: ["actions", "goal", "visit"] },
            result: {
              type: "object",
              properties: {
                answer: { type: "string" },
                summary: { type: "string" },
                confidence: { type: "number" },
                text: { type: "string" },
                final_url: { type: "string" },
                title: { type: "string" },
                extracts: { type: "array", items: { type: "object" } },
                downloads: { type: "array", items: { type: "object" } },
              },
            },
            actions_executed: { type: "integer" },
            duration_ms: { type: "integer" },
            browser: { type: "object" },
            evidence: { type: "array", items: { $ref: "#/components/schemas/Evidence" } },
            download: { type: "object" },
            steps: { type: "array", items: { $ref: "#/components/schemas/Step" } },
            warnings: { type: "array", items: { type: "string" } },
          },
        },
        ActError: {
          type: "object",
          properties: {
            success: { const: false },
            status: { type: "string", enum: ["failed", "blocked"] },
            task_id: { type: "string" },
            error: {
              type: "object",
              properties: { code: { type: "string", enum: Object.keys(ERROR_STATUS) }, message: { type: "string" }, details: { type: "object" } },
            },
            steps: { type: "array", items: { $ref: "#/components/schemas/Step" } },
          },
        },
      },
    },
  };
}
