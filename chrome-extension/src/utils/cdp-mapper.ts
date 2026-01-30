/**
 * Utilities for mapping CDP computed styles to Figma schema properties
 */

// Re-export shared color utilities for backward compatibility
export { parseColorToRGBA as parseColor, type RGBA } from "../../../shared/color-utils";

export function parsePixelValue(value: string): number {
  if (!value) return 0;
  return parseFloat(value) || 0;
}

export function mapFontWeight(weight: string): number {
  const w = parseInt(weight, 10);
  if (isNaN(w)) {
    if (weight === "bold") return 700;
    if (weight === "normal") return 400;
    return 400;
  }
  return w;
}

export function mapTextAlign(
  align: string
): "LEFT" | "CENTER" | "RIGHT" | "JUSTIFIED" {
  switch (align) {
    case "center":
      return "CENTER";
    case "right":
      return "RIGHT";
    case "justify":
      return "JUSTIFIED";
    default:
      return "LEFT";
  }
}

export function mapTextDecoration(
  decoration: string
): "NONE" | "UNDERLINE" | "STRIKETHROUGH" {
  if (decoration.includes("underline")) return "UNDERLINE";
  if (decoration.includes("line-through")) return "STRIKETHROUGH";
  return "NONE";
}

export function mapTextTransform(
  transform: string
): "ORIGINAL" | "UPPER" | "LOWER" | "TITLE" {
  switch (transform) {
    case "uppercase":
      return "UPPER";
    case "lowercase":
      return "LOWER";
    case "capitalize":
      return "TITLE";
    default:
      return "ORIGINAL";
  }
}

export function mapVerticalAlign(align: string): "TOP" | "CENTER" | "BOTTOM" {
  switch (align) {
    case "middle":
      return "CENTER";
    case "bottom":
    case "text-bottom":
    case "sub":
      return "BOTTOM";
    case "top":
    case "text-top":
    case "super":
      return "TOP";
    default:
      return "TOP";
  }
}
