import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host");
  const protocol =
    requestHeaders.get("x-forwarded-proto") ??
    (host?.startsWith("localhost") ? "http" : "https");
  const origin = `${protocol}://${host ?? "localhost:3000"}`;

  return {
    metadataBase: new URL(origin),
    title: "MCT Section Lab",
    description:
      "Inspect MIDAS Civil MCT node clouds in a custom local coordinate system.",
    icons: {
      icon: "/favicon.svg",
      shortcut: "/favicon.svg",
    },
    openGraph: {
      title: "MCT Section Lab",
      description: "Local node cloud inspection for MIDAS Civil models.",
      images: [{ url: `${origin}/og.png`, width: 1733, height: 909 }],
    },
    twitter: {
      card: "summary_large_image",
      title: "MCT Section Lab",
      description: "Local node cloud inspection for MIDAS Civil models.",
      images: [`${origin}/og.png`],
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
