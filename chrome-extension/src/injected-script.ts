/**
 * injected-script.ts
 *
 * Production-grade script that runs in the page context (MAIN world).
 * Has full access to window, document, and any JavaScript frameworks on the page.
 *
 * Responsibilities:
 * - Guard against duplicate injection
 * - Wait for DOM readiness before extraction
 * - Import and call extractPageToSchema from the robust DOM extractor
 * - Relay EXTRACTION_PROGRESS messages to CAPTURE_PROGRESS
 * - Capture screenshot via content-script bridge
 * - Post CAPTURE_DONE or CAPTURE_ERROR on completion
 */

import { DOMExtractor } from "./utils/dom-extractor";
import { WebToFigmaSchema } from "./types/schema";

// Make this file a module to allow global augmentation
export {};

// ============================================================================
// TYPE DEFINITIONS SAME AS LEGACY FOR BACKWARD COMPAT
// ============================================================================

interface CaptureSchema extends WebToFigmaSchema {
  screenshot?: {
    bytes: string;
    width: number;
    height: number;
    devicePixelRatio: number;
  };
}

// ============================================================================
// GLOBAL STATE & DUPLICATE INJECTION GUARD
// ============================================================================

declare global {
  interface Window {
    __FigmaCaptureLoaded__?: boolean;
    __FigmaCaptureMessageListener__?: (event: MessageEvent) => void;
  }
}

// Guard against duplicate injection
if (window.__FigmaCaptureLoaded__) {
  console.log("🔄 Figma Capture already loaded, skipping duplicate injection");
} else {
  window.__FigmaCaptureLoaded__ = true;
  initializeInjectedScript();
}

// ============================================================================
// MAIN INITIALIZATION
// ============================================================================

