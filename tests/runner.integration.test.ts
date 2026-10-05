import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Isolate storage and tighten the download cap before any module reads the config.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "act402-test-"));
process.env.DATA_DIR = dataDir;
process.env.MAX_DOWNLOAD_SIZE_MB = "1";

import { getConfig } from "@/lib/config";
import { parseActRequest } from "@/lib/act/schema";
import { runTask, type RunTaskOptions } from "@/lib/act/run-task";
import { LocalPlaywrightProvider, findChromium } from "@/lib/browser/local-playwright";
import { Semaphore } from "@/lib/browser/limiter";

const PAGES: Record<string, string> = {
  "/": `<!doctype html><title>Test Shop</title>
    <nav><a href="/pricing">Pricing</a> <a href="/docs">Docs</a></nav>
    <h1>Welcome</h1>
    <button id="reveal" onclick="setTimeout(() => { const p = document.createElement('p'); p.id = 'out'; p.textContent = 'Revealed: 42'; document.body.appendChild(p); }, 400)">Reveal</button>
    <form action="/search"><input name="q" placeholder="Search products"><button type="submit">Search</button></form>
    <label for="size">Size</label><select id="size" onchange="document.getElementById('chosen').textContent = this.value"><option value="s">Small</option><option value="m">Medium</option></select>
    <span id="chosen"></span>
    <label><input type="checkbox" id="news"> In stock only</label>
    <input type="password" id="pw" aria-label="Password">
    <button id="buy">Buy now</button>
    <a href="/files/report.pdf">Annual report (PDF)</a>
    <a href="/files/big.bin">Big file</a>
    <a href="/redirect-internal">Partner portal</a>
    <table id="t"><thead><tr><th>Plan</th><th>Price</th></tr></thead><tbody><tr><td>Basic</td><td>$9</td></tr><tr><td>Pro</td><td>$49</td></tr></tbody></table>
    <ul class="items"><li>Alpha</li><li>Beta</li><li>Gamma</li></ul>`,
  "/pricing": `<!doctype html><title>Pricing</title><h1>Pricing</h1><div class="card"><h2>Pro plan</h2><p>Pro costs $49/month</p></div><div class="card"><h2>Basic plan</h2><p>Basic costs $9/month</p></div>`,
  "/docs": `<!doctype html><title>Docs</title><h1>Docs</h1><p>The API rate limit is 100 requests per minute.</p>`,
};

let server: http.Server;
let origin = "";
let port = 0;

function opts(over: Partial<RunTaskOptions> = {}): RunTaskOptions {
  return {
    source: "api",
    baseUrl: origin,
    policy: { allowHosts: ["127.0.0.1"], allowedPorts: new Set([port]) },
    provider,
    slots: new Semaphore(2, 4),
    ...over,
  };
}

let provider: LocalPlaywrightProvider;

async function act(body: Record<string, unknown>, over: Partial<RunTaskOptions> = {}) {
  const { request, warnings } = parseActRequest({ url: `${origin}/`, ...body }, getConfig());
  const outcome = await runTask(request, warnings, opts(over));
  return { status: outcome.httpStatus, body: outcome.body as Record<string, any> };
}

const hasChromium = findChromium() !== null;

