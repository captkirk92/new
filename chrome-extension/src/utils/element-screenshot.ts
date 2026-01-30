// chrome-extension/src/utils/element-screenshot.ts
// Phase 5: Element screenshot capture for rasterization fallback

/**
 * Check if the current page URL is capturable via CDP/captureVisibleTab.
 * Chrome blocks CDP attachment to certain URL schemes for security.
 */
function isCapturablePageUrl(): boolean {
  const protocol = window.location.protocol;
  const restrictedProtocols = [
    "chrome-extension:",
    "chrome:",
    "edge:",
    "about:",
    "data:",
    "javascript:",
    "file:",
    "view-source:",
    "chrome-search:",
  ];
  return !restrictedProtocols.includes(protocol);
}

/**
 * PRIMARY: Capture element using native browser screenshot (pixel-perfect)
 * FALLBACK: Use SVG foreignObject if native capture fails
 *
 * Priority hierarchy:
 * 1. chrome.tabs.captureVisibleTab + crop (MOST RELIABLE)
 * 2. SVG foreignObject rendering (FALLBACK for edge cases)
 * 3. Return null (graceful degradation)
 */
export async function captureElementScreenshot(
  element: Element,
  options: {
    signal?: AbortSignal;
    timeoutMs?: number;
    targetWidth?: number;
    targetHeight?: number;
  } = {},
): Promise<string | null> {
  // P0-3 FIX: Enhanced diagnostic logging for rasterization debugging
  const elementInfo = getElementDiagnosticInfo(element);
  const startTime = performance.now();

  console.log(`[PHASE 5 RASTER] Starting capture for ${elementInfo.tag} (${elementInfo.dimensions})`);

  // Early exit for non-capturable URLs (chrome-extension://, chrome://, etc.)
  // CDP/captureVisibleTab always fails on these URLs
  if (!isCapturablePageUrl()) {
    console.warn(`[PHASE 5 RASTER] Skipping: non-capturable URL protocol (${window.location.protocol})`);
    return null;
  }

  // Try native capture first (highest fidelity)
  console.log(`[PHASE 5 RASTER] Attempting native CDP capture...`);
  let nativeResult: string | null = null;
  let nativeError: string | null = null;

  try {
    nativeResult = await captureElementViaTabCapture(
      element,
      options.signal,
      options.timeoutMs,
      options.targetWidth,
      options.targetHeight,
    );
  } catch (err) {
    nativeError = err instanceof Error ? err.message : String(err);
    console.error(`[PHASE 5 RASTER] Native capture threw error:`, nativeError);
  }

  // Validate native capture didn't fail silently
  if (nativeResult && validateCaptureResult(nativeResult, element)) {
    const elapsed = (performance.now() - startTime).toFixed(1);
    const dataSize = nativeResult.length;
    console.log(`[PHASE 5 RASTER] Native capture SUCCESS for ${elementInfo.tag} (${dataSize} bytes, ${elapsed}ms)`);
    return nativeResult;
  }

  // P0-3 FIX: Log why native capture failed
  if (!nativeResult) {
    console.warn(`[PHASE 5 RASTER] Native capture returned null/empty${nativeError ? `: ${nativeError}` : ''}`);
  } else {
    console.warn(`[PHASE 5 RASTER] Native capture failed validation (likely blank/corrupted)`);
  }

  // Fallback to foreignObject if native failed
  console.log(`[PHASE 5 RASTER] Attempting foreignObject fallback for ${elementInfo.tag}...`);
  let foreignObjectResult: string | null = null;
  let foreignObjectError: string | null = null;

  try {
    foreignObjectResult = await captureElementViaForeignObject(
      element,
      options.targetWidth,
      options.targetHeight,
    );
  } catch (err) {
    foreignObjectError = err instanceof Error ? err.message : String(err);
    console.error(`[PHASE 5 RASTER] ForeignObject capture threw error:`, foreignObjectError);
  }

  if (
    foreignObjectResult &&
    validateCaptureResult(foreignObjectResult, element)
  ) {
    const elapsed = (performance.now() - startTime).toFixed(1);
    const dataSize = foreignObjectResult.length;
    console.log(`[PHASE 5 RASTER] ForeignObject fallback SUCCESS for ${elementInfo.tag} (${dataSize} bytes, ${elapsed}ms)`);
    return foreignObjectResult;
  }

  // P0-3 FIX: Log detailed failure info
  const elapsed = (performance.now() - startTime).toFixed(1);
  console.error(`[PHASE 5 RASTER] ALL CAPTURE METHODS FAILED for ${elementInfo.tag} after ${elapsed}ms`);
  console.error(`[PHASE 5 RASTER] Element details:`, {
    tag: elementInfo.tag,
    dimensions: elementInfo.dimensions,
    hasFilter: elementInfo.hasFilter,
    hasBackdropFilter: elementInfo.hasBackdropFilter,
    hasMask: elementInfo.hasMask,
    hasClipPath: elementInfo.hasClipPath,
    nativeError,
    foreignObjectError,
  });

  return null;
}

