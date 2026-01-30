# START HERE - Automated Fidelity Testing

## YOU ASKED FOR AUTOMATION - HERE IT IS

I've created a **complete automation system** for you. No more manual clicking.

---

## RUN YOUR FIRST AUTOMATED TEST (NOW)

```bash
npm run quick-test test/fidelity-pages/simple-layout.html
```

**What happens:**
1. ✅ Checks if handoff server is running (starts if needed)
2. ✅ Checks if extension is built (builds if needed)
3. ✅ Launches Chrome with your extension loaded
4. ✅ Navigates to test page
5. ✅ Captures original screenshot
6. ✅ **Automatically triggers your extension capture**
7. ✅ Waits for schema to upload to handoff server
8. ✅ Downloads and saves schema
9. ✅ Gives you Figma import instructions

**Output location:** `test/fidelity-results/simple-layout/`

---

## WHAT I CREATED FOR YOU

### 1. Automated Capture Script
**File:** `tools/automation/auto-capture-test.js`
- Launches Chrome with extension via Puppeteer
- Triggers capture by sending `START_CAPTURE` message
- Polls handoff server for result
- Saves schema + screenshot

### 2. Quick Test Wrapper
**File:** `tools/automation/quick-test.sh`
- One-command test runner
- Handles all prerequisites
- Runs full automation

### 3. Fidelity Test Framework
**File:** `tools/validation/fidelity-test.js`
- End-to-end testing system
- Pixel-diff comparison
- Reporting

### 4. Test Page
**File:** `test/fidelity-pages/simple-layout.html`
- First fidelity test case
- Tests: colors, gradients, shadows, border-radius
- Target: 98% fidelity

### 5. Documentation
- `FIDELITY_ASSESSMENT.md` - What's wrong and why
- `IMPLEMENTATION_PLAN.md` - 5-week roadmap
- `QUICKSTART.md` - Daily workflow
- `RUN_FIDELITY_TEST.md` - How automation works

---

## COMPLETE WORKFLOW

### 1. Run Automated Capture (5 seconds)

```bash
npm run quick-test test/fidelity-pages/simple-layout.html
```

**You'll see:**
```
🚀 Starting automated capture test
✅ Extension found
✅ Handoff server is ready
🌐 Launching Chrome with extension...
📸 Capturing original screenshot...
🔧 Triggering extension capture...
⏳ Waiting for schema...
✅ New capture received!
📊 Schema Summary: 47 nodes, 3 images
```

**Results saved to:**
```
test/fidelity-results/simple-layout/
├── original.png    ← Original page screenshot
├── schema.json     ← Captured schema (ready for Figma)
└── (figma.png)     ← You'll add this next
```

### 2. Import to Figma (Manual - 1 minute)

The script tells you exactly what to do:

```
📋 NEXT STEPS - MANUAL FIGMA IMPORT

1. Open Figma Desktop
2. Plugins → Development → Import plugin from manifest
3. Run the plugin
4. It will auto-poll and import the schema
5. Export result as PNG to:
   test/fidelity-results/simple-layout/figma.png
```

### 3. Measure Fidelity (5 seconds)

```bash
npm run quick-test test/fidelity-pages/simple-layout.html
```

Now it detects `figma.png` exists and runs comparison:

```
🔍 Running pixel-diff comparison...
Pixel diff: 12450 (2.34%)

📊 FIDELITY SCORE: 97.66% ✅
```

**You now have an objective fidelity measurement.**

---

## YOUR BASELINE MEASUREMENT (Do this TODAY)

```bash
# Test 1: Simple layout
npm run quick-test test/fidelity-pages/simple-layout.html
# → Figma import → Re-run
# Write down fidelity score: ____%

# That's your baseline. Now you can improve it.
```

---

## WHY NOTHING WAS SAVED BEFORE

Your extension **requires a trigger**. It doesn't auto-capture on page load.

**Before:** You had to click the extension icon manually.

