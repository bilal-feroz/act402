import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Act402 — Give AI agents a browser they can actually control",
  description:
    "Browser execution infrastructure for autonomous agents. Send a website and browser actions; Act402 executes them in a real Chromium session and returns structured results with screenshot evidence.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
