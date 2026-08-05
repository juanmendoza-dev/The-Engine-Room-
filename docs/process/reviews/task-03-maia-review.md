# Task 3 — Maia spike: review of PR #7

> **Outcome, added when this review landed on `main` (2026-08-05).** Everything
> below is the review exactly as written on 2026-08-04, while PR #7 was still
> open. Read it as a snapshot, not as a to-do list — the verdict was acted on and
> every follow-up it names is already done. What happened after:
>
> - **PR #7 merged**, squash `e8e851f`. Maia is live on `/model-1v1`.
> - **All three follow-ups were done inside PR #7 before it merged**, so don't
>   re-do them: the first-load status line *plus* a stall timeout (20 s of zero
>   bytes, not a total budget) on both `/model-1v1` and `/user-1v1` and a new
>   `components/MaiaLoadNotice.tsx`; the 13.6 MB of dead ort files deleted
>   (40.4 → 26.9 MB); and the model rehosted.
> - **The weights now live in a second repo**, `juanmendoza-dev/engine-room-assets`,
>   fetched from `raw.githubusercontent.com` pinned to `7c916f4`. That closes the
>   Q2/Q6 single-point-of-failure about CSSLab having deleted the file from their
>   `main`. One hard-won fact from doing it: GitHub **Release** assets send no
>   CORS headers at all (they're served from Azure blob), so a browser fetch of
>   one fails outright — a Release was built, tested, and deleted.
> - **The ready-to-paste §4 correction at the bottom of this doc is applied.**
> - **Q1's timings are optimistic.** The 24–29 s figures were local, where the
>   26.8 MB ORT wasm came off localhost for free. Cold load on *production*
>   measured **73 s and 261 s**, because there the wasm is a real download
>   competing with the 93 MB model. Our mirror isn't the culprit — it benchmarked
>   faster than CSSLab's. Numbers are in `docs/deployment.md` §4.
>
> Still genuinely open in this review's territory: the **IndexedDB model cache**
> (Chrome won't disk-cache a 93 MB body, so every full page load re-downloads it
> — that's the real fix for the timings above; until then, pre-warm Maia in the
> tab before showing anyone and don't refresh), and this repo still has **no
> `LICENSE` file**.

Independent review, written against the PR as it stands at `613a9b6` (eight
commits — note the branch grew a commit *after* the review was assigned, and it
matters: Maia is now wired into the registry, so merging this puts three Maia
presets live on `/model-1v1` immediately, not "later when Task 4 wires it").

| | |
| --- | --- |
| PR | #7 — open at review time, and this doc is that review; **merged since** as `e8e851f` (see the outcome block above) |
| Branch | `feat/03-maia-onnx-spike` at `613a9b6`, based on `e3319ba` (#8); GitHub reports `MERGEABLE / CLEAN` against `main` at `c5af670` |
| Verdict | **Merge now.** Three follow-ups named below; the loading state is the one to treat as blocking *for demo day*, not for the merge |
| Re-verified | production build (`next build` + `next start -p 3003`), headless Chrome 151, cold cache, this machine — plus a reference-parity check against CSSLab's own training-side code run in Python. Every number the author reports reproduced exactly |

## Verdict, in the form the owner can act on

**Merge it.** The engine work is correct — not "looks correct": the browser
pipeline's output matches CSSLab's canonical implementation to the decimal on
every position I threw at it (details in Q3). The licensing call is right, the
build is clean, GitHub says the merge is conflict-free, and the presets are
opt-in (Model 1v1 still defaults to Stockfish vs Stockfish, so nobody hits Maia
without choosing it).

Then, before demo day, in this order:

1. **First-load status line.** A cold visitor who picks Maia stares at
   `WHITE THINKING · MAIA 1100` over a frozen board for **24–29 s on a fast
   connection** (measured, twice), **~2.5 minutes at 5 Mbit/s conference wifi**
   (arithmetic), and **forever** if the fetch stalls — `engineMaia`'s loader has
   no timeout, unlike Stockfish's 60 s one. Even a static "downloading the 89 MB
   Maia model, ~30 s…" line next to the lamp defuses it. The author flags this;
   what they don't flag is that it repeats on *every* full page load — see Q1,
   Chrome refuses to cache the file.
2. **Decide where the model lives.** Today it hotlinks a file that CSSLab has
   *already deleted from their `main`* — the pinned commit is the only thing
   still serving it (Q2/Q6). Fine for this week; not something to discover
   broken on stage.
3. **Delete 13.6 MB of dead ort files** — verified unused, zero code change
   (Q4). A further 26.8 MB cut is available for a small verified code change.

And one paste: `docs/deployment.md` §4's no-COOP/COEP paragraph needs a rewording
(Q5). **Deliberately not done on this review's branch** — two other lanes are
editing that file right now; the exact replacement text is at the bottom, apply
it wherever that file settles.

## What I actually did (so you can discount it appropriately)

- Fresh worktree of the PR head, `npm install`, `npm run build`, `npm run start
  -p 3003`; drove `/dev/maia-test` and `/model-1v1` with headless Chrome via CDP
  on cold profiles. All timings are **one machine, one connection** (~34 Mbit/s
  measured by curl to the same CDN) — treat the seconds as a floor, the sizes as
  exact.
- Ported CSSLab's **training-side** preprocessing (`maia2/utils.py`,
  `board_to_tensor` / `map_to_category` / `get_all_possible_moves`, torch →
  numpy mechanically) and ran the same released `maia_rapid.onnx` through Python
  onnxruntime. This is the reference-parity check the spec's V1 wanted, minus
  lc0 — against the code that *trained* the model rather than the frontend port
  the author compared to.
- Destructive experiments (file deletions, import swaps, `numThreads=4`) ran in
  a throwaway checkout, never on the PR branch.
- Two CDP traps cost me time and are worth other agents knowing: enabling the
  CDP `Network` domain with a large body buffer stalled the 89 MB fetch
  indefinitely (harness artifact, not an app bug — pass `maxResourceBufferSize:
  0` or don't enable it), and `innerText` returns the *rendered* uppercase of
  the status line (`WHITE THINKING · MAIA 1100`), which corroborates the regex
  trap the author documented in `docs/maia-notes.md`.

## The seven questions

### Q1 — Does the 89 MB runtime fetch work from a production build, and how long cold?

**Works, and here are the numbers.** Production build, headless Chrome, cold
profile:

```
model fetch:  88.98 MB in 26.5 s (28.2 Mbit/s)   [run 1]
              88.98 MB in 19.4 s (38.4 Mbit/s)   [run 2, same profile — see below]
curl baseline: 93,246,338 bytes in 21.7 s (34 Mbit/s)
page-suite total, navigate → done: 29.4 s
real screen, click Start → first move on the board: 28.8 s and 24.0 s (two cold runs)
```

Size math for other connections (93,246,338 bytes): **5 Mbit/s ≈ 149 s**,
20 Mbit/s ≈ 37 s, 100 Mbit/s ≈ 7.5 s, plus ~2–3 s of session init.

The part the PR undersells: **run 2 above is the same browser profile minutes
later, and it re-downloaded all 88.98 MB.** The server sends `Cache-Control:
max-age=300` (five minutes), but it never got that far — Chrome declined to
disk-cache the object at all (a body this size exceeds Chrome's per-entry cache
cap), while the 25 KB move table cached fine. So "we rely on the browser HTTP
cache" is effectively false in Chrome for this file: **every full page load
pays the full download**. Within one tab session it loads once (module-level
singleton); F5 pays again. That upgrades the reference app's IndexedDB cache
from nice-to-have to the actual fix, whenever someone has an hour.

Also: `load()` has **no timeout** — `getStockfishMove` rejects after 60 s, Maia
just awaits `fetch` forever. A judge on flaky wifi gets a permanent thinking
lamp instead of the "Engine failed" error card the page already knows how to
show.

### Q2 — MOVE_TABLE_URL pinning, and 1858 vs 1880

**Already fixed on the branch** — the review brief predates commit `cfc935d`;
both URLs now pin `e23a50e`. Verified independently, three ways:

- The blob is byte-identical at the pinned commit and on CSSLab's current
  `main` (`1698c2296e`, 25,298 bytes — GitHub API, both paths), so the pin
  changed nothing today, exactly as the author reports.
- My run round-trips **1880 entries, 0 mismatches** (their number, reproduced).
- Stronger than either: `maia2`'s own `get_all_possible_moves()` *regenerates*
  the table programmatically — 1880 moves, and the pinned JSON matches the
  generated **order** exactly, all 1880 indices. The table isn't just
  self-consistent; it's the canonical one.

**1858 vs 1880 reconciled:** not an off-by-anything. 1858 is the size of
**lc0's** classic policy vector — the *original-Maia* world the spec was written
against before CP1. 1880 is Maia 2's own move space (1792 queen/knight
from-square moves + 88 promotion entries, generated by the code above). The
notes already say this (`docs/maia-notes.md` line 190); the two numbers never
described the same table.

One thing the pin turned out to be **necessary** for, not just hygienic:
CSSLab's current `main` no longer contains `maia_rapid.onnx` *at all* (they
ship only `public/maia3/` now). An unpinned MODEL_URL wouldn't be "at risk of
drift" — it would already be a 404. Q6 continues this thought.

### Q3 — Is the encoder actually correct?

**Yes — and this review can say so more strongly than the PR does.** The PR's
own queen-capture test is the right discriminator and I reproduced it exactly
(`e3d4 93.9%, g1f3 1.1%, c2c3 1.1%`). But "my arithmetic matches the reference
line-for-line" was doing load-bearing work in the earlier argument, so I went
around the frontend reference entirely:

**Canonical parity.** CSSLab's *training-side* preprocessing (from
`CSSLab/maia2`, the code the model was actually trained with) feeding the same
released ONNX in Python produces output **identical to the browser pipeline to
0.1 percentage points on every test position** — same top-3 with the same
probabilities after 1.e4 at all three ratings (g8f6 31.9/29.3/32.6%), same
93.9% queen grab, same Ruy `f1b5` at 28.5%, same raw values (−0.1813 start,
+0.4583 queen-up), same mirror value 0.2076. The encode/decode is not "probably
right"; it is the canonical computation.

