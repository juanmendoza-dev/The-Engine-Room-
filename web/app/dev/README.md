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
| `/dev/rating-test` | The rating estimator's verification harness (Task 13). Sweeps `elo_self` and `elo_oppo` one at a time, then feeds Maia's own moves at a known bucket back through the posterior to see whether it recovers them. Includes an **evidence ceiling** (`g=1, τ=1`) so "the MAP is one bucket off" can be told apart from "the constants are throwing signal away" — without it the tempting fix is to crank τ until the fixture passes, which is just overfitting one game. |

All four are deliberately unstyled: they're instruments, and the design tokens
would only make the readouts harder to scan.

**Run `/dev/rating-test` against a production build.** Under `next dev`, React
StrictMode mounts effects twice and every forward pass on these pages happens
twice for no benefit. It used to be worse than wasteful — two overlapping
`session.run()` calls threw `Session already started` and the page died halfway
through — which is what turned up the ORT serialisation now in `engineMaia.ts`.

They do get built and deployed alongside the real routes. That's a deliberate
trade — it keeps them one URL away when something misbehaves on production,
where the interesting failures actually live (Maia's cold load behaves nothing
like it does on localhost; see `docs/deployment.md` §4).
