# What the presets are actually worth

The dropdowns say Stockfish 1320 / 1800 / 2800 and Maia 1100 / 1500 / 1900. None
of those numbers was ever a measurement. They are a UCI option string and a model
input, and the only thing the engine spikes established is that both are
*accepted* — Task 2's own notes say so outright:

> Depth does not vary with ELO (13 at both 1320 and 2800)... this spike proves
> the options are accepted and the engine searches; it does **not** prove the ELO
> settings change playing strength.

`docs/maia-notes.md` has the same admission one level removed: sweeping the
rating input left the top move unchanged in its rating-responsiveness check,
which "proves the input is wired... not that it produces a large strength
difference."

This is the measurement. Engines play each other from a randomized opening book,
results go into a Bradley-Terry fit with a Davidson draw term, and a sequential
test (SPRT) decides when there is enough evidence to stop. Built as Task 16 from
[`specs/2026-08-05-sprt-engine-ratings.md`](specs/2026-08-05-sprt-engine-ratings.md).

## The numbers

114 games, six pairings, anchored on Stockfish 1800 = 1800 by definition.
Fitted Bradley-Terry Elo with a Davidson tie term (γ̂ = 0.641 ± 0.171):

| Preset | Label says | Measured | ± 1 s.e. | Record |
| --- | --- | --- | --- | --- |
| Maia 1900 | 1900 | **2104** | 169 | 15/22 |
| Maia 1500 | 1500 | **1978** | 134 | 26.5/46 |
| Maia 1100 | 1100 | **1929** | 141 | 51.5/90 |
| Stockfish 1800 | 1800 | *1800 (anchor)* | — | 9.5/24 |
| Stockfish 1320 | 1320 | **1347** | 159 | 3.5/38 |
| Stockfish 2800 | 2800 | *unrated* | — | 8/8 |

Sequential tests, all asking "is the gap at least 200 Elo?" at α = β = 0.05:

| Pairing | Result | SPRT | Gap |
| --- | --- | --- | --- |
| Stockfish 1800 vs 1320 | 7W 1D 0L | H1 | decisively stronger |
| Stockfish 2800 vs 1800 | 8W 0D 0L | H1 | decisively stronger |
| Maia 1900 vs Maia 1100 | 13W 4D 5L | *no decision* | +176, interval covers 0 |
| Maia 1500 vs Maia 1100 | 16W 9D 13L | *no decision* | +34 ± 63 |
| Maia 1500 vs Stockfish 1800 | 4W 4D 0L | H0 | −241 ± 161, to Maia |
| Maia 1100 vs Stockfish 1320 | 26W 2D 2L | H0 | −496 ± 125, to Maia |

### Three things worth taking from this

**Stockfish's `UCI_Elo` is real.** 1800 beat 1320 seven games to nil with one
draw, and 2800 beat 1800 eight to nil. Both crossed the H1 boundary almost
immediately. Whatever else is uncertain here, Task 2's open question — do the
presets differ in strength at all, or is `UCI_Elo` just an accepted option string
— is closed, and the answer is yes.

**Maia's rating tiers barely differentiate.** 1500 against 1100 over 38 games:
sixteen wins, nine draws, thirteen losses, a fitted gap of **34 Elo** against a
label gap of 400, and the test never reached a boundary. 1900 against 1100 is
+176 with an interval that comfortably covers zero. This is the same thing
`docs/maia-notes.md` saw from the other end — sweeping the rating input left the
top move unchanged — now measured in games rather than logits. The rating input
is wired and it does *something*; it does not buy 800 Elo, or plausibly even 200.

**Stockfish's weakened presets lose to Maia, badly.** Maia 1100 beat Stockfish
1320 twenty-six games to two. Maia 1500 went unbeaten against Stockfish 1800 in
eight. On this scale every Maia tier fits *above* Stockfish 1800. The likely
reason is that `UCI_LimitStrength` weakens Stockfish by making it choose worse
moves from its own candidate list, which produces occasional catastrophic
blunders rather than consistently mediocre play — while Maia plays the move a
human would, which is rarely a catastrophe. Two engines can share a nominal
rating and be nothing like each other to play against. Worth knowing before
anyone reads the dropdown numbers as comparable across engines: **they are not,
and this is the measurement that says so.**

### Why Stockfish 2800 has no number

