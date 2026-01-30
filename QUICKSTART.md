# QUICKSTART - Path to High Fidelity

**Current state:** ~60% fidelity (estimated)
**Target:** 95%+ fidelity
**Time:** 5 weeks of focused work

---

## READ THIS FIRST

**I've analyzed your entire codebase (29K lines).** Here's the truth:

✅ **What you have RIGHT:**
- Good infrastructure (capture → handoff → import)
- Defensive programming
- Basic CSS support working

❌ **What's WRONG:**
- No systematic CSS coverage
- No fidelity measurement
- Inconsistent rasterization (violates your golden rule)
- No regression testing

**Bottom line:** You have a prototype. You need 5 weeks to reach production quality.

---

## CRITICAL DOCUMENTS (Read in order)

1. **FIDELITY_ASSESSMENT.md** - Brutal analysis of current state
2. **IMPLEMENTATION_PLAN.md** - 5-week roadmap to 95%+
3. **This file** - What to do RIGHT NOW

---

## START HERE - Week 1, Day 1 (TODAY)

### Task 1: Measure Your Current Fidelity (2 hours)

**You cannot improve what you don't measure.**

```bash
# 1. Open the simple test page in Chrome
open test/fidelity-pages/simple-layout.html

# 2. Capture original screenshot (automated)
npm run validate:fidelity simple

# This will:
# - Capture the original page screenshot
# - Save to test/fidelity-results/simple-layout/original.png
# - Tell you where to save the Figma render
```

**Manual steps (until automation complete):**

3. Load `test/fidelity-pages/simple-layout.html` in Chrome
4. Click your extension icon to capture
5. Import to Figma plugin
6. Export Figma render as PNG
7. Save to: `test/fidelity-results/simple-layout/figma.png`
8. Re-run: `npm run validate:fidelity simple`

**You'll get:**
```
📊 Results:
   Fidelity: XX.XX%
   Target: 98%
   Status: FAIL ❌
```

**This number is your baseline. Write it down.**

### Task 2: Create CSS Coverage Matrix (2 hours)

**Document what your code actually supports:**

```bash
mkdir -p docs
touch docs/CSS_COVERAGE.md
```

**Fill it out by auditing your code:**

```markdown
# CSS Property Coverage

| Property | Status | Figma Mapping | Current Fidelity | Test Case |
|----------|--------|---------------|-----------------|-----------|
| background-color | ✅ SUPPORTED | SOLID fill | 100% | simple-layout.html |
| background: linear-gradient | ⚠️ PARTIAL | GRADIENT_LINEAR | 95% | gradients.html |
| background: conic-gradient | ❌ NOT_HANDLED | None | 0% | gradients.html |
| transform: rotate() | ✅ SUPPORTED | rotation | 100% | transforms-2d.html |
| transform: matrix3d() | ⚠️ RASTERIZES | Screenshot | 100% | transforms-3d.html |
| filter: blur() | ✅ SUPPORTED | LAYER_BLUR | 95% | filters.html |
| filter: hue-rotate() | ❌ NOT_HANDLED | None | 0% | filters.html |
| backdrop-filter | ❌ NOT_HANDLED | None | 0% | MISSING |
```

**How to fill it:**
- Grep your code for each CSS property
- Check if it's parsed
- Check if it maps to Figma
- Check if it triggers rasterization
- Mark status accordingly

**This matrix is your roadmap.**

### Task 3: Fix the Worst Offenders (4 hours)

**Based on your matrix, pick the top 3 gaps:**

Example:
1. backdrop-filter not detected → Add detection + rasterization
2. conic-gradient crashes → Add detection + rasterization
3. hue-rotate() ignored → Add to filter parser + rasterization

**For each gap:**

```typescript
// Example: Add backdrop-filter detection
// File: chrome-extension/src/utils/dom-extractor.ts

const backdropFilter = computed.backdropFilter || computed.webkitBackdropFilter;
if (backdropFilter && backdropFilter !== 'none') {
  node.rasterize = {
    reason: 'BACKDROP_FILTER',
    cssFeature: 'backdrop-filter',
    originalValue: backdropFilter,
    dataUrl: await captureElementScreenshot(element)
  };
  console.log(`🔄 [RASTERIZE] backdrop-filter detected, rasterizing element`);
}
```

**Test each fix:**
```bash
npm run validate:fidelity simple
# Fidelity should increase
```

---

## Week 1 Goals

By end of Week 1, you should have:

✅ Baseline fidelity measured on 3 test pages
✅ CSS Coverage Matrix completed
✅ Top 3 CSS gaps fixed
✅ Fidelity improved by 10-15%

---

