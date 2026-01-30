# Testing the Integration

## Quick Test

1. **Build the plugin:**
```bash
cd figma-plugin && npm run build
```

2. **Load in Figma:**
   - Open Figma Desktop
   - Plugins → Development → Import plugin from manifest
   - Select `figma-plugin/manifest.json`

3. **Capture a page:**
   - Install and load the Chrome extension
   - Navigate to a test page
   - Click "Capture Website"

4. **Check console output:**
   - In Figma: Plugins → Development → Open Console
   - Look for:
     - `[RENDER_TREE] Converting DOM tree to render tree...`
     - `[RENDER_TREE] Transformation complete: {...}`
     - `[CLEANUP] Starting layer cleanup optimization...`
     - `[CLEANUP] Layer cleanup complete: {...}`

## Expected Results

### Before Optimization
- More layers (wrappers, duplicate shapes)
- Deeper nesting
- Non-visual container frames

### After Optimization  
- 20-40% fewer layers
- Cleaner hierarchy
- No empty wrappers
- Merged adjacent rectangles
- Merged consecutive text

## Manual Checks

1. **Visual Accuracy:**
   - Compare imported design to original webpage
   - Should be pixel-perfect (< 1% difference)

2. **Editability:**
   - Try selecting and moving layers
   - Layer names should be meaningful
   - Structure should be understandable

3. **Performance:**
   - Import should complete in reasonable time
   - Check console for processing times

## Disable Optimizations

To test without optimizations, modify `code.ts`:

```typescript
const importer = new EnhancedFigmaImporter(schema, {
  enableRenderTreeOptimization: false,
  enableLayerCleanup: false,
});
```

Then rebuild and compare results.
