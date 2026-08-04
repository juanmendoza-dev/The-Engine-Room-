import { TransitionLink } from "./PageTransition";
import { ThemeToggle } from "./ThemeToggle";

/**
 * The persistent minimal header — carries to every screen, not just the hero,
 * so it lives in the root layout. Treatment per docs/design/ink-and-bone-notes.md:
 * rotating ink square, letterspaced mono wordmark, live badge, edition toggle.
 */
export function SiteHeader() {
  return (
    <header className="border-er-line er-rise relative z-2 flex items-center justify-between gap-4 border-b px-10 py-[18px] max-md:px-5">
      <TransitionLink href="/" className="flex items-center gap-[14px]">
        <span className="er-brand-square" aria-hidden />
        <span className="font-mono text-[11px] tracking-[0.22em] uppercase">The Engine Room</span>
      </TransitionLink>
      <div className="flex items-center gap-[26px]">
        <div className="text-er-dim flex items-center gap-[10px] font-mono text-[11px] tracking-[0.22em] uppercase max-sm:hidden">
          <span className="er-live-dot" aria-hidden />
          <span>
            <b className="text-er-accent font-medium">Live</b> — engines coupled
          </span>
        </div>
        <ThemeToggle />
      </div>
    </header>
  );
}
