"use client";

import { useSyncExternalStore } from "react";

import {
  MAIA_MODEL_SIZE_MB,
  getMaiaLoadState,
  subscribeMaiaLoad,
} from "@/lib/chess/engineMaia";

interface Props {
  /** True when a Maia preset is selected on this screen. Hidden otherwise. */
  active: boolean;
}

const MB = 1_000_000;

/**
 * Explains the one genuinely surprising thing about Maia: it fetches an ~89MB
 * model at runtime, which is 25s+ of nothing on a fast connection and minutes on
 * bad wifi. Chrome won't disk-cache a body that large, so this happens on every
 * full page load, not just the first ever visit.
 *
 * Reads the engine module's own load state, so both game screens get the same
 * story without either of them knowing how Maia loads.
 *
 * Failures are deliberately NOT rendered here - `getMaiaMove` rejects, and both
 * screens already have an "Engine failed" card for that.
 */
export function MaiaLoadNotice({ active }: Props) {
  const state = useSyncExternalStore(subscribeMaiaLoad, getMaiaLoadState, getMaiaLoadState);

  if (!active || state.status === "ready" || state.status === "failed") return null;

  if (state.status === "idle") {
    return (
      <p className="text-er-dim mb-6 font-mono text-[11px] leading-relaxed tracking-[0.14em] uppercase">
        Heads up · Maia fetches a {MAIA_MODEL_SIZE_MB} MB model on its first move,
        roughly 30 s on a fast connection
      </p>
    );
  }

  if (state.status === "initializing") {
    return (
      <p className="text-er-dim mb-6 flex items-center gap-2 font-mono text-[11px] tracking-[0.18em] uppercase">
        <span className="er-lamp h-2 w-2 rounded-full" />
        Starting the Maia engine
      </p>
    );
  }

  const receivedMb = Math.round(state.receivedBytes / MB);
  const totalMb = state.totalBytes ? Math.round(state.totalBytes / MB) : null;
  const percent = state.totalBytes
    ? Math.min(100, Math.round((state.receivedBytes / state.totalBytes) * 100))
    : null;

  return (
    <div className="mb-6">
      <p className="text-er-dim mb-2 flex items-center gap-2 font-mono text-[11px] tracking-[0.18em] uppercase">
        <span className="er-lamp h-2 w-2 rounded-full" />
        Downloading Maia · {receivedMb} {totalMb ? `/ ${totalMb} ` : ""}MB
        {percent === null ? "" : ` · ${percent}%`}
      </p>
      <div
        className="border-er-line bg-er-surface2 h-1 w-full max-w-[320px] overflow-hidden border"
        role="progressbar"
        aria-label="Downloading the Maia model"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent ?? undefined}
      >
        <div
          className="bg-er-accent h-full transition-[width] duration-300"
          style={{ width: `${percent ?? 100}%` }}
        />
      </div>
    </div>
  );
}
