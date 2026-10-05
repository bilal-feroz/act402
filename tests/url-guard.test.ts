import { describe, expect, it } from "vitest";
import { checkHost, checkUrl, checkUrlSyntax, isPublicIp } from "@/lib/security/url-guard";

describe("isPublicIp", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.16.5.4",
    "172.31.255.255",
    "192.168.0.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "255.255.255.255",
    "198.18.0.1",
    "192.0.2.10",
    "240.0.0.1",
    "::1",
    "::",
    "fe80::1",
    "fc00::1",
    "fd12:3456::1",
    "::ffff:127.0.0.1",
    "::ffff:10.0.0.1",
    "64:ff9b::7f00:1",
    "2002:7f00:1::",
    "2001:db8::1",
    "ff02::1",
  ])("rejects non-public %s", (ip) => {
    expect(isPublicIp(ip)).toBe(false);
  });

  it.each(["8.8.8.8", "1.1.1.1", "93.184.215.14", "2606:4700:4700::1111", "::ffff:8.8.8.8"])("accepts public %s", (ip) => {
    expect(isPublicIp(ip)).toBe(true);
  });

  it("rejects garbage", () => {
    expect(isPublicIp("not-an-ip")).toBe(false);
  });
});

describe("checkUrlSyntax", () => {
  const blocked = [
    ["file:///etc/passwd", "BLOCKED_URL"],
    ["javascript:alert(1)", "BLOCKED_URL"],
    ["ftp://example.com/file", "BLOCKED_URL"],
    ["data:text/html,<h1>x</h1>", "BLOCKED_URL"],
    ["http://localhost/", "BLOCKED_URL"],
    ["http://localhost./", "BLOCKED_URL"],
    ["http://LOCALHOST:80/admin", "BLOCKED_URL"],
    ["http://api.localhost/", "BLOCKED_URL"],
    ["http://127.0.0.1/", "BLOCKED_URL"],
    ["http://2130706433/", "BLOCKED_URL"],
    ["http://0x7f.1/", "BLOCKED_URL"],
    ["http://0177.0.0.1/", "BLOCKED_URL"],
    ["http://[::1]/", "BLOCKED_URL"],
    ["http://[::ffff:127.0.0.1]/", "BLOCKED_URL"],
    ["http://0.0.0.0/", "BLOCKED_URL"],
    ["http://169.254.169.254/latest/meta-data/", "BLOCKED_URL"],
    ["http://metadata.google.internal/", "BLOCKED_URL"],
    ["http://service.internal/", "BLOCKED_URL"],
    ["http://printer.local/", "BLOCKED_URL"],
    ["http://intranet/", "BLOCKED_URL"],
    ["http://10.0.0.5:8080/", "BLOCKED_URL"],
    ["http://user:pass@example.com/", "BLOCKED_URL"],
    ["https://example.com:22/", "BLOCKED_URL"],
    ["https://example.com:6379/", "BLOCKED_URL"],
    ["not a url", "INVALID_URL"],
    ["", "INVALID_URL"],
    ["example.com", "INVALID_URL"],
  ] as const;

  it.each(blocked)("refuses %s", (url, code) => {
    const result = checkUrlSyntax(url);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(code);
  });

  it.each(["https://example.com", "http://example.com/path?q=1", "https://example.com:443/", "https://example.com:8443/x", "http://8.8.8.8/"])("accepts %s", (url) => {
    expect(checkUrlSyntax(url).ok).toBe(true);
  });

  it("refuses URLs longer than 2048 characters", () => {
    const result = checkUrlSyntax(`https://example.com/${"a".repeat(2100)}`);
    expect(result.ok).toBe(false);
  });

  it("refuses this service's own domain", () => {
    process.env.APP_BASE_URL = "https://act402.example.org";
    const result = checkUrlSyntax("https://act402.example.org/act");
    delete process.env.APP_BASE_URL;
    expect(result.ok).toBe(false);
  });

  it("test policy can allow one private IP literal without opening the rest", () => {
    const policy = { allowHosts: ["127.0.0.1"], allowedPorts: new Set([4000]) };
    expect(checkUrlSyntax("http://127.0.0.1:4000/", policy).ok).toBe(true);
    expect(checkUrlSyntax("http://localhost:4000/", policy).ok).toBe(false);
    expect(checkUrlSyntax("http://10.0.0.1:4000/", policy).ok).toBe(false);
  });
});

describe("checkHost / checkUrl with DNS", () => {
  it("blocks names that resolve to loopback", async () => {
    const result = await checkHost("localhost");
    expect(result.ok).toBe(false);
  });

  it("blocks public DNS names that point at private addresses", async () => {
    // nip.io answers 127.0.0.1 for this name (DNS rebinding style). Skip when offline.
    const result = await checkUrl("http://127.0.0.1.nip.io/");
    if (!result.ok && result.code === "INVALID_URL") return;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("BLOCKED_URL");
  });
});
