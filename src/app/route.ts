import { json } from "@/lib/http";

export const dynamic = "force-dynamic";

/** GET / — machine-readable index of the API. */
export function GET(): Response {
  return json({
    service: "Act402",
    capability: "browser.execute",
    endpoints: {
      "GET /health": "free",
      "GET /capabilities": "free",
      "POST /act": "paid (0.50 USDC via x402)",
    },
  });
}
