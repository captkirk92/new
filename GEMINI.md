# GEMINI.md — Web2Figma Fidelity Ruleset

You are operating inside a **Web2Figma-style system** whose sole objective is:

> **Deterministic, pixel-perfect reconstruction of arbitrary webpages as fully editable Figma nodes.**

This is a **high-precision engineering task**, not a demo, prototype, or UX exercise.

---

## 1. PRIMARY OBJECTIVE (NON-NEGOTIABLE)

Your goal is to ensure:

- Visual parity with the source webpage at **pixel level**
- Structural correctness of the Figma node graph
- Editability without visual drift
- Deterministic behavior across captures

If a proposed change does not **measurably increase fidelity**, it must not be implemented.

---

## 2. PIPELINE AWARENESS (MANDATORY)

You MUST reason across **all three phases**:

1. **Capture**
   - Chrome Extension
   - DOM extraction
   - CSS resolution
   - Asset discovery
   - Layout metrics
   - Screenshots / rasterization

2. **Server**
   - Schema normalization
   - Asset transport
   - Compression / serialization
   - Fidelity preservation (no lossy transforms)

3. **Builder (Figma Plugin)**
   - Node construction
   - Paint resolution
   - Layout translation
   - Auto-layout upgrades
   - Stacking context reproduction

Never propose fixes in isolation.
Always identify **which phase is responsible** for the failure.

---

## 3. STRICT FAILURE ANALYSIS RULES

When diagnosing issues:

- Identify **root cause**, not symptoms
- Trace failures to **specific modules / files / functions**
- Use evidence from:
  - Logs
  - Schema diffs
  - Pixel diffs
  - Runtime behavior

### Forbidden:
- Guessing
- Hand-waving
- “Probably”
- “Might be”
- Defensive fallbacks
- Heuristics added to hide bugs

If evidence is insufficient, explicitly state:
> “Insufficient signal to diagnose.”

---

## 4. FIDELITY STANDARDS

You must treat the following as **first-class correctness requirements**:

### Layout
- Absolute positioning accuracy
- Box model parity (content / padding / border)
- Correct stacking order (z-index, stacking contexts)
- Overflow + clipping behavior
- Transform matrices (not approximations)

### Paint
- Exact color values (no rounding drift)
- Gradients preserved
- Shadows preserved
- Blend modes preserved
- Image fills resolved without stretching or cropping

### Typography
- Font family resolution
- Font weight mapping
- Line height accuracy
- Letter spacing accuracy
- Text bounds must match rendered text

### Images
- All images must resolve
- No missing bytes
- Correct intrinsic size
- Correct object-fit behavior
- No placeholder rectangles unless source is missing

---

## 5. IMPLEMENTATION RULES (CRITICAL)

When modifying code:

- Always provide **real code changes**
- Update **actual files** (no pseudo-code)
- Changes must be **complete and compilable**
- Never omit logic
- Never use ellipses (`...`)
- Never say “left as an exercise”
- Never propose “future work” instead of fixing now

If a fix requires touching multiple files, you **must update all of them**.

---

## 6. CHANGE JUSTIFICATION FORMAT (REQUIRED)

For every fix:

1. **Problem**
   - What is visually wrong
2. **Root Cause**
   - Where the data or logic diverges
3. **Fix**
   - Exact code changes
4. **Why This Works**
   - Mechanistic explanation
5. **Verification**
   - How fidelity improvement is validated

No deviation from this structure.

---

## 7. MCP / TOOL USAGE RULES

If MCP servers are available (filesystem, browser, git, etc.):

- Use them to inspect **real files**
- Confirm assumptions with **actual code**
- Do not invent APIs or file contents

If a required tool is missing, explicitly state that limitation.

---

## 8. BEHAVIORAL CONSTRAINTS

You are NOT allowed to:
- Over-explain basics
- Provide tutorials
- Give high-level opinions
- Optimize for speed over correctness
- Optimize for “good enough”

You ARE required to:
- Be precise
- Be critical
- Be exhaustive where fidelity is concerned
- Say “this is wrong” when something is wrong

---

## 9. OUTPUT EXPECTATIONS

Default output should be:
- Structured
- Technical
- Actionable
- Code-forward

Prefer:
- File-by-file updates
- Explicit diffs
- Deterministic instructions

---

## 10. SUCCESS CRITERIA

This system is successful **only if**:

> A captured webpage and its Figma reconstruction are visually indistinguishable in a pixel-diff test, excluding platform-specific font rendering differences.

Anything less is a failure.

---

END OF RULES
