# Web → Figma Architecture Specification

## Primary Objective

Reach html2design-level fidelity through:
- **Pixel-close visual accuracy**
- **High editability in Figma**
- **Clean, minimal layer structure**

## Core Principles (Priority Order)

1. **Browser-rendered truth** over DOM assumptions
2. **Correct text rendering** over layout heuristics
3. **Correct visuals** over Auto Layout
4. **Editability** over over-vectorization
5. **Image fallback** over incorrect reconstruction

## Pipeline Architecture

```
┌─────────────┐      ┌─────────────┐      ┌─────────────┐
│   CAPTURE   │─────▶│   SERVER    │─────▶│   BUILDER   │
│             │      │             │      │             │
│ Browser     │      │ Normalize   │      │ Figma Node  │
│ Rendered    │      │ Interpret   │      │ Creation    │
│ Truth       │      │ Reason      │      │             │
└─────────────┘      └─────────────┘      └─────────────┘
```

### 1. CAPTURE Module (`chrome-extension/`)

**Responsibility:** Extract browser-rendered truth

**Owns:**
- DOM + CDP hooks
- Computed style extraction
- Layout measurement
- Font detection
- Screenshot capture
- Fallback eligibility tagging

**Outputs:**
- Render-aware node list
- Screenshot assets
- Font metadata
- Device scale context

**Rules:**
- Never trust raw DOM values when computed values are available
- Prefer Chrome DevTools Protocol (CDP) data when possible
- Capture `getBoundingClientRect()` for every visible node
- Resolve final transforms (matrix + origin)
- Record absolute coordinates in page space
- Capture full `getComputedStyle()` output

#### Stylesheet Preprocessing Enhancement

**Problem:** CORS restrictions prevent accessing external stylesheet rules, causing incomplete style capture.

**Solution:** Server-side preprocessing (`/api/preprocess`)
- Fetches page via headless browser
- Inlines all external stylesheets
- Resolves nested `@import` rules
- Inlines `@font-face` declarations
- Returns preprocessed HTML for capture

**Alignment with Principles:**
- ✅ **Browser-rendered truth**: Makes all CSS accessible to computed style extraction
- ✅ **Correct text rendering**: Ensures fonts are available
- ✅ **Fidelity over cleverness**: Solves CORS deterministically

### 2. SERVER Module (`handoff-server.cjs`)

**Responsibility:** Normalize, interpret, and reason about layout

**Owns:**
- Render tree construction
- Stacking context resolution
- Primitive normalization
- Layout heuristics (flex/grid)
- Auto Layout confidence scoring

**Outputs:**
- Canonical primitive tree
- Layout decisions (auto vs absolute)
- Clean, deterministic structure

**Canonical Primitives:**
- Frame / Group (bounds + transform)
- Fill (solid / image / gradient)
- Stroke (uniform or per-side)
- Effect (shadow / blur)
- Text (content + style runs)
- Vector (paths, fill rules)
- Mask / Clip relationships

### 3. BUILDER Module (`figma-plugin/`)

**Responsibility:** Emit human-quality Figma documents

**Owns:**
- Figma node creation
- Layer merging & cleanup
- Text style runs
- Effects mapping
- Image slicing & placement
- Mask & clip translation

**Outputs:**
- Editable Figma document
- Minimal, clean layer tree
- High visual fidelity

**Layer Cleanup (Critical):**
- Remove non-visual wrapper frames
- Merge adjacent rectangles with identical styles
- Merge consecutive text nodes with same styles
- Flatten unnecessary nesting

## Success Criteria

✅ Visual diff against browser screenshot is minimal
✅ Text line breaks, font weight, and spacing match the browser
✅ Layer count is sane and editable by designers
✅ Output resembles human-made Figma files, not DOM dumps

## Decision Framework

**When fidelity and editability conflict:**
1. **Fidelity wins first** (correct rendering)
2. **Editability recovered** through cleanup and merging

**When uncertain:**
- Choose **correctness over cleverness**
- Use **image fallback** over incorrect reconstruction
- Apply **Auto Layout** only when confidence is high

## Implementation Checklists

### CAPTURE Checklist

#### Layout & Geometry
- [x] Capture `getBoundingClientRect()` for every visible node
- [x] Resolve final transforms (matrix + origin)
- [x] Record final absolute coordinates in page space
- [ ] Resolve fixed and sticky positioning

#### Computed Styles
- [x] Capture full `getComputedStyle()` output
- [x] Normalize font-family (resolved stack)
- [x] Normalize font-weight / style / stretch
- [x] Compute line-height (px)
- [x] Compute letter-spacing (px)
- [x] Capture background layers (color, image, gradient)
- [x] Capture borders (per-side, radius)
- [x] Capture box-shadow
- [x] Capture opacity and blend mode
- [x] Capture filter / backdrop-filter

#### Text Fidelity
- [x] Detect all fonts via `document.fonts`
- [ ] Capture font-variation-settings
- [ ] Capture font-feature-settings
- [x] Measure text using browser layout
- [ ] Preserve span-level style boundaries

