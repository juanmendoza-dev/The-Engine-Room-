/**
 * The ER monogram — the app's brand mark, replacing the rotating ink square.
 *
 * Two cuts of one design, because a framed two-letter monogram cannot survive
 * 16px: the hairline frame, the gap inside it, and the letter counters all land
 * under ~1.5px and collapse into a blob.
 *
 *   plate — hairline frame + letters + red plate-corner marker. 28px and up.
 *   bare  — the same letters, frame dropped and scaled up to fill the box.
 *
 * `cut` defaults to whichever the requested size can carry, so callers only
 * have to ask for a size and always get something legible.
 *
 * The letterforms are hand-drawn paths on a 100-unit cap-height grid (stem 26,
 * bar 20) placed with a transform, so both cuts share one source of truth.
 * Deliberately NOT <text> in Archivo Black: app/icon.svg reuses this geometry
 * and a favicon has no webfont, so a text mark would fall back to a serif in
 * the browser tab.
 */

const E_PATH = "M0 0H74V20H26V40H66V60H26V80H74V100H0Z";
// Second subpath is the bowl counter — evenodd punches it out.
const R_PATH = "M0 0H78V62H52L82 100H48L26 66V100H0ZM26 20H56V42H26Z";

const E_ADVANCE = 74;
const R_ADVANCE = 82;
const TRACKING = 8; // tight, in the same 100-unit space

const CUTS = {
  plate: { cap: 9.5, x: 4.21, y: 7.25, frame: true, tick: { x: 18, y: 18, size: 2.6 } },
  bare: { cap: 13, x: 0.5, y: 3.6, frame: false, tick: { x: 20.4, y: 19.4, size: 3.1 } },
} as const;

/** Below this, the plate cut's frame and inner gap stop holding up. */
const PLATE_MIN_PX = 28;

interface BrandMarkProps {
  size?: number;
  cut?: keyof typeof CUTS;
  /** Give it an accessible name when it stands alone; omit next to the wordmark. */
  label?: string;
  className?: string;
}

export function BrandMark({ size = 24, cut, label, className }: BrandMarkProps) {
  const spec = CUTS[cut ?? (size >= PLATE_MIN_PX ? "plate" : "bare")];
  const scale = spec.cap / 100;
  const rx = spec.x + (E_ADVANCE + TRACKING) * scale;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={`er-mark ${className ?? ""}`}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      {spec.frame && (
        <rect x="1.5" y="1.5" width="21" height="21" fill="none" stroke="currentColor" strokeWidth="1.5" />
      )}
      <g fill="currentColor" fillRule="evenodd">
        <path d={E_PATH} transform={`translate(${spec.x} ${spec.y}) scale(${scale})`} />
        <path d={R_PATH} transform={`translate(${rx} ${spec.y}) scale(${scale})`} />
      </g>
      <rect
        className="er-mark-tick"
        x={spec.tick.x}
        y={spec.tick.y}
        width={spec.tick.size}
        height={spec.tick.size}
      />
    </svg>
  );
}
