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

All three are deliberately unstyled: they're instruments, and the design tokens
would only make the readouts harder to scan.

They do get built and deployed alongside the real routes. That's a deliberate
trade — it keeps them one URL away when something misbehaves on production,
where the interesting failures actually live (Maia's cold load behaves nothing
like it does on localhost; see `docs/deployment.md` §4).
