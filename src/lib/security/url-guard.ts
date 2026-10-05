import { lookup } from "node:dns/promises";
import ipaddr from "ipaddr.js";

/**
 * SSRF guard shared by request validation, the browser egress proxy, and the
 * server-side downloader. A destination is allowed only when it is http(s), on
 * an allowed port, and every address its hostname resolves to is public unicast.
 */
export interface UrlPolicy {
  /** Test-only escape hatch. Production code never sets this. */
  allowPrivateNetwork?: boolean;
  /** Test-only: specific IP literals allowed even if private (e.g. a local test server). */
  allowHosts?: readonly string[];
  allowedPorts?: ReadonlySet<number>;
  /** Extra hostnames to refuse (e.g. this service's own domain). */
  extraBlockedHosts?: readonly string[];
}

export type HostCheck =
  | { ok: true; addresses: string[] }
  | { ok: false; code: "INVALID_URL" | "BLOCKED_URL"; reason: string };

export type UrlCheck =
  | { ok: true; url: URL; addresses: string[] }
  | { ok: false; code: "INVALID_URL" | "BLOCKED_URL"; reason: string };

export const DEFAULT_ALLOWED_PORTS: ReadonlySet<number> = new Set([80, 443, 8080, 8443]);
const MAX_URL_LENGTH = 2048;

const BLOCKED_EXACT_HOSTS = new Set([
  "localhost",
  "localhost.localdomain",
  "ip6-localhost",
  "ip6-loopback",
  "metadata",
  "metadata.google.internal",
  "instance-data",
  "kubernetes",
  "kubernetes.default",
  "host.docker.internal",
  "gateway.docker.internal",
]);

const BLOCKED_SUFFIXES = [
  ".localhost",
  ".local",
  ".localdomain",
  ".internal",
  ".intranet",
  ".lan",
  ".home",
  ".home.arpa",
  ".corp",
  ".private",
  ".test",
  ".invalid",
  ".example",
  ".onion",
  ".svc",
  ".cluster.local",
  ".in-addr.arpa",
  ".ip6.arpa",
];

/** True only for globally routable unicast addresses (IPv4-mapped IPv6 is unwrapped first). */
export function isPublicIp(address: string): boolean {
  const raw = address.replace(/^\[|\]$/g, "");
  if (!ipaddr.isValid(raw)) return false;
  let addr = ipaddr.parse(raw);
  if (addr.kind() === "ipv6") {
    const v6 = addr as ipaddr.IPv6;
    if (v6.isIPv4MappedAddress()) addr = v6.toIPv4Address();
  }
  return addr.range() === "unicast";
}

