import Link from "next/link";

import { ThemeToggle } from "./ThemeToggle";

/**
 * The "persistent minimal header" from docs/design/hero-notes.md — it's meant to
 * carry to every screen, not just the hero, so it lives in the root layout.
 */
export function SiteHeader() {
  return (
    <header className="border-er-line er-rise relative z-2 flex items-center justify-between gap-4 border-b px-8 py-[14px]">
      <Link href="/" className="flex items-center gap-[14px]">
        <div className="relative">
          <span
            className="er-puff top-[-4px] right-[2px] h-[7px] w-[7px] blur-[2.5px]"
            style={{ animationDelay: "0.2s" }}
          />
          <span
            className="er-puff top-[-3px] right-[6px] h-[5px] w-[5px] blur-[2px]"
            style={{ animationDelay: "1.3s" }}
          />
          <span
            className="er-puff top-[-5px] right-[4px] h-[9px] w-[9px] blur-[3px]"
            style={{ animationDelay: "2.3s" }}
          />
          <div className="er-mark grid h-9 w-9 place-items-center rounded-md text-[22px] leading-none">
            ♞
          </div>
        </div>
        <div className="er-wordmark text-[18px] leading-none font-extrabold tracking-[-0.01em]">
          The Engine Room
        </div>
      </Link>
      <ThemeToggle />
    </header>
  );
}
