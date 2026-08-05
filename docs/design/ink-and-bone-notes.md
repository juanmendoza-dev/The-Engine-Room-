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

## Fonts (via `next/font/google`, loaded in `web/app/layout.tsx`)

| Var | Face | Use | Tailwind utility |
|---|---|---|---|
| `--font-er-black` | Archivo Black | giant headlines, index-row titles, h1/h2 | `font-display-black` |
| `--font-er-display` | Archivo | body text | (body default) |
| `--font-er-mono` | Spline Sans Mono | labels, captions, marquee, buttons | `font-mono` |

Display type is always uppercase with tight tracking (−0.02 to −0.035em) and
leading around 0.9. Mono labels are small (10–12px) with wide tracking
(0.16–0.24em), uppercase.

## Tokens (CSS custom properties in `web/app/globals.css`)

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
The toggle (`web/components/ThemeToggle.tsx`) and the inline bootstrap in
`web/app/layout.tsx` both flipped accordingly. The localStorage key is still
`er-theme` (values `"light"`/`"dark"`), and with nothing stored the bootstrap
falls back to `prefers-color-scheme` — so a returning visitor keeps their
choice and a new visitor gets their OS preference.

`.er-when-light` / `.er-when-dark` visibility helpers also flipped to match
the new default. Anything theme-conditional hangs off
`:root[data-theme="dark"]` selectors in `globals.css`.

## Structure

- **Header** (`web/components/SiteHeader.tsx`, all screens): ER monogram (see below),
  letterspaced mono wordmark, live scoreboard, edition toggle. No gradient
  wordmark. Stays a *server* component — only the scoreboard needs the client,
  and it's a separate component so the rest of the header isn't dragged over the
  boundary with it; the monogram is plain SVG with no hooks, so it doesn't cross
  that boundary either. The rotating ink square the monogram replaced is gone,
  along with the `er-sq-turn` keyframes it was the only user of — a monogram
  can't rotate and stay readable.
- **Hero** (`web/app/page.tsx`): three-line THE / ENGINE / ROOM headline, each
  line rising from an `overflow: hidden` mask (`.er-line`), "ENGINE" hollow
  via `-webkit-text-stroke` (`.er-hollow`; fills red on headline hover).
  Right: the ReplayBoard.
- **ReplayBoard** (`web/components/ReplayBoard.tsx`): replays Morphy's Opera Game
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

## Header scoreboard — the live readout

`web/components/HeaderScoreboard.tsx` + `web/lib/boardFeed.ts`. Two squares for the two
sides with the side to move ringed in red, the move number, and the last move in
algebraic. Replaced the old `Live — engines coupled` badge, which is worth
understanding as a design lesson rather than just a deleted line:

**The badge wasn't ugly, it was untrue.** Nothing was live and no engines were
coupled — it spent the loudest element in the header (a pulsing accent dot) on a
claim the app couldn't back. But the landing page *does* have a real game running
on it: `ReplayBoard`'s Opera Game, one ply every 1150ms. So the fix wasn't to
remove the readout, it was to connect it.

- **`web/lib/boardFeed.ts` is a module-level store, not React context.** The header
  lives in the root layout and every board lives inside the page, so a provider
  would have to wrap the whole layout, and publishing upward from board to
  provider means calling `setState` from an effect — the same
  `react-hooks/set-state-in-effect` trap `TransitionLink`'s pressed state hit
  (see Traps below). `useSyncExternalStore` is the shape React ships for this.
  `getServerBoardFrame()` returns `null` so the server render and the first
  client render agree, then a board mounts and publishes.
- **Three publishers, one readout.** The hero replay, `/model-1v1`, and
  `/user-1v1` all publish `{ ply, lastSan, over }`. Adding another board is one
  effect, no new component.
- **`null` means "no board on this route" and is not the same as ply 0.** On
  `/history` the scoreboard renders nothing — dead chrome reading "no game"
  would be worse than an empty slot. `/model-1v1` publishes from ply 0 because
  its board is on screen before you press Start; `/user-1v1` publishes `null`
  until `started`, because there genuinely is no board yet.
- **The move number is *moves completed*** (`ceil(ply / 2)`), deliberately
  matching the caption under the hero board so the two can't visibly disagree.
  Read strictly, "Move 1 · e5 · white to move" means one full move is played and
  white is up next — not that white is playing move 1.
- **Width is pinned** (`tabular-nums` + `min-w` on the number and the notation).
  A readout that resizes itself every ply is most of what makes a live element
  feel cheap; it was measured at a constant 153px across a whole game.
## Brand mark — the ER monogram

`web/components/BrandMark.tsx`. Two letters on a 100-unit cap-height grid (stem 26,
horizontal bar 20), constructed rather than typeset: flat terminals, square
corners, a rectilinear R bowl with a straight leg. Ink by day, paper by night
(it inherits `color`, so it flips for free), plus one red plate-corner tick that
stays red in both editions and lights up at night off `--er-accent-glow`.

**Two cuts, and the reason matters.** A framed monogram *cannot* work at 16px:
the hairline frame, the gap inside it, and the letter counters all land under
1.5px and merge into a dark blob. So:

