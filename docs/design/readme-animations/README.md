# README animations — option gallery

Twelve animated-SVG options for dressing up the root README, in the Ink & Bone
language (bone plate, ink, the one red accent, no rounded corners). Each option
is a **real standalone `.svg`** using only CSS/SMIL animation with system-font
fallbacks — exactly what GitHub allows inside a README `<img>`, so a picked
option ships as-is, no rework.

## Browse them

```sh
node docs/design/readme-animations/server.mjs   # then open http://localhost:4173/
```

(or open `index.html` straight off disk — the server only exists so `<img>`
loading matches how GitHub serves them). The page has a Replay button per
option and a GitHub light/dark toggle; every SVG carries its own bone-paper
plate so it reads identically on both GitHub themes.

## The options

| Spot in the README | Files |
| --- | --- |
| Masthead | `hero-a-rising` (the site hero, miniaturised) · `hero-b-press` (platen slats lift off the headline) · `hero-c-marquee` (looping telemetry strip) |
| Section dividers | `div-a-registration` (rules draw in, plays once) · `div-b-inkdot` (carriage shuttles forever) · `div-c-typed` (section label types itself) |
| "The two engines" | `vs-a-duel` (Stockfish grinds depth 3→13 while Maia answers in one 35 ms blink) · `vs-b-scoreboard` (the header scoreboard, replicated) |
| Architecture diagram | `flow-a-pulse` (red move-pulses travel the `getMoveFor` path) · `flow-b-conveyor` (belt wires, stages light in order) |
| Board plates / footer | `board-a-replay` (Opera Game first six plies, looping) · `board-b-mate` (the final Rd8# position, mating square breathing) |

## State, and what's left

- **Nothing is wired into `README.md` yet.** These were cut against the old
  README; the submission README (#30/#32) landed meanwhile with its own
  `docs/assets/hero.svg` masthead and a PNG screenshot gallery — so placement
  needs a fresh look before wiring anything in. Rough intent was: masthead at
  the top, typed labels as `## ![alt](svg)` headings (alt text keeps GitHub's
  outline and anchors working), `flow-a` replacing the ASCII diagram (fold its
  annotations into the box sublabels first, and add the missing
  `lib/games/store.ts` node), duel/scoreboard in the engines section, a board
  plate as the colophon.
- **Night-edition variants aren't cut yet** (ink ground, lit-red signage,
  swapped via `<picture prefers-color-scheme>`). The day plates read fine on
  GitHub dark as-is, so this is polish, not a blocker.
- All 12 verified animating in headless Chrome via `<img>` embedding — but
  note the capture trap: Chrome's `--screenshot` and `--virtual-time-budget`
  both sample these SVGs at t≈0 and make working animations look broken
  (1A renders blank, 1B stays a solid ink block). Screenshot through CDP with
  a real-time wait instead; that's how these were checked.
