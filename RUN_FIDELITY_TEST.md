# HOW TO RUN AUTOMATED FIDELITY TEST

**Your extension captured nothing because it wasn't triggered properly.**

Here's how to run the complete automated test:

---

## QUICKEST WAY (3 commands)

```bash
# 1. Make sure handoff server is running (it already is)
# You can verify: curl http://localhost:4411/health

# 2. Build extension if not built
cd chrome-extension && npm run build && cd ..

# 3. Run automated test
node tools/automation/auto-capture-test.js test/fidelity-pages/simple-layout.html
```

**What this does:**
1. Launches Chrome with your extension loaded
2. Opens the test page
3. Captures original screenshot
4. **Triggers your extension** by sending `START_CAPTURE` message
5. Waits for schema to appear on handoff server
6. Saves everything
7. Gives you instructions for Figma import

---

## EVEN SIMPLER (1 command)

```bash
./tools/automation/quick-test.sh test/fidelity-pages/simple-layout.html
```

This wrapper script:
- Checks if handoff server is running (starts it if needed)
- Checks if extension is built (builds it if needed)
- Runs the automated test
- Handles all the setup for you

---

## WHAT HAPPENS

### Step 1: Automated Capture

```
🚀 Starting automated capture test
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

✅ Extension found
✅ Handoff server is ready
🌐 Launching Chrome with extension...
📄 Loading test page
📸 Capturing original screenshot...
✅ Original saved: test/fidelity-results/simple-layout/original.png

🔧 Triggering extension capture...
   Sending START_CAPTURE message to extension...

⏳ Waiting for extension to capture and upload schema...
.......
✅ New capture received! Job ID: abc-123

📊 Schema Summary:
   Total nodes: 47
   Images: 3
   Metadata URL: file:///path/to/simple-layout.html

✅ Capture completed!
📁 Results saved to: test/fidelity-results/simple-layout/
```

### Step 2: Manual Figma Import (for now)

The script will tell you:

```
📋 NEXT STEPS - MANUAL FIGMA IMPORT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. Open Figma Desktop
2. Plugins → Development → Import plugin from manifest
   Select: figma-plugin/manifest.json
3. Run the plugin
4. Click "Poll Server" (or wait for auto-poll)
5. The schema should import automatically
6. After import:
   a. Select the imported frame
   b. File → Export → PNG
   c. Save to: test/fidelity-results/simple-layout/figma.png
7. Run: npm run validate:fidelity simple-layout
```

### Step 3: Re-run to Compare (after Figma export)

```bash
node tools/automation/auto-capture-test.js test/fidelity-pages/simple-layout.html
```

This time it will:
1. Skip capture (already have it)
2. Detect that `figma.png` exists
3. Run pixel-diff comparison
4. Show fidelity score

```
🔍 Running pixel-diff comparison...
Pixel diff: 12450 (2.34%)

📊 FIDELITY SCORE: 97.66%
```

---

## HOW THE AUTOMATION WORKS

The automation script:

1. **Launches Chrome** with `puppeteer.launch()` and loads your extension
2. **Navigates** to test page
3. **Triggers capture** by injecting this JavaScript:

```javascript
window.postMessage({ type: 'START_CAPTURE' }, '*');
```

Your `injected-script.ts` already listens for this message (line 241):

```typescript
if (type === "START_CAPTURE") {
  console.log("📨 Received START_CAPTURE message");
  // ... capture logic runs
}
```

4. **Polls handoff server** waiting for new job to appear
5. **Downloads schema** from handoff server
6. **Saves everything** to results directory

---

## TROUBLESHOOTING

### "Extension not built"

```bash
cd chrome-extension && npm run build
```

### "Handoff server not responding"

```bash
# Check if running
curl http://localhost:4411/health

# If not, start it
node handoff-server.cjs
```

### "Timeout waiting for capture"

This means the extension didn't respond to the `START_CAPTURE` message.

**Debug steps:**

1. Open Chrome DevTools on the test page
2. Look for console messages:
   - `📨 Received START_CAPTURE message` ← Good!
   - If missing, extension didn't receive message

3. Check browser console (where you ran the script):
   - Should show: `Trigger result: message-posted`

4. Check handoff server logs:
   - Should show: `POST /queue` when capture completes

### "Nothing happened"

Make sure:
- ✅ Extension is built: `ls chrome-extension/dist/manifest.json`
- ✅ Handoff server running: `curl http://localhost:4411/health`
- ✅ Test page exists: `ls test/fidelity-pages/simple-layout.html`

---

## FULL WORKFLOW EXAMPLE

```bash
# Terminal 1: Keep handoff server running
node handoff-server.cjs

# Terminal 2: Run tests
./tools/automation/quick-test.sh test/fidelity-pages/simple-layout.html

# ... automated capture runs ...

# [MANUAL] Open Figma, import, export figma.png

# Terminal 2: Check fidelity
node tools/automation/auto-capture-test.js test/fidelity-pages/simple-layout.html

# See fidelity score:
# 📊 FIDELITY SCORE: 97.66%
```

---

## NEXT STEPS

Once you get this working:

1. ✅ Create more test pages (gradients, transforms, filters)
2. ✅ Run automated capture on all of them
3. ✅ Build the CSS coverage matrix (docs/CSS_COVERAGE.md)
4. ✅ Fix the worst fidelity gaps
5. ✅ Track daily progress

**Goal:** Run `quick-test.sh` on 10 test pages, measure all fidelity scores, start fixing gaps.

---

## WHY NOTHING WAS SAVED

Your extension works. But you need to **trigger it**. The extension icon doesn't auto-trigger on page load.

**Two ways to trigger:**

1. **Manual:** Click extension icon (popup.html UI)
2. **Automated:** Send `START_CAPTURE` message (what the script does)

The automation script sends the message, so **it should work now**.

---

## RUN IT NOW

```bash
./tools/automation/quick-test.sh test/fidelity-pages/simple-layout.html
```

Watch the Chrome window open, see the capture happen, check the results directory.

**Then:** Follow the manual Figma import steps, re-run, get your first fidelity score.

**Start measuring. Start improving.**
