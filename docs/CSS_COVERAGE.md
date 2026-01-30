# CSS Property Coverage Matrix

**Status Key:**
- ✅ **SUPPORTED**: Maps 1:1 to native Figma feature.
- ⚠️ **APPROXIMATE**: Maps to Figma but with potential visual fidelity loss (documented).
- 🔄 **RASTERIZE**: Not supported by Figma; triggers image rasterization fallback.
- ❌ **NOT_IMPLEMENTED**: Ignored or missing support.

## 1. Backgrounds & Fills

| CSS Property | Status | Figma Mapping | Notes |
|--------------|--------|---------------|-------|
| `background-color` | ✅ SUPPORTED | `fills: [{type: 'SOLID'}]` | Supports hex, rgb, rgba, hsl. |
| `background-image: url()` | ✅ SUPPORTED | `fills: [{type: 'IMAGE'}]` | `background-size: cover/contain` supported. |
| `linear-gradient` | ✅ SUPPORTED | `fills: [{type: 'GRADIENT_LINEAR'}]` | Angle and color stops preserved. |
| `radial-gradient` | ⚠️ APPROXIMATE | `fills: [{type: 'GRADIENT_RADIAL'}]` | Complex positioning/sizing may differ. |
| `conic-gradient` | 🔄 RASTERIZE | Rasterized Image | Figma does not support conic gradients. |
| `repeating-linear-gradient` | ⚠️ APPROXIMATE | `fills: [{type: 'GRADIENT_LINEAR'}]` | Approximated as non-repeating or rasterized. |
| `background-blend-mode` | ❌ NOT_IMPLEMENTED | Ignored | |

## 2. Typography

| CSS Property | Status | Figma Mapping | Notes |
|--------------|--------|---------------|-------|
| `font-family` | ✅ SUPPORTED | `fontName.family` | Fallback to Inter/Roboto if missing. |
| `font-weight` | ✅ SUPPORTED | `fontName.style` | Full 100-900 mapping implemented. |
| `font-size` | ✅ SUPPORTED | `fontSize` | |
| `line-height` | ✅ SUPPORTED | `lineHeight` | Supports px, %, and unitless. |
| `letter-spacing` | ✅ SUPPORTED | `letterSpacing` | |
| `text-align` | ✅ SUPPORTED | `textAlignHorizontal` | Left, Right, Center, Justify. |
| `text-transform` | ✅ SUPPORTED | `textCase` | Uppercase, Lowercase, Capitalize. |
| `text-decoration` | ✅ SUPPORTED | `textDecoration` | Underline, Strikethrough. |
| `color` | ✅ SUPPORTED | `fills: [{type: 'SOLID'}]` | |
| `text-shadow` | ❌ NOT_IMPLEMENTED | Ignored | Missing implementation. |

## 3. Layout & Box Model

| CSS Property | Status | Figma Mapping | Notes |
|--------------|--------|---------------|-------|
| `display: flex` | ⚠️ APPROXIMATE | Auto Layout | Conversion confidence varies. |
| `display: grid` | ⚠️ APPROXIMATE | Auto Layout / Frames | Complex grids approximated. |
| `width` / `height` | ✅ SUPPORTED | `resize(w, h)` | |
| `padding` | ✅ SUPPORTED | `paddingTop`, etc. | |
| `margin` | ⚠️ APPROXIMATE | `itemSpacing` (in Auto Layout) | Margins collapse in CSS, not in Figma. |
| `border-radius` | ✅ SUPPORTED | `cornerRadius` | Supports individual corner radii. |
| `border` | ✅ SUPPORTED | `strokes` | Solid, dashed (partial). |
| `box-shadow` | ✅ SUPPORTED | `effects: DROP_SHADOW/INNER_SHADOW` | |
| `overflow: hidden` | ✅ SUPPORTED | `clipsContent: true` | |

## 4. Transforms

| CSS Property | Status | Figma Mapping | Notes |
|--------------|--------|---------------|-------|
| `transform: translate()` | ✅ SUPPORTED | `x`, `y` | |
| `transform: scale()` | ✅ SUPPORTED | Width/Height adjustment | |
| `transform: rotate()` | ✅ SUPPORTED | `rotation` | |
| `transform: skew()` | ⚠️ APPROXIMATE | Matrix decomposition | Limited support in Figma (only skew X/Y via matrix). |
| `transform: matrix()` | ✅ SUPPORTED | `relativeTransform` | 2D affine transforms. |
| `transform: matrix3d()` | 🔄 RASTERIZE | Rasterized Image | 3D transforms not supported. |
| `perspective` | 🔄 RASTERIZE | Rasterized Image | |
| `transform-style` | 🔄 RASTERIZE | Rasterized Image | |

## 5. Filters & Effects

| CSS Property | Status | Figma Mapping | Notes |
|--------------|--------|---------------|-------|
| `filter: blur()` | ✅ SUPPORTED | `effects: LAYER_BLUR` | |
| `filter: drop-shadow()` | ✅ SUPPORTED | `effects: DROP_SHADOW` | |
| `filter: contrast()` | ⚠️ APPROXIMATE | Image Filter / Unsupported | Supported on Images, rasterized on others. |
| `filter: saturate()` | ⚠️ APPROXIMATE | Image Filter / Unsupported | Supported on Images, rasterized on others. |
| `filter: brightness()` | ⚠️ APPROXIMATE | Image Filter / Unsupported | Mapped to `exposure` for images. |
| `filter: hue-rotate()` | 🔄 RASTERIZE | Rasterized Image | Not supported natively. |
| `filter: grayscale()` | 🔄 RASTERIZE | Rasterized Image | Not supported natively. |
| `filter: invert()` | 🔄 RASTERIZE | Rasterized Image | Not supported natively. |
| `filter: sepia()` | 🔄 RASTERIZE | Rasterized Image | Not supported natively. |
| `backdrop-filter` | 🔄 RASTERIZE | Rasterized Image | Glassmorphism requires rasterization. |
| `mix-blend-mode` | ✅ SUPPORTED | `blendMode` | Most standard modes supported. |
| `opacity` | ✅ SUPPORTED | `opacity` | |
| `clip-path` | 🔄 RASTERIZE | Rasterized Image | Complex paths not supported. |
| `mask` / `mask-image` | 🔄 RASTERIZE | Rasterized Image | CSS masks not supported. |

## 6. Rasterization Policy Summary

The plugin strictly enforces a "Golden Rule": **If a CSS property cannot be mapped 1:1 to a native Figma node with high fidelity, the element is rasterized (captured as an image).**

**Triggers for Rasterization:**
1.  **3D Transforms:** `matrix3d`, `rotateX`, `rotateY`, `perspective`.
2.  **Unsupported Filters:** `hue-rotate`, `grayscale`, `invert`, `sepia`, `opacity()` inside filter.
3.  **Backdrop Filters:** `backdrop-filter` (any value other than `none`).
4.  **Complex Gradients:** `conic-gradient`.
5.  **Masking:** `clip-path`, `mask`, `webkit-mask`.
6.  **Complex Text:** Text with `background-clip: text`.

## 7. Known Gaps & Roadmap

1.  **Shadow Blur Radius:** CSS blur radius vs. Figma blur radius conversion needs validation (suspect 0.5x or 2x factor).
2.  **Text Wrapping:** Browser text wrapping vs. Figma text box behavior differs.
3.  **Flexbox Fidelity:** `gap` property and `justify-content: space-evenly` approximations.
4.  **Pseudo-elements:** `::before` and `::after` are materialized as separate frames, but interaction with parent layout can be tricky.