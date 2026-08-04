# Ink & Bone — design notes

The 2026-08-04 UI revamp. Replaces the original brass/steam "hero" design —
see `hero-notes.md` for what this superseded and why it was dropped (it read
as AI-generated default styling).

`ink-and-bone-preview.html` in this folder is the approved mockup. **Open it
directly in a browser** — self-contained except for Google Fonts (needs
internet). It has a working day/night toggle; it's the visual spec the real
app was built from, kept for reference.

## The concept

Kinetic editorial monochrome — a print-shop metaphor with two "editions":

- **Day (default):** ink printed on bone paper. Red is a printed accent.
- **Night (`data-theme="dark"`):** the print shop after hours. Ink ground,
  paper type, and the red stops being printed ink and becomes **lit
  signage** — everything red picks up a glow that doesn't exist by day, the
  hollow "ENGINE" strokes in red instead of ink, the board frame becomes a
  red "safelight" hairline, and the index-row hover floods paper-white
  instead of ink (the inversion runs the *opposite* direction to day mode —
  same gesture, mirrored, so it feels intentional rather than auto-inverted).

Boldness budget is spent on typography; everything else stays quiet: hairline
borders, sharp corners (no border-radius anywhere), one accent color.

## Fonts (via `next/font/google`, loaded in `app/layout.tsx`)

| Var | Face | Use | Tailwind utility |
|---|---|---|---|
| `--font-er-black` | Archivo Black | giant headlines, index-row titles, h1/h2 | `font-display-black` |
| `--font-er-display` | Archivo | body text | (body default) |
| `--font-er-mono` | Spline Sans Mono | labels, captions, marquee, buttons | `font-mono` |

Display type is always uppercase with tight tracking (−0.02 to −0.035em) and
leading around 0.9. Mono labels are small (10–12px) with wide tracking
(0.16–0.24em), uppercase.

## Tokens (CSS custom properties in `app/globals.css`)

| Token | Day | Night | Use |
|---|---|---|---|
| `--er-bg` | `#f2f0ea` | `#131217` | page ground (bone / ink-violet, never pure white/black) |
| `--er-text` | `#16151a` | `#ece9df` | primary text |
| `--er-dim` | ink @ 60% | paper @ 55% | secondary text |
| `--er-line` | ink @ 14% | paper @ 15% | hairline borders |
| `--er-surface` / `--er-surface2` | `#ece9e1` / `#e9e6dd` | `#1b1a21` / `#17161c` | panels (selects, move log, result card) |
| `--er-accent` | `#e0331f` | `#ff4f35` (hotter) | the one accent: red |
| `--er-accent-glow` | `transparent` | red @ 45% | glow shadows — **this is the night-edition switch**: day glows are invisible because the color is transparent, so glow effects can be written once |
| `--er-stroke` | `var(--er-text)` | `var(--er-accent)` | hollow headline stroke |
| `--er-frame` | `var(--er-text)` | red @ 55% | board frame ("safelight" at night) |
| `--er-invert-bg/fg/dim` | ink/bone | **bone/ink** | index-row hover flood (mirrored per edition) |
| `--er-ember` | `transparent` | red @ 6% | faint corner glow on `<body>`, night only |
| `--er-sq-light` / `--er-sq-dark` | `#e9e6dd` / `#dcd8cb` | `#1c1b22` / `#26242e` | board squares (both ReplayBoard and react-chessboard) |
| `--er-sq-white-piece` / `--er-sq-black-piece` + shadows | — | — | piece colors; black pieces get a light halo at night to stay visible |

## Theme mechanics — changed from the old design

**Day is now the default; `data-theme="dark"` is the override.** The old
brass design had dark as `:root` and `data-theme="light"` as the override.
The toggle (`components/ThemeToggle.tsx`) and the inline bootstrap in
`app/layout.tsx` both flipped accordingly. The localStorage key is still
`er-theme` (values `"light"`/`"dark"`), and with nothing stored the bootstrap
falls back to `prefers-color-scheme` — so a returning visitor keeps their
choice and a new visitor gets their OS preference.

`.er-when-light` / `.er-when-dark` visibility helpers also flipped to match
the new default. Anything theme-conditional hangs off
`:root[data-theme="dark"]` selectors in `globals.css`.

## Structure

- **Header** (`components/SiteHeader.tsx`, all screens): rotating ink square
  (red + glowing at night), letterspaced mono wordmark, live badge, edition
  toggle. No logo glyph, no gradient wordmark.
- **Hero** (`app/page.tsx`): three-line THE / ENGINE / ROOM headline, each
  line rising from an `overflow: hidden` mask (`.er-line`), "ENGINE" hollow
  via `-webkit-text-stroke` (`.er-hollow`; fills red on headline hover).
  Right: the ReplayBoard.
- **ReplayBoard** (`components/ReplayBoard.tsx`): replays Morphy's Opera Game
  (1858) on a loop, one ply per 1.15s, board squares cascade in on load.
  Dependency-free — a hardcoded move script, no chess.js. Captured pieces are
  *flagged*, not removed, so React keys stay stable and CSS transitions
  animate the exit.
- **Marquee**: flavor-text strip between hero and modes. The item list is
  rendered twice and the row animates `translateX(-50%)` — the duplication is
  what makes the loop seamless; don't "simplify" it to one copy.
- **Mode index** (`.er-index-row`): full-width hairline rows, not cards.
  Hover floods the row (ink by day, paper by night) and slides it right.
  Tag + description columns hide under 720px.

## Traps

- The entry animations use `animation-fill-mode: forwards` on `transform` —
  never put a *hover* transform on the same element that has a forwards-fill
  transform animation, the fill wins forever. (Hovers here animate child
  elements or non-transform properties instead.)
- The old `background-clip: text` gradient-headline trap in
  `docs/deployment.md` §4 no longer applies — nothing clips gradients to text
  anymore — but it becomes relevant again if gradient text ever returns.
- `prefers-reduced-motion` collapses all animation/transition to ~0ms
  globally at the bottom of `globals.css` (including delays — a delayed
  `opacity: 0 → 1` entry would otherwise leave content invisible for the
  delay duration).