**The one divergence from the reference is in the PR's favour.** The frontend
reference the author ported from (`useMaiaEngine/utils.ts` at the same pinned
commit) writes the **en-passant bit with an extra rank inversion**
(`row = 7 - rank`); the PR writes it at `rank − 1`. The training code
(`divmod(ep_square, 8)`) says the PR is right and the **GPL reference has an EP
bug** — the model never saw an EP bit where the reference puts it. So the
"line-for-line match" claim is actually false in exactly one place, and that
place is where the reference is wrong. Worth retiring the claim; also worth
knowing that **none of the PR's test FENs carry an EP square** (`AFTER_E4` was
hand-written with `-`), so the dev page never exercises this plane — a
`… w KQkq d6` FEN would be a two-line addition if anyone wants it covered.
(Related nuance, no action needed: chess.js emits the EP field only when a
capture is actually possible; python-chess set it after any double push during
training. The capturable case — the one that matters — is handled, and
canonically: with `d6` available the model puts `e5d6` on top at 32.6%.)

**The odd opening distribution is the model, full stop.** The canonical
pipeline's start-position top-5 at 1500 is `g1f3 33.4%, b1c3 24.1%, b1a3 7.6%,
d2d4 7.5%, g1h3 5.2%` — real humans at any rating play `Na3`/`Nh3` well under
1%, so this released `maia_rapid.onnx` genuinely has a knight-heavy opening
prior at every bucket. That's the file CSSLab published, reproduced through
their own code; nothing in this repo can fix it, and no blitz ONNX exists at
the pinned commit (or anywhere in that repo) to swap in. Watch for it in demos:
Maia 1100 opening `Nc3` and retreating `Nb1` (the author's end-to-end game) is
this prior on display, and "it plays like a weird human" is the honest framing.

### Q4 — Can the vendored wasm be cut down?

**Yes — 13.6 MB for free, 26.8 MB more for a small verified change.**
`public/ort/` carries 40.4 MB; the network log answers which half is real:

- **As shipped** (default `onnxruntime-web` import), the app loads **only the
  jsep pair** — `ort-wasm-simd-threaded.jsep.wasm` (26.8 MB on disk, 6.04 MB
  compressed on the wire) plus its `.mjs`. Verified by deletion: with the plain
  `.wasm`, plain `.mjs`, `asyncify.mjs`, and `jspi.mjs` removed, the full suite
  passes. **Those four files (13.6 MB) are dead weight — delete them, no code
  change.** (The brief guessed the 26.8 MB jsep file was the droppable one;
  it's the opposite — the default ort 1.27 bundle *is* the jsep build.)
- **The bigger cut** needs the CPU-only entry point. The naive one-liner —
  `import * as ort from "onnxruntime-web/wasm"` — **fails `next build`**
  (prerender dies with `ERR_INVALID_URL` on `ort.wasm.bundle.min….mjs`; the
  wasm bundle resolves its own URL at module scope, which Node prerender can't).
  The working recipe, verified end-to-end: make ort a **client-side dynamic
  import inside `load()`** (`ort = await import("onnxruntime-web/wasm")`, types
  via `import type` from the main entry). Then only the plain pair is needed:
  `public/ort/` drops to **13.5 MB**, the wire cost drops 6.04 → **3.30 MB**,
  and the whole suite passes identically.

Recommend doing the free deletion in or right after the merge, and the dynamic
import whenever someone touches the file next.

### Q5 — Threaded ort build without cross-origin isolation

**No headers needed, verified — but §4's *reasoning* is stale.** As shipped:
`crossOriginIsolated === false`, `typeof SharedArrayBuffer === "undefined"`,
inference correct, **zero console warnings**. The binary is a `-threaded` build
because that's the *only* build ort ships since ~1.19; what keeps
SharedArrayBuffer out is the runtime setting `ort.env.wasm.numThreads = 1`,
which the PR sets and its own §4 addition documents.

I also probed the failure mode the doc worries about: rebuilt with
`numThreads = 4` and no isolation headers. ort logs two warnings —
`env.wasm.numThreads is set to 4, but this will not work unless you enable
crossOriginIsolated mode` and `WebAssembly multi-threading is not supported…
falling back to single-threading` — **and falls back gracefully; inference
stays correct.** So the doc's claim survives in outcome (no COOP/COEP needed),
but "we avoid SAB because the Stockfish build is single-threaded" is no longer
the whole story once this PR lands. Ready-to-paste §4 wording at the bottom.

### Q6 — Licensing, and hotlinking 89 MB from someone else's repo

Verified via the GitHub API: **CSSLab/maia2 is MIT** (the author's claim),
**CSSLab/maia3 is AGPL-3.0** (so the avoid-Maia-3 reasoning checks out), the
frontend reference repo is **GPL-3.0**, and **onnxruntime-web 1.27.0 is MIT**
(`package.json` license field), so vendoring its assets is fine.

Two wrinkles the PR doesn't state:

- **The `.onnx` artifact itself is only distributed inside the GPL-3.0 frontend
  repo**, with no per-file license note. "The weights are MIT" is an inference
  from the maia2 project's license (reasonable — that project trained them),
  not a statement anyone at CSSLab made about this file. Runtime-fetching
  rather than committing conveniently means *this repo never redistributes the
  file*, which de-risks the ambiguity. Worth knowing that's part of what the
  hotlink is buying.
- **`engineMaia.ts` was written by studying GPL-3.0 reference code.** It's a
  reimplementation of interface facts (plane layout, bucket edges) rather than
  a copy — and it demonstrably diverges where the reference is buggy (the EP
  plane, Q3) — so I'd call the risk low. But the repo ships GPL-3.0 Stockfish
  and **still has no LICENSE file**; the notes flag it, it predates this task,
  and it should get fixed before anyone audits us the way this review audits
  CSSLab.

On the hotlink itself: `Access-Control-Allow-Origin: *` confirmed, so it works.
As a dependency it's the weakest link in the PR: 89 MB per cold visitor off
`raw.githubusercontent.com` — no SLA, soft rate limits, `max-age=300` — pointed
at a repo that has **already deleted the file from `main`**; the pinned commit
is the only thing keeping it alive, and a repo rename, privatization, or
history rewrite kills the engine with no change on our side. Etiquette-wise
CSSLab moved these files off their own hosting to dodge bandwidth costs, and
this PR moves our bandwidth cost onto their GitHub raw. The file is under
GitHub's 100 MB hard limit, so committing it is *possible* (ugly repo, safe
demo); Vercel Blob or any static host is the cleaner version of the same fix,
and IndexedDB caching (Q1) cuts repeat traffic to near zero regardless of host.

### Q7 — What breaks in the demo?

Nothing *breaks*; one thing *looks* broken. The 8th commit already wired the
presets (the brief's "if the owner wires them in" is now "when this merges,
they're live"), so I measured the real screen, cold cache, Maia 1100 (White) vs
Stockfish 1320 (Black):

```
t+0.5s   plies=0 | WHITE THINKING · MAIA 1100     ← static board, pulsing lamp
t+24.0s  plies=1 | BLACK THINKING · STOCKFISH 1320
t+25.0s  plies=2 | WHITE THINKING · MAIA 1100     ← normal cadence from here
```

24.0 s and 28.8 s across two cold runs on a ~34 Mbit/s connection; ~2.5 min at
conference-wifi speeds; repeated **in full on every reload** (Q1); **unbounded**
if the fetch stalls (no timeout — the existing "Engine failed, refresh" card
never fires for a hung download). Mitigations that make "merge now" still
right: the defaults are Stockfish vs Stockfish so Maia is opt-in, a rematch in
the same tab is instant (module singleton holds the session), and on any
healthy connection the wait ends in a working game with no console errors.

Pace, once loaded: Maia answered in **47–55 ms** per move on this machine (the
author says ~35 ms; same order). Against the game loop's single
`moveDelayMs = 350`, a Maia-vs-Maia game runs ~0.4 s/ply — brisk but watchable;
mixed games alternate 0.4 s and 0.85 s plies, which reads as one engine being
snappier, which is… true. The author's suggestion (per-engine delay, Task 6's
file) is right and not urgent.

Demo-quality footnote from Q3: at 1100, expect openings like `Nc3` followed by
`Nb1`. That's the released model's knight-heavy prior, verified canonical —
brief it to whoever narrates the demo so it's "watch it play like a weird
human" and not "is it broken?".

## What I'd attack hardest if I were the author

1. **"It matches the reference line-for-line" is retired** — it was false (EP
   plane) and the truth was better than the claim. The PR body still leans on
   reference-matching in places; the canonical-parity result above is the
   stronger footing.
2. **The untested EP plane.** Correct by parity check, but no committed test
   exercises it. Two lines on the dev page.
3. **The unbounded load.** Stockfish's wrapper rejects at 60 s; Maia's hangs
   forever. Same PR that documents the Stockfish timeout's rationale ships an
   engine without one.
4. **"We rely on the browser HTTP cache"** — measured false in Chrome for this
   object size. The IndexedDB cache the reference app has is the fix, not a
   nicety.
5. **Docs cite a dead-ish commit**: `1563b5c` (pre-rebase) in
   `docs/process/work-orders/phase-0-engine-spike.md` and the plan doc for what is now `1ffb98a`.
   The old object still resolves on GitHub, so the links work today — but it's
   the hash of a commit no branch contains.

## How to re-verify from scratch

`feat/03-maia-onnx-spike` is deleted now that #7 has merged — this all runs off
`main`, plus whatever PR #7 gained before it landed (the load notice and the
stall timeout, which didn't exist when the numbers below were taken).

```sh
git fetch origin && git switch main
npm install && npm run build && npm run start -- -p 3003

