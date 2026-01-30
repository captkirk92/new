/**
 * Shared color parsing utilities
 * Consolidates duplicate parseColor implementations from:
 * - chrome-extension/src/utils/cdp-mapper.ts
 * - chrome-extension/src/utils/dom-extractor.ts
 * - figma-plugin/src/hover-variant-mapper.ts
 * - figma-plugin/src/node-builder.ts
 */

export interface RGBA {
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface RGB {
  r: number;
  g: number;
  b: number;
}

export interface ColorWithOpacity {
  color: RGB;
  opacity: number;
}

function clamp(num: number, min: number, max: number): number {
  return Math.min(Math.max(num, min), max);
}

function parseColorComponent(val: string, isAlpha = false): number {
  if (!val) return isAlpha ? 1 : 0;
  const isPercent = val.includes("%");
  const num = parseFloat(val.replace("%", ""));
  if (isNaN(num)) return 0;
  if (isPercent) {
    return isAlpha ? num / 100 : (num / 100) * 255;
  }
  return num;
}

/**
 * Core color parsing - returns RGBA (0-1 range)
 * Handles: rgb(), rgba(), hex (#RRGGBB, #RGB, #RRGGBBAA), transparent, modern CSS syntax
 */
export function parseColorToRGBA(colorString: string): RGBA | null {
  if (!colorString) return null;
  
  const trimmed = colorString.trim().toLowerCase();
  
  if (!trimmed || trimmed === "transparent" || trimmed === "rgba(0, 0, 0, 0)") {
    return { r: 0, g: 0, b: 0, a: 0 };
  }

  // Handle hex #RRGGBB
  const hex6Match = trimmed.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/);
  if (hex6Match) {
    return {
      r: parseInt(hex6Match[1], 16) / 255,
      g: parseInt(hex6Match[2], 16) / 255,
      b: parseInt(hex6Match[3], 16) / 255,
      a: 1,
    };
  }

  // Handle hex #RGB (shorthand)
  const hex3Match = trimmed.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/);
  if (hex3Match) {
    return {
      r: parseInt(hex3Match[1] + hex3Match[1], 16) / 255,
      g: parseInt(hex3Match[2] + hex3Match[2], 16) / 255,
      b: parseInt(hex3Match[3] + hex3Match[3], 16) / 255,
      a: 1,
    };
  }
  
  // Handle hex #RRGGBBAA
  const hex8Match = trimmed.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/);
  if (hex8Match) {
    return {
      r: parseInt(hex8Match[1], 16) / 255,
      g: parseInt(hex8Match[2], 16) / 255,
      b: parseInt(hex8Match[3], 16) / 255,
      a: parseInt(hex8Match[4], 16) / 255,
    };
  }

  // Handle standard rgba()/rgb() with commas and optional percentages
  // Matches: rgba(255, 255, 255, 1), rgb(100%, 50%, 0%), rgba(0,0,0,0.5)
  const rgbaMatch = trimmed.match(
    /^rgba?\(\s*([\d.]+%?)\s*,?\s*([\d.]+%?)\s*,?\s*([\d.]+%?)\s*(?:,?\s*([\d.]+%?))?\s*\)$/
  );
  if (rgbaMatch) {
    return {
      r: clamp(parseColorComponent(rgbaMatch[1]) / 255, 0, 1),
      g: clamp(parseColorComponent(rgbaMatch[2]) / 255, 0, 1),
      b: clamp(parseColorComponent(rgbaMatch[3]) / 255, 0, 1),
      a: rgbaMatch[4] ? clamp(parseColorComponent(rgbaMatch[4], true), 0, 1) : 1,
    };
  }

  // Handle modern CSS syntax: rgb(0 0 0 / 0.5)
  const spaceRgbMatch = trimmed.match(
    /^rgba?\(\s*([\d.]+%?)\s+([\d.]+%?)\s+([\d.]+%?)(?:\s*\/\s*([\d.]+%?))?\s*\)$/
  );
  if (spaceRgbMatch) {
    return {
      r: clamp(parseColorComponent(spaceRgbMatch[1]) / 255, 0, 1),
      g: clamp(parseColorComponent(spaceRgbMatch[2]) / 255, 0, 1),
      b: clamp(parseColorComponent(spaceRgbMatch[3]) / 255, 0, 1),
      a: spaceRgbMatch[4] ? clamp(parseColorComponent(spaceRgbMatch[4], true), 0, 1) : 1,
    };
  }

  return null;
}

/**
 * Parse color to Figma-style format with separate opacity
 * Used by figma-plugin for Figma API compatibility
 */
export function parseColorWithOpacity(colorString: string): ColorWithOpacity | null {
  const rgba = parseColorToRGBA(colorString);
  if (!rgba) return null;

  return {
    color: { r: rgba.r, g: rgba.g, b: rgba.b },
    opacity: rgba.a,
  };
}

/**
 * Parse CSS box-shadow to structured format
 * Format: offsetX offsetY blur [spread] color
 */
export interface ParsedBoxShadow {
  offsetX: number;
  offsetY: number;
  blur: number;
  spread: number;
  color: RGBA;
  type?: "DROP_SHADOW" | "INNER_SHADOW";
}

export function parseBoxShadow(shadow: string): ParsedBoxShadow | null {
  if (!shadow || shadow === "none") return null;

  const trimmed = shadow.trim();
  const isInset = trimmed.toLowerCase().includes("inset");
  const cleanShadow = trimmed.replace(/inset/gi, "").trim();

  // Basic regex to find color and dimensions.
  // This is a heuristic and might not cover all edge cases (like multiple shadows)
  // For multiple shadows, use a splitter before calling this.
  
  // Try to find color at the end or beginning
  // Hex, rgb, rgba
  const colorRegex = /(rgba?\([^)]+\)|#[0-9a-f]{3,8})/i;
  const colorMatch = cleanShadow.match(colorRegex);
  
  if (!colorMatch) return null;
  
  const colorStr = colorMatch[0];
  const color = parseColorToRGBA(colorStr);
  if (!color) return null;

  const dimensionsStr = cleanShadow.replace(colorStr, "").trim();
  const parts = dimensionsStr.split(/\s+/).map(p => parseFloat(p)).filter(n => !isNaN(n));
  
  // offsetX, offsetY, blur, spread
  const offsetX = parts[0] || 0;
  const offsetY = parts[1] || 0;
  const blur = parts[2] || 0;
  const spread = parts[3] || 0;

  return {
    offsetX,
    offsetY,
    blur,
    spread,
    color,
    type: isInset ? "INNER_SHADOW" : "DROP_SHADOW"
  };
}