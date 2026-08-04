# Maia integration notes

Findings from Task 3's timeboxed spike. Written so the next person doesn't repeat
the archaeology.

**Timebox:** started 12:03:48, CP1 concluded ~12:09 — **≈5 minutes, well inside the
15-minute CP1 budget**, with ~84 minutes of the box still unspent.

**Reached:** CP1 complete, and it made CP2–CP6 largely unnecessary. Stopped before
implementing, because what CP1 found deviates materially from the approved spec.
See "Why this stopped for a decision".

---

## Headline: the plan was aimed at the wrong Maia

The build plan and spec assumed **original Maia** — lc0-format `.pb.gz` weights,
one network per rating tier, converted to ONNX with `lc0 leela2onnx`, taking lc0's
112 input planes including move history.

That's a real thing and the plan's description of it was accurate. But there's a
newer official model, **Maia 3**, which is what CSSLab actually runs in production
on maiachess.com, and it is a completely different architecture that is far easier
to integrate:

| | Original Maia (planned) | Maia 3 (found) |
| --- | --- | --- |
| Format | lc0 `.pb.gz`, needs conversion | ONNX already, no conversion |
| Requires lc0 binary | yes | **no** |
| Input | ~112 planes of 8×8, incl. move history | `(64, 12)` piece tokens, **no history** |
| Rating | one network per tier | `elo_self` / `elo_oppo` as **continuous model inputs** |
| Files for 3 tiers | 3 `.onnx` | **1 `.onnx`** |
| Policy output | lc0 move encoding | 4352-dim, own index table |
| Value output | scalar / WDL | 3-dim loss/draw/win logits |

So the whole conversion pipeline — CP2 (source `.pb.gz`), CP3 (lc0 + `leela2onnx`),
CP4 (graph archaeology), and the history-plane question — simply evaporates. Five
minutes of searching removed the three riskiest checkpoints in the task. This is
the entire argument for doing CP1 first rather than getting on with "the real
work".

## Where everything lives

- **Model:** `https://www.maiachess.com/maia3/maia3_simplified.onnx` — HTTP 200,
  **43.57 MB**, `application/octet-stream`. Note `maiachess.com` 308-redirects;
  use the `www.` host.
  Default in the reference app is the relative path `/maia3/maia3_simplified.onnx`,
  overridable via `NEXT_PUBLIC_MAIA_MODEL_URL`, version via
  `NEXT_PUBLIC_MAIA_MODEL_VERSION` (currently `'3'`).
- **Reference implementation:** `CSSLab/maia-platform-frontend`
  - `src/lib/engine/tensor.ts` — encoding, mirroring, move index lookup
  - `src/lib/engine/maia.ts` — inference + output decode (`processOutputsMaia3`)
  - `public/maia-worker.js` — ONNX session in a Web Worker, IndexedDB model cache
- **Move index tables:** `src/lib/engine/data/all_moves_maia3.json` (58.7 KB) and
  `all_moves_maia3_reversed.json` (67.2 KB). Small enough to commit.

## The ONNX interface, confirmed from the reference worker

```js
feeds = {
  tokens:    Tensor('float32', ..., [batch, 64, 12]),
  elo_self:  Tensor('float32', ..., [batch]),
  elo_oppo:  Tensor('float32', ..., [batch]),
}
// outputs: result.logits_move (4352 per item), result.logits_value (3 per item)
```

## How encoding works

1. **Always white's perspective.** If it's Black to move, mirror the FEN first —
   vertical flip, swap piece colours, swap castling rights, mirror the en passant
   square, flip active colour. Then the board is encoded as if White were moving.
2. **Tokens:** `Float32Array(64 * 12)`, set `tensor[square * 12 + pieceIdx] = 1`,
   where `square = row * 8 + file` and piece order is `P N B R Q K p n b r q k`.
3. **Legal-move mask:** `Float32Array(4352)`, index via
   `allMovesMaia3[from + to + promotion]`, computed **on the mirrored board**.
4. **Decode:** softmax over the legal indices only; map index → move via the
   reversed table; if Black was to move, `mirrorMove()` each move to get back to
   real board coordinates. Value: softmax the 3 LDW logits,
   `winProb = (W + 0.5 · D) / total`, then `1 - winProb` if Black to move.

## Two real limitations of Maia 3, worth knowing

1. **The input encodes piece placement only.** No castling-rights channel, no en
   passant channel, no explicit side-to-move channel (side to move is implicit in
   the always-white-perspective mirroring). The older 18-channel path in the same
   reference file *does* encode castling and en passant, but `boardToMaia3Tokens`
   does not. So the model cannot distinguish a position where castling is still
   available from one where it isn't. That's a property of the model, not a bug to
   fix, but it will occasionally show up as odd play around castling.
2. **43.57 MB is a real download.** The reference app caches it in IndexedDB
   specifically because of this, and shows a progress bar during the fetch. For our
   MVP the browser HTTP cache is probably enough, but first load of a Maia game
   will not be instant, and Task 6 should not assume it is.

## Why this stopped for a decision

The approved verification design made **V1 — lc0 parity** the load-bearing check:
run the same weights through lc0 and require my pipeline's policy and value to
match. That check is **impossible for Maia 3**, because Maia 3 is not an lc0
network — lc0 cannot load or run it. There is no lc0 in this pipeline at all.

Silently dropping the primary verification check that a reviewer specifically added
would be exactly the sort of thing the last two reviews caught. So this stops here
with findings recorded, rather than proceeding on a verification plan nobody has
agreed to.

Proposed replacement, for approval — see the PR discussion:

- **ELO responsiveness (new primary).** `elo_self` is a continuous input, so the
  same FEN at 1100 vs 1900 must produce measurably different policy
  distributions. If the elo inputs are mis-wired, swapped, or ignored, the output
  is identical or nonsense. This is genuinely discriminating — and notably it's the
  check that Stockfish *couldn't* provide, since its search depth was identical
  across ELOs.
- **Index-table round-trip.** Assert `reversed[table[m]] === m` across all 4352
  entries. Cheap, complete, and catches a mismatched or corrupted table pair.
- **Reference parity.** Compare my encode/decode against the reference logic on the
  same FENs. Weaker than V1 was — it confirms the port is faithful, not that the
  reference is right — but the reference is what maiachess.com runs in production,
  so it's well exercised.
- **Value sanity, policy plausibility, legality** (old V2/V3/V5) carry over
  unchanged.
- **Mirror invariance** (old V4) is more meaningful here than for lc0, since
  mirroring is explicit load-bearing code in this pipeline rather than implicit in
  the encoder — but the same self-confirmation caution applies: build the mirrored
  FEN independently, not by calling the reference's own `mirrorFEN`.

## Still unchecked

- **Licence terms for the model file** before committing 43.57 MB of it. The Maia
  source repos are GPL-3.0; the model artefact's terms need reading.
- Whether to commit the `.onnx` to `public/` or fetch it at runtime. Committing is
  simplest and stays inside GitHub's 100 MB hard limit (though above the 50 MB
  warning). Fetching cross-origin from `maiachess.com` would depend on their CORS
  headers and add a third-party runtime dependency to the demo.
- `onnxruntime-web`'s own wasm assets need to be served locally
  (`ort.env.wasm.wasmPaths`), exactly as `docs/deployment.md` §4 predicted.
