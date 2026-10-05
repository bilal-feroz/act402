import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { checkHost, checkUrlSyntax, DEFAULT_ALLOWED_PORTS, type UrlPolicy } from "./url-guard";
import { log } from "../logger";

/**
 * Local forward proxy that every Chromium request goes through.
 *
 * Chromium runs inside this server's container, so a hostile page could try to
 * reach localhost services or the private network (directly, via redirects, or
 * via DNS rebinding). The proxy resolves each destination itself, refuses
 * anything that is not public unicast on an allowed port, and connects to the
 * exact IP it validated — the browser never resolves DNS on its own.
 */
export interface EgressProxy {
  url: string;
  port: number;
  close(): Promise<void>;
}

export interface BlockedEgress {
  host: string;
  port: number;
  reason: string;
}

const IDLE_TIMEOUT_MS = 60_000;

function parseConnectTarget(target: string | undefined): { host: string; port: number } | null {
  if (!target) return null;
  const match = /^\[?([^\]]+?)\]?:(\d{1,5})$/.exec(target);
  if (!match) return null;
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host: match[1], port };
}

export async function startEgressProxy(
  policy: UrlPolicy = {},
  onBlocked?: (info: BlockedEgress) => void,
): Promise<EgressProxy> {
  const allowedPorts = policy.allowedPorts ?? DEFAULT_ALLOWED_PORTS;

  async function authorize(host: string, port: number): Promise<{ ok: true; address: string } | { ok: false; reason: string }> {
    if (!policy.allowPrivateNetwork && !allowedPorts.has(port)) {
      return { ok: false, reason: `port ${port} not allowed` };
    }
    const result = await checkHost(host, policy);
    if (!result.ok) return { ok: false, reason: result.reason };
    return { ok: true, address: result.addresses[0] };
  }

  const server = http.createServer(async (req, res) => {
    // Plain-HTTP proxying: the request line carries an absolute URL.
    const syntax = checkUrlSyntax(req.url ?? "", policy);
    if (!syntax.ok && syntax.code === "BLOCKED_URL") {
      let host = "";
      let port = 0;
      try {
        const u = new URL(req.url ?? "");
        host = u.hostname;
        port = Number(u.port || 80);
      } catch {
        // unparsable; reported as blocked anyway
      }
      onBlocked?.({ host, port, reason: syntax.reason });
      res.writeHead(403, { "content-type": "text/plain", "x-act402-blocked": "1" }).end("Blocked by Act402 egress policy");
      return;
    }
    if (!syntax.ok || syntax.url.protocol !== "http:") {
      res.writeHead(400, { "content-type": "text/plain" }).end("Bad proxy request");
      return;
    }
    const target = syntax.url;
    const port = target.port ? Number(target.port) : 80;
    const verdict = await authorize(target.hostname, port);
    if (!verdict.ok) {
      onBlocked?.({ host: target.hostname, port, reason: verdict.reason });
      res.writeHead(403, { "content-type": "text/plain", "x-act402-blocked": "1" }).end("Blocked by Act402 egress policy");
      return;
    }
    const headers = { ...req.headers };
    delete headers["proxy-connection"];
    delete headers["proxy-authorization"];
    const upstream = http.request(
      {
        host: verdict.address,
        port,
        method: req.method,
        path: `${target.pathname}${target.search}`,
        headers,
        setHost: false,
        timeout: IDLE_TIMEOUT_MS,
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      },
    );
    upstream.on("timeout", () => upstream.destroy(new Error("upstream timeout")));
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
      res.end();
    });
    req.pipe(upstream);
  });

  // HTTPS and WebSocket traffic arrives as CONNECT tunnels.
  server.on("connect", async (req: http.IncomingMessage, clientSocket: net.Socket, head: Buffer) => {
    clientSocket.on("error", () => clientSocket.destroy());
    const target = parseConnectTarget(req.url);
    if (!target) {
      clientSocket.end("HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    const verdict = await authorize(target.host, target.port);
    if (!verdict.ok) {
      onBlocked?.({ host: target.host, port: target.port, reason: verdict.reason });
      clientSocket.end("HTTP/1.1 403 Forbidden\r\nX-Act402-Blocked: 1\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    const upstream = net.connect({ host: verdict.address, port: target.port });
    upstream.setTimeout(IDLE_TIMEOUT_MS, () => upstream.destroy());
    clientSocket.setTimeout(IDLE_TIMEOUT_MS, () => clientSocket.destroy());
    upstream.once("connect", () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head && head.length > 0) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on("error", () => {
      if (clientSocket.writable) clientSocket.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n");
      clientSocket.destroy();
    });
    clientSocket.on("close", () => upstream.destroy());
  });

  // Plain ws:// upgrades are not tunnelled through CONNECT by every client; refuse them.
  server.on("upgrade", (_req, socket: net.Socket) => {
    socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
  });

  server.on("clientError", (_err, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  log("egress_proxy_started", { port });

  return {
    port,
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}