#### Screenshot Strategy
- [x] Capture full-page screenshot at device scale
- [x] Capture per-element paint-rect crops
- [x] Record devicePixelRatio
- [x] Mark nodes requiring image fallback

#### Stylesheet Preprocessing
- [x] Server endpoint for preprocessing
- [x] Inline external stylesheets
- [x] Resolve @import rules recursively
- [x] Inline @font-face declarations
- [x] Cache preprocessed results
- [x] Health check and fallback

### SERVER Checklist

#### Render Tree Construction
- [x] Build render tree (not DOM tree) ✅ **IMPLEMENTED** (`render-tree-builder.ts`)
- [x] Remove display:none ✅ **IMPLEMENTED**
- [x] Remove fully invisible nodes ✅ **IMPLEMENTED**
- [x] Materialize ::before / ::after ✅ **IMPLEMENTED**
- [ ] Materialize shadow DOM slots (placeholder added)
- [x] Flatten stacking contexts into paint order ✅ **IMPLEMENTED**

#### Canonical Primitives
- [x] Frame / Group (bounds + transform)
- [x] Fill (solid / image / gradient)
- [x] Stroke (uniform or per-side)
- [x] Effect (shadow / blur)
- [x] Text (content + style runs)
- [ ] Vector (paths, fill rules)
- [ ] Mask / Clip relationships

#### Layout Intelligence
- [x] Detect flex containers
- [x] Promote to Auto Layout with confidence scoring
- [ ] Fallback to absolute positioning when uncertain
- [x] Prefer visual correctness over layout semantics

### BUILDER Checklist

#### Layer Cleanup (Critical)
- [x] Remove non-visual wrapper frames ✅ **IMPLEMENTED** (`layer-cleanup-optimizer.ts`)
- [x] Merge adjacent rectangles with identical styles ✅ **IMPLEMENTED**
- [x] Merge consecutive text nodes with same styles ✅ **IMPLEMENTED**
- [x] Flatten unnecessary nesting ✅ **IMPLEMENTED**

#### Text Output
- [x] Emit Figma text with style runs
- [x] Preserve exact width + wrapping
- [x] Fallback to image on mismatch

#### Effects & Visual Parity
- [x] Map shadows (CSS → Figma)
- [x] Fallback image for filters
- [x] Fallback image for backdrop-filter
- [x] Preserve opacity and blend modes

#### Clipping & Masks
- [x] CSS overflow:hidden → Frame with clipsContent
- [x] SVG clipPath / mask → vector mask
- [x] Handle border-radius + clipping

#### Image Handling
- [x] Resolve all image URLs
- [x] Support multiple background layers
- [x] Apply object-fit / object-position
- [x] Pad screenshot slices by 1-2 px
- [x] Align to device pixels

## File Structure

```
chrome-extension/src/
├── content-script.ts          # Capture orchestration
├── utils/
│   ├── dom-extractor.ts       # Core capture logic (~11K lines)
│   ├── stylesheet-preprocessor.ts  # CORS bypass for external CSS
│   ├── element-screenshot.ts  # Per-element image capture
│   └── cdp-mapper.ts          # Chrome DevTools Protocol integration

figma-plugin/src/
├── code.ts                    # Plugin entry point
├── enhanced-figma-importer.ts # Import orchestration
├── node-builder.ts            # Figma node creation (~309KB)
├── layout-solver.ts           # Auto Layout intelligence
└── semantic-tree-enhancer.ts  # Layer cleanup & optimization

handoff-server.cjs             # Job queue + preprocessing endpoint
shared/schema.ts               # Contract between capture & builder
```

## Integration Points

### Capture → Server
- `POST /api/jobs` - Submit captured schema
- `POST /api/preprocess` - Request stylesheet preprocessing
- `GET /api/health` - Check server availability

### Server → Builder
- `GET /api/jobs/next` - Poll for next job
- `POST /api/jobs/:id/complete` - Mark import complete

## Monitoring & Validation

- Import diagnostics (`ImportDiagnosticExport`)
- Node pipeline status tracking
- Rasterization audit trail
- Layout solver decision logs
- Mapping verification (schema → Figma)

## Current Status

**Completed:**
- ✅ Core capture pipeline
- ✅ CDP-based screenshot capture
- ✅ Font detection & embedding
- ✅ Stylesheet preprocessing (NEW)
- ✅ Handoff server infrastructure
- ✅ Figma node builder
- ✅ Layout solver with Auto Layout

**In Progress:**
- 🔄 Testing and validation of optimizations
- 🔄 Text span-level style preservation
- 🔄 Performance benchmarking

**Recently Completed:**
- ✅ Layer cleanup optimization (layer-cleanup-optimizer.ts)
- ✅ Render tree construction (render-tree-builder.ts)
- ✅ Integration into main import pipeline (enhanced-figma-importer.ts)
- ✅ Stylesheet preprocessing (handoff-server.cjs + stylesheet-preprocessor.ts)

**Planned:**
- ⏳ ::before/::after materialization
- ⏳ Shadow DOM support
- ⏳ Stacking context flattening
- ⏳ Vector primitive extraction