It won all eight of its games. A preset that never loses has an Elo that is
unbounded above — push it higher and the likelihood keeps improving, so there is
no maximum to report. Ford's condition catches this before fitting rather than
after, and the fit refuses rather than emitting the large confident number a
runaway iterate would produce. The honest statement is "stronger than everything
it played, by an amount these games cannot bound."

### A result that did not survive its own audit

The first Maia 1900 vs Maia 1100 match reported H1 accepted — "at least 200 Elo
apart" — on an LLR of 3.141 over 34 games. Replaying it from the deduplicated log
gives **LLR 1.795 over 22 games, which is not a decision at all.** Twelve of
those 34 games were byte-identical replays of others in the same match: the
opening sampler drew with replacement, and against a deterministic engine the
same opening is the same game. The duplicates carried the test over its boundary.

Nothing was wrong with the SPRT. It was fed twelve games' worth of evidence that
did not exist. `scripts/refit-ratings.mjs` recomputes every run's terminal state
from the log rather than trusting what was stored, which is the only reason this
was caught; it flags disagreements instead of overwriting them. The log is
deduplicated and the runner now deals openings from a shuffled deck.

**Three of the six pairings are still short** — the two Stockfish ones and
Maia 1500 vs Stockfish 1800 ran only 8 games each, because the sequential test
decided and stopped before `minGames` existed. Their gaps are real in direction
and weak in magnitude. Re-running them at `minGames=30` is the single highest-
value thing anyone could do to this fixture, and the runbook below is how.


## How to read these numbers

**The anchor is a definition, not a measurement.** Bradley-Terry identifies
strength only up to an additive constant — the model only ever sees differences —
so one preset has to be nailed down for the rest to have a scale. `Stockfish 1800`
is fixed at 1800 by fiat. It has no standard error because it was never
estimated. If the real Stockfish 1800 preset plays at 1650, every number here is
150 too high and their *differences* are all still correct. There is no external
human pool to calibrate against, so the gaps are the honest deliverable and the
absolute numbers are scaffolding.

**"Unrated" is a real answer, not a missing one.** A preset that never lost has an
Elo that is unbounded above: the likelihood keeps improving the further you push
it, so there is no maximum to report. Ford's condition (1957) is the general
version — the win graph has to be strongly connected — and the fit checks it
before fitting rather than discovering it as a runaway iterate. When you see
"unrated, never lost", the right reading is "decisively stronger than everything
it played, by an amount these games cannot bound", which is usually the more
interesting sentence anyway.

**The intervals are wide and that is not a defect.** A sequential test stops the
moment the evidence crosses a boundary, which for a lopsided pairing is a handful
of games. That is the whole point — it does not waste an hour confirming
something obvious — but a handful of games cannot also produce a precise rating.
The spec's own table says a directional question costs ~22 games and a 50-Elo
precision question costs ~320. Every match here asked the cheap question.

**Draws are modelled, not scored as half a win.** Half-win scoring cannot tell
"many close draws" (weak evidence) from the same score split entirely between
decisive results (strong evidence), and it systematically understates gaps — a
true 200-Elo difference comes back as about 159. Measured on synthetic data in
`scripts/verify-analysis-math.mjs`: 158.2. The Davidson term is the fix.

## Where the numbers live

- **`web/lib/analysis/fixtures/games-log.jsonl`** — one JSON object per game:
  pairing, opening id, result, full SAN, timestamp, run id. Newline-delimited, so
  a new match appends rather than rewriting a growing array.
- **`web/lib/analysis/fixtures/ratings.json`** — the derived fit plus each SPRT
  run's terminal state. A cache: delete it and it regenerates from the log.

Nothing here is surfaced in the app. The spec puts that out of scope, and it
should stay out until someone decides what an honest UI for "unrated, unbounded
above" looks like.

## Adding a pairing

The whole loop is one page and one script. From `web/`, with a production build
running (`npm run build && npx next start -p 3200`):

```sh
URL='http://localhost:3200/dev/match-runner?a=Stockfish%202800&b=Maia%201900&elo1=200&minGames=30&maxGames=40&seed=1007'

"C:/Program Files/Google/Chrome/Application/chrome.exe" \
  --headless=new --remote-debugging-port=9351 \
  --user-data-dir=/tmp/chrome-sprt --window-size=1280,1400 "$URL" &

node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
  scripts/sprt-run.mjs "$URL" 2700000 9351
```

