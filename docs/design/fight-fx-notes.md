# Fight FX — design notes

The anime-fight effects layer over both game boards. Added 2026-08-04, after
the Ink & Bone revamp.

## The idea

"Anime fight" and Ink & Bone's restrained editorial monochrome sound like
opposites. They aren't: **manga is ink on paper.** Speed lines, impact frames,
screentone, hard black spatter, one spot colour — that's the same vocabulary the
rest of the app already speaks. So the frame isn't "anime on a chessboard", it's
*the fight as printed in a manga panel*. Nothing here introduces a new colour;
`--er-accent` and `--er-text` do all of it, and `--er-invert-bg/fg` (already
there for the index-row hover) *is* the impact frame.

## Architecture

```
verbose move + position → classify() → FxBeat{tier,kind,from,to,…} → FxStage
```

| File | Job |
| --- | --- |
| `web/lib/fx/types.ts` | `FxBeat`, `FxContext`. No React, no chess.js. |
| `web/lib/fx/classify.ts` | The tier rules. Pure — testable without a DOM. |
| `web/lib/fx/openings.ts` | Opening-name table for the attack-name callout. |
| `web/lib/fx/effects.ts` | The 19 effects, shared by FxStage and the lab. |
| `web/lib/fx/runtime.ts` | `useFxEnabled`, `materialHp`, `depthToPct`. |
| `web/components/fx/FxStage.tsx` | Wraps a board, renders effects, imperative handle. |
| `web/components/fx/fx.css` | Every keyframe. Deliberately not in globals.css. |
| `web/app/dev/fx-lab/page.tsx` | Disposable picking harness. Delete when done with it. |

## The tier ladder

The failure mode of an effects layer is uniformity — if every ply screams,
nothing lands and a 60-ply game is noise. So most plies render **nothing**, and
that's what buys the captures their impact.

| Tier | Fires on | Gets | Pause |
| --- | --- | --- | --- |
| 0 | quiet move | nothing | 350ms (unchanged) |
| 1 | any capture | impact frame, focus lines, blot, spatter, shake, damage number | 470ms |
| 2 | check / promotion / castle / rook-or-queen capture / recapture / opening reveal | + callout, vignette, alarm, pillar | 700ms |
| 3 | checkmate | + slow-mo, screen crack | 2000ms |

**The pause is part of the effect.** That's the hit-stop, and it's the one thing
a fixed delay can't fake, which is why `runModelGame`'s `onMove` may return a
number to override `moveDelayMs` for that ply. Tier 3 is off the leash because
the game is over — there's no next ply to overlap.

## Two profiles

- **`spectate`** (Model 1v1) — you're an audience. Full ceiling, hit-stop on,
  VS card before the first search.
- **`play`** (User 1v1) — you're a participant. Same tiers, but the engine's
  own beats get `muted` so the board never gets buried while it's your turn to
  read it, and **there's no hit-stop**: a pause between two engines is drama,
  the same pause between your drag and the reply is just lag.

## Things that will bite

- **The overlay must stay `pointer-events: none`.** User 1v1's drags run through
  dnd-kit's PointerSensor (react-chessboard v5). An overlay that captures
  pointers kills every move on that screen, silently.
- **Measure geometry in one pass, from the *stage*, not the overlay.** The board
  is a *sibling* of the overlay, so `overlayRef.querySelector('[data-square]')`
  finds nothing, `readBeat` returns null, and all 19 effects no-op without a
  single error. Cost an hour during the build. And never `scrollIntoView`
  between reading two squares — `deployment.md` §4 covers why.
- **Effects fire `BOARD_SLIDE_MS` (220ms) after the move**, matching Board's own
  `animationDurationInMs`. Hitting a square the piece hasn't reached yet reads
  as the effect missing. If you retune the board's animation, retune this.
- **The ki-charge bar is real** — it's Stockfish's streamed `info depth` through
  `getMoveFor`'s `onInfo`. Maia has no search and reports no depth, so it shows
  an indeterminate charge capped below 100 rather than a bar stuck at zero.
- **`orientation` must match the Board's.** The HP rails and the charge half are
  side-anchored; on a flipped board (playing Black) they'd otherwise label the
  wrong side.
- **Two opt-outs:** `prefers-reduced-motion` and `?fx=off`. The latter is for the
  CDP harnesses — driving drags while spatter paints over the board is a way to
  lose an afternoon.
- Effects are throwaway DOM with a TTL, so a long game doesn't accumulate
  hundreds of dead nodes. Don't make them state.

## Tuning already done once

- The finisher's screen crack is clipped to the board (`.er-fx-crack` is
  `overflow: hidden` while the overlay is `visible`). Unclipped, branches drew up
  over the site header and read as a rendering bug.
- Cinema's contrast was cut from 1.32 to 1.1 plus a touch of brightness. On the
  night edition's already-dark ground, 1.32 took the board to nearly solid black
  and you lost the position under the finisher.

## Verification status (2026-08-04)

The 19 effects were each confirmed producing DOM in the FX lab over CDP, and
shake/slow-mo confirmed separately by sampling `.er-fx-body`'s class and computed
transform per frame (they add no overlay nodes, so node-counting reports them
dead). `tsc`, `eslint`, and a production build are clean.

**Not yet verified in a browser: the wiring on the two game screens**, including
the drag path on `/user-1v1`. That was cut for time on the merge. If drags stop
working there, the overlay's `pointer-events` is the first thing to check.
`web/scripts/`-style CDP harnesses for this live in the session scratchpad, not the
repo.
