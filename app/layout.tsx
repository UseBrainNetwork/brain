import type { Metadata, Viewport } from "next";
import { Stupified } from "@/components/layout/Stupified";
import { Chrome } from "@/components/layout/Chrome";
import { Footer } from "@/components/layout/Footer";
import { Nav } from "@/components/layout/Nav";
import { RevealObserver } from "@/components/layout/RevealObserver";
import { siteUrl, social } from "@/lib/site";
import "./globals.css";

const description =
  "Your browser becomes part of an AI supercomputer. Contribute verified WebGPU compute. Earn credits, USDC or SOL.";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: { default: "BRAIN — Compute from everywhere", template: "%s · BRAIN" },
  description,
  openGraph: { type: "website", siteName: "BRAIN", title: "BRAIN — Compute from everywhere", description },
  twitter: { card: "summary_large_image", site: `@${social.xHandle}`, creator: `@${social.xHandle}`, title: "BRAIN — Compute from everywhere", description },
};

export const viewport: Viewport = {
  themeColor: "#e9ebef",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: "document.documentElement.classList.add('rv')" }} />
      </head>
      <body className="min-h-dvh">
        <Chrome>
          <Nav />
        </Chrome>
        <main>{children}</main>
        <Chrome>
          <Footer />
        </Chrome>
        <div aria-hidden className="grain" />
        <RevealObserver />
        <Stupified />
      </body>
    </html>
  );
}