The script appends the games and refits `ratings.json` over *everything* logged,
so pairings accumulate. To rebuild that file from the log alone — including
replaying each run's SPRT rather than trusting the stored terminal state:

```sh
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/refit-ratings.mjs --dedupe
```

Five things worth knowing before you start a match:

- **Set `minGames`.** Without it the sequential test stops the moment it is
  confident, which on a lopsided pairing is about eight games — and eight games
  of a lopsided pairing is a whitewash, which has no measurable Elo at all. The
  decision still only counts games up to the boundary; the rest are for the fit.
- **Use a fresh `seed` per run on a pairing you have already played.** Same seed,
  same openings, same deterministic engines, same games. `sprt-run.mjs` will drop
  them as duplicates, so you get a match that logs nothing.

- **Use a fresh `--user-data-dir` and a port nobody else is on.** A killed
  headless Chrome leaves a ProcessSingleton lock and the next launch on the same
  profile aborts silently; and two agents both assuming 9222 is theirs is a real
  hazard in this repo (`docs/deployment.md` §4).
- **`localhost`, never `127.0.0.1`.** Next treats the latter as cross-origin and
  the page never hydrates — HTTP 200, no console errors, nothing happens.
- **Run against a production build.** Under `next dev`, StrictMode mounts the
  effect twice and you play the match twice.
- **Budget the wall clock.** ~35s per Stockfish-vs-Stockfish game, ~19s mixed,
  ~2.5s Maia-vs-Maia, times tens of games. There is no parallelism to lean on:
  `engineStockfish.ts` is one shared Worker behind a promise queue, so two
  concurrent games interleave onto it rather than going faster.

To check the maths without playing anything — ten seconds, no browser, no engine:

```sh
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/verify-analysis-math.mjs
```

## Why there is an opening book

Because without one, N games is one game N times.

Maia is *exactly* deterministic: `getMaiaMove` takes the argmax of a softmax over
legal moves, a pure function of `(fen, ratingTier)`. Same position, same move,
forever. Stockfish has variance but it is accidental — `go movetime 500` is a
wall-clock search, so timing jitter flips close calls and nothing else does.
Task 2 saw exactly that: at 1320 two runs agreed, at 2800 they didn't.

So the runner plays a prescribed opening first — 21 structurally distinct lines,
6–8 plies, picked uniformly — and only then hands over. The engines are untouched;
what differs is the *position* they start thinking about. Each line is played
twice with colours swapped, which cancels first-move bias without adopting
fishtest's paired scoring.

All 21 lines are checked legal and, more usefully, checked *non-transposing*:
replay each one and the resulting positions must all differ. Two lines that
transpose are one line for decorrelation purposes however different their move
lists look.

**Openings are dealt from a shuffled deck, not drawn with replacement, and that
change came from measurement.** The spec says "picked uniformly per game" and
sizes the book so repeats stay rare. At small N that under-reads the problem: a
repeat is not a slightly-correlated game, it is a byte-identical one, worth zero
information — but the sequential test still counts it as evidence and reports a
narrower interval for it. The first Maia 1900 vs Maia 1100 match logged 34 games
of which **22 were distinct**. Seventeen opening draws over a 21-line book
collide about a third of the time, which is exactly the birthday arithmetic.
Dealing without replacement makes it impossible for the first 42 games of a
match; `sprt-run.mjs` catches cross-run collisions separately, on exact
move-sequence identity.

## What isn't here

- **The full 15-pairing roster.** Scheduling is explicitly out of the spec's
  scope. Adding one is the runbook above.
- **Precision runs.** Every match asked "is the gap at least 200 Elo", which is
  the ~22-game question. The ~320-game version (is it at least 50?) is roughly
  three hours per Stockfish pairing and was never started.
- **Pentanomial scoring.** fishtest pairs two games per opening and scores the
  pair as one of five outcomes, which cancels more variance than colour-swapping
  alone. Trinomial plus colour-pairing is a deliberately smaller step.
- **Any claim about human Elo.** These are relative gaps on a scale anchored by
  assertion. "Stockfish 2800 beats Stockfish 1800" is measured; "Stockfish 2800
  would beat a 2800-rated human" is not, and nothing here is evidence for it.
