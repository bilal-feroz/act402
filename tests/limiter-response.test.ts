import { describe, expect, it } from "vitest";
import { Semaphore } from "@/lib/browser/limiter";
import { Act402Error } from "@/lib/errors";
import { buildResponse, type ResponseInput } from "@/lib/act/response";
import { parseActRequest } from "@/lib/act/schema";
import { getConfig } from "@/lib/config";

describe("Semaphore", () => {
  it("limits concurrency and hands slots over in FIFO order", async () => {
    const sem = new Semaphore(2, 5);
    const a = await sem.acquire(1000);
    const b = await sem.acquire(1000);
    expect(sem.stats).toMatchObject({ active: 2, queued: 0 });
    const order: string[] = [];
    const c = sem.acquire(1000).then((r) => (order.push("c"), r));
    const d = sem.acquire(1000).then((r) => (order.push("d"), r));
    expect(sem.stats.queued).toBe(2);
    a();
    a(); // double release is ignored
    const releaseC = await c;
    b();
    const releaseD = await d;
    expect(order).toEqual(["c", "d"]);
    releaseC();
    releaseD();
    expect(sem.stats).toMatchObject({ active: 0, queued: 0 });
  });

  it("rejects with AT_CAPACITY when the queue is full or the wait times out", async () => {
    const sem = new Semaphore(1, 1);
    const release = await sem.acquire(1000);
    const waiting = sem.acquire(50);
    await expect(sem.acquire(1000)).rejects.toMatchObject({ code: "AT_CAPACITY" });
    await expect(waiting).rejects.toMatchObject({ code: "AT_CAPACITY" });
    release();
    expect(sem.stats.active).toBe(0);
  });
});

function input(over: Partial<ResponseInput>): ResponseInput {
  const { request } = parseActRequest({ url: "https://example.com", actions: [{ type: "extract", selector: "body" }] }, getConfig());
  return {
    taskId: "act_0123456789abcdef01234567",
    request,
    warnings: [],
    steps: [
      { index: -1, type: "open", status: "ok", duration_ms: 10, url: "https://example.com/" },
      { index: 0, type: "extract", status: "ok", duration_ms: 5, url: "https://example.com/" },
    ],
    extracts: [{ action_index: 0, format: "text", target: "selector body", count: 1, text: "secret page text", truncated: false, source_url: "https://example.com/" }],
    evidence: [
      { type: "screenshot", name: "final.png", url: "https://x/evidence/act_0123456789abcdef01234567/final.png", path: "/evidence/act_0123456789abcdef01234567/final.png", source_url: "https://example.com/", captured_at: "2026-10-05T00:00:00Z", bytes: 10 },
    ],
    domains: ["example.com"],
    dialogs: [],
    collected: { final_url: "https://example.com/", title: "Example", text: "secret page text", text_source: "extract", text_truncated: false },
    durationMs: 1234,
    queueMs: 0,
    navigationMs: 500,
    provider: "local-playwright",
    ...over,
  };
}

describe("buildResponse", () => {
  it("returns the documented success shape", () => {
    const body = buildResponse(input({}));
    expect(body).toMatchObject({
      success: true,
      status: "completed",
      task_id: "act_0123456789abcdef01234567",
      final_url: "https://example.com/",
      result: { text: "secret page text" },
      actions_executed: 1,
      duration_ms: 1234,
      evidence: [{ type: "screenshot", url: expect.stringContaining("/evidence/") }],
    });
  });

  it("never returns extracted content when the task failed", () => {
    const body = buildResponse(input({ error: new Act402Error("TARGET_NOT_FOUND", "nope") }));
    expect(body).toMatchObject({ success: false, status: "failed", error: { code: "TARGET_NOT_FOUND" }, final_url: "https://example.com/" });
    expect(JSON.stringify(body)).not.toContain("secret page text");
    expect(body).not.toHaveProperty("evidence");
  });

  it("marks policy refusals as blocked", () => {
    const body = buildResponse(input({ error: new Act402Error("ACTION_REQUIRES_AUTHORIZATION", "no") }));
    expect(body.status).toBe("blocked");
  });

  it("honours the return filter", () => {
    const { request } = parseActRequest({ url: "https://example.com", return: ["final_url"] }, getConfig());
    const body = buildResponse(input({ request }));
    expect(body.result).toEqual({ final_url: "https://example.com/" });
    expect(body).not.toHaveProperty("evidence");
    expect(body).not.toHaveProperty("steps");
  });
});