| Cut | What it is | Used at |
|---|---|---|
| `plate` | hairline frame + letters + corner tick | 28px and up |
| `bare` | same letters, no frame, scaled up to fill the box | under 28px |

`<BrandMark size={n} />` picks the cut from the size, so callers can't
accidentally ship the illegible one; pass `cut` to override. The header uses
`size={18}` → bare.

**The letters are paths, not `<text>` in Archivo Black.** `web/app/icon.svg` reuses
the same geometry and a favicon renders with no webfont available — a text mark
would silently fall back to a serif in the browser tab. The trade is that the
numbers exist in two files; the SVG says so at the top, and `BrandMark.tsx` is
the source of truth.

**Icons** (all Next `web/app/` file conventions, no `metadata.icons` config needed):
`icon.svg` is the bare cut, ink on light browser chrome and paper on dark via an
inline `prefers-color-scheme` rule. `favicon.ico` (32px bare) and
`apple-icon.png` (180px plate, inset 15% so iOS's rounded mask can't clip the
frame) are raster, so they can't carry that media query — both sit on an opaque
bone plate instead, because an ink monogram on transparency disappears entirely
on a dark tab strip. Regenerate them with `web/scripts/make-icons.mjs`.
## Route transition — "the press"

`web/components/PageTransition.tsx` + the `.er-press-*` rules in `globals.css`.
Every link that navigates goes through it; nothing else in the app does.

The print metaphor taken literally — a press taking an impression:

1. Red ink strikes at the exact pixel you clicked (a hard core dot plus a ring
   of impact spreading off it), and the clicked control depresses ~3px and stays
   down. Fires at 0ms so the click feels instant.
2. The platen drops as six vertical slats, staggered left→right, in the inverted
   ground — the same ink-by-day / paper-by-night flip as the index-row hover.
3. The destination's **plate name** types up out of a mask between two
   registration rules that draw in from opposite ends, with printer's
   registration marks in the four corners. Plate names/kickers live in the
   `PLATES` map keyed by route; the kickers reuse the mode index's tags.
4. The platen lifts *downward* — opposite direction to the way it came, so it
   never looks like it's retracing its path — revealing the new page already
   mid-entry-animation.

Roughly 1.2s end to end (620ms to cover, then the route swap, then 540ms to
lift). Verified frame by frame with `web/scripts/cdp-press.mjs`.

Things worth knowing before you touch it:

- **It's a provider, not CSS on the link.** The platen has to stay down *across*
  the navigation, so one overlay lives above the router in `web/app/layout.tsx` and
  links only ask it to run. It renders a fragment — wrapping the header and page
  in a `<div>` there would break `<body>`'s flex column.
- **The lift is triggered by the route committing, not a timer.** A slow RSC
  fetch stays hidden behind the platen instead of flashing the old page. There's
  a 3s cap so a route that never commits can't leave the screen covered.
- **Links opt out in three cases**, all deliberate: modified clicks
  (cmd/ctrl/shift/alt, middle-click — "open this elsewhere"), an href equal to
  the current path, and `prefers-reduced-motion`. In all three the press never
  mounts and the link behaves like a plain `<Link>`.
- **Pressed-down state is derived, not stored.** `TransitionLink` computes it
  from the provider's `active` href rather than holding local state, because the
  header wordmark outlives the navigation it triggers and would otherwise stay
  stuck down. (An effect syncing the two also trips
  `react-hooks/set-state-in-effect`.)
- **The stamp is a `transition`, not an `animation`.** `.er-index-row` already
  runs `er-fade … forwards`, and a second animation on the same element would
  replace it — snapping the row back to its `opacity: 0` base. Safe as written
  because `er-fade` only keyframes `opacity`, so its fill never holds a
  transform hostage; `transform` is just added to the row's transition list. This
  is the "Traps" note at the bottom of this file, met in the wild.
- **The ink is contained on purpose.** The first pass scaled a filled disc to
  150x and it washed the entire viewport red — you lost the platen, the page, and
  any sense of where you'd clicked. A ring reads as an impression; a flood reads
  as a bug. Also why the ring carries no `box-shadow`: a blurred shadow scaled
  that far is genuinely expensive to paint.

## Traps

- **Never let chess notation inherit the header's `uppercase`.** Case is
  semantic in algebraic notation: `Nxb5` uppercased to `NXB5` loses the piece
  letter, and `dxe5` → `DXE5` reads as a bishop move. The scoreboard's notation
  span carries `normal-case` for exactly this, and it's the only thing in that
  header which isn't caps. Hit in the mockup pass before it could ship.
- **`role="status"` on anything that updates on a timer is an accessibility
  bug.** Status carries an implicit `aria-live="polite"`, so the scoreboard would
  have announced itself to a screen reader once every 1150ms, forever, on the
  landing page. It's `role="img"` with an `aria-label` instead — a single
  labelled graphic, read when you reach it, never shouting. (The label also
  stops the bare fragments "Move", "4", "Bg4" being read as a sentence.)
- **`[role="status"]` is not a safe test selector on any page with a board.**
  react-chessboard's dnd-kit sensor mounts a hidden 1px `DndLiveRegion` with
  that exact role, so a verification script looking for a status element finds
  dnd-kit's and reports the wrong thing. Target `.er-turn` instead.
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
