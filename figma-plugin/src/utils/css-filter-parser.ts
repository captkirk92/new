// figma-plugin/src/utils/css-filter-parser.ts

export type ParsedCssFilter =
  | { kind: "blur"; radiusPx: number }
  | {
      kind: "drop-shadow";
      offsetX: number;
      offsetY: number;
      blurRadius: number;
      spread: number;
      color: { r: number; g: number; b: number; a: number };
    }
  | { kind: "brightness"; amount: number }
  | { kind: "contrast"; amount: number }
  | { kind: "saturate"; amount: number }
  | { kind: "unknown"; raw: string };

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

function parseNumberPx(token: string): number | null {
  const m = token.trim().match(/^(-?\d*\.?\d+)(px)?$/);
  if (!m) return null;
  return Number(m[1]);
}

function parseColorToRgba(color: string): { r: number; g: number; b: number; a: number } | null {
  const c = color.trim();

  // rgba(r,g,b,a)
  let m = c.match(/^rgba?\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)\s*(?:,\s*([0-9.]+)\s*)?\)$/i);
  if (m) {
    const r = clamp01(Number(m[1]) / 255);
    const g = clamp01(Number(m[2]) / 255);
    const b = clamp01(Number(m[3]) / 255);
    const a = m[4] !== undefined ? clamp01(Number(m[4])) : 1;
    return { r, g, b, a };
  }

  // #RRGGBB / #RRGGBBAA
  m = c.match(/^#([0-9a-f]{6})([0-9a-f]{2})?$/i);
  if (m) {
    const rgb = m[1];
    const aa = m[2];
    const r = clamp01(parseInt(rgb.slice(0, 2), 16) / 255);
    const g = clamp01(parseInt(rgb.slice(2, 4), 16) / 255);
    const b = clamp01(parseInt(rgb.slice(4, 6), 16) / 255);
    const a = aa ? clamp01(parseInt(aa, 16) / 255) : 1;
    return { r, g, b, a };
  }

  // If you want named colors, you can add a small map, but do not guess silently.
  return null;
}

// Splits `filter: blur(2px) drop-shadow(...)` into top-level function calls
function splitTopLevelFunctions(filter: string): string[] {
  const out: string[] = [];
  let i = 0;
  let start = 0;
  let depth = 0;

  while (i < filter.length) {
    const ch = filter[i];
    if (ch === "(") depth++;
    if (ch === ")") depth = Math.max(0, depth - 1);

    // split on spaces only when not inside parentheses
    if (depth === 0 && ch === " ") {
      const seg = filter.slice(start, i).trim();
      if (seg) out.push(seg);
      start = i + 1;
    }
    i++;
  }

  const tail = filter.slice(start).trim();
  if (tail) out.push(tail);
  return out;
}

export function parseCssFilter(filter: string): ParsedCssFilter[] {
  const raw = filter.trim();
  if (!raw || raw === "none") return [];

  const parts = splitTopLevelFunctions(raw);

  return parts.map((p) => {
    const m = p.match(/^([a-z-]+)\((.*)\)$/i);
    if (!m) return { kind: "unknown", raw: p };

    const fn = m[1].toLowerCase();
    const args = m[2].trim();

    if (fn === "blur") {
      const n = parseNumberPx(args);
      if (n === null) return { kind: "unknown", raw: p };
      return { kind: "blur", radiusPx: Math.max(0, n) };
    }

    if (fn === "drop-shadow") {
      // Spec allows: drop-shadow(<length> <length> <length>? <color>?)
      // Also allows color anywhere; we'll parse robustly but conservatively.
      const tokens = args
        .split(/\s+/)
        .map((t) => t.trim())
        .filter(Boolean);

      // Find color token (last token that looks like rgba() or hex)
      let colorTokenIndex = -1;
      for (let i = tokens.length - 1; i >= 0; i--) {
        if (/^rgba?\(/i.test(tokens[i]) || /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.test(tokens[i])) {
          colorTokenIndex = i;
          break;
        }
      }

      let color = { r: 0, g: 0, b: 0, a: 1 };
      if (colorTokenIndex !== -1) {
        const parsed = parseColorToRgba(tokens[colorTokenIndex]);
        if (parsed) color = parsed;
        tokens.splice(colorTokenIndex, 1);
      }

      // Remaining should be lengths: offsetX offsetY blur? spread?
      const nums = tokens.map(parseNumberPx);
      if (nums.some((n) => n === null) || nums.length < 2) {
        return { kind: "unknown", raw: p };
      }

      const offsetX = nums[0] as number;
      const offsetY = nums[1] as number;
      const blurRadius = (nums[2] as number | undefined) ?? 0;
      const spread = (nums[3] as number | undefined) ?? 0;

      return {
        kind: "drop-shadow",
        offsetX,
        offsetY,
        blurRadius: Math.max(0, blurRadius),
        spread,
        color,
      };
    }

    // For ImagePaint.filters approximations (best supported subset)
    if (fn === "brightness") {
      const v = Number(args.replace("%", ""));
      if (!Number.isFinite(v)) return { kind: "unknown", raw: p };
      // CSS brightness(100%) = 1
      const amount = args.includes("%") ? v / 100 : v;
      return { kind: "brightness", amount };
    }

    if (fn === "contrast") {
      const v = Number(args.replace("%", ""));
      if (!Number.isFinite(v)) return { kind: "unknown", raw: p };
      const amount = args.includes("%") ? v / 100 : v;
      return { kind: "contrast", amount };
    }

    if (fn === "saturate") {
      const v = Number(args.replace("%", ""));
      if (!Number.isFinite(v)) return { kind: "unknown", raw: p };
      const amount = args.includes("%") ? v / 100 : v;
      return { kind: "saturate", amount };
    }

    // FIDELITY FIX #3: Add missing filter functions (P0 - HIGH IMPACT)
    // These filters cannot be represented in Figma and will trigger rasterization
    if (fn === "hue-rotate") {
      // hue-rotate() takes degrees
      const deg = parseFloat(args.replace("deg", ""));
      if (!Number.isFinite(deg)) return { kind: "unknown", raw: p };
      return { kind: "unknown", raw: p }; // Mark as unknown to trigger rasterization
    }

    if (fn === "grayscale") {
      const v = Number(args.replace("%", ""));
      if (!Number.isFinite(v)) return { kind: "unknown", raw: p };
      return { kind: "unknown", raw: p }; // Mark as unknown to trigger rasterization
    }

    if (fn === "invert") {
      const v = Number(args.replace("%", ""));
      if (!Number.isFinite(v)) return { kind: "unknown", raw: p };
      return { kind: "unknown", raw: p }; // Mark as unknown to trigger rasterization
    }

    if (fn === "sepia") {
      const v = Number(args.replace("%", ""));
      if (!Number.isFinite(v)) return { kind: "unknown", raw: p };
      return { kind: "unknown", raw: p }; // Mark as unknown to trigger rasterization
    }

    return { kind: "unknown", raw: p };
  });
}

export function filterRequiresRasterization(parsed: ParsedCssFilter[]): boolean {
  // Anything unknown must rasterize in strict clone mode.
  return parsed.some((p) => p.kind === "unknown");
}