## Week 2-5 Overview

**Week 2:** Centralize rasterization policy (enforce golden rule)
**Week 3:** Expand CSS support (gradients, filters, blend modes)
**Week 4:** Refactor code (split 13K line files into modules)
**Week 5:** Add regression tests + determinism validation

**See IMPLEMENTATION_PLAN.md for detailed breakdown.**

---

## Daily Workflow

**Every day:**

1. Pick highest priority task from IMPLEMENTATION_PLAN.md
2. Implement fix
3. Run `npm run validate:fidelity`
4. Record before/after fidelity
5. Commit if improved
6. Update CSS_COVERAGE.md

**Track your progress:**

```
Day 1:  60% → 65% (+5%)  [Fixed backdrop-filter]
Day 2:  65% → 70% (+5%)  [Fixed conic-gradient]
Day 3:  70% → 75% (+5%)  [Fixed hue-rotate()]
...
Day 30: 93% → 96% (+3%)  [Edge case fixes]
```

---

## CRITICAL RULES

**1. Measure before fixing**
- Never make changes without measuring impact
- Always run fidelity test after changes

**2. One fix at a time**
- Don't combine multiple fixes
- Isolate what caused improvement

**3. Enforce golden rule**
- If CSS can't map 1:1 to Figma → RASTERIZE
- No "close enough" approximations

**4. Update documentation**
- Every fix updates CSS_COVERAGE.md
- Document why rasterization was chosen

**5. Test determinism**
- Same input → Same output
- Run capture 3x, verify identical

---

## AUTOMATION ROADMAP

**Current state:** Manual steps for Figma import

**Week 2 goal:** Automate extension trigger
**Week 3 goal:** Automate Figma import
**Week 4 goal:** Fully automated fidelity tests

**Until then:** Run tests manually, track results

---

## STOPPING POINTS

**Stop and reassess if:**

1. Fidelity not improving after 3 days
   - Audit your changes
   - Check if rasterization is working
   - Verify pixel-diff is accurate

2. New bugs appear
   - Add regression test FIRST
   - Fix bug
   - Verify regression test passes

3. Code becoming unmaintainable
   - Pause feature work
   - Refactor NOW (don't accumulate debt)

---

## SUCCESS METRICS

**You're done when:**

- ✅ All 10 test pages > 95% fidelity
- ✅ CSS Coverage Matrix 100% complete
- ✅ Determinism tests pass (3 runs = identical)
- ✅ Regression suite in CI/CD
- ✅ Core files < 3000 lines each
- ✅ Documentation complete

**Not before.**

---

## FAQ

**Q: Why 95% and not 100%?**
A: Anti-aliasing, browser quirks, floating-point rounding. 95%+ is production-grade.

**Q: Why rasterize instead of approximate?**
A: Your golden rule says "pixel-perfect or rasterize". Approximations = fidelity loss.

**Q: Can I skip the CSS matrix?**
A: No. You can't fix what you don't document. Matrix is your roadmap.

**Q: What if Figma API can't do something?**
A: Rasterize it. That's the whole point of the fallback strategy.

**Q: When will I be at html2design level?**
A: Week 5 if you follow the plan. Week 8+ if you skip steps.

---

## NEXT STEPS

**Right now, this minute:**

1. Read FIDELITY_ASSESSMENT.md (15 min)
2. Run `npm run validate:fidelity simple` (5 min)
3. Write down your baseline fidelity score
4. Start CSS Coverage Matrix (2 hours)
5. Fix your first gap (2 hours)

**Tomorrow:**

1. Create 2 more test pages (gradients.html, transforms-2d.html)
2. Run fidelity tests on all 3
3. Fix 2 more gaps
4. Update matrix

**This week:**

1. Complete all 10 test pages
2. Measure baseline on all
3. Fix top 10 gaps
4. See 10-15% fidelity improvement

---

## ACCOUNTABILITY

**Track your progress in:** `PROGRESS.md`

```markdown
# Fidelity Progress

## Week 1
- Day 1: Baseline measured at 62%
- Day 2: Added backdrop-filter detection → 67% (+5%)
- Day 3: Fixed conic-gradient → 72% (+5%)
- ...

## Week 2
- Day 8: Centralized rasterization policy → 78% (+6%)
- ...
```

**Review weekly:**
- What worked?
- What's blocked?
- Are you on track for 95%?

---

## FINAL WORD

**You asked for brutal honesty. Here it is:**

Your code is **good infrastructure** but **not production-ready**. You have the foundation. Now build the house.

**Follow this plan. Measure everything. Fix systematically.**

You'll reach 95%+ in 5 weeks.

**Start now. Task 1. Go.**
