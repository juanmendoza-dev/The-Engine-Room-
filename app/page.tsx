import Link from "next/link";

import { MiniBoard } from "@/components/MiniBoard";

// Atmospheric flavour text, not live data. hero-notes.md flags wiring this to
// real KV records as an optional later touch.
const TICKER_ITEMS = [
  { text: "Stockfish 17 · depth 42", dot: "var(--er-accent)" },
  { text: "Boiler pressure nominal", dot: "var(--er-copper)" },
  { text: "Leela Zero · 84k nodes/s", dot: "var(--er-verd)" },
  { text: "Eval +0.4 · white ahead", dot: "var(--er-accent)" },
  { text: "Sicilian Defence · B90", dot: "var(--er-copper)" },
  { text: "All engines coupled", dot: "var(--er-verd)" },
];

function Gauge({ delay = "0s", duration = "5.5s" }: { delay?: string; duration?: string }) {
  return (
    <span className="relative h-[26px] w-11 overflow-hidden">
      <span className="er-gauge-arc absolute inset-0" />
      <span className="er-gauge-face absolute inset-x-[2.5px] top-[2.5px] bottom-0" />
      <span
        className="er-needle absolute bottom-0 left-1/2 h-5 w-[1.5px]"
        style={{ animationDelay: delay, animationDuration: duration }}
      />
      <span className="bg-er-copper absolute bottom-[-2px] left-1/2 -ml-[2.5px] h-[5px] w-[5px] rounded-full" />
    </span>
  );
}

