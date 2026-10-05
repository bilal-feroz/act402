#!/usr/bin/env node
// HTTP contract audit for a running Act402 deployment.
//   node scripts/audit.mjs https://act402.replit.app
const base = (process.argv[2] || "http://localhost:3000").replace(/\/+$/, "");
const key = process.env.ACT402_KEY || "";
const H = { "content-type": "application/json", ...(key ? { "x-act402-key": key } : {}) };
let failed = 0;

async function call(method, path, body, raw) {
  const res = await fetch(base + path, {
    method,
    headers: H,
    body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(90_000),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: res.status, json, text, headers: res.headers };
}

async function check(name, fn) {
  const t = Date.now();
  try {
    const note = await fn();
    console.log(`PASS  ${name.padEnd(46)} ${String(Date.now() - t).padStart(6)} ms  ${note ?? ""}`);
  } catch (err) {
    failed++;
    console.log(`FAIL  ${name.padEnd(46)} ${String(Date.now() - t).padStart(6)} ms  ${err.message}`);
  }
}

function expect(cond, msg) {
  if (!cond) throw new Error(msg);
}

console.log(`Act402 API audit against ${base}\n`);

await check("GET / (index)", async () => {
  const r = await call("GET", "/");
  expect(r.status === 200 && r.json?.service === "Act402", `status ${r.status}`);
});
await check("GET /health exact body", async () => {
  const r = await call("GET", "/health");
  expect(r.status === 200, `status ${r.status}`);
  expect(JSON.stringify(r.json) === JSON.stringify({ status: "ok", service: "Act402" }), r.text);
});
await check("HEAD /health", async () => {
  const r = await call("HEAD", "/health");
  expect(r.status === 200, `status ${r.status}`);
});
await check("GET /capabilities shape", async () => {
  const r = await call("GET", "/capabilities");
  expect(r.status === 200, `status ${r.status}`);
  const c = r.json;
  expect(c.service === "Act402" && c.capability === "browser.execute" && typeof c.description === "string", "fields");
  for (const a of ["navigate", "click", "type", "select", "scroll", "wait", "extract", "screenshot"]) expect(c.actions.includes(a), `missing ${a}`);
});
await check("POST /health -> 405 JSON", async () => {
  const r = await call("POST", "/health", {});
  expect(r.status === 405 && r.json?.error?.code === "METHOD_NOT_ALLOWED", `status ${r.status} ${r.text.slice(0, 80)}`);
});
await check("GET /act -> 405 JSON", async () => {
  const r = await call("GET", "/act");
  expect(r.status === 405 && r.json?.error?.code === "METHOD_NOT_ALLOWED", `status ${r.status}`);
});
await check("PUT /act -> 405 JSON", async () => {
  const r = await call("PUT", "/act", {});
  expect(r.status === 405 && r.json?.error?.code === "METHOD_NOT_ALLOWED", `status ${r.status} ${r.text.slice(0, 80)}`);
});
await check("GET /unknown -> 404 JSON", async () => {
  const r = await call("GET", "/does-not-exist");
  expect(r.status === 404 && r.json?.error?.code === "NOT_FOUND", `status ${r.status} ${r.text.slice(0, 80)}`);
});
await check("POST /act invalid JSON -> 400", async () => {
  const r = await call("POST", "/act", undefined, "{not json");
  expect(r.status === 400 && r.json?.error?.code === "INVALID_REQUEST", `status ${r.status}`);
});
await check("POST /act empty body -> 400", async () => {
  const r = await call("POST", "/act", undefined, "");
  expect(r.status === 400 && r.json?.error?.code === "INVALID_REQUEST", `status ${r.status}`);
});
await check("POST /act missing url -> 400", async () => {
  const r = await call("POST", "/act", { actions: [{ type: "extract" }] });
  expect(r.status === 400 && r.json?.error?.code === "INVALID_REQUEST", `status ${r.status}`);
});
await check("POST /act goal only -> 400", async () => {
  const r = await call("POST", "/act", { url: "https://example.com", goal: "find the price" });
  expect(r.status === 400 && r.json?.error?.code === "INVALID_REQUEST", `status ${r.status}`);
});
await check("POST /act unknown action -> 400", async () => {
  const r = await call("POST", "/act", { url: "https://example.com", actions: [{ type: "hack" }] });
  expect(r.status === 400 && r.json?.error?.code === "UNSUPPORTED_ACTION", `status ${r.status}`);
});
await check("POST /act 21 actions -> 422", async () => {
  const r = await call("POST", "/act", { url: "https://example.com", actions: Array.from({ length: 21 }, () => ({ type: "extract" })) });
  expect(r.status === 422 && r.json?.error?.code === "STEP_LIMIT_REACHED", `status ${r.status}`);
});
await check("POST /act 4 screenshots -> 422", async () => {
  const r = await call("POST", "/act", { url: "https://example.com", actions: Array.from({ length: 4 }, () => ({ type: "screenshot" })) });
  expect(r.status === 422 && r.json?.error?.code === "STEP_LIMIT_REACHED", `status ${r.status}`);
});
await check("POST /act body > 256KB -> 400", async () => {
  const r = await call("POST", "/act", { url: "https://example.com", pad: "x".repeat(300_000) });
  expect(r.status === 400, `status ${r.status}`);
});
await check("SSRF: localhost/private/metadata/file/js", async () => {
  for (const url of ["http://localhost/", "http://127.0.0.1/", "http://0.0.0.0/", "http://10.0.0.1/", "http://192.168.1.1/", "http://169.254.169.254/latest/meta-data/", "http://[::1]/", "file:///etc/passwd", "javascript:alert(1)"]) {
    const r = await call("POST", "/act", { url });
    expect(r.status === 403 || r.status === 400, `${url} -> ${r.status}`);
    expect(["BLOCKED_URL", "INVALID_URL"].includes(r.json?.error?.code), `${url} -> ${r.json?.error?.code}`);
  }
});
await check("SSRF: redirect to 127.0.0.1 blocked", async () => {
  const r = await call("POST", "/act", { url: "https://httpbin.org/redirect-to?url=http%3A%2F%2F127.0.0.1%3A8080%2F", actions: [{ type: "extract" }] });
  expect(r.status === 403 && r.json?.error?.code === "BLOCKED_URL", `status ${r.status} ${r.json?.error?.code}`);
});
await check("Safety: purchase click refused", async () => {
  const r = await call("POST", "/act", { url: "https://example.com", actions: [{ type: "click", target: { text: "Buy now" } }] });
  expect(r.status === 403 && r.json?.error?.code === "ACTION_REQUIRES_AUTHORIZATION", `status ${r.status}`);
});

let evidenceUrl = "";
await check("POST /act happy path (spec format)", async () => {
  const r = await call("POST", "/act", {
    url: "https://example.com",
    actions: [
      { type: "click", target: { text: "Learn more" } },
      { type: "extract", target: { selector: "body" } },
      { type: "screenshot" },
    ],
  });
  expect(r.status === 200, `status ${r.status} ${r.text.slice(0, 200)}`);
  const b = r.json;
  expect(b.success === true, "success");
  expect(/^act_[a-f0-9]{24}$/.test(b.task_id), "task_id");
  expect(typeof b.final_url === "string" && b.final_url.includes("iana.org"), `final_url ${b.final_url}`);
  expect(b.actions_executed === 3, `actions_executed ${b.actions_executed}`);
  expect(typeof b.result?.text === "string" && b.result.text.length > 100, "result.text");
  expect(typeof b.duration_ms === "number", "duration_ms");
  expect(r.headers.get("x-act402-task-id") === b.task_id, "x-act402-task-id header");
  evidenceUrl = b.evidence?.[0]?.url ?? "";
  expect(evidenceUrl.includes("/evidence/"), "evidence url");
  return `final_url=${b.final_url}`;
});
await check("GET evidence screenshot", async () => {
  const url = evidenceUrl.startsWith("http") ? evidenceUrl : base + evidenceUrl;
  const res = await fetch(url);
  const buf = Buffer.from(await res.arrayBuffer());
  expect(res.status === 200 && res.headers.get("content-type") === "image/png" && buf.length > 1000, `status ${res.status} ${res.headers.get("content-type")} ${url}`);
  return `${buf.length} bytes`;
});
await check("Evidence path traversal -> 404", async () => {
  for (const p of ["/evidence/act_000000000000000000000000/..%2F..%2Fpackage.json", "/evidence/..%2F..%2F/package.json", "/evidence/act_x/final.png"]) {
    const r = await call("GET", p);
    expect(r.status === 404, `${p} -> ${r.status}`);
  }
});
await check("Actions: type/submit, wait, scroll, select, navigate", async () => {
  const r = await call("POST", "/act", {
    url: "https://www.scrapethissite.com/pages/forms/",
    actions: [
      { type: "type", target: { placeholder: "Search for Teams" }, value: "Boston", submit: true },
      { type: "wait", milliseconds: 500 },
      { type: "scroll", direction: "down" },
      { type: "extract", target: { selector: "table.table" }, format: "table" },
      { type: "navigate", url: "https://www.scrapethissite.com/pages/forms/" },
      { type: "select", target: { selector: "#per_page" }, value: "50" },
      { type: "wait", url_contains: "per_page=50" },
    ],
  });
  expect(r.status === 200 && r.json.actions_executed === 7, `status ${r.status} ${r.text.slice(0, 200)}`);
  expect(JSON.stringify(r.json.result.extracts ?? r.json.result).includes("Boston Bruins"), "table content");
});
await check("Target by role + name", async () => {
  const r = await call("POST", "/act", {
    url: "https://www.scrapethissite.com/pages/ajax-javascript/",
    actions: [{ type: "click", target: { role: "link", name: "2015" } }, { type: "wait", target: { selector: "#table-body tr" } }, { type: "extract", target: { selector: "#table-body" } }],
  });
  expect(r.status === 200 && /Spotlight/.test(r.json.result.text), `status ${r.status} ${r.text.slice(0, 160)}`);
});
await check("Timeout -> 504", async () => {
  const r = await call("POST", "/act", { url: "https://example.com", timeout_seconds: 6, actions: [{ type: "wait", text: "this text never appears", timeout_ms: 30000 }] });
  expect(r.status === 504 && r.json?.error?.code === "TIMEOUT", `status ${r.status} ${r.json?.error?.code}`);
});
await check("Concurrency: 4 parallel (2 slots + queue)", async () => {
  const started = Date.now();
  const rs = await Promise.all(Array.from({ length: 4 }, () => call("POST", "/act", { url: "https://example.com", actions: [{ type: "extract", target: { selector: "body" } }] })));
  expect(rs.every((r) => r.status === 200), `statuses ${rs.map((r) => r.status).join(",")}`);
  return `all 200 in ${Date.now() - started} ms`;
});

// ---- single-purpose paid endpoints ----
await check("POST /screenshot page", async () => {
  const r = await call("POST", "/screenshot", { url: "https://example.com" });
  expect(r.status === 200 && r.json?.screenshot?.url?.includes("/evidence/"), `status ${r.status} ${r.text.slice(0, 160)}`);
  const img = await fetch(r.json.screenshot.url.startsWith("http") ? r.json.screenshot.url : base + r.json.screenshot.url);
  expect(img.status === 200 && img.headers.get("content-type") === "image/png", `image ${img.status}`);
  return `${r.json.duration_ms} ms task`;
});
await check("POST /screenshot full_page", async () => {
  const r = await call("POST", "/screenshot", { url: "https://books.toscrape.com", full_page: true });
  expect(r.status === 200 && r.json?.screenshot?.full_page === true, `status ${r.status} ${r.text.slice(0, 160)}`);
});
await check("POST /extract default (body text)", async () => {
  const r = await call("POST", "/extract", { url: "https://example.com" });
  expect(r.status === 200 && /documentation examples/.test(r.json?.result?.text ?? ""), `status ${r.status} ${r.text.slice(0, 160)}`);
});
await check("POST /extract table", async () => {
  const r = await call("POST", "/extract", { url: "https://www.scrapethissite.com/pages/forms/", selector: "table.table", format: "table" });
  const rows = r.json?.result?.extracts?.[0]?.table?.rows?.length ?? 0;
  expect(r.status === 200 && rows >= 20, `status ${r.status} rows ${rows}`);
  return `${rows} rows`;
});
await check("POST /download direct file URL", async () => {
  const r = await call("POST", "/download", { url: "https://arxiv.org/pdf/1706.03762" });
  expect(r.status === 200 && r.json?.download?.mime_type === "application/pdf", `status ${r.status} ${r.text.slice(0, 160)}`);
  return `${r.json.download.filename} ${r.json.download.size_bytes} bytes`;
});
await check("POST /download behind a link", async () => {
  const r = await call("POST", "/download", { url: "https://arxiv.org/abs/1706.03762", target: "View PDF" });
  expect(r.status === 200 && r.json?.download?.mime_type === "application/pdf", `status ${r.status} ${r.text.slice(0, 160)}`);
});
await check("POST /download page without target -> 422", async () => {
  const r = await call("POST", "/download", { url: "https://example.com" });
  expect(r.status === 422 && r.json?.error?.code === "DOWNLOAD_FAILED", `status ${r.status} ${r.json?.error?.code}`);
});
await check("GET on paid single-purpose endpoints -> 405", async () => {
  for (const p of ["/screenshot", "/extract", "/download"]) {
    const r = await call("GET", p);
    expect(r.status === 405 && r.json?.error?.code === "METHOD_NOT_ALLOWED", `${p} -> ${r.status}`);
  }
});
if (key) {
  await check("Paid endpoints refuse calls without the key -> 401", async () => {
    for (const p of ["/act", "/screenshot", "/extract", "/download"]) {
      const res = await fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: "https://example.com" }) });
      expect(res.status === 401, `${p} -> ${res.status}`);
    }
  });
}

console.log(`\n${failed === 0 ? "ALL PASSED" : `${failed} FAILED`}`);
process.exit(failed ? 1 : 0);
