# `app/dev/` — verification harnesses

Not part of the app. Nothing in the UI links here, and no route outside this
folder imports from it. These are the pages used to prove the engine layer
works, kept because "does Maia's encoder actually encode what I think it does"
is not a question you want to answer for the first time under demo pressure.

| Route | What it's for |
| --- | --- |
| `/dev/stockfish-test` | Reads back the UCI handshake's advertised option list, then runs three positions at three ELOs and reports the search depth reached. A UCI engine silently ignores `setoption` for a name it doesn't know, so the handshake is the only way to tell a working option from a typo. |
| `/dev/maia-test` | Falsification checks on the Maia pipeline — hand-derived plane expectations, mirroring, and policy decode. Written this way because the decoder filters to legal moves and picks the best one, so a *wrong* encoder still returns a perfectly legal move: "chess.js accepted it" proves nothing about Maia. |
| `/dev/fx-lab` | Picker for the 19 fight-FX effects, firing each one on demand over a live board. Disposable — safe to delete once the effects are settled. |
| `/dev/maia-rollout-test` | Monte Carlo rollouts (Task 14). Batched rows against the same positions evaluated alone, the temperature sampler against its own maths, Wilson intervals against hand-computed values, and two perspective checks — the same board with each side to move, which must invert. A rollout estimator that reads chess.js's `1-0` as the root mover's win returns plausible percentages pointing the wrong way, so those two are the reason this file exists. |
| `/dev/mixture-test` | The policy mixture's verification harness (Task 15). Section A is pure arithmetic with no engine call, and it's the section that matters most: the mixture's failure modes all return a perfectly legal move, so "it moved" proves nothing. It catches the `Math.log(0)` → `NaN` path that a zero-Maia-mass candidate opens up **even at β=0** (`0 * -Infinity` is `NaN`, not `0`), and it caught the spec's mate-ordering scheme being broken by logistic saturation. Sections B-D answer two unknowns the spec flagged — what MultiPV costs in depth, and whether `UCI_LimitStrength` corrupts the reported evals — and print the exact α:β crossover that calibration step 1 was asking for. |
| `/dev/rating-test` | The rating estimator's verification harness (Task 13). Sweeps `elo_self` and `elo_oppo` one at a time, then feeds Maia's own moves at a known bucket back through the posterior to see whether it recovers them. Includes an **evidence ceiling** (`g=1, τ=1`) so "the MAP is one bucket off" can be told apart from "the constants are throwing signal away" — without it the tempting fix is to crank τ until the fixture passes, which is just overfitting one game. |

All six are deliberately unstyled: they're instruments, and the design tokens
would only make the readouts harder to scan.

**`/dev/mixture-test` has a companion that this folder can't cover.**
`web/scripts/cdp-mixture-game.mjs` drives /model-1v1 with the mixture picked on
both sides. It exists because the riskiest part of adding a fourth `EngineType`
isn't the arithmetic — it's that TypeScript does not flag a
`config.type === "maia"` comparison for failing to mention `"mixture"`. It just
evaluates to `false`, and the symptom is silently missing UI rather than a compile
error. So that script asserts on the three sites the spec identified: the VS card's
power-level line (which otherwise prints the bare word "mixture"), the Maia
download notice (which **must** fire for a mixture config — same ~93MB file), and
plies actually accumulating. Scope the VS-card assertion to `.er-fx-vs-elo`, not
whole-page text: the preset is *labelled* "Policy Mixture (uncalibrated)", so a
`/\bmixture\b/` test against `document.body.innerText` matches the dropdown and
reports a failure that isn't one.

**Run `/dev/rating-test`, `/dev/maia-rollout-test` and `/dev/mixture-test` against a
production build.** Under `next dev`, React StrictMode mounts effects twice and every
forward pass on these pages happens twice for no benefit. It used to be worse than
wasteful — two overlapping
`session.run()` calls threw `Session already started` and the page died halfway
through — which is what turned up the ORT serialisation now in `engineMaia.ts`.

They do get built and deployed alongside the real routes. That's a deliberate
trade — it keeps them one URL away when something misbehaves on production,
where the interesting failures actually live (Maia's cold load behaves nothing
like it does on localhost; see `docs/deployment.md` §4).
