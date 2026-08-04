"use client";

/**
 * Flips data-theme on <html>, which is what the --er-* overrides in globals.css
 * hang off. Day (bone paper) is the default; "dark" is the night edition.
 *
 * Deliberately stateless: both labels are rendered and CSS shows whichever
 * matches the current theme. That keeps the label correct from the very first
 * paint (the inline bootstrap in layout.tsx has already applied the stored
 * theme by then) instead of only after hydration, and avoids mirroring DOM
 * state into React for no reason.
 */
export function ThemeToggle() {
  function toggle() {
    const root = document.documentElement;
    const goingDark = root.dataset.theme !== "dark";

    if (goingDark) {
      root.dataset.theme = "dark";
    } else {
      delete root.dataset.theme;
    }

    try {
      localStorage.setItem("er-theme", goingDark ? "dark" : "light");
    } catch {
      // Private mode / storage disabled — still works for this visit.
    }
  }

  return (
    <button
      onClick={toggle}
      title="Switch edition"
      aria-label="Switch between the day and night editions"
      className="er-toggle text-er-dim cursor-pointer bg-transparent px-4 py-2 font-mono text-[11px] tracking-[0.22em] whitespace-nowrap uppercase"
    >
      <span className="er-when-light">Night edition ↗</span>
      <span className="er-when-dark">Day edition ↗</span>
    </button>
  );
}
