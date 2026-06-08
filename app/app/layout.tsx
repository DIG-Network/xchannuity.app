import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono, Cormorant_Garamond } from "next/font/google";
import "./globals.css";

// Clean, modern grotesk for body, UI, and figures; a high-contrast Garamond for
// the large luxury headlines; the mono companion for the live-vesting figures.
const sans = Geist({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-sans",
  display: "swap",
});
const serif = Cormorant_Garamond({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-serif",
  display: "swap",
});
const mono = Geist_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-mono",
  display: "swap",
});

// Canonical https origin for absolute social-card URLs. Override per deployment
// with NEXT_PUBLIC_SITE_URL (scrapers require absolute image URLs).
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "https://xchannuity.app";

const TITLE = "XCH Annuity — streamed annuities on Chia";
const DESCRIPTION =
  "Transferable, tradable streamed-CAT annuities on Chia. Stream a stablecoin to a " +
  "beneficiary continuously over a fixed term — claim what has accrued anytime, assign the " +
  "annuity in a single spend, or sell it through a trustless offer. Self-custodial, " +
  "consensus-enforced.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: TITLE,
    template: "%s · XCH Annuity",
  },
  description: DESCRIPTION,
  applicationName: "XCH Annuity",
  keywords: [
    "XCH Annuity",
    "Xchannuity",
    "Chia",
    "XCH",
    "CAT2",
    "annuity",
    "streaming payments",
    "vesting",
    "DeFi",
    "Chia blockchain",
  ],
  authors: [{ name: "DIG Network" }],
  alternates: { canonical: "/" },
  icons: {
    icon: [
      { url: "/favicon.svg", type: "image/svg+xml" },
      { url: "/favicon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/favicon-16.png", sizes: "16x16", type: "image/png" },
    ],
    shortcut: "/favicon.svg",
    apple: "/apple-touch-icon.png",
  },
  manifest: "/manifest.webmanifest",
  openGraph: {
    type: "website",
    siteName: "XCH Annuity",
    title: TITLE,
    description: DESCRIPTION,
    url: SITE_URL,
    images: [
      {
        url: "/og.png",
        width: 1200,
        height: 630,
        alt: "XCH Annuity — annuities that vest by the second",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: DESCRIPTION,
    images: ["/og.png"],
  },
};

export const viewport: Viewport = {
  themeColor: "#0b0c0e",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${serif.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
