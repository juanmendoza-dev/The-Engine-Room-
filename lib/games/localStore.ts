// localStorage adapter for the game log.
//
// This is the adapter that works *today*, with no KV store provisioned: records
// live in this browser only. The Vercel KV adapter (app/actions/games.ts) takes
// over when NEXT_PUBLIC_KV_ENABLED=1 — see lib/games/store.ts for the switch.
//
// Only ever call these from the browser. Both functions are defensive about
// that anyway (localStorage doesn't exist during SSR/prerender).

import type { GameRecord, NewGameRecord } from "./types";

const STORAGE_KEY = "er:games";

// localStorage is ~5MB and a SAN move list is tiny, but a key that only ever
// grows is a bug you ship once and debug much later. Newest-first, pruned
// oldest-first past the cap.
const MAX_RECORDS = 50;

function makeId(): string {
  // randomUUID needs a secure context (https or localhost) — true everywhere
  // this app runs, but the fallback costs nothing.
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function readAll(): GameRecord[] {
  if (typeof window === "undefined") return [];
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Light shape filter so one corrupt entry doesn't take the page down.
    return parsed.filter(
      (r): r is GameRecord =>
        typeof r === "object" &&
        r !== null &&
        typeof (r as GameRecord).id === "string" &&
        typeof (r as GameRecord).timestamp === "number" &&
        Array.isArray((r as GameRecord).moves),
    );
  } catch {
    // Corrupt JSON — treat as empty rather than crash. The next save rewrites it.
    return [];
  }
}

/**
 * Persist one finished game to this browser's localStorage.
 *
 * Throws if storage is unavailable or full (private browsing, quota) — the
 * facade in store.ts catches that, because a failed write must never break
 * the result screen the player just earned.
 */
export function saveGameLocal(game: NewGameRecord): void {
  if (typeof window === "undefined") {
    throw new Error("localStorage game log written outside the browser");
  }
  const record: GameRecord = { id: makeId(), timestamp: Date.now(), ...game };
  const next = [record, ...readAll()].slice(0, MAX_RECORDS);
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
}

/** Latest games from this browser, newest first. Never throws. */
export function listGamesLocal(limit = 20): GameRecord[] {
  // Stored newest-first already; the sort is belt-and-braces against records
  // written by an older/other version of this code.
  return readAll()
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, limit);
}