**Now:** The automation script sends `START_CAPTURE` message to trigger it.

Your `injected-script.ts` already listens for this (line 241):

```typescript
if (type === "START_CAPTURE") {
  // Your capture logic runs here
}
```

**The automation works with your existing code. No changes needed.**

---

## DAILY WORKFLOW

**Every day, do this:**

1. Pick a CSS gap from FIDELITY_ASSESSMENT.md
2. Fix it in your code
3. Rebuild: `cd chrome-extension && npm run build && cd ..`
4. Re-test: `npm run quick-test test/fidelity-pages/simple-layout.html`
5. Check if fidelity improved
6. Commit if better

**Track progress:**
```
Day 1: 62% baseline
Day 2: 67% (+5%) - Fixed backdrop-filter detection
Day 3: 72% (+5%) - Added conic-gradient rasterization
...
```

---

## PREREQUISITES CHECK

Run these to make sure everything works:

```bash
# 1. Handoff server running?
curl http://localhost:4411/health
# Expected: OK

# 2. Extension built?
ls chrome-extension/dist/manifest.json
# Expected: File exists

# 3. Test page exists?
ls test/fidelity-pages/simple-layout.html
# Expected: File exists

# 4. Dependencies installed?
npm list puppeteer pixelmatch pngjs
# Expected: All installed
```

If any fail, run:
```bash
npm install
cd chrome-extension && npm run build && cd ..
node handoff-server.cjs &  # Run in background
```

---

## TROUBLESHOOTING

### "Cannot find module 'puppeteer'"
```bash
npm install
```

### "Extension not found"
```bash
cd chrome-extension && npm run build && cd ..
```

### "Handoff server not responding"
```bash
# Check if running
ps aux | grep handoff-server

# If not:
node handoff-server.cjs &
```

### "Timeout waiting for capture"
- Extension didn't trigger
- Check Chrome console for `📨 Received START_CAPTURE message`
- Check handoff server logs for `POST /queue`

### Chrome window opens but nothing happens
- Extension loaded? Check chrome://extensions
- Console errors? Open DevTools
- Message sent? Check automation script output

---

## NEXT ACTIONS (In order)

### TODAY:

1. ✅ Run automated test: `npm run quick-test test/fidelity-pages/simple-layout.html`
2. ✅ Import to Figma manually
3. ✅ Re-run to get fidelity score
4. ✅ Write down baseline: ____%
5. ✅ Start CSS Coverage Matrix (docs/CSS_COVERAGE.md)

### THIS WEEK:

1. ✅ Create 2 more test pages (gradients.html, transforms.html)
2. ✅ Measure baseline on all 3 pages
3. ✅ Identify worst CSS gaps
4. ✅ Fix top 3 gaps
5. ✅ Re-measure, track improvement

### WEEKS 2-5:

Follow IMPLEMENTATION_PLAN.md

---

## FILES YOU NEED TO READ

**Read in this order:**

1. **This file (START_HERE.md)** ← You are here
2. **RUN_FIDELITY_TEST.md** - How automation works (10 min)
3. **FIDELITY_ASSESSMENT.md** - What's wrong (20 min)
4. **IMPLEMENTATION_PLAN.md** - 5-week plan (30 min)

Then **execute**.

---

## THE BOTTOM LINE

**You have everything you need:**

✅ Automated capture system
✅ Pixel-diff validation
✅ Test pages
✅ 5-week roadmap
✅ Daily workflow

**What you DON'T have:**

❌ Fidelity measurement (you've never measured it)
❌ Systematic CSS coverage
❌ Production quality

**The path forward:**

1. Run `npm run quick-test test/fidelity-pages/simple-layout.html`
2. Get your first fidelity score
3. Fix gaps systematically
4. Measure daily
5. Reach 95%+ in 5 weeks

**Stop reading. Start running.**

```bash
npm run quick-test test/fidelity-pages/simple-layout.html
```

**GO.**
