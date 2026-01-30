# Run Pixel-Perfect Fidelity Test

## Quick Start (5 Minutes)

This guide walks you through running a complete pixel-diff comparison to identify exactly what needs to be fixed for pixel-perfect fidelity.

---

## Prerequisites

1. **Handoff server running:**
   ```bash
   node handoff-server.cjs
   # Or: ./start.sh
   ```

2. **Chrome extension loaded:**
   - Go to `chrome://extensions`
   - Enable Developer Mode
   - Load unpacked → select `chrome-extension/dist`

3. **Figma Desktop open:**
   - Have the Web-to-Figma plugin loaded
   - Plugins → Development → Import from manifest

---

## Step 1: Start the Test

```bash
node test/run-fidelity-comparison.js
```

This will:
- ✅ Check server is running
- ✅ Create a comprehensive test page
- ✅ Display instructions for manual steps

---

## Step 2: Follow the Manual Steps

The script will guide you through:

### A. Capture (in Chrome)
1. Open the test page URL shown in terminal
2. Open Web-to-Figma extension popup
3. Click "Capture Website"
4. **Verify console shows 0 CDP errors** ✅

### B. Import (in Figma)
1. Open Figma Desktop
2. Run Web-to-Figma plugin
3. Click "Import to Figma"
4. Wait for import complete

### C. Export from Figma
1. Select the imported frame
2. Right-click → Export
3. **Format: PNG, Scale: 1x** (critical!)
4. Save to: `test/results/figma-export.png`

### D. Browser Screenshot
1. Return to Chrome with test page
2. Take screenshot:
   - **Method 1 (Recommended):** Chrome DevTools
     - Press `Cmd+Shift+P` (Mac) or `Ctrl+Shift+P` (Windows)
     - Type "Capture full size screenshot"
     - Screenshot auto-saves
   - **Method 2:** Mac screenshot
     - Press `Cmd+Shift+4`, then `Space`
     - Click on Chrome window
3. Move/rename screenshot to: `test/results/browser-screenshot.png`

---

## Step 3: Run Analysis

```bash
node test/analyze-fidelity.js
```

This will:
- Run pixel-diff comparison using pixelmatch
- Calculate fidelity score
- Identify which issues are causing discrepancies
- Suggest specific files and line numbers to fix
- Generate diff.png showing exact pixel differences

---

## Understanding Results

### Fidelity Scores

| Diff % | Score | Quality | Action |
|--------|-------|---------|--------|
| < 1% | Excellent | ✅ Pixel-perfect | Ship it! |
| 1-3% | Good | 🟢 Minor issues | Optional fixes |
| 3-5% | Fair | 🟡 Moderate issues | Should fix |
| 5-10% | Poor | 🟠 Major issues | Must fix |
| > 10% | Critical | 🔴 Broken | Blocking bugs |

### What the Script Tells You

The analysis script will output:

1. **Pixel Difference:**
   ```
   Total Pixels: 1,920,000
   Different Pixels: 12,450
   Difference: 0.65%
   Fidelity Score: 99.35%
   ```

2. **Issue Classification:**
   ```
   🟢 MINOR ISSUES (1-3% diff):
     • Subpixel positioning
     • Anti-aliasing differences
     • Text rendering variations
   ```

3. **Specific Fixes:**
   ```
   FILES TO FIX:
   1. figma-plugin/src/node-builder.ts:2498
      → Verify mapFontWeight() is called
   2. chrome-extension/src/utils/dom-extractor.ts:8062
      → Test blur radius * 0.5 conversion
   ```

---

## Inspecting the Diff Image

Open `test/results/diff.png` to see:
- **Pink/magenta pixels** = Differences
- **Black pixels** = Identical
- **Intensity** = Magnitude of difference

### Common Patterns

**Entire element missing:**
- Large block of pink
- → Check render tree builder (elements being removed incorrectly)

**Shadow wrong:**
- Pink halo around elements
- → Check box-shadow blur radius conversion

**Text slightly off:**
- Pink at character edges
- → Check font-weight mapping or letter-spacing

**Transform wrong:**
- Element shifted/rotated incorrectly
- → Check transform matrix decomposition

