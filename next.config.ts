import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Playwright must stay a real Node dependency (never bundled).
  serverExternalPackages: ["playwright-core"],
  poweredByHeader: false,
  async rewrites() {
    // Agents sometimes probe /api/* paths; serve the same handlers there.
    return [
      { source: "/api/act", destination: "/act" },
      { source: "/api/health", destination: "/health" },
      { source: "/api/capabilities", destination: "/capabilities" },
    ];
  },
};

export default nextConfig;
