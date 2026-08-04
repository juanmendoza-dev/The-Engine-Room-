"use server";

// Vercel KV (Upstash Redis) adapter for the game log — the only server-side
// code in the app. Dormant until the store is provisioned and
// NEXT_PUBLIC_KV_ENABLED=1 is set (see docs/deployment.md §3); until then the
// localStorage adapter handles everything and nothing in here runs.
//
// Types live in lib/games/types.ts, NOT here — a "use server" file can only
// export async functions, and client components need the shapes.
//
// NOTE: untested against a real store as of 2026-08-04 — no KV has ever been
// provisioned for this project. It compiles and follows the documented
// @vercel/kv API, but the first person to flip the flag should play one game
// and check /history before trusting it.

import { createClient, type VercelKV } from "@vercel/kv";
import { randomUUID } from "crypto";

import type { GameMode, GameRecord, GameResult, NewGameRecord } from "@/lib/games/types";

let client: VercelKV | null = null;

function getKv(): VercelKV {
  if (client) return client;
  // @vercel/kv's default `kv` export only reads KV_REST_API_*. The marketplace
  // Upstash integration can inject UPSTASH_REDIS_REST_* instead (deployment.md
  // §3 warns the names vary by flow), so accept either rather than making the
  // owner rename env vars in the dashboard.
  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    throw new Error(
      "KV is enabled but no store is connected — expected KV_REST_API_URL/KV_REST_API_TOKEN (or UPSTASH_REDIS_REST_*)",
    );
  }
  client = createClient({ url, token });
  return client;
}

const MODES: GameMode[] = ["model-1v1", "user-1v1"];
const RESULTS: GameResult[] = ["1-0", "0-1", "1/2-1/2"];

// Server Actions are public POST endpoints on the live site, so do a cheap
// shape check before writing anything. Not exported (a "use server" file may
// only export async functions).
function isValidNewGame(game: NewGameRecord): boolean {
  return (
    typeof game === "object" &&
    game !== null &&
    MODES.includes(game.mode) &&
    RESULTS.includes(game.result) &&
    typeof game.endReason === "string" &&
    game.endReason.length <= 64 &&
    typeof game.white?.label === "string" &&
    game.white.label.length <= 64 &&
    typeof game.black?.label === "string" &&
    game.black.label.length <= 64 &&
    Array.isArray(game.moves) &&
    game.moves.length <= 2048 &&
    game.moves.every((m) => typeof m === "string" && m.length <= 16)
  );
}

/** Write one finished game: `game:{id}` JSON + a `games:index` ZADD by timestamp. */
export async function saveGameKv(game: NewGameRecord): Promise<void> {
  if (!isValidNewGame(game)) throw new Error("saveGameKv: malformed game record");

  const kv = getKv();
  const id = randomUUID();
  const timestamp = Date.now();
  const record: GameRecord = {
    ...game,
    id,
    timestamp,
    white: { type: game.white.type, label: game.white.label },
    black: { type: game.black.type, label: game.black.label },
  };

  await kv.set(`game:${id}`, record);
  await kv.zadd("games:index", { score: timestamp, member: id });
}

/** Latest games, newest first: ZRANGE REV on the index, then one MGET. */
export async function listGamesKv(limit = 20): Promise<GameRecord[]> {
  const kv = getKv();
  const capped = Math.max(1, Math.min(limit, 100));
  const ids = await kv.zrange<string[]>("games:index", 0, capped - 1, { rev: true });
  if (ids.length === 0) return [];
  const records = await kv.mget<(GameRecord | null)[]>(...ids.map((id) => `game:${id}`));
  return records.filter((r): r is GameRecord => r !== null);
}
