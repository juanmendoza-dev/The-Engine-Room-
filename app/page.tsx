import { TransitionLink } from "@/components/PageTransition";
import { ReplayBoard } from "@/components/ReplayBoard";

// Atmospheric flavour text, not live data. Wiring this to real KV records
// stays an optional later touch (same call as the old ticker).
//
// "all engines coupled" used to be in here. It came out with the header badge
// that said the same thing: the header now reads a real game, so leaving the
// claim in the marquee would have made this the only place the site still
// asserts a backend it doesn't have.
const MARQUEE_ITEMS = [
  "Stockfish 17 — depth 42",
  "eval +0.4 — white ahead",
  "Sicilian Defence · B90",
  "84,000 nodes / second",
  "checkmate detected in 7",
];

const MODES = [
  {
    href: "/model-1v1",
    tag: "Spectate",
    title: "Model 1v1",
    desc: "Pick two engines and set them loose. Every move validated, every game scored.",
  },
  {
    href: "/user-1v1",
    tag: "Play",
    title: "User 1v1",
    desc: "Choose your opponent, choose your color, and see how long you last.",
  },
  {
    href: "/history",
    tag: "Archive",
    title: "History",
    desc: "Every finished game, on the record.",
  },
] as const;

export default function MenuPage() {
  return (
    <main className="relative z-1">
      <section className="mx-auto flex w-full max-w-[1280px] flex-wrap items-center gap-12 px-10 pt-[clamp(40px,7vh,84px)] pb-14 max-md:px-5">
        <div className="min-w-[320px] flex-[1_1_480px]">
          <h1 className="er-headline font-display-black text-[clamp(58px,10.5vw,148px)] leading-[0.9] tracking-[-0.035em] uppercase">
            <span className="er-line">
              <span>The</span>
            </span>
            <span className="er-line">
              <span className="er-hollow">Engine</span>
            </span>
            <span className="er-line">
              <span>Room</span>
            </span>
          </h1>
          <p
            className="text-er-dim er-rise mt-7 max-w-[46ch] text-[15px] leading-[1.65]"
            style={{ animationDelay: "0.55s" }}
          >
            Two chess engines. Sixty-four squares.{" "}
            <em className="text-er-text font-semibold not-italic">No mercy.</em> Watch machines
            fight it out move by move — or sit down at the board and take one on yourself.
          </p>
        </div>

        <div className="er-rise mx-auto flex-[0_1_auto]" style={{ animationDelay: "0.3s" }}>
          <ReplayBoard />
        </div>
      </section>

      <div className="er-marquee" aria-hidden>
        <div className="flex w-max er-marquee-row">
          {[...MARQUEE_ITEMS, ...MARQUEE_ITEMS].map((text, i) => (
            <span
              key={i}
              className="inline-flex items-center px-[34px] font-mono text-[11px] tracking-[0.22em] uppercase"
            >
              <span className="er-tick-dot pr-[34px] text-[9px]">◆</span>
              {text}
            </span>
          ))}
        </div>
      </div>

      <nav className="mx-auto w-full max-w-[1280px] px-10 pb-24 max-md:px-5" aria-label="Modes">
        {MODES.map((mode) => (
          <TransitionLink key={mode.href} href={mode.href} className="er-index-row">
            <span className="er-row-tag font-mono text-[10px] tracking-[0.24em] uppercase">
              {mode.tag}
            </span>
            <span className="font-display-black text-[clamp(24px,3.4vw,42px)] tracking-[-0.02em] uppercase">
              {mode.title}
            </span>
            <span className="er-row-desc text-[14px] leading-[1.55]">{mode.desc}</span>
            <span className="er-row-arrow text-[26px]" aria-hidden>
              →
            </span>
          </TransitionLink>
        ))}
      </nav>
    </main>
  );
}
