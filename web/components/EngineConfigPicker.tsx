"use client";

import type { EngineConfig } from "@/lib/chess/types";

interface Props {
  presets: EngineConfig[];
  value: EngineConfig | null;
  onChange: (config: EngineConfig) => void;
  label: string;
  disabled?: boolean;
}

export function EngineConfigPicker({ presets, value, onChange, label, disabled }: Props) {
  return (
    <label className="flex flex-col gap-2">
      <span className="text-er-dim font-mono text-[11px] tracking-[0.2em] uppercase">{label}</span>
      <select
        value={value?.label ?? ""}
        disabled={disabled}
        onChange={(e) => {
          const found = presets.find((p) => p.label === e.target.value);
          if (found) onChange(found);
        }}
        className="border-er-line bg-er-surface text-er-text focus:border-er-accent cursor-pointer border px-3 py-2 text-[15px] outline-none disabled:cursor-not-allowed disabled:opacity-50"
      >
        <option value="" disabled>
          Choose an engine
        </option>
        {presets.map((p) => (
          <option key={p.label} value={p.label}>
            {p.label}
          </option>
        ))}
      </select>
    </label>
  );
}
