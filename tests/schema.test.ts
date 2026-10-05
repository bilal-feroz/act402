import { describe, expect, it } from "vitest";
import { getConfig } from "@/lib/config";
import { Act402Error } from "@/lib/errors";
import { parseActRequest } from "@/lib/act/schema";

const config = getConfig();

function parse(body: unknown) {
  return parseActRequest(body, config);
}

function expectError(body: unknown, code: string): Act402Error {
  try {
    parse(body);
  } catch (err) {
    expect(err).toBeInstanceOf(Act402Error);
    expect((err as Act402Error).code).toBe(code);
    return err as Act402Error;
  }
  throw new Error(`expected ${code}`);
}

describe("parseActRequest", () => {
  it("accepts the canonical example", () => {
    const { request, warnings } = parse({
      url: "https://example.com",
      actions: [{ type: "click", target: { text: "More information" } }, { type: "extract", selector: "body" }, { type: "screenshot" }],
    });
    expect(request.mode).toBe("actions");
    expect(request.actions).toHaveLength(3);
    expect(request.actions[1]).toMatchObject({ type: "extract", target: { selector: "body" } });
    expect(request.timeoutMs).toBe(config.maxTaskDurationMs);
    expect(warnings).toEqual([]);
  });

  it("supports role+name, label, placeholder and string targets", () => {
    const { request } = parse({
      url: "https://example.com",
      actions: [
        { type: "type", target: { role: "textbox", name: "Search" }, value: "XDC" },
        { type: "click", target: { role: "Button", name: "Search" } },
        { type: "type", target: { label: "Email" }, value: "x" },
        { type: "type", target: { placeholder: "City" }, value: "Dubai" },
        { type: "click", target: "Pricing" },
      ],
    });
    expect(request.actions[1]).toMatchObject({ target: { role: "button" } });
    expect(request.actions[4]).toMatchObject({ target: { text: "Pricing" } });
  });

  it("maps aliases (fill, goto, sleep, css, text for type)", () => {
    const { request } = parse({
      url: "https://example.com",
      actions: [
        { type: "goto", url: "/pricing" },
        { type: "fill", target: { css: "#q" }, text: "hello" },
        { type: "sleep", ms: 500 },
        { action: "get_text", selector: ".price" },
        { type: "press", key: "enter" },
      ],
    });
    expect(request.actions.map((a) => a.type)).toEqual(["navigate", "type", "wait", "extract", "press"]);
    expect(request.actions[1]).toMatchObject({ target: { selector: "#q" }, value: "hello" });
    expect(request.actions[2]).toMatchObject({ milliseconds: 500 });
    expect(request.actions[4]).toMatchObject({ key: "Enter" });
  });

  it("executes explicit actions only: goal-only requests are rejected", () => {
    expectError({ url: "https://example.com", goal: "Find the pricing page" }, "INVALID_REQUEST");
    expect(parse({ url: "https://example.com" }).request.mode).toBe("visit");
    const both = parse({ url: "https://example.com", goal: "x y z", actions: [{ type: "extract" }] });
    expect(both.request.mode).toBe("actions");
    expect(both.warnings.join(" ")).toMatch(/goal/);
  });

  it("rejects unsupported actions with the supported list", () => {
    const err = expectError({ url: "https://example.com", actions: [{ type: "evaluate", script: "1" }] }, "UNSUPPORTED_ACTION");
    expect(err.details?.supported_actions).toContain("click");
  });

  it("enforces the action limit", () => {
    const actions = Array.from({ length: config.maxActions + 1 }, () => ({ type: "extract" }));
    expectError({ url: "https://example.com", actions }, "STEP_LIMIT_REACHED");
  });

  it("enforces the screenshot limit", () => {
    const actions = Array.from({ length: config.maxScreenshots + 1 }, () => ({ type: "screenshot" }));
    expectError({ url: "https://example.com", actions }, "STEP_LIMIT_REACHED");
  });

  it("reports precise validation paths", () => {
    const err = expectError({ url: "https://example.com", actions: [{ type: "click" }] }, "INVALID_REQUEST");
    expect(JSON.stringify(err.details)).toContain("actions[0]");
    expectError({ actions: [] }, "INVALID_REQUEST");
    expectError("nope", "INVALID_REQUEST");
    expectError({ url: "https://example.com", actions: [{ type: "wait" }] }, "INVALID_REQUEST");
    expectError({ url: "https://example.com", actions: [{ type: "wait", milliseconds: 5, text: "x" }] }, "INVALID_REQUEST");
    expectError({ url: "https://example.com", actions: [{ type: "extract", format: "attribute" }] }, "INVALID_REQUEST");
    expectError({ url: "https://example.com", actions: [{ type: "select", target: "#x" }] }, "INVALID_REQUEST");
    expectError({ url: "https://example.com", actions: [{ type: "click", target: { colour: "red" } }] }, "INVALID_REQUEST");
    expectError({ url: "https://example.com", return: ["everything"] }, "INVALID_REQUEST");
    expectError({ url: "https://example.com", viewport: { width: 10, height: 10 } }, "INVALID_REQUEST");
  });

  it("caps timeout_seconds at the configured maximum", () => {
    const { request, warnings } = parse({ url: "https://example.com", timeout_seconds: 9999 });
    expect(request.timeoutMs).toBe(config.maxTaskDurationMs);
    expect(warnings.join(" ")).toMatch(/capped/);
  });

  it("normalizes return aliases and warns about unknown top-level fields", () => {
    const { request, warnings } = parse({ url: "https://example.com", return: ["screenshot", "final_url"], callback: "x" });
    expect([...request.returnFields]).toEqual(["screenshots", "final_url"]);
    expect(warnings.join(" ")).toMatch(/callback/);
  });
});