/**
 * P0-3 FIX: Get diagnostic info about an element for logging
 */
function getElementDiagnosticInfo(element: Element): {
  tag: string;
  dimensions: string;
  hasFilter: boolean;
  hasBackdropFilter: boolean;
  hasMask: boolean;
  hasClipPath: boolean;
} {
  const tag = element.tagName?.toLowerCase() || 'unknown';
  const rect = element.getBoundingClientRect();
  const dimensions = `${Math.round(rect.width)}x${Math.round(rect.height)}`;

  let hasFilter = false;
  let hasBackdropFilter = false;
  let hasMask = false;
  let hasClipPath = false;

  try {
    const style = window.getComputedStyle(element);
    hasFilter = !!(style.filter && style.filter !== 'none');
    hasBackdropFilter = !!((style as any).backdropFilter && (style as any).backdropFilter !== 'none');
    hasMask = !!((style as any).webkitMaskImage || (style as any).maskImage);
    hasClipPath = !!(style.clipPath && style.clipPath !== 'none');
  } catch {
    // Ignore style access errors
  }

  return { tag, dimensions, hasFilter, hasBackdropFilter, hasMask, hasClipPath };
}

/**
 * Validate that a capture result is not suspiciously blank/invalid
 * Returns true if capture appears valid, false if suspicious
 */
function validateCaptureResult(dataUrl: string, element: Element): boolean {
  if (!dataUrl || !dataUrl.startsWith("data:image/")) {
    return false;
  }

  // Check if data URL is suspiciously small (likely blank/failed)
  const base64Data = dataUrl.split(",")[1];
  if (!base64Data || base64Data.length < 100) {
    console.warn(
      "[PHASE 5] Capture result suspiciously small:",
      base64Data?.length || 0,
      "bytes",
    );
    return false;
  }

  // Check element dimensions are reasonable
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    console.warn("[PHASE 5] Element has zero dimensions");
    return false;
  }

  // If element is very large but capture is very small, likely failed
  const elementArea = rect.width * rect.height;
  const minExpectedBytes = elementArea / 100; // Very rough heuristic
  if (base64Data.length < minExpectedBytes) {
    console.warn("[PHASE 5] Capture size too small for element dimensions", {
      area: elementArea,
      bytes: base64Data.length,
      expected: minExpectedBytes,
    });
    return false;
  }

  return true;
}

/**
 * FALLBACK: Captures screenshot using SVG foreignObject (best effort, not pixel-perfect)
 *
 * Known limitations:
 * - External fonts may not load (CORS/timing)
 * - Cross-origin images will taint canvas
 * - Filters/blends may differ from real renderer
 * - Pseudo-elements depend on cloning strategy
 * - Videos/canvas/WebGL won't render
 * - Some CSS features not supported in foreignObject
 */
