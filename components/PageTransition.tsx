"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type MouseEvent,
  type ReactNode,
} from "react";

/**
 * "The press" — the route transition every navigating link runs through.
 *
 * It's the Ink & Bone print-shop metaphor taken literally (see
 * docs/design/ink-and-bone-notes.md): red ink blooms out of the exact pixel you
 * clicked, the platen drops as staggered vertical slats, the destination's plate
 * name types up between two registration rules, then the platen lifts *downward*
 * — the opposite direction to the way it came, so it never looks like it's
 * retracing its own path — revealing the new page already mid-entry-animation.
 *
 * Why a provider rather than CSS on the link: the platen has to stay down
 * *across* the navigation, so one overlay lives above the router in the layout
 * and links only ask it to run.
 */

/* Timing. The band stagger is what makes the platen read as slats closing
   instead of one panel dropping, so the totals are derived from it rather than
   written twice. These numbers and the durations in globals.css's `.er-press-*`
   rules have to stay in step — if you retune one, retune the other. */
const BANDS = 6;
const STAGGER_MS = 28;
const CLOSE_MS = 320;
const OPEN_MS = 400;

/** Platen fully down, plus a beat to actually read the plate, then navigate. */
const COVER_MS = CLOSE_MS + (BANDS - 1) * STAGGER_MS + 160;
/** Route committed → let the destination paint before the platen lifts off it. */
const SETTLE_MS = 80;
const OPEN_TOTAL_MS = OPEN_MS + (BANDS - 1) * STAGGER_MS;
/** Safety valve: a route that never commits must not leave the screen covered. */
const HOLD_CAP_MS = 3000;

type Plate = { kicker: string; title: string };

/** "Plate" as in a press plate — one per route. Tags match the mode index. */
const PLATES: Record<string, Plate> = {
  "/": { kicker: "Plate 00 · Index", title: "The Engine Room" },
  "/model-1v1": { kicker: "Plate 01 · Spectate", title: "Model 1v1" },
  "/user-1v1": { kicker: "Plate 02 · Play", title: "User 1v1" },
  "/history": { kicker: "Plate 03 · Archive", title: "History" },
};

const UNTITLED_PLATE: Plate = { kicker: "Setting the plate", title: "Engine Room" };

type Phase = "idle" | "down" | "up";

interface TransitionApi {
  /** Runs the press. Returns false when the caller should just let the browser navigate. */
  start: (href: string, from: { x: number; y: number }) => boolean;
  /** The href being transitioned to, or null when idle. Links derive their
      pressed-down state from this instead of holding their own. */
  active: string | null;
}

