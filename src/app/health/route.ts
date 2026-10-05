import { CAPABILITY, getConfig, SERVICE_NAME, SERVICE_VERSION } from "@/lib/config";
import { json } from "@/lib/http";
import { getRuntime } from "@/lib/runtime";
import { getTaskStore } from "@/lib/storage/tasks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CORS = { "access-control-allow-origin": "*" };

export function GET(): Response {
  const rt = getRuntime();
  const provider = rt.provider.status();
  const slots = rt.browserSlots.stats;
  const config = getConfig();
  return json(
    {
      status: provider.configured ? "ok" : "degraded",
      service: SERVICE_NAME,
      version: SERVICE_VERSION,
      capability: CAPABILITY,
      browser: {
        provider: provider.name,
        engine: "chromium",
        configured: provider.configured,
        launched: provider.ready,
        version: provider.browserVersion ?? null,
        active_sessions: slots.active,
        max_sessions: slots.max,
        queued: slots.queued,
        ...(provider.configured ? {} : { detail: "No Chromium executable found on this server." }),
      },
      storage: getTaskStore().kind,
      gateway_auth: config.gatewaySecret ? "required" : "open",
      uptime_seconds: Math.round((Date.now() - rt.startedAt) / 1000),
      time: new Date().toISOString(),
    },
    200,
    CORS,
  );
}

export function OPTIONS(): Response {
  return new Response(null, { status: 204, headers: { ...CORS, "access-control-allow-methods": "GET, OPTIONS" } });
}
