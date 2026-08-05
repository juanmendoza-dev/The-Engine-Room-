"use client";

// The SPRT match runner's browser end (Task 16). Unstyled, same as every other
// /dev page — it's an instrument, and the design tokens would only make the
// readout harder to scan.
//
// Everything comes off the URL so a Node script can drive it without a build:
//
//   /dev/match-runner?a=Stockfish%202800&b=Stockfish%201320&elo1=200&maxGames=40
//
// Params: a, b (preset labels, required) · elo0, elo1, alpha, beta, gamma,
// maxGames, seed (all optional, defaults from the spec).
//
// Drive it with `scripts/sprt-run.mjs`, which polls this page and writes the
// result into `lib/analysis/fixtures/`. Nothing here writes to disk — a page
// can't.
//
// Run against a production build. Under `next dev` React StrictMode mounts
// effects twice, and here that means playing the entire match twice.

import { useEffect, useRef, useState } from "react";

import { runSprtMatch, type MatchProgress, type SprtMatchResult } from "@/lib/analysis/matchRunner";
import { describeSprt } from "@/lib/analysis/sprt";
import { ALL_ENGINE_PRESETS } from "@/lib/chess/engines";
import type { EngineConfig } from "@/lib/chess/types";

function findPreset(label: string | null): EngineConfig | null {
  if (!label) return null;
  return ALL_ENGINE_PRESETS.find((p) => p.label === label) ?? null;
}

function num(params: URLSearchParams, key: string, fallback: number): number {
  const raw = params.get(key);
  if (raw === null) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export default function MatchRunnerPage() {
  const [lines, setLines] = useState<string[]>(["starting..."]);
  const [progress, setProgress] = useState<MatchProgress | null>(null);
  const [result, setResult] = useState<SprtMatchResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    // One match per mount, whatever StrictMode does.
    if (started.current) return;
    started.current = true;

    const controller = new AbortController();

    // The whole body lives in here rather than in the effect directly: the match
    // is an external system this page kicks off and subscribes to, and the state
    // updates belong to its callbacks, not to the effect's own synchronous pass.
    async function run() {
      const params = new URLSearchParams(window.location.search);
      const a = findPreset(params.get("a"));
      const b = findPreset(params.get("b"));

      if (!a || !b) {
        setError(
          `need ?a= and ?b= to name two presets. Available: ${ALL_ENGINE_PRESETS.map((p) => p.label).join(", ")}`,
        );
        return;
      }

      const config = {
        a,
        b,
        elo0: num(params, "elo0", 0),
        elo1: num(params, "elo1", 200),
        alpha: num(params, "alpha", 0.05),
        beta: num(params, "beta", 0.05),
        gamma: num(params, "gamma", 0.5),
        maxGames: num(params, "maxGames", 40),
        // Play on past the SPRT's decision so the rating fit has something to
        // work with — a whitewash in eight games decides the test and rates
        // nobody. See the option's own note in matchRunner.ts.
        minGames: num(params, "minGames", 0),
        seed: num(params, "seed", 20260805),
        signal: controller.signal,
        onProgress: setProgress,
      };

      setLines([
        `${a.label} vs ${b.label}`,
        `H0: gap = ${config.elo0} Elo   H1: gap = ${config.elo1} Elo`,
        `alpha=${config.alpha} beta=${config.beta} gamma=${config.gamma} ` +
          `minGames=${config.minGames} maxGames=${config.maxGames} seed=${config.seed}`,
        a.type === "maia" || b.type === "maia"
          ? "note: the first Maia game pays the ~93MB model download before it moves."
          : "",
        "",
      ]);

      try {
        const res = await runSprtMatch(config);
        setResult(res);
        // Where sprt-run.mjs actually reads it from — pulling a large JSON blob
        // back out of innerText across CDP is slow and lossy.
        (window as unknown as { __SPRT_RESULT__?: SprtMatchResult }).__SPRT_RESULT__ = res;
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : String(err));
      }
    }

    void run();
    return () => controller.abort();
  }, []);

  const summary: string[] = [];
  if (result) {
    const { finalSprt, ratings, deltaElo, deltaStderr } = result;
    summary.push(
      describeSprt(finalSprt),
      "",
      `games: ${result.games.length}   status: ${result.status}   elapsed: ${(result.elapsedMs / 1000).toFixed(1)}s`,
      deltaElo === null
        ? "measured gap: not rateable from these games (see warnings)"
        : `measured gap: ${deltaElo >= 0 ? "+" : ""}${deltaElo.toFixed(1)} Elo` +
          (deltaStderr === null ? "" : ` ± ${deltaStderr.toFixed(1)} (1 s.e.)`),
      "",
      ...ratings.ratings.map(
        (r) =>
          `  ${r.presetId.padEnd(16)} ${r.rated ? `${r.elo.toFixed(1)} Elo` : "unrated"}` +
          `${r.stderr !== null ? ` ±${r.stderr.toFixed(1)}` : ""}` +
          `  (${r.score}/${r.games})${r.note ? `  — ${r.note}` : ""}`,
      ),
      ...ratings.warnings.map((w) => `  ! ${w}`),
      "",
      // The distinctness the whole book exists to buy, measured rather than
      // assumed — the spec asks for exactly this spot check once real games run.
      (() => {
        const distinct = new Set(result.games.map((g) => g.moves.join(" "))).size;
        const openings = new Set(result.games.map((g) => g.openingId)).size;
        return `distinct games: ${distinct}/${result.games.length} across ${openings} openings`;
      })(),
      result.error ? `error: ${result.error}` : "",
      "",
      "done",
    );
  } else if (error) {
    summary.push(`error: ${error}`, "", "done");
  } else if (progress) {
    summary.push(
      describeSprt(progress.sprt),
      `game ${progress.gamesPlayed + 1}, opening ${progress.currentOpening}, ply ${progress.currentPly}`,
    );
  }

  return (
    <main style={{ padding: "1rem" }}>
      <pre style={{ whiteSpace: "pre-wrap", fontSize: 13, lineHeight: 1.5 }}>
        {[...lines, ...summary].join("\n")}
      </pre>
      {result && (
        <pre id="result" style={{ display: "none" }}>
          {JSON.stringify(result)}
        </pre>
      )}
    </main>
  );
}