async function captureElementViaForeignObject(
  element: Element,
  targetWidth?: number,
  targetHeight?: number,
): Promise<string | null> {
  try {
    const rect = element.getBoundingClientRect();
    // Rect used for cropping full-viewport screenshots (visible-tab fallback)
    let cropRect: DOMRect = rect;

    // Skip elements with zero dimensions
    if (rect.width <= 0 || rect.height <= 0) {
      return null;
    }

    // For perfect clone, we need actual rendered pixels
    // Use html2canvas-like approach with canvas drawing
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;

    // Set canvas size to element size (accounting for device pixel ratio)
    const dpr = window.devicePixelRatio || 1;
    const finalWidth = targetWidth || rect.width;
    const finalHeight = targetHeight || rect.height;

    canvas.width = finalWidth * dpr;
    canvas.height = finalHeight * dpr;
    ctx.scale(
      dpr * (finalWidth / rect.width),
      dpr * (finalHeight / rect.height),
    );

    // Strategy: Use SVG foreignObject to render the element
    // This captures all CSS effects including filters, blends, transforms
    const elementHtml = element.outerHTML;
    const computedStyle = window.getComputedStyle(element);

    // Sanitize HTML to remove cross-origin resources that would taint the canvas
    const sanitizedHtml = sanitizeHtmlForForeignObject(elementHtml);

    // Create SVG with foreignObject containing the element
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="${rect.width}" height="${
        rect.height
      }">
        <foreignObject width="${rect.width}" height="${rect.height}">
          <div xmlns="http://www.w3.org/1999/xhtml" style="${getInlineStyles(
            computedStyle,
          )}">
            ${sanitizedHtml}
          </div>
        </foreignObject>
      </svg>
    `;

    // Convert SVG to data URL
    const svgBlob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
    const svgUrl = URL.createObjectURL(svgBlob);

    // Load SVG as image and draw to canvas
    const img = new Image();

    return new Promise<string | null>((resolve) => {
      img.onload = () => {
        try {
          ctx.drawImage(img, 0, 0, rect.width, rect.height);
          URL.revokeObjectURL(svgUrl);

          // Convert canvas to PNG data URL
          const dataUrl = canvas.toDataURL("image/png");
          resolve(dataUrl);
        } catch (err) {
          console.warn("[RASTERIZE] Failed to draw SVG to canvas:", err);
          URL.revokeObjectURL(svgUrl);
          resolve(null);
        }
      };

      img.onerror = () => {
        console.warn("[RASTERIZE] Failed to load SVG as image");
        URL.revokeObjectURL(svgUrl);
        resolve(null);
      };

      // Set a timeout to avoid hanging
      setTimeout(() => {
        URL.revokeObjectURL(svgUrl);
        resolve(null);
      }, 5000);

      img.src = svgUrl;
    });
  } catch (err) {
    console.warn("[RASTERIZE] Element screenshot capture failed:", err);
    return null;
  }
}

/**
 * Sanitizes HTML for safe use in foreignObject SVG rendering.
 * Removes cross-origin resources that would taint the canvas.
 */
function sanitizeHtmlForForeignObject(html: string): string {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, "text/html");

  // Remove script and iframe elements to prevent execution/loading
  const scripts = Array.from(doc.querySelectorAll("script, iframe, frame, object, embed"));
  for (let i = 0; i < scripts.length; i++) {
    scripts[i].remove();
  }

  // Remove all images with cross-origin or extension URLs
  const images = Array.from(doc.querySelectorAll("img"));
  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    const src = img.getAttribute("src") || "";
    const srcset = img.getAttribute("srcset") || "";

    // Check for problematic URL patterns
    const isCrossOrigin =
      src.startsWith("http") && !src.startsWith(window.location.origin);
    const isExtensionUrl =
      src.startsWith("chrome-extension://") ||
      src.startsWith("moz-extension://") ||
      src.startsWith("edge://");

    // Keep only same-origin, data URLs, and blob URLs
    if (isCrossOrigin || isExtensionUrl) {
      img.removeAttribute("src");
      img.removeAttribute("srcset");
      // Set a transparent placeholder
      img.setAttribute("src", "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7");
    }

    // Also clean srcset of cross-origin URLs
    if (srcset) {
      const cleanedSrcset = srcset
        .split(",")
        .map((s) => s.trim())
        .filter((s) => {
          const url = s.split(/\s+/)[0];
          return (
            !url.startsWith("http") ||
            url.startsWith(window.location.origin)
          );
        })
        .join(", ");
      if (cleanedSrcset) {
        img.setAttribute("srcset", cleanedSrcset);
      } else {
        img.removeAttribute("srcset");
      }
    }
  }

  // Remove link elements (external stylesheets/fonts)
  const links = Array.from(doc.querySelectorAll('link[rel="stylesheet"], link[rel="preload"]'));
  for (let i = 0; i < links.length; i++) {
    links[i].remove();
  }

  // Remove style elements with @import or @font-face pointing to external URLs
  const styles = Array.from(doc.querySelectorAll("style"));
  for (let i = 0; i < styles.length; i++) {
    const style = styles[i];
    const text = style.textContent || "";
    // Remove @import and @font-face rules with external URLs
    const cleaned = text
      .replace(/@import\s+url\([^)]+\)[^;]*;?/gi, "")
      .replace(/@font-face\s*\{[^}]*url\s*\([^)]+\)[^}]*\}/gi, "");
    style.textContent = cleaned;
  }

  // Remove background-image styles pointing to external URLs in inline styles
  const elementsWithStyle = Array.from(doc.querySelectorAll("[style]"));
  for (let i = 0; i < elementsWithStyle.length; i++) {
    const el = elementsWithStyle[i];
    const style = el.getAttribute("style") || "";
    // Remove background-image with external URLs
    const cleaned = style.replace(
      /background(-image)?\s*:\s*url\s*\(\s*['"]?(https?:\/\/[^'")\s]+)['"]?\s*\)[^;]*;?/gi,
      ""
    );
    el.setAttribute("style", cleaned);
  }

  return doc.body.innerHTML;
}

/**
 * Converts computed styles to inline style string
 * Preserves all visual properties including filters, transforms, blends
 */
function getInlineStyles(computed: CSSStyleDeclaration): string {
  const important = [
    "display",
    "width",
    "height",
    "position",
    "top",
    "left",
    "right",
    "bottom",
    "margin",
    "padding",
    "border",
    "background",
    "color",
    "font-family",
    "font-size",
    "font-weight",
    "line-height",
    "text-align",
    "filter",
    "transform",
    "transform-origin",
    "opacity",
    "mix-blend-mode",
    "isolation",
  ];

  const styles: string[] = [];
  for (const prop of important) {
    const value = computed.getPropertyValue(prop);
    if (value && value !== "none" && value !== "normal") {
      styles.push(`${prop}: ${value}`);
    }
  }

  return styles.join("; ");
}

/**
 * PRIMARY CAPTURE METHOD: Use Chrome's tab.captureVisibleTab API with cropping
 * This captures actual rendered pixels including all effects - PIXEL-PERFECT
 *
 * Why this is PRIMARY:
 * - Native browser screenshot - captures exactly what user sees
 * - Includes all CSS effects: filters, blends, transforms, animations
 * - External fonts render correctly (already loaded in page)
 * - Cross-origin images render correctly (browser has access)
 * - Videos/canvas/WebGL content captured as-is
 * - Pseudo-elements (::before/::after) included automatically
 * - No synthetic re-rendering artifacts
 *
 * Requires: 'activeTab' permission in manifest.json
 */
async function captureElementViaTabCapture(
  element: Element,
  signal?: AbortSignal,
  configuredTimeoutMs: number = 2500,
  targetWidth?: number,
  targetHeight?: number,
): Promise<string | null> {
  try {
    const rect = element.getBoundingClientRect();
    // Rect used for cropping full-viewport screenshots (visible-tab fallback)
    let cropRect: DOMRect = rect;

    if (rect.width <= 0 || rect.height <= 0) {
      console.warn("[PHASE 5] Element has zero dimensions, skipping capture");
      return null;
    }

    // Compute page-space clip (viewport rect + scroll offsets) for CDP capture.
    // CDP clip coordinates are in page coordinates (CSS px).
    const scrollX =
      window.scrollX ||
      document.documentElement.scrollLeft ||
      (document.body as any)?.scrollLeft ||
      0;
    const scrollY =
      window.scrollY ||
      document.documentElement.scrollTop ||
      (document.body as any)?.scrollTop ||
      0;

    const clip = {
      x: rect.left + scrollX,
      y: rect.top + scrollY,
      width: rect.width,
      height: rect.height,
      scale: 1,
    };

    // Check if we're in injected script context (no chrome.runtime) or content script context
    const hasChromeRuntime =
      typeof chrome !== "undefined" &&
      chrome.runtime &&
      chrome.runtime.sendMessage;

    let response: any;

    if (hasChromeRuntime) {
      // Direct call from content script context: prefer CDP clip capture (no scrolling artifacts).
      response = await chrome.runtime.sendMessage({
        type: "CAPTURE_CDP_CLIP",
        clip,
      });

      // Fallback: visible tab capture (background returns full viewport; we crop locally).
      if (!response?.ok) {
        // Visible-tab crop requires the element to be in the viewport, so scroll only for this fallback.
        element.scrollIntoView({
          block: "center",
          inline: "center",
          behavior: "instant",
        });
        await new Promise((resolve) => setTimeout(resolve, 150)); // Allow time for scroll + reflow
        const scrolledRect = element.getBoundingClientRect();
        cropRect = scrolledRect;
        response = await chrome.runtime.sendMessage({
          type: "CAPTURE_VISIBLE_TAB",
          rect: {
            x: scrolledRect.left,
            y: scrolledRect.top,
            width: scrolledRect.width,
            height: scrolledRect.height,
          },
        });
      }
    } else {
      // Injected script context - use window.postMessage to communicate with content script
      const requestId = `capture_${Date.now()}_${Math.random()
        .toString(36)
        .substr(2, 9)}`;

      response = await new Promise<any>((resolve) => {
        let resolved = false;
        let fallbackTimeoutId: ReturnType<typeof setTimeout> | null = null;
        let overallTimeoutId: ReturnType<typeof setTimeout> | null = null;

        const cleanup = () => {
          if (fallbackTimeoutId) clearTimeout(fallbackTimeoutId);
          if (overallTimeoutId) clearTimeout(overallTimeoutId);
          window.removeEventListener("message", messageHandler);
        };

        const resolveOnce = (value: any, source: string) => {
          if (resolved) {
            console.log(
              `[CAPTURE] Ignoring duplicate response from ${source} for ${requestId}`,
            );
            return;
          }
          resolved = true;
          cleanup();
          console.log(`[CAPTURE] Resolved via ${source} for ${requestId}`);
          resolve(value);
        };

        // Set up one-time listener for the response
        const messageHandler = (event: MessageEvent) => {
          if (event.source !== window) return;
          if (resolved) return; // Already resolved, ignore

          if (
            (event.data.type === "CAPTURE_CDP_CLIP_PROXY_RESPONSE" ||
              event.data.type === "CAPTURE_VISIBLE_TAB_PROXY_RESPONSE") &&
            event.data.requestId === requestId
          ) {
            resolveOnce(
              event.data.response || {
                ok: false,
                error: "No response received",
              },
              event.data.type,
            );
          }
        };

        window.addEventListener("message", messageHandler);

        // Send request to content script (prefer CDP clip capture).
        console.log(`[CAPTURE] Sending CDP request ${requestId}`);
        window.postMessage(
          {
            type: "CAPTURE_CDP_CLIP_PROXY",
            requestId,
            clip,
          },
          "*",
        );

        const timeoutMs = Math.max(500, Math.min(8000, configuredTimeoutMs));

        // Fallback to visible-tab proxy if CDP path doesn't respond quickly.
        fallbackTimeoutId = setTimeout(() => {
          if (resolved) return;
          console.log(
            `[CAPTURE] CDP timeout (${timeoutMs}ms), sending VISIBLE_TAB fallback for ${requestId}`,
          );
          window.postMessage(
            {
              type: "CAPTURE_VISIBLE_TAB_PROXY",
              requestId,
              rect: {
                x: cropRect.left,
                y: cropRect.top,
                width: cropRect.width,
                height: cropRect.height,
              },
            },
            "*",
          );
        }, timeoutMs);

        // Abort signal handling
        if (signal) {
          signal.addEventListener(
            "abort",
            () => {
              resolveOnce({ ok: false, error: "Aborted" }, "abort");
            },
            { once: true },
          );
        }

        // Timeout after 10 seconds (hard limit)
        overallTimeoutId = setTimeout(() => {
          resolveOnce(
            { ok: false, error: "Capture request timeout" },
            "timeout",
          );
        }, 12000);
      });
    }

    if (!response || !response.ok) {
      console.warn(
        "[PHASE 5] Native capture failed:",
        response?.error || "Unknown error",
      );
      return null;
    }

    const rawData = response.dataUrl || response.data;
    if (rawData) {
      // If we got a full-viewport screenshot, crop it; if we got a clip screenshot, it's already cropped.
      // Heuristic: CDP returns just the clip; visible-tab returns full viewport.
      // We always crop visible-tab; cropping an already-cropped image is harmless but may shift if coords mismatch,
      // so only crop when the source is likely full-viewport.
      const isLikelyFullViewport = rawData.length > 200000; // rough heuristic
      if (isLikelyFullViewport) {
        return await cropImage(rawData, cropRect, targetWidth, targetHeight);
      }
      return rawData;
    }

    return null;
  } catch (err) {
    console.warn("[PHASE 5] Native tab capture failed:", err);
    return null;
  }
}

/**
 * Crops an image data URL to specified bounds
 */
async function cropImage(
  dataUrl: string,
  rect: DOMRect,
  targetWidth?: number,
  targetHeight?: number,
): Promise<string | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        resolve(null);
        return;
      }

      const dpr = window.devicePixelRatio || 1;

      // Target dimensions: if explicitly provided, use them. Otherwise use rendered size * DPR.
      // This effectively clamps resolution to the rendered size.
      const finalWidth = targetWidth || rect.width;
      const finalHeight = targetHeight || rect.height;

      canvas.width = finalWidth * dpr;
      canvas.height = finalHeight * dpr;
      ctx.scale(
        dpr * (finalWidth / rect.width),
        dpr * (finalHeight / rect.height),
      );

      // Crop from the full screenshot
      ctx.drawImage(
        img,
        rect.left * dpr,
        rect.top * dpr,
        rect.width * dpr,
        rect.height * dpr,
        0,
        0,
        rect.width,
        rect.height,
      );

      resolve(canvas.toDataURL("image/png"));
    };

    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}
