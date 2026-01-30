# Complete Testing Guide: Image Asset Pipeline Diagnostics

**Date:** 2026-01-12
**Status:** ✅ All 5 diagnostic patches applied and built

---

## Quick Start

### 1. Reload Extension (REQUIRED)

The extension was just rebuilt with diagnostics. Chrome needs to reload it:

1. Open `chrome://extensions/`
2. Find "figmafi" extension
3. Click **Reload** button (circular arrow)

### 2. Capture Test Page

Open test file: `file:///Users/skirk92/figmacionvert-2/test-images-simple.html`

This has 3 simple images (400x300 each):
- Unsplash photo
- Picsum random photo
- Placeholder.com

**Steps:**
1. Open Chrome DevTools (F12 or Cmd+Option+I)
2. Go to **Console** tab
3. Click extension icon → "Capture Page"
4. **Watch the console output carefully**

---

## What to Look For: The 5 Diagnostic Checkpoints

### ✅ Checkpoint 1: Asset Creation (Injected Script)

**File:** `injected-script.ts:129`
**When:** Right after extraction completes, before sending to background

**Expected Log:**
```
✅ [INJECT] extractPageToSchema() returned successfully
✅ [INJECT] Schema structure: {nodes: 'present', assets: 3}
```

**What it means:**
- `assets: 3` = Assets created successfully in memory
- `assets: 0` = Asset creation failed (images not being captured)

**If assets: 0** → Issue is in `dom-extractor.ts` image capture logic

---

### ✅ Checkpoint 2: Asset Finalization (DOM Extractor)

**File:** `dom-extractor.ts:10445`
**When:** After all images captured, before sending to injected script

**Expected Log:**
```
📊 [ASSET VALIDATION] Finalized 3 image assets
  📸 Asset img_abc123...:
     - hasData: false
     - hasBase64: false
     - hasUrl: true
     - url: https://images.unsplash.com/photo-...
     - dimensions: 400x300
  📸 Asset img_def456...:
     ...
  📸 Asset img_ghi789...:
     ...
⚠️ [ASSET VALIDATION] ALL 3 images are URL-only (no embedded base64)
   Plugin MUST fetch via proxy. Ensure handoff server is running at http://localhost:4411
```

**What it means:**
- Shows asset count and structure
- `hasUrl: true` = Fallback URL is available
- `hasBase64: false` = No embedded data (URL-only mode, requires proxy)

**If no log appears** → `finalizeAssets` not being called

---

### ✅ Checkpoint 3: Serialization Check (Background Script)

**File:** `background.ts:2766` (NEW!)
**When:** Right before JSON.stringify in background script

**Expected Log:**
```
📊 [BACKGROUND SERIALIZATION] About to serialize schema:
   - Images: 3
   - SVGs: 0
   - Has assets object: true
   - Has assets.images: true
```

**OR if assets missing:**
```
⚠️ [BACKGROUND SERIALIZATION] NO IMAGES IN ASSETS! Schema will be incomplete.
```

**What it means:**
- **Images: 3** = Assets made it from injected script → background script
- **Images: 0** = Assets lost in postMessage between scripts

**If Images: 0 but Checkpoint 1 showed assets: 3** → postMessage is stripping assets

---

### ✅ Checkpoint 4: Plugin Import Validation

**File:** `enhanced-figma-importer.ts:522`
**When:** When plugin starts importing the JSON

**Steps to see this:**
1. After capture, find the JSON file: `ls -t page-capture-*.json | head -1`
2. Open Figma desktop app
3. Open plugin console: Plugins → Development → Open Console
4. Load the JSON and click "Import"
5. Watch the plugin console

**Expected Log:**
```
📊 [IMPORT VALIDATION] Checking assets structure...
  Assets validation: {hasAssets: true, hasImages: true, imageCount: 3, ...}
  📸 Sample asset hashes: ['img_abc123...', 'img_def456...', 'img_ghi789...']
  📊 Sample asset structure: {hasData: false, hasBase64: false, hasUrl: true, url: '...'}
⚠️ [IMPORT VALIDATION] Assets are URL-only (no embedded data)
   Ensure handoff server proxy is running at http://localhost:4411
```

**OR if assets missing:**
```
❌ [IMPORT VALIDATION] NO IMAGES IN ASSETS! This will cause all images to fail.
   Check extension console for asset finalization logs.
```

**What it means:**
- **imageCount: 3** = Assets made it into the JSON file
- **imageCount: 0** = Assets not saved to file

**If Checkpoint 3 showed Images: 3 but this shows imageCount: 0** → File writing/server storage issue

---

### ✅ Checkpoint 5: Hash Lookup

**File:** `node-builder.ts:6044`
**When:** For each image during import, if lookup fails

**Expected Log (if hash found):**
```
🖼️ [FIGMA IMPORT] Resolving image paint for hash: img_abc123...
  📁 Found asset for hash img_abc123...
  📊 Asset details: hasBase64=false, url=https://...
  ✅ Successfully created image from asset
```

