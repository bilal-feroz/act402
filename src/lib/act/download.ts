import http from "node:http";
import https from "node:https";
import net from "node:net";
import type { LookupFunction } from "node:net";
import { Act402Error } from "../errors";
import { checkUrl, type UrlPolicy } from "../security/url-guard";
import { extensionForMime, mimeForFilename } from "../storage/evidence";
import { sanitizeFilename } from "../util";

export interface DownloadedFile {
  data: Buffer;
  mimeType: string;
  filename: string;
  finalUrl: string;
}

export interface DownloadOptions {
  maxBytes: number;
  timeoutMs: number;
  policy?: UrlPolicy;
  headers?: Record<string, string>;
  preferredName?: string;
}

const MAX_REDIRECTS = 5;

/** Resolve to exactly the address the SSRF check approved (defeats DNS rebinding). */
function pinnedLookup(address: string): LookupFunction {
  const family = net.isIPv6(address) ? 6 : 4;
  return ((_hostname: string, options: { all?: boolean } | number | undefined, callback: (...args: unknown[]) => void) => {
    const cb = typeof options === "function" ? (options as (...args: unknown[]) => void) : callback;
    if (typeof options === "object" && options?.all) cb(null, [{ address, family }]);
    else cb(null, address, family);
  }) as unknown as LookupFunction;
}

function filenameFromDisposition(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const star = /filename\*\s*=\s*(?:UTF-8|utf-8)?''([^;]+)/i.exec(header);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ""));
    } catch {
      // fall through to plain filename
    }
  }
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(header);
  return plain?.[1]?.trim();
}

export function chooseFilename(candidates: Array<string | undefined>, mimeType: string): string {
  let name = "download";
  for (const c of candidates) {
    if (c && c.trim()) {
      name = sanitizeFilename(c.trim(), "download");
      break;
    }
  }
  if (!/\.[a-zA-Z0-9]{1,5}$/.test(name)) {
    const ext = extensionForMime(mimeType);
    if (ext) name = `${name}.${ext}`;
  }
  return name;
}

function requestOnce(url: URL, address: string, opts: DownloadOptions, signal: AbortSignal): Promise<http.IncomingMessage> {
  const lib = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request(
      url,
      {
        method: "GET",
        lookup: pinnedLookup(address),
        headers: { accept: "*/*", ...opts.headers },
        signal,
      },
      resolve,
    );
    req.on("error", reject);
    req.end();
  });
}

/**
 * Fetch a public file server-side. Every redirect hop is re-validated against
 * the SSRF policy and the body is streamed with a hard size limit.
 */
export async function safeDownload(inputUrl: string, opts: DownloadOptions): Promise<DownloadedFile> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, opts.timeoutMs));
  let current = inputUrl;
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const check = await checkUrl(current, opts.policy);
      if (!check.ok) {
        throw new Act402Error(check.code === "BLOCKED_URL" ? "BLOCKED_URL" : "DOWNLOAD_FAILED", hop === 0 ? check.reason : `Redirect blocked: ${check.reason}`);
      }
      let res: http.IncomingMessage;
      try {
        res = await requestOnce(check.url, check.addresses[0], opts, controller.signal);
      } catch (err) {
        if (controller.signal.aborted) throw new Act402Error("DOWNLOAD_FAILED", "The download timed out.");
        throw new Act402Error("DOWNLOAD_FAILED", `Could not fetch the file: ${err instanceof Error ? err.message : String(err)}`);
      }
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        current = new URL(res.headers.location, check.url).href;
        continue;
      }
      if (status !== 200) {
        res.resume();
        throw new Act402Error("DOWNLOAD_FAILED", `The server answered HTTP ${status} for the file.`, { http_status: status });
      }
      const declared = Number(res.headers["content-length"] ?? "0");
      if (declared > opts.maxBytes) {
        res.destroy();
        throw new Act402Error("DOWNLOAD_FAILED", `The file is ${(declared / 1048576).toFixed(1)} MB; the limit is ${(opts.maxBytes / 1048576).toFixed(0)} MB.`, {
          size_bytes: declared,
        });
      }
      const chunks: Buffer[] = [];
      let total = 0;
      await new Promise<void>((resolve, reject) => {
        res.on("data", (chunk: Buffer) => {
          total += chunk.length;
          if (total > opts.maxBytes) {
            res.destroy();
            reject(new Act402Error("DOWNLOAD_FAILED", `The file exceeds the ${(opts.maxBytes / 1048576).toFixed(0)} MB limit.`));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => resolve());
        res.on("error", (err) =>
          reject(controller.signal.aborted ? new Act402Error("DOWNLOAD_FAILED", "The download timed out.") : new Act402Error("DOWNLOAD_FAILED", `Download interrupted: ${err.message}`)),
        );
      });
      const finalUrl = check.url.href;
      const headerMime = (res.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
      const pathName = decodeURIComponent(check.url.pathname.split("/").pop() ?? "");
      const mimeType = headerMime && headerMime !== "application/octet-stream" ? headerMime : mimeForFilename(pathName);
      const filename = chooseFilename([opts.preferredName, filenameFromDisposition(res.headers["content-disposition"]), pathName], mimeType);
      return { data: Buffer.concat(chunks), mimeType, filename, finalUrl };
    }
    throw new Act402Error("DOWNLOAD_FAILED", `Too many redirects (more than ${MAX_REDIRECTS}).`);
  } finally {
    clearTimeout(timer);
  }
}