const TransitionContext = createContext<TransitionApi | null>(null);

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export function PageTransitionProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();

  const [phase, setPhase] = useState<Phase>("idle");
  const [plate, setPlate] = useState<Plate>(UNTITLED_PLATE);
  const [from, setFrom] = useState<{ x: number; y: number } | null>(null);
  const [active, setActive] = useState<string | null>(null);

  // Phase is read from inside timers and the pathname effect, both of which
  // would otherwise close over a stale value — hence the ref alongside state.
  const phaseRef = useRef<Phase>("idle");
  const targetRef = useRef<string | null>(null);
  const timersRef = useRef<number[]>([]);

  const to = useCallback((next: Phase) => {
    phaseRef.current = next;
    setPhase(next);
  }, []);

  const after = useCallback((ms: number, fn: () => void) => {
    timersRef.current.push(window.setTimeout(fn, ms));
  }, []);

  const clearTimers = useCallback(() => {
    timersRef.current.forEach((id) => clearTimeout(id));
    timersRef.current = [];
  }, []);

  useEffect(() => clearTimers, [clearTimers]);

  const lift = useCallback(() => {
    if (phaseRef.current !== "down") return;
    clearTimers();
    to("up");
    after(OPEN_TOTAL_MS, () => {
      targetRef.current = null;
      setActive(null);
      to("idle");
    });
  }, [after, clearTimers, to]);

  const start = useCallback(
    (href: string, point: { x: number; y: number }) => {
      // Mid-transition already: swallow the click rather than stack a second
      // platen behind the first.
      if (phaseRef.current !== "idle") return true;
      // Same page, or motion is unwelcome — let the link behave like a link.
      if (href === pathname) return false;
      if (prefersReducedMotion()) return false;

      clearTimers();
      setPlate(PLATES[href] ?? UNTITLED_PLATE);
      setFrom(point);
      setActive(href);
      targetRef.current = href;
      to("down");

      after(COVER_MS, () => router.push(href));
      after(HOLD_CAP_MS, lift);
      return true;
    },
    [after, clearTimers, lift, pathname, router, to],
  );

  // The platen lifts when the route actually commits, not on a fixed timer, so a
  // slow RSC fetch stays hidden behind it instead of flashing the old page.
  useEffect(() => {
    if (phaseRef.current !== "down") return;
    if (targetRef.current === null || pathname !== targetRef.current) return;
    timersRef.current.push(window.setTimeout(lift, SETTLE_MS));
  }, [pathname, lift]);

  const busy = phase !== "idle";

  return (
    <TransitionContext.Provider value={{ start, active }}>
      {children}
      {busy && (
        <div
          className={`er-press ${phase === "down" ? "er-press--down" : "er-press--up"}`}
          aria-hidden
        >
          {Array.from({ length: BANDS }, (_, i) => (
            <span
              key={i}
              className="er-press-band"
              style={{
                left: `${(i * 100) / BANDS}%`,
                // +1px so sub-pixel band widths can't leave hairline seams.
                width: `calc(${100 / BANDS}% + 1px)`,
                // Closing runs left→right, opening right→left.
                animationDelay: `${(phase === "down" ? i : BANDS - 1 - i) * STAGGER_MS}ms`,
              }}
            />
          ))}

          {/* Fires at 0ms from the click point, so the press feels instant even
              though the platen takes a third of a second to shut. */}
          {from && phase === "down" && (
            <>
              <span className="er-press-ink" style={{ left: from.x, top: from.y }} />
              <span className="er-press-ink-core" style={{ left: from.x, top: from.y }} />
            </>
          )}

          <div className="er-press-plate">
            <span className="er-press-reg er-press-reg--tl" />
            <span className="er-press-reg er-press-reg--tr" />
            <span className="er-press-reg er-press-reg--bl" />
            <span className="er-press-reg er-press-reg--br" />

            <div className="er-press-slug">
              <span className="er-press-kicker font-mono text-[11px] tracking-[0.24em] uppercase">
                {plate.kicker}
              </span>
              <span className="er-press-rule" />
              <span className="er-press-mask font-display-black text-[clamp(38px,8vw,104px)] tracking-[-0.03em] uppercase">
                <span>{plate.title}</span>
              </span>
              <span className="er-press-rule er-press-rule--b" />
            </div>
          </div>
        </div>
      )}
    </TransitionContext.Provider>
  );
}

export function useRouteTransition(): TransitionApi {
  const ctx = useContext(TransitionContext);
  if (!ctx) throw new Error("useRouteTransition needs a <PageTransitionProvider> above it");
  return ctx;
}

type LinkProps = ComponentProps<typeof Link>;

/**
 * Drop-in replacement for `<Link>` on anything that navigates. Falls back to a
 * plain link for modified clicks (open-in-new-tab), same-page hrefs, and
 * reduced-motion visitors — in all three cases a transition would be wrong.
 */
export function TransitionLink({ href, onClick, className, ...rest }: LinkProps) {
  const { start, active } = useRouteTransition();

  // Derived, not local state: the header wordmark outlives the navigation it
  // triggered, and deriving from `active` releases it when the press finishes
  // without an effect syncing the two.
  const stamped = active !== null && active === href;

  function handleClick(event: MouseEvent<HTMLAnchorElement>) {
    onClick?.(event);
    if (event.defaultPrevented) return;
    // Cmd/ctrl/shift/alt-click and middle-click all mean "open this somewhere
    // else" — running the press would actively fight the user's intent.
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (event.button !== 0) return;

    // Object hrefs aren't used anywhere here; they navigate without the press.
    const target = typeof href === "string" ? href : null;
    if (!target?.startsWith("/")) return;

    if (start(target, { x: event.clientX, y: event.clientY })) event.preventDefault();
  }

  return (
    <Link
      href={href}
      onClick={handleClick}
      className={stamped ? `${className ?? ""} er-stamp`.trim() : className}
      {...rest}
    />
  );
}
