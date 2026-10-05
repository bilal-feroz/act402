import { describe, expect, it } from "vitest";
import { getConfig } from "@/lib/config";
import { Act402Error } from "@/lib/errors";
import { buildDownload, buildExtract, buildScreenshot } from "@/lib/act/quick";
import { parseActRequest } from "@/lib/act/schema";

const parse = (raw: Record<string, unknown>) => parseActRequest(raw, getConfig()).request;

describe("single-purpose endpoint builders", () => {
  it("/screenshot builds one screenshot action, with optional element and waits", () => {
    const req = parse(buildScreenshot({ url: "https://example.com", selector: "#main", full_page: true, wait_for_text: "Ready" }).raw);
    expect(req.actions).toEqual([
      { type: "wait", text: "Ready" },
      { type: "screenshot", name: "screenshot", target: { selector: "#main" }, full_page: true },
    ]);
    expect(req.finalScreenshot).toBe(false);
    expect([...req.returnFields]).toEqual(["final_url", "title", "screenshots"]);
  });

  it("/extract defaults to body text and returns structured extracts only when asked", () => {
    const plain = parse(buildExtract({ url: "https://example.com" }).raw);
    expect(plain.actions).toEqual([{ type: "extract", target: { selector: "body" }, format: "text" }]);
    expect(plain.returnFields.has("extracts")).toBe(false);

    const table = parse(buildExtract({ url: "https://example.com", selector: "table", format: "table", wait_for_selector: "table", screenshot: true }).raw);
    expect(table.actions[0]).toEqual({ type: "wait", target: { selector: "table" } });
    expect(table.returnFields.has("extracts")).toBe(true);
    expect(table.finalScreenshot).toBe(true);
  });

  it("/download without a target fetches the URL itself and never opens the page", () => {
    const built = buildDownload({ url: "https://example.com/file.pdf", filename: "spec.pdf" });
    expect(built.openUrl).toBe(false);
    expect(built.requireDownload).toBe(true);
    expect(parse(built.raw).actions).toEqual([{ type: "download", url: "https://example.com/file.pdf", filename: "spec.pdf" }]);
  });

  it("/download with a target opens the page and clicks through to the file", () => {
    const built = buildDownload({ url: "https://arxiv.org/abs/1706.03762", target: "View PDF" });
    expect(built.openUrl).toBeUndefined();
    expect(built.requireDownload).toBe(true);
    expect(parse(built.raw).actions).toEqual([{ type: "download", target: { text: "View PDF" } }]);
    expect(parse(buildDownload({ url: "https://x.example.org", selector: "a.pdf" }).raw).actions).toEqual([{ type: "download", target: { selector: "a.pdf" } }]);
  });

  it("rejects bad input with INVALID_REQUEST", () => {
    for (const fn of [buildScreenshot, buildExtract, buildDownload]) {
      expect(() => fn("nope")).toThrow(Act402Error);
      expect(() => parse(fn({}).raw)).toThrow(Act402Error);
    }
    expect(() => buildScreenshot({ url: "https://example.com", selector: 42 })).toThrow(Act402Error);
    expect(() => parse(buildExtract({ url: "https://example.com", format: "pdf" }).raw)).toThrow(Act402Error);
  });
});
