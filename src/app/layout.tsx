// Act402 is an API-only service; this root layout exists only because Next.js requires one.
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
