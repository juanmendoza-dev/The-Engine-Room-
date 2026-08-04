import { HeaderScoreboard } from "./HeaderScoreboard";
import { TransitionLink } from "./PageTransition";
import { ThemeToggle } from "./ThemeToggle";

/**
 * The persistent minimal header — carries to every screen, not just the hero,
 * so it lives in the root layout. Treatment per docs/design/ink-and-bone-notes.md:
 * rotating ink square, letterspaced mono wordmark, live scoreboard, edition
 * toggle.
 *
 * Stays a server component: only the scoreboard needs the client, and it's its
 * own component precisely so the rest of the header isn't dragged along.
 */
export function SiteHeader() {
  return (
    <header className="border-er-line er-rise relative z-2 flex items-center justify-between gap-4 border-b px-10 py-[18px] max-md:px-5">
      <TransitionLink href="/" className="flex items-center gap-[14px]">
        <span className="er-brand-square" aria-hidden />
        <span className="font-mono text-[11px] tracking-[0.22em] uppercase">The Engine Room</span>
      </TransitionLink>
      <div className="flex items-center gap-[26px]">
        <HeaderScoreboard />
        <ThemeToggle />
      </div>
    </header>
  );
}
