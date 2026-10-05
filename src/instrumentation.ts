// Runs once when the server starts: launch Chromium and start evidence cleanup
// before the first request arrives.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { getRuntime } = await import("./lib/runtime");
  const { LocalPlaywrightProvider } = await import("./lib/browser/local-playwright");
  const provider = getRuntime().provider;
  if (provider instanceof LocalPlaywrightProvider) provider.warmUp();
}
