import type { Metadata } from "next";
import { Geist_Mono, Martian_Mono, Schibsted_Grotesk } from "next/font/google";

import { SiteHeader } from "@/components/SiteHeader";

import "./globals.css";

const displayFont = Schibsted_Grotesk({
  variable: "--font-er-display",
  subsets: ["latin"],
});

const monoFont = Geist_Mono({
  variable: "--font-er-mono",
  subsets: ["latin"],
});

// Only used by the telemetry ticker, so a single weight is plenty.
const martianFont = Martian_Mono({
  variable: "--font-er-martian",
  subsets: ["latin"],
  weight: "400",
});

export const metadata: Metadata = {
  title: "The Engine Room",
  description: "Watch two chess engines play each other, or take one on yourself.",
};

// Runs before first paint so a returning light-mode visitor never sees a dark
// flash. Has to be inline for that — a component effect is already too late.
const themeBootstrap = `try{if(localStorage.getItem('er-theme')==='light')document.documentElement.dataset.theme='light'}catch(e){}`;

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${displayFont.variable} ${monoFont.variable} ${martianFont.variable} h-full antialiased`}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootstrap }} />
      </head>
      <body className="flex min-h-full flex-col">
        <SiteHeader />
        {children}
      </body>
    </html>
  );
}
