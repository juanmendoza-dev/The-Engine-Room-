// The game-log facade every screen talks to. Callers never know which adapter
// is underneath:
//
//   - localStorage (lib/games/localStore.ts) — the default, works today with
//     nothing provisioned. Per-browser records.
//   - Vercel KV (app/actions/games.ts, a Server Action) — shared records,
//     switched on by NEXT_PUBLIC_KV_ENABLED=1 once a store exists.
//
// Why a NEXT_PUBLIC_ flag: this module runs in the browser, where server-only
// env vars (KV_REST_API_URL etc.) simply don't exist — you can't branch on
// them there. NEXT_PUBLIC_* values get inlined at build time, so the same flag
// answers identically on server and client. Flipping it requires a rebuild,
// not just a restart — see docs/deployment.md §3.
//
// Importing a "use server" module from client code is fine (each export
// compiles to an RPC stub). Importing @vercel/kv itself from client code is
// not — which is why the KV calls stay behind app/actions/games.ts.

import { listGamesKv, saveGameKv } from "@/app/actions/games";

import { listGamesLocal, saveGameLocal } from "./localStore";
import type { GameRecord, NewGameRecord } from "./types";

/** True when the app was built to log games to Vercel KV instead of localStorage. */
export const KV_ENABLED = process.env.NEXT_PUBLIC_KV_ENABLED === "1";

/**
 * Log a finished game. **Never throws** — private browsing, a full quota, or a
 * KV outage must not break the result screen the player just earned (spec:
 * "KV write failure at game end → swallow it"). A failed write costs one
 * history entry and a console warning, nothing else.
 */
export async function saveGame(game: NewGameRecord): Promise<void> {
  try {
    if (KV_ENABLED) {
      await saveGameKv(game);
    } else {
      saveGameLocal(game);
    }
  } catch (err) {
    console.warn("Couldn't log the finished game (history will miss this one):", err);
  }
}

/**
 * Latest games, newest first. Never throws — a broken store reads as an empty
 * history, with the real error in the console.
 */
export async function listGames(limit = 20): Promise<GameRecord[]> {
  try {
    return KV_ENABLED ? await listGamesKv(limit) : listGamesLocal(limit);
  } catch (err) {
    console.warn("Couldn't read the game log:", err);
    return [];
  }
}
