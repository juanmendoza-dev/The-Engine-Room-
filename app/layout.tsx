import type { Metadata } from "next";
import { Archivo, Archivo_Black, Spline_Sans_Mono } from "next/font/google";

import { SiteHeader } from "@/components/SiteHeader";

import "./globals.css";

const bodyFont = Archivo({
  variable: "--font-er-display",
  subsets: ["latin"],
});

// Archivo Black is a single-weight display face — the giant editorial
// headlines and index-row titles. Exposed as the `font-display-black` utility.
const displayBlack = Archivo_Black({
  variable: "--font-er-black",
  weight: "400",
  subsets: ["latin"],
});

const monoFont = Spline_Sans_Mono({
  variable: "--font-er-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "The Engine Room",
  description: "Watch two chess engines play each other, or take one on yourself.",
};

// Runs before first paint so a returning night-edition visitor never sees a
// bone-white flash. Day is the default; night comes from a stored choice or,
// failing that, the OS preference. Has to be inline for that — a component
// effect is already too late.
const themeBootstrap = `try{var t=localStorage.getItem('er-theme');if(t==='dark'||(!t&&matchMedia('(prefers-color-scheme: dark)').matches))document.documentElement.dataset.theme='dark'}catch(e){}`;

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${bodyFont.variable} ${displayBlack.variable} ${monoFont.variable} h-full antialiased`}
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
