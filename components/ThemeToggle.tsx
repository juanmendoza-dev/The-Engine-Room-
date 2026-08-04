"use client";

/**
 * Flips data-theme on <html>, which is what the --er-* overrides in globals.css
 * hang off.
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
    const goingLight = root.dataset.theme !== "light";

    if (goingLight) {
      root.dataset.theme = "light";
    } else {
      delete root.dataset.theme;
    }

    try {
      localStorage.setItem("er-theme", goingLight ? "light" : "dark");
    } catch {
      // Private mode / storage disabled — still works for this visit.
    }
  }

  return (
    <button
      onClick={toggle}
      title="Toggle light / dark"
      aria-label="Toggle light or dark theme"
      className="er-toggle text-er-dim flex cursor-pointer items-center gap-2 rounded-full bg-transparent px-3 py-[7px] font-mono text-[11px] tracking-[0.14em] whitespace-nowrap uppercase"
    >
      <span className="er-lamp h-2 w-2 rounded-full" />
      <span className="er-when-dark">Lamps on</span>
      <span className="er-when-light">Lamps off</span>
    </button>
  );
}