function ownHosts(): string[] {
  const hosts: string[] = [];
  for (const value of [process.env.APP_BASE_URL, process.env.REPLIT_DEV_DOMAIN, ...(process.env.REPLIT_DOMAINS ?? "").split(",")]) {
    if (!value) continue;
    const trimmed = value.trim();
    if (!trimmed) continue;
    try {
      hosts.push(new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`).hostname.toLowerCase());
    } catch {
      // ignore malformed env values
    }
  }
  return hosts;
}

export function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");
}

/** Synchronous hostname rules that need no DNS (names, IP literals, own domain). */
export function checkHostnameStatic(hostnameInput: string, policy: UrlPolicy = {}): HostCheck | null {
  const hostname = normalizeHostname(hostnameInput);
  if (!hostname) return { ok: false, code: "INVALID_URL", reason: "URL has no hostname." };

  if (ipaddr.isValid(hostname)) {
    if (policy.allowPrivateNetwork || policy.allowHosts?.includes(hostname) || isPublicIp(hostname)) return { ok: true, addresses: [hostname] };
    return { ok: false, code: "BLOCKED_URL", reason: `Address ${hostname} is not a public internet address.` };
  }
  if (policy.allowPrivateNetwork) return null;

  if (BLOCKED_EXACT_HOSTS.has(hostname) || BLOCKED_SUFFIXES.some((s) => hostname.endsWith(s))) {
    return { ok: false, code: "BLOCKED_URL", reason: `Host ${hostname} is an internal or reserved name.` };
  }
  if (!hostname.includes(".")) {
    return { ok: false, code: "BLOCKED_URL", reason: `Single-label host "${hostname}" is not a public domain.` };
  }
  const blocked = [...ownHosts(), ...(policy.extraBlockedHosts ?? [])].map(normalizeHostname);
  if (blocked.includes(hostname)) {
    return { ok: false, code: "BLOCKED_URL", reason: "Act402 cannot be pointed at its own domain." };
  }
  return null; // needs DNS
}

// Small TTL cache so the proxy does not resolve the same host for every request.
const dnsCache = new Map<string, { at: number; result: HostCheck }>();
const DNS_TTL_MS = 60_000;

async function resolveAll(hostname: string): Promise<string[]> {
  const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("DNS timeout")), 4000));
  const results = await Promise.race([lookup(hostname, { all: true, verbatim: true }), timeout]);
  return results.map((r) => r.address);
}

/** Full host check: static rules, then DNS, requiring every resolved address to be public. */
export async function checkHost(hostnameInput: string, policy: UrlPolicy = {}): Promise<HostCheck> {
  const staticResult = checkHostnameStatic(hostnameInput, policy);
  if (staticResult) return staticResult;
  const hostname = normalizeHostname(hostnameInput);

  const cacheKey = `${policy.allowPrivateNetwork ? "p" : "s"}:${hostname}`;
  const hit = dnsCache.get(cacheKey);
  if (hit && Date.now() - hit.at < DNS_TTL_MS) return hit.result;

  let result: HostCheck;
  try {
    const addresses = await resolveAll(hostname);
    if (addresses.length === 0) {
      result = { ok: false, code: "INVALID_URL", reason: `Host ${hostname} does not resolve.` };
    } else if (!policy.allowPrivateNetwork && addresses.some((a) => !isPublicIp(a))) {
      result = { ok: false, code: "BLOCKED_URL", reason: `Host ${hostname} resolves to a private or reserved address.` };
    } else {
      result = { ok: true, addresses };
    }
  } catch {
    result = { ok: false, code: "INVALID_URL", reason: `Host ${hostname} does not resolve.` };
  }
  dnsCache.set(cacheKey, { at: Date.now(), result });
  if (dnsCache.size > 2000) dnsCache.delete(dnsCache.keys().next().value as string);
  return result;
}

export function portOf(url: URL): number {
  if (url.port) return Number(url.port);
  return url.protocol === "https:" || url.protocol === "wss:" ? 443 : 80;
}

/** Parse and statically validate a URL (scheme, credentials, length, port, host rules). */
export function checkUrlSyntax(input: string, policy: UrlPolicy = {}): UrlCheck | { ok: true; url: URL; needsDns: boolean } {
  if (typeof input !== "string" || input.trim() === "") {
    return { ok: false, code: "INVALID_URL", reason: "URL is required." };
  }
  const trimmed = input.trim();
  if (trimmed.length > MAX_URL_LENGTH) {
    return { ok: false, code: "INVALID_URL", reason: `URL exceeds ${MAX_URL_LENGTH} characters.` };
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, code: "INVALID_URL", reason: "URL is not a valid absolute URL (include https://)." };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, code: "BLOCKED_URL", reason: `Scheme "${url.protocol.replace(":", "")}" is not allowed; use http or https.` };
  }
  if (url.username || url.password) {
    return { ok: false, code: "BLOCKED_URL", reason: "URLs with embedded credentials are not allowed." };
  }
  const allowedPorts = policy.allowedPorts ?? DEFAULT_ALLOWED_PORTS;
  if (!policy.allowPrivateNetwork && !allowedPorts.has(portOf(url))) {
    return { ok: false, code: "BLOCKED_URL", reason: `Port ${portOf(url)} is not allowed (allowed: ${[...allowedPorts].join(", ")}).` };
  }
  const hostResult = checkHostnameStatic(url.hostname, policy);
  if (hostResult && !hostResult.ok) return hostResult;
  if (hostResult && hostResult.ok) return { ok: true, url, addresses: hostResult.addresses };
  return { ok: true, url, needsDns: true };
}

/** Full URL check including DNS resolution of the hostname. */
export async function checkUrl(input: string, policy: UrlPolicy = {}): Promise<UrlCheck> {
  const syntax = checkUrlSyntax(input, policy);
  if (!syntax.ok) return syntax;
  if ("addresses" in syntax) return syntax;
  const host = await checkHost(syntax.url.hostname, policy);
  if (!host.ok) return host;
  return { ok: true, url: syntax.url, addresses: host.addresses };
}