export default function MenuPage() {
  return (
    <>
      {/* Ambient background. Fixed and behind everything, including the header. */}
      <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
        <div className="er-glows absolute inset-0" />
        <div className="er-grain absolute inset-0" />
        <div className="er-flywheel er-flywheel--outer" />
        <div className="er-flywheel er-flywheel--spokes" />
        <div className="er-flywheel er-flywheel--far" />
      </div>

      <main className="relative z-1 mx-auto w-full max-w-[1180px] px-8 pt-13 pb-16">
        <div className="mb-12 flex flex-wrap items-center gap-x-16 gap-y-12">
          <div className="min-w-[300px] flex-[1_1_420px]">
            {/* Little train pulling along its track above the headline */}
            <div
              aria-hidden
              className="er-trackbox er-rise relative mb-5 h-[30px] w-[min(280px,100%)] overflow-hidden"
              style={{ animationDelay: "0.1s" }}
            >
              <span className="er-rail absolute inset-x-0 bottom-[3px] h-px" />
              <span className="er-sleepers absolute inset-x-0 bottom-0 h-px" />
              <div className="er-train absolute bottom-1 left-0 flex items-end gap-[3px]">
                <div className="er-loco relative h-[15px] w-[34px]">
                  <span className="bg-er-copper absolute top-[-6px] left-[5px] h-[7px] w-1 rounded-t-[1.5px]" />
                  <span
                    className="absolute top-[-5px] right-[3px] h-[6px] w-[9px] rounded-t-[2px]"
                    style={{ background: "var(--er-accent-deep)" }}
                  />
                  {/* Duration goes inline, not as an [animation-duration:] utility:
                      .er-puff's unlayered `animation` shorthand would win. */}
                  <span
                    className="er-puff top-[-11px] left-[3px] h-[6px] w-[6px] blur-[2px]"
                    style={{ animationDuration: "1.6s" }}
                  />
                  <span
                    className="er-puff top-[-12px] left-[6px] h-[5px] w-[5px] blur-[2px]"
                    style={{ animationDuration: "1.6s", animationDelay: "0.8s" }}
                  />
                </div>
                <div className="er-carriage h-[10px] w-[22px] rounded-[2px]" />
                <div className="er-carriage h-[10px] w-[22px] rounded-[2px]" />
              </div>
            </div>

            <h1
              className="er-rise mb-[18px] text-[clamp(44px,6vw,76px)] leading-[1.02] font-bold tracking-[-0.03em]"
              style={{ animationDelay: "0.18s" }}
            >
              The <span className="er-headline-accent">Engine</span>
              <br />
              <span className="relative inline-block">
                Room
                <span aria-hidden className="er-underline" />
              </span>
            </h1>

            <p
              className="text-er-dim er-rise max-w-[44ch] text-[19px] leading-[1.5] text-pretty"
              style={{ animationDelay: "0.3s" }}
            >
              Where chess engines run at full steam. Watch machines duel across the sixty-four
              squares — or take the controls yourself.
            </p>
          </div>

          {/* Mini board "photo" panel */}
          <div
            className="er-rise relative mx-auto min-w-[280px] flex-[0_1_400px]"
            style={{ animationDelay: "0.34s" }}
          >
            <div aria-hidden>
              <span
                className="er-steamwisp top-[-8px] left-[18%] h-14 w-14 blur-[18px]"
                style={{ animation: "er-steam 7s 1s ease-out infinite" }}
              />
              <span
                className="er-steamwisp top-[-4px] left-[56%] h-[72px] w-[72px] blur-[22px]"
                style={{ animation: "er-steam 9s 3.4s ease-out infinite" }}
              />
              <span
                className="er-steamwisp top-[-10px] left-[38%] h-11 w-11 blur-[14px]"
                style={{ animation: "er-steam 8s 5.6s ease-out infinite" }}
              />
            </div>

            <div className="er-plate relative rounded-[10px] p-4">
              <span aria-hidden className="er-rivet top-[7px] left-[7px]" />
              <span aria-hidden className="er-rivet top-[7px] right-[7px]" />
              <span aria-hidden className="er-rivet bottom-[7px] left-[7px]" />
              <span aria-hidden className="er-rivet right-[7px] bottom-[7px]" />

              <MiniBoard />

              <div className="text-er-dim mt-3 flex items-center justify-between font-mono text-[10px] tracking-[0.18em] uppercase">
                <span>Nº 64</span>
                <span
                  className="inline-flex items-center gap-[6px]"
                  style={{ color: "var(--er-verd)" }}
                >
                  <span className="er-lamp--verd h-[6px] w-[6px] rounded-full" />
                  Live · engines coupled
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Telemetry ticker */}
        <div
          aria-hidden
          className="border-er-line er-tickerbox er-rise mb-11 overflow-hidden border-y"
          style={{ animationDelay: "0.45s" }}
        >
          <div className="er-tickerrow flex w-max">
            {[...TICKER_ITEMS, ...TICKER_ITEMS].map((item, i) => (
              <span
                key={i}
                className="text-er-dim font-martian inline-flex items-center gap-[10px] px-[26px] py-[11px] text-[10px] tracking-[0.18em] whitespace-nowrap uppercase"
              >
                <span className="text-[9px]" style={{ color: item.dot }}>
                  ◆
                </span>
                {item.text}
              </span>
            ))}
          </div>
        </div>

        {/* Mode cards */}
        <div className="grid grid-cols-[repeat(auto-fit,minmax(290px,1fr))] gap-5">
          <Link
            href="/model-1v1"
            className="er-card er-card--brass er-rise relative block overflow-hidden rounded-[10px] px-[30px] pt-[30px] pb-[26px]"
            style={{ animationDelay: "0.55s" }}
          >
            <span aria-hidden className="er-sheen pointer-events-none absolute inset-y-0 w-[46%]" />
            <div className="mb-[30px] flex items-start justify-between">
              <span className="er-badge-brass rounded-[3px] px-[10px] py-[5px] font-mono text-[11px] tracking-[0.2em] whitespace-nowrap uppercase">
                Mode 01 · Spectate
              </span>
              <Gauge />
            </div>
            <h2 className="mb-2 text-[30px] font-semibold tracking-[-0.01em]">Model 1v1</h2>
            <p className="text-er-dim mb-6 text-[15.5px] leading-[1.5]">
              Pick two engines. Sit back and watch them run.
            </p>
            <span className="text-er-accent inline-flex items-center gap-[10px] font-mono text-[12px] tracking-[0.16em] uppercase">
              Open the throttle{" "}
              <span className="er-arrow inline-block text-[15px]" aria-hidden>
                →
              </span>
            </span>
          </Link>

          <Link
            href="/user-1v1"
            className="er-card er-card--copper er-rise relative block overflow-hidden rounded-[10px] px-[30px] pt-[30px] pb-[26px]"
            style={{ animationDelay: "0.65s" }}
          >
            <span
              aria-hidden
              className="er-sheen pointer-events-none absolute inset-y-0 w-[46%]"
              style={{ animationDelay: "3.4s" }}
            />
            <div className="mb-[30px] flex items-start justify-between">
              <span className="er-badge-copper rounded-[3px] px-[10px] py-[5px] font-mono text-[11px] tracking-[0.2em] whitespace-nowrap uppercase">
                Mode 02 · Play
              </span>
              <Gauge delay="1.2s" duration="4.6s" />
            </div>
            <h2 className="mb-2 text-[30px] font-semibold tracking-[-0.01em]">User 1v1</h2>
            <p className="text-er-dim mb-6 text-[15.5px] leading-[1.5]">
              Pick your opponent. Take a seat at the board.
            </p>
            <span className="text-er-copper inline-flex items-center gap-[10px] font-mono text-[12px] tracking-[0.16em] uppercase">
              Take the controls{" "}
              <span
                className="er-arrow inline-block text-[15px]"
                style={{ animationDelay: "0.5s" }}
                aria-hidden
              >
                →
              </span>
            </span>
          </Link>
        </div>

        <div className="er-rise mt-9 flex justify-center" style={{ animationDelay: "0.8s" }}>
          <Link
            href="/history"
            className="text-er-dim er-history-link inline-flex items-center gap-[10px] pb-[6px] font-mono text-[12px] tracking-[0.18em] uppercase"
          >
            <span
              className="inline-block text-[14px] [animation:er-spin_12s_linear_infinite]"
              aria-hidden
            >
              ◷
            </span>{" "}
            Game history — the ledger
          </Link>
        </div>
      </main>
    </>
  );
}