**Colors inverted:**
- Entire element different color
- → Check fill conversion (RGBA values)

---

## Fix → Test Cycle

### 1. Identify Issue Category

From diff.png, determine if issue is:
- **Text rendering** (font-weight, spacing, wrapping)
- **Layout precision** (position, transform, dimensions)
- **Visual effects** (shadows, gradients, borders)
- **Image handling** (scaling, cropping, positioning)

### 2. Apply Suggested Fix

The analysis script tells you exactly which file and line to check.

Example:
```
FILES TO FIX:
1. figma-plugin/src/node-builder.ts:8404
   → Check applyTransformMatrix() decomposition
```

Go to that file, add debugging:
```typescript
console.log('Transform matrix:', matrix);
console.log('Final position:', { x: node.x, y: node.y });
```

### 3. Rebuild

```bash
npm run build:all
```

### 4. Re-Test

```bash
# Reload extension in Chrome
# Re-import to Figma
# Re-export and re-screenshot
node test/analyze-fidelity.js
```

### 5. Repeat

Continue until fidelity score > 99% (< 1% diff)

---

## Automated Testing (Future)

Once manual testing confirms the workflow works, automate it:

```javascript
// tools/automation/automated-fidelity-test.js
const puppeteer = require('puppeteer');

// 1. Launch browser with extension
// 2. Navigate to test page
// 3. Trigger capture programmatically
// 4. Use Figma API to import and export
// 5. Run pixel-diff automatically
// 6. Report results to dashboard
```

---

## Troubleshooting

### "Browser screenshot not found"
- Make sure you saved to exact path: `test/results/browser-screenshot.png`
- Check file actually exists: `ls -la test/results/`

### "Figma export not found"
- Make sure you saved to exact path: `test/results/figma-export.png`
- Verify scale is 1x (not 2x or 3x)

### "Dimension mismatch"
- Browser and Figma screenshots must be same size
- Check viewport width in browser vs Figma export
- May need to crop/resize one to match

### "Comparison failed"
- Make sure pixelmatch is installed: `npm install`
- Check smart-compare.js exists: `ls tools/validation/`
- Run manually: `node tools/validation/smart-compare.js path1 path2 diff.png`

### High diff % but image looks identical
- Anti-aliasing differences (acceptable)
- Zoom into diff.png at 400% to see actual differences
- Difference may be in tiny details (1-2px shadows)

---

## Example Session

```bash
# Terminal 1: Start server
$ node handoff-server.cjs
Server running on port 4411

# Terminal 2: Run test
$ node test/run-fidelity-comparison.js

# [Follow manual steps]
# - Capture in Chrome
# - Import to Figma
# - Export PNG
# - Screenshot browser

# Run analysis
$ node test/analyze-fidelity.js

📊 FIDELITY SCORE: 97.35%
Difference: 2.65%

🟢 MINOR ISSUES (1-3% diff):
  • Shadow blur - May need conversion
  • Text subpixel positioning

FILES TO FIX:
1. chrome-extension/src/utils/dom-extractor.ts:8062

# Apply fix, rebuild, re-test
$ npm run build:extension
$ node test/analyze-fidelity.js

📊 FIDELITY SCORE: 99.65%
Difference: 0.35%

✅ EXCELLENT: Pixel-perfect fidelity achieved!
```

---

## Quick Reference

| Command | Purpose |
|---------|---------|
| `node test/run-fidelity-comparison.js` | Start test, create test page |
| `node test/analyze-fidelity.js` | Analyze pixel-diff results |
| `npm run build:all` | Rebuild extension + plugin |
| `open test/results/diff.png` | View diff image |
| `cat test/results/fidelity-report.json` | See full report |

---

## Success Criteria

**Definition of Pixel-Perfect:**
- ✅ Diff < 1% on automated test
- ✅ No visible discrepancies on manual inspection
- ✅ All test categories passing (text, layout, effects, images)

**When to Ship:**
- Fidelity score > 99%
- Diff image shows only anti-aliasing differences
- Manual inspection confirms visual identity

---

**Status:** Ready to run
**Time Required:** 5-10 minutes per test cycle
**Goal:** < 1% pixel difference

Run `node test/run-fidelity-comparison.js` to start!
