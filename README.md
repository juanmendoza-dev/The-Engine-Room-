# The-Engine-Room-

Chess Models that 1v1 each other — watch two engines play, or take one on
yourself.

**Live:** https://the-engine-room-gold.vercel.app

Next.js app. Both engines (Stockfish via wasm, Maia via ONNX) run client-side,
with chess.js as the sole authority on legal moves and game endings.

- [Design](docs/process/specs/2026-08-03-engine-room-design.md) — architecture, phases, what's out of scope
- [Build plan](docs/process/plans/2026-08-03-engine-room-implementation.md) — task by task
- [Deployment & branches](docs/deployment.md) — how a branch gets to the live site, who can work in parallel
- [Phase 0 work order](docs/process/work-orders/phase-0-engine-spike.md) — the engine spike: what's claimed, which files, what it produces
- [AGENTS.md](AGENTS.md) — rules for agents working in this repo