**OR if hash not found:**
```
🖼️ [FIGMA IMPORT] Resolving image paint for hash: img_abc123...
  ⚠️ No asset found for hash img_abc123...
  🔍 [HASH MISMATCH DEBUG] Comparing hash formats:
     Requested hash: img_abc123... (length: 15)
     Sample asset key: img_abc123... (length: 15)
```

**What it means:**
- Hash lookup worked → Assets are properly keyed
- Hash mismatch → Extension and plugin use different hash algorithms (unlikely)

---

## Failure Scenario Matrix

| Checkpoint | Result | Root Cause | Fix |
|------------|--------|------------|-----|
| 1 | assets: 0 | Images not captured | Check `captureImageSafe` in dom-extractor.ts |
| 2 | No log | `finalizeAssets` not called | Check extraction flow |
| 2 | Assets logged | Assets created OK | Continue to next checkpoint |
| 3 | Images: 0 | postMessage stripping | Check message size limits |
| 3 | Images: 3 | Serialization OK | Continue to next checkpoint |
| 4 | imageCount: 0 | File/server issue | Check JSON file and handoff server |
| 4 | imageCount: 3 | Assets in JSON | Continue to next checkpoint |
| 5 | Hash mismatch | Hashing inconsistent | Fix hash algorithm (unlikely) |
| 5 | Hash found | Lookup OK | Check proxy and URL fetch |

---

## Expected Timeline

Based on checkpoint results, the issue will be in one of these layers:

### Layer 1: Asset Creation (Checkpoints 1-2)
- **If fails here:** Image capture logic broken
- **Probability:** Low (code looks correct)

### Layer 2: Message Passing (Checkpoint 3)
- **If fails here:** postMessage size limits or structured clone issue
- **Probability:** Medium (assets might be too large)

### Layer 3: Serialization/Storage (Checkpoint 4)
- **If fails here:** JSON.stringify or file/server writing issue
- **Probability:** High (existing captures have no assets)

### Layer 4: Plugin Import (Checkpoints 4-5)
- **If fails here:** Hash mismatch or proxy fetch issue
- **Probability:** Low (code looks correct)

---

## Post-Test Actions

### If Assets are in Schema at Checkpoint 3 but Missing in JSON (Checkpoint 4)

This means the issue is in JSON.stringify or file/server storage. Check:

1. **JSON.stringify behavior:**
   ```bash
   # Test if JSON.stringify preserves assets
   node -e "
   const obj = {assets: {images: {'img_123': {url: 'test'}}}};
   const str = JSON.stringify(obj);
   const parsed = JSON.parse(str);
   console.log('Has assets:', !!parsed.assets);
   console.log('Has images:', !!parsed.assets?.images);
   "
   ```

2. **File size limits:**
   - Check if JSON file is truncated
   - Check Chrome download limits

3. **Handoff server storage:**
   - Check server logs for errors
   - Check if server strips large objects

### If Assets are Missing at Checkpoint 3

This means postMessage is losing the assets. Possible causes:

1. **Structured clone limits:** Assets too large for cloning
2. **Message size limits:** Chrome has 64MB message limit
3. **Circular references:** Though sanitization should prevent this

**Fix:** Stream assets separately or use IndexedDB instead of postMessage

---

## Success Criteria

**✅ All checkpoints pass:** Images should render in Figma

**Expected output sequence:**
```
1. [INJECT] Schema structure: {assets: 3}        ← Assets created
2. [ASSET VALIDATION] Finalized 3 image assets   ← Assets finalized
3. [BACKGROUND SERIALIZATION] Images: 3          ← Assets serialized
4. [IMPORT VALIDATION] imageCount: 3             ← Assets in JSON
5. [FIGMA IMPORT] Successfully created image     ← Images rendered
```

---

## Files Modified (5 Diagnostic Patches)

1. **chrome-extension/src/utils/dom-extractor.ts** (line 10445)
   - Asset validation logging

2. **chrome-extension/src/injected-script.ts** (line 129)
   - Schema structure logging (pre-existing)

3. **chrome-extension/src/background.ts** (line 2766)
   - Serialization checkpoint logging (NEW!)

4. **figma-plugin/src/enhanced-figma-importer.ts** (line 522)
   - Import validation logging

5. **figma-plugin/src/node-builder.ts** (lines 6044, 6957)
   - Hash mismatch detection
   - Proxy failure diagnostics

---

## Build Status

- Extension: ✅ Built successfully (3506 ms)
- Plugin: ✅ Built successfully (23 ms)
- Test file: ✅ Created (`test-images-simple.html`)
- Handoff server: ✅ Running (confirmed via health check)

---

## Next Action

**RUN THE TEST:**

1. Reload extension in Chrome
2. Open test file with DevTools console
3. Capture page
4. Review console logs at each checkpoint
5. Report which checkpoint fails (if any)

The diagnostic output will definitively identify where the pipeline breaks.

---

**END OF TESTING GUIDE**