function initializeInjectedScript(): void {
  console.log("🎯 Figma Capture Injected Script loaded (v2.0 Refactored)");
  console.log(`📍 URL: ${window.location.href}`);

  // Remove previous listener if exists (for hot reload scenarios)
  if (window.__FigmaCaptureMessageListener__) {
    window.removeEventListener(
      "message",
      window.__FigmaCaptureMessageListener__,
    );
    console.log("♻️ Removed previous message listener");
  }

  // ============================================================================
  // PROGRESS REPORTING
  // ============================================================================

  function emitProgress(
    progress: number,
    phase: string,
    message: string,
    data?: any,
  ): void {
    window.postMessage(
      {
        type: "CAPTURE_PROGRESS",
        // Ensure progress is within 0-100
        progress: Math.min(100, Math.max(0, progress)),
        phase,
        message,
        ...data,
      },
      "*",
    );
  }

  // ============================================================================
  // LOG PROXY (Content Script -> Injected Script -> Console)
  // ============================================================================
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    if (event.data?.type === "LOG_PROXY") {
      console.log(`📝 [CS-PROXY] ${event.data.message}`);
    }
  });

  function emitDone(
    schema: CaptureSchema,
    duration: number,
    nodeCount: number,
  ): void {
    console.log("📤 Emitting CAPTURE_DONE via postMessage");
    try {
      window.postMessage(
        {
          type: "CAPTURE_DONE",
          schema,
          duration,
          nodeCount,
        },
        "*",
      );
      console.log("✅ CAPTURE_DONE emitted successfully");
    } catch (error) {
      console.error("❌ Failed to emit CAPTURE_DONE:", error);
      emitError(
        `PostMessage Failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  function emitError(error: string, details?: unknown): void {
    window.postMessage(
      {
        type: "CAPTURE_ERROR",
        error,
        details,
      },
      "*",
    );
  }

  // ============================================================================
  // SCREENSHOT CAPTURE (Legacy Logic Preserved)
  // ============================================================================

  async function capturePageScreenshot(): Promise<{
    bytes: string;
    width: number;
    height: number;
    devicePixelRatio: number;
  } | null> {
    emitProgress(95, "Screenshot", "Capturing page screenshot...");

    return new Promise((resolve) => {
      // Never reject, just resolve null on error
      let timeoutId: number;

      const handler = (event: MessageEvent) => {
        if (event.source !== window) return;
        if (event.data?.type === "SCREENSHOT_RESULT") {
          window.removeEventListener("message", handler);
          clearTimeout(timeoutId);

          if (event.data.error) {
            console.warn(
              `⚠️ Screenshot capture error from content script: ${event.data.error}`,
            );
            resolve(null);
          } else {
            const output = event.data.screenshot || "";
            // Extract base64
            const base64Data = output.startsWith("data:")
              ? output.split(",")[1]
              : output;

            if (!base64Data || base64Data.length < 100) {
              console.warn("⚠️ Empty screenshot received");
              resolve(null);
              return;
            }

            resolve({
              bytes: base64Data,
              width: window.innerWidth,
              height: window.innerHeight,
              devicePixelRatio: window.devicePixelRatio || 1,
            });
          }
        }
      };

      window.addEventListener("message", handler);

      // Request screenshot from content script
      window.postMessage({ type: "REQUEST_SCREENSHOT" }, "*");

      // Timeout after 15 seconds (increased from 10)
      timeoutId = window.setTimeout(() => {
        window.removeEventListener("message", handler);
        console.warn("⚠️ Screenshot request timeout");
        resolve(null);
      }, 15000);
    });
  }

  // ============================================================================
  // PROGRESS BRIDGE (DOMExtractor -> Content Script)
  // ============================================================================

  // Listen for EXTRACTION_PROGRESS from DOMExtractor and forward if needed
  // (Though we primarily rely on DOMExtractor's internal progress logic, this ensures
  // visual feedback even if DOMExtractor uses a different event name)
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    if (event.data?.type === "EXTRACTION_PROGRESS") {
      // Forward as CAPTURE_PROGRESS for content-script UI
      emitProgress(
        event.data.percent,
        event.data.phase,
        event.data.message,
        event.data,
      );
    }
  });

  // ============================================================================
  // MAIN CAPTURE HANDLER
  // ============================================================================

  const messageListener = async (event: MessageEvent): Promise<void> => {
    // Only accept messages from our window
    if (event.source !== window) return;

    const { type } = event.data || {};

    // Handle health check
    if (type === "PING") {
      window.postMessage({ type: "PONG" }, "*");
      return;
    }

    // Handle capture start
    if (type === "START_CAPTURE") {
      console.log("📨 Received START_CAPTURE message");
      const captureStartTime = performance.now();

      try {
        emitProgress(0, "Initializing", "Starting robust capture (v2.0)...");

        // 1. Initialize DOM Extractor
        const extractor = new DOMExtractor();

        // 2. Run Extraction
        // Note: DOMExtractor handles auto-scroll, font waiting, and navigation blocking internally
        const schema = await extractor.extractPageToSchema();

        // 3. Capture Screenshot
        // We do this after extraction to ensure the page is stable
        let screenshotData;
        try {
          screenshotData = await capturePageScreenshot();
          console.log(`📸 Screenshot captured successfully`);
        } catch (screenshotError) {
          console.warn(
            "⚠️ Screenshot capture failed (proceeding without it):",
            screenshotError,
          );
          // Non-fatal, proceed
        }

        // 4. Assemble Final Payload
        const finalSchema: CaptureSchema = {
          ...schema,
          screenshot: screenshotData,
        };

        // 5. Statistics
        const duration = Math.round(performance.now() - captureStartTime);
        // Look for node count in metadata or calculate root descendants
        const nodeCount = finalSchema.metadata?.extractedNodes || 0;

        console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        console.log(`✅ Capture Sequence Complete`);
        console.log(`   ⏱️  Duration: ${duration}ms`);
        console.log(`   📊 Nodes: ${nodeCount}`);
        console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

        emitDone(finalSchema, duration, nodeCount);
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        const errorStack = error instanceof Error ? error.stack : undefined;

        console.error("❌ Capture failed:", errorMessage);
        emitError(errorMessage, { stack: errorStack });
      }
    }
  };

  // Register listener and store reference for cleanup
  window.__FigmaCaptureMessageListener__ = messageListener;
  window.addEventListener("message", messageListener);

  console.log("✅ Message listener installed, ready for START_CAPTURE");

  // Notify content script that we are ready
  window.postMessage({ type: "SCRIPT_READY" }, "*");
}