"/c/Program Files/Google/Chrome/Application/chrome.exe" \
  --headless=new --remote-debugging-port=9222 \
  --user-data-dir=/tmp/fresh-profile about:blank &

node scripts/cdp-verify.mjs http://localhost:3003/dev/maia-test done 300000 9222
```

Expect: every PASS above, `e3d4 93.9%`, `1880 entries, 0 round-trip
mismatches`, values `-0.1813` / `0.4583`, no console errors — and a first run
that takes ~30 s to a few minutes depending on your connection, which is Q1
demonstrating itself. (If you script your own driver instead: don't enable
CDP's Network domain with a body buffer, and remember `innerText` is uppercase
here.) For the wasm experiments and the Python parity check, the exact steps
and the parity script's full output are in this review's PR description trail —
they're destructive, so run them in a scratch checkout, not the PR branch.

## Ready-to-paste correction for `docs/deployment.md` §4

Replace the "No COOP/COEP headers needed." paragraph with:

> **No COOP/COEP headers needed — for two different reasons now.** Stockfish
> uses the single-threaded build, which never touches `SharedArrayBuffer`.
> onnxruntime-web (Maia) only *ships* threaded-named binaries, so there the
> guarantee is a runtime setting instead: `ort.env.wasm.numThreads = 1` in
> `lib/chess/engineMaia.ts`. Verified against a production build:
> `crossOriginIsolated` is `false`, `SharedArrayBuffer` is absent, no console
> warnings, inference correct. If anyone raises `numThreads` above 1 without
> adding cross-origin-isolation headers, ort logs a warning and **falls back to
> single-threaded** rather than breaking — so the failure mode is a misleading
> console message and no speedup, not a crash. Raising it for real means
> serving COOP/COEP headers from `next.config.ts`, which would also let the
> multi-threaded Stockfish build in; treat that as one decision, not two.

Not applied on this branch on purpose: `docs/deployment.md` is being edited by
two other lanes at this hour, and this PR may outlive both merges. Whoever
touches §4 last, paste the block.

**Done — no action needed.** This went in with PR #7; §4 on `main` opens with
"No COOP/COEP headers needed — for two different reasons now." Kept here so the
review reads whole.