describe.skipIf(!hasChromium)("TaskRunner against a local site (real Chromium)", () => {
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://x");
      if (url.pathname === "/search") {
        res.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><title>Results</title><p id="results">Results for ${url.searchParams.get("q")}</p>`);
      } else if (url.pathname === "/files/report.pdf") {
        res.writeHead(200, { "content-type": "application/pdf" }).end(Buffer.from("%PDF-1.4\n% test pdf\n"));
      } else if (url.pathname === "/files/big.bin") {
        res.writeHead(200, { "content-type": "application/octet-stream" }).end(Buffer.alloc(2 * 1024 * 1024, 1));
      } else if (url.pathname === "/redirect-internal") {
        res.writeHead(302, { location: `http://localhost:${port}/` }).end();
      } else if (PAGES[url.pathname]) {
        res.writeHead(200, { "content-type": "text/html" }).end(PAGES[url.pathname]);
      } else {
        res.writeHead(404).end("not found");
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
    origin = `http://127.0.0.1:${port}`;
    provider = new LocalPlaywrightProvider({ allowHosts: ["127.0.0.1"], allowedPorts: new Set([port]) });
  });

  afterAll(async () => {
    await provider?.shutdown();
    server?.close();
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      // Windows keeps the open SQLite file locked; the OS temp cleaner removes it later.
    }
  });

  it("clicks, waits for dynamic content, extracts and screenshots", async () => {
    const { status, body } = await act({
      actions: [
        { type: "click", target: { role: "button", name: "Reveal" } },
        { type: "wait", text: "Revealed" },
        { type: "extract", target: { selector: "#out" } },
        { type: "screenshot", name: "proof" },
      ],
    });
    expect(status).toBe(200);
    expect(body.result.text).toBe("Revealed: 42");
    expect(body.actions_executed).toBe(4);
    expect(body.evidence[0]).toMatchObject({ type: "screenshot", name: "proof.png" });
    const file = path.join(dataDir, "evidence", body.task_id, "proof.png");
    expect(fs.statSync(file).size).toBeGreaterThan(1000);
  });

  it("navigates by link text and extracts a table and links", async () => {
    const { status, body } = await act({
      actions: [
        { type: "extract", target: { selector: "#t" }, format: "table" },
        { type: "extract", target: { selector: ".items li" }, all: true },
        { type: "click", target: "Pricing" },
        { type: "extract", target: { text: "Pro costs" } },
      ],
    });
    expect(status).toBe(200);
    expect(body.result.extracts[0].table).toEqual({ headers: ["Plan", "Price"], rows: [["Basic", "$9"], ["Pro", "$49"]] });
    expect(body.result.extracts[1].items).toEqual(["Alpha", "Beta", "Gamma"]);
    expect(body.result.final_url).toBe(`${origin}/pricing`);
    expect(body.result.text).toBe("Pro costs $49/month");
  });

  it("types into a field by placeholder, submits, selects and checks", async () => {
    const { status, body } = await act({
      actions: [
        { type: "select", target: { label: "Size" }, label: "Medium" },
        { type: "check", target: { label: "In stock only" } },
        { type: "extract", target: { selector: "#chosen" }, name: "chosen" },
        { type: "type", target: { placeholder: "Search products" }, value: "red shoes", submit: true },
        { type: "wait", url_contains: "/search" },
        { type: "extract", target: { selector: "#results" } },
      ],
    });
    expect(status).toBe(200);
    expect(body.result.extracts[0].text).toBe("m");
    expect(body.result.text).toBe("Results for red shoes");
  });

  it("downloads a public file and records its hash", async () => {
    const { status, body } = await act({ actions: [{ type: "download", target: { text: "Annual report" } }] });
    expect(status).toBe(200);
    expect(body.download).toMatchObject({ filename: "report.pdf", mime_type: "application/pdf", size_bytes: 20 });
    expect(body.download.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("enforces the download size limit", async () => {
    const { status, body } = await act({ actions: [{ type: "download", target: { text: "Big file" } }] });
    expect(status).toBe(422);
    expect(body.error.code).toBe("DOWNLOAD_FAILED");
  });

  it("returns TARGET_NOT_FOUND with suggestions and no page content", async () => {
    const { status, body } = await act({ actions: [{ type: "extract" }, { type: "click", target: { text: "Pricng" }, timeout_ms: 800 }] });
    expect(status).toBe(422);
    expect(body.error.code).toBe("TARGET_NOT_FOUND");
    expect(body.error.details.suggestions).toContainEqual({ role: "link", name: "Pricing" });
    expect(JSON.stringify(body)).not.toContain("Welcome");
  });

  it("continues past failing optional actions", async () => {
    const { status, body } = await act({
      actions: [
        { type: "click", target: { text: "Accept cookies" }, optional: true, timeout_ms: 500 },
        { type: "extract", target: { selector: "h1" } },
      ],
    });
    expect(status).toBe(200);
    expect(body.result.text).toBe("Welcome");
    expect(body.warnings.join(" ")).toMatch(/optional/);
  });

  it("refuses to click a purchase button found by selector at runtime", async () => {
    const { status, body } = await act({ actions: [{ type: "click", target: { selector: "#buy" } }] });
    expect(status).toBe(403);
    expect(body.error.code).toBe("ACTION_REQUIRES_AUTHORIZATION");
  });

  it("refuses to type into a password field", async () => {
    const { status, body } = await act({ actions: [{ type: "type", target: { selector: "#pw" }, value: "hunter2" }] });
    expect(status).toBe(403);
    expect(body.error.code).toBe("SENSITIVE_INPUT_REJECTED");
  });

  it("blocks a redirect to an internal host", async () => {
    const { status, body } = await act({ actions: [{ type: "click", target: { text: "Partner portal" } }] });
    expect(status).toBe(403);
    expect(body.error.code).toBe("BLOCKED_URL");
  });

  it("times out cleanly and closes the context", async () => {
    const { status, body } = await act({ timeout_seconds: 5, actions: [{ type: "wait", text: "never appears", timeout_ms: 20000 }] });
    expect(status).toBe(504);
    expect(body.error.code).toBe("TIMEOUT");
    expect(provider.status().activeSessions).toBe(0);
  });

  it("answers a simple goal with the heuristic planner", async () => {
    const { status, body } = await act({ goal: "Go to pricing and return the Pro plan price" });
    expect(status).toBe(200);
    expect(body.result.answer).toBe("$49/month");
    expect(body.result.final_url).toBe(`${origin}/pricing`);
    expect(body.evidence[0].text_excerpt).toContain("Pro costs $49/month");
  });

  it("runs tasks concurrently in isolated contexts", async () => {
    const results = await Promise.all([
      act({ actions: [{ type: "extract", target: { selector: "h1" } }] }),
      act({ actions: [{ type: "click", target: "Docs" }, { type: "extract", target: { selector: "p" } }] }),
      act({ actions: [{ type: "click", target: "Pricing" }, { type: "extract", target: { selector: "h1" } }] }),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(results[1].body.result.text).toMatch(/100 requests per minute/);
    expect(provider.status().activeSessions).toBe(0);
  });
});
