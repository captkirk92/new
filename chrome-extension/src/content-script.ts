/**
 * content-script.ts
 *
 * Production-grade content script that acts as controller between the
 * background service worker and the injected DOM extractor.
 *
 * Responsibilities:
 * - Request OAuth token from background before capture
 * - Display full-screen progress overlay with color transitions
 * - Perform smooth single-pass scroll to trigger lazy-loaded content
 * - Use IntersectionObserver to detect lazy-loaded elements
 * - Inject the extraction script into page context
 * - Coordinate capture messages (START_CAPTURE, CAPTURE_DONE, CAPTURE_ERROR, CAPTURE_PROGRESS)
 * - Upload captured schema to Figma via background
 * - Clean up all event listeners after each capture run
 */

// Make this file a module to allow global augmentation
export {};

import { stylesheetPreprocessor } from "./utils/stylesheet-preprocessor";

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

interface OAuthResponse {
  success: boolean;
  token?: string;
  error?: string;
}

interface CaptureProgressMessage {
  type: "CAPTURE_PROGRESS";
  progress: number;
  phase: string;
  message: string;
}

interface CaptureDoneMessage {
  type: "CAPTURE_DONE";
  schema: unknown;
  duration: number;
  nodeCount: number;
}

interface CaptureErrorMessage {
  type: "CAPTURE_ERROR";
  error: string;
  details?: unknown;
}

interface FigmaUploadResponse {
  success: boolean;
  figmaUrl?: string;
  error?: string;
}

type CaptureMessage =
  | CaptureProgressMessage
  | CaptureDoneMessage
  | CaptureErrorMessage
  | CaptureErrorMessage
  | LayoutPreviewMessage
  | ExtractionProgressMessage;

interface ExtractionProgressMessage {
  type: "EXTRACTION_PROGRESS";
  percent: number;
  phase: string;
  message: string;
}

interface LayoutPreviewMessage {
  type: "LAYOUT_PREVIEW";
  blocks: unknown[];
  viewport: unknown;
  page: unknown;
}

// ============================================================================
// GLOBAL STATE
// ============================================================================

declare global {
  interface Window {
    __FigmaCaptureContentScriptLoaded__?: boolean;
  }
}

// Guard against duplicate injection
if (window.__FigmaCaptureContentScriptLoaded__) {
  console.log("📍 Content script already loaded, skipping initialization");
} else {
  window.__FigmaCaptureContentScriptLoaded__ = true;
  initializeContentScript();
}

// ============================================================================
// MAIN INITIALIZATION
// ============================================================================

function initializeContentScript(): void {
  console.log("🚀 Figma Capture Content Script loaded");
  console.log(`📍 URL: ${window.location.href}`);
  console.log(`📍 Frame: ${window.top === window ? "top" : "iframe"}`);

  // Only run in top frame
  if (window.top !== window) {
    console.log("📍 Running in iframe, skipping capture orchestration");
    return;
  }

  // Mark content script as ready for automation tools
  document.documentElement.setAttribute("data-web2figma-cs", "ready");

  // Track active event listeners for cleanup
  const activeListeners: Array<{
    target: EventTarget;
    type: string;
    listener: EventListenerOrEventListenerObject;
  }> = [];

  // ============================================================================
  // PROGRESS OVERLAY
  // ============================================================================

  class CaptureOverlay {
    private overlay: HTMLDivElement | null = null;
    private progressBar: HTMLDivElement | null = null;
    private statusText: HTMLDivElement | null = null;
    private phaseText: HTMLDivElement | null = null;

    private readonly COLORS = {
      capturing: "#3B82F6", // Blue
      success: "#22C55E", // Green
      error: "#EF4444", // Red
    };

    show(
      message: string,
      phase: string = "Initializing",
      percent: number = 0,
    ): void {
      if (this.overlay) {
        this.update(message, phase, percent);
        return;
      }

      this.overlay = document.createElement("div");
      this.overlay.id = "figma-capture-overlay";
      this.overlay.style.cssText = `
        position: fixed !important;
        top: 0 !important;
        left: 0 !important;
        width: 100vw !important;
        height: 100vh !important;
        background: rgba(0, 0, 0, 0.85) !important;
        display: flex !important;
        flex-direction: column !important;
        align-items: center !important;
        justify-content: center !important;
        z-index: 2147483647 !important;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif !important;
        transition: background-color 0.3s ease !important;
      `;

      // Logo/Icon
      const logo = document.createElement("div");
      logo.innerHTML = `
        <svg width="64" height="64" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
          <circle cx="32" cy="32" r="28" stroke="${this.COLORS.capturing}" stroke-width="4" fill="none">
            <animate attributeName="stroke-dasharray" values="0 176;176 0" dur="2s" repeatCount="indefinite"/>
          </circle>
          <path d="M22 32L28 38L42 24" stroke="${this.COLORS.capturing}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" opacity="0.5"/>
        </svg>
      `;
      logo.style.marginBottom = "24px";

      // Phase text
      this.phaseText = document.createElement("div");
      this.phaseText.style.cssText = `
        color: ${this.COLORS.capturing} !important;
        font-size: 14px !important;
        font-weight: 600 !important;
        text-transform: uppercase !important;
        letter-spacing: 2px !important;
        margin-bottom: 8px !important;
      `;
      this.phaseText.textContent = phase;

      // Status text
      this.statusText = document.createElement("div");
      this.statusText.style.cssText = `
        color: white !important;
        font-size: 20px !important;
        font-weight: 500 !important;
        margin-bottom: 32px !important;
        text-align: center !important;
        max-width: 80% !important;
      `;
      this.statusText.textContent = message;

      // Progress bar container
      const progressContainer = document.createElement("div");
      progressContainer.style.cssText = `
        width: 300px !important;
        height: 6px !important;
        background: rgba(255, 255, 255, 0.2) !important;
        border-radius: 3px !important;
        overflow: hidden !important;
      `;

      // Progress bar fill
      this.progressBar = document.createElement("div");
      this.progressBar.style.cssText = `
        width: ${percent}% !important;
        height: 100% !important;
        background: ${this.COLORS.capturing} !important;
        border-radius: 3px !important;
        transition: width 0.3s ease, background-color 0.3s ease !important;
      `;

      progressContainer.appendChild(this.progressBar);
      this.overlay.appendChild(logo);
      this.overlay.appendChild(this.phaseText);
      this.overlay.appendChild(this.statusText);
      this.overlay.appendChild(progressContainer);

      document.body.appendChild(this.overlay);
    }

    update(message: string, phase?: string, percent?: number): void {
      if (!this.overlay) return;

      if (this.statusText && message) {
        this.statusText.textContent = message;
      }
      if (this.phaseText && phase) {
        this.phaseText.textContent = phase;
      }
      if (this.progressBar && typeof percent === "number") {
        this.progressBar.style.width = `${Math.min(100, Math.max(0, percent))}%`;
      }
    }

    setColor(state: "capturing" | "success" | "error"): void {
      const color = this.COLORS[state];
      if (this.progressBar) {
        this.progressBar.style.background = color;
      }
      if (this.phaseText) {
        this.phaseText.style.color = color;
      }
    }

    animateSuccess(): void {
      this.setColor("success");
      this.update("✅ Capture completed successfully!", "Complete", 100);
    }

    animateError(errorMessage: string): void {
      this.setColor("error");
      this.update(`❌ ${errorMessage}`, "Error", 100);
    }

    hide(delay: number = 0): void {
      if (!this.overlay) return;

      const doHide = () => {
        if (this.overlay && this.overlay.parentNode) {
          this.overlay.parentNode.removeChild(this.overlay);
        }
        this.overlay = null;
        this.progressBar = null;
        this.statusText = null;
        this.phaseText = null;
      };

      if (delay > 0) {
        setTimeout(doHide, delay);
      } else {
        doHide();
      }
    }
  }

  const overlay = new CaptureOverlay();

  // ============================================================================
  // CHROME RUNTIME MESSAGING UTILITIES
  // ============================================================================

  async function sendMessageToBackground<T>(message: unknown): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!chrome.runtime?.id) {
        reject(new Error("Extension context invalidated"));
        return;
      }

      // Add timeout to prevent infinite hangs
      const timeoutId = setTimeout(() => {
        reject(
          new Error(
            `Message timeout: no response for ${(message as any).type || "unknown"} after 30s`,
          ),
        );
      }, 30000);

      try {
        chrome.runtime.sendMessage(message, (response) => {
          clearTimeout(timeoutId);
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve(response as T);
          }
        });
      } catch (error) {
        clearTimeout(timeoutId);
        reject(error);
      }
    });
  }

  /**
   * Send capture data to background, using chunked transfer for large payloads
   * to avoid chrome.runtime.sendMessage size limits
   */
  async function sendCaptureDataToBackground(
    schema: unknown,
    duration: number,
    onProgress?: (percent: number) => void,
  ): Promise<void> {
    const jsonString = JSON.stringify(schema);
    const sizeBytes = new TextEncoder().encode(jsonString).length;
    const sizeMB = sizeBytes / (1024 * 1024);

    console.log(`📊 Capture payload size: ${sizeMB.toFixed(2)}MB`);

    // Threshold: use chunking for payloads > 5MB to avoid IPC failures
    const CHUNK_THRESHOLD_MB = 5;
    const CHUNK_SIZE = 64 * 1024; // 64KB chunks

    if (sizeMB <= CHUNK_THRESHOLD_MB) {
      // Small payload - send directly
      console.log("📤 Sending capture data directly (small payload)");
      await sendMessageToBackground({
        type: "CAPTURE_COMPLETE",
        data: schema,
        dataSize: sizeBytes,
        duration,
      });
      return;
    }

    // Large payload - use chunked transfer
    console.log(`📦 Using chunked transfer for ${sizeMB.toFixed(2)}MB payload`);

    const chunks: string[] = [];
    for (let i = 0; i < jsonString.length; i += CHUNK_SIZE) {
      chunks.push(jsonString.slice(i, i + CHUNK_SIZE));
    }

    const totalChunks = chunks.length;
    console.log(
      `📦 Split into ${totalChunks} chunks of ${CHUNK_SIZE / 1024}KB each`,
    );

    // Start chunked transfer
    console.log(`📦 [CHUNKED] Starting transfer: ${totalChunks} chunks`);
    const startResponse = await sendMessageToBackground({
      type: "CAPTURE_CHUNKED_START",
      totalChunks,
      totalSize: sizeBytes,
      totalSizeKB: (sizeBytes / 1024).toFixed(1),
    });
    console.log(`📦 [CHUNKED] START acknowledged:`, startResponse);

    // Send chunks
    for (let i = 0; i < chunks.length; i++) {
      const chunkStartTime = Date.now();
      const response = await sendMessageToBackground({
        type: "CAPTURE_CHUNKED_DATA",
        chunkIndex: i,
        chunkData: chunks[i],
        totalChunks,
      });
      const chunkDuration = Date.now() - chunkStartTime;

      // Report progress (85% -> 95% during chunking)
      if (onProgress) {
        const chunkProgress = 85 + ((i + 1) / totalChunks) * 10;
        onProgress(chunkProgress);
      }

      // Log every 10 chunks to avoid spam, or if a chunk is slow
      if (
        (i + 1) % 10 === 0 ||
        i === chunks.length - 1 ||
        chunkDuration > 1000
      ) {
        console.log(
          `📦 [CHUNKED] Sent chunk ${i + 1}/${totalChunks} (${chunkDuration}ms)`,
          response,
        );
      }
    }

    // Complete chunked transfer
    console.log(`📦 [CHUNKED] Completing transfer...`);
    const completeResponse = await sendMessageToBackground({
      type: "CAPTURE_CHUNKED_COMPLETE",
      totalChunks,
    });
    console.log(`📦 [CHUNKED] COMPLETE acknowledged:`, completeResponse);

    console.log("✅ Chunked transfer complete");
  }

  // ============================================================================
  // OAUTH TOKEN REQUEST
  // ============================================================================

  async function requestOAuthToken(): Promise<string | null> {
    console.log("🔐 Requesting OAuth token from background...");

    try {
      const response = await sendMessageToBackground<OAuthResponse>({
        type: "REQUEST_OAUTH",
      });

      if (response.success && response.token) {
        console.log("✅ OAuth token received");
        return response.token;
      } else {
        console.warn("⚠️ OAuth token not available:", response.error);
        return null;
      }
    } catch (error) {
      console.error("❌ Failed to request OAuth token:", error);
      return null;
    }
  }

  // ============================================================================
  // SKELETON LOADING DETECTION
  // ============================================================================

  async function waitForSkeletons(maxWaitMs: number = 6000): Promise<{
    initialCount: number;
    finalCount: number;
    waitedMs: number;
  }> {
    const startTime = Date.now();
    const skeletonSelectors = [
      ".skeleton",
      ".Skeleton",
      ".anim-pulse",
      "[data-skeleton]",
      "[aria-busy='true']",
      ".gh-skeleton",
      ".is-loading",
    ];

    const getSkeletonCount = () => {
      let count = 0;
      skeletonSelectors.forEach((sel) => {
        try {
          count += document.querySelectorAll(sel).length;
        } catch (e) {
          // ignore
        }
      });

      // Shimmer heuristic: elements with pulse or shimmer animations
      const allEls = document.querySelectorAll("*");
      const subsetSize = Math.min(allEls.length, 1000);
      for (let i = 0; i < subsetSize; i++) {
        const el = allEls[i];
        const style = window.getComputedStyle(el);
        const anim = style.animationName || "";
        if (
          anim.includes("pulse") ||
          anim.includes("shimmer") ||
          anim.includes("skeleton")
        ) {
          count++;
        }
      }
      return count;
    };

    const initialCount = getSkeletonCount();
    if (initialCount === 0) {
      return { initialCount: 0, finalCount: 0, waitedMs: 0 };
    }

    console.log(
      `🦴 [SKELETON] Detected ${initialCount} placeholders, waiting...`,
    );

    let currentCount = initialCount;
    let stableForMs = 0;
    const checkInterval = 250;

    while (Date.now() - startTime < maxWaitMs) {
      await new Promise((resolve) => setTimeout(resolve, checkInterval));

      const nextCount = getSkeletonCount();
      if (nextCount < currentCount) {
        currentCount = nextCount;
        stableForMs = 0;
      } else {
        stableForMs += checkInterval;
      }

      if (currentCount === 0 || stableForMs >= 600) {
        break;
      }

      const elapsed = Date.now() - startTime;
      const progress = Math.min(100, (elapsed / maxWaitMs) * 100);
      updateProgress(
        `Waiting for content stabilization... (${currentCount} left)`,
        "Stabilizing",
        30 + progress * 0.05,
      );
    }

    const finalCount = getSkeletonCount();
    const waitedMs = Date.now() - startTime;
    console.log(
      `✅ [SKELETON] Wait complete: ${waitedMs}ms. Skeletons: ${initialCount} -> ${finalCount}`,
    );

    return { initialCount, finalCount, waitedMs };
  }

  // ============================================================================
  // TURBO FRAME DETECTION (GitHub & Hotwire Support)
  // ============================================================================

  async function waitForTurboFrames(maxWaitMs: number = 6000): Promise<void> {
    const hasTurboFrames = document.querySelector("turbo-frame") !== null;
    const hasGitHubCustomElements =
      document.querySelector(
        "feed-container, feed-live-container, react-partial",
      ) !== null;
    const isGitHub = location.hostname.includes("github.com");

    if (!isGitHub && !hasTurboFrames && !hasGitHubCustomElements) {
      return;
    }

    console.log(
      "🧩 [TURBO] Detected Turbo/GitHub elements, monitoring hydration...",
    );

    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitMs) {
      const frames = Array.from(document.querySelectorAll("turbo-frame"));
      const loadingFrames = frames.filter((frame) => {
        const busy = frame.getAttribute("busy");
        const loading = frame.getAttribute("loading");
        const complete = frame.getAttribute("complete");
        // GitHub specific: some frames stay 'eager' but aren't 'complete' until content loads
        return (
          busy === "true" ||
          loading === "lazy" ||
          (frame.hasAttribute("complete") &&
            frame.getAttribute("complete") !== "true")
        );
      });

      if (loadingFrames.length === 0) {
        console.log(`✅ [TURBO] All ${frames.length} frames ready`);
        break;
      }

      updateProgress(
        `Waiting for ${loadingFrames.length} turbo frames...`,
        "Hydrating",
        28,
      );
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  // ============================================================================
  // LAZY LOAD DETECTION WITH INTERSECTION OBSERVER
  // ============================================================================

  async function waitForLazyLoadedElements(
    timeoutMs: number = 5000,
  ): Promise<number> {
    return new Promise((resolve) => {
      let loadedCount = 0;
      const observedElements = new Set<Element>();
      const startTime = Date.now();

      // Find elements that might be lazy-loaded
      const lazySelectors = [
        "img[loading='lazy']",
        "img[data-src]",
        "img[data-lazy]",
        "[data-lazy-load]",
        ".lazy",
        ".lazyload",
        "iframe[data-src]",
      ];

      const potentialLazyElements = document.querySelectorAll(
        lazySelectors.join(","),
      );
      console.log(
        `🔍 Found ${potentialLazyElements.length} potential lazy-loaded elements`,
      );

      if (potentialLazyElements.length === 0) {
        resolve(0);
        return;
      }

      const observer = new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            if (entry.isIntersecting && !observedElements.has(entry.target)) {
              observedElements.add(entry.target);
              loadedCount++;

              // Check if the element has loaded (for images)
              if (entry.target instanceof HTMLImageElement) {
                if (entry.target.complete && entry.target.naturalWidth > 0) {
                  console.log(
                    `✅ Lazy image loaded: ${entry.target.src?.slice(0, 50)}...`,
                  );
                }
              }
            }
          });
        },
        { threshold: 0.1 },
      );

      potentialLazyElements.forEach((el) => observer.observe(el));

      // Timeout to prevent infinite waiting
      const timeoutId = setTimeout(() => {
        observer.disconnect();
        console.log(
          `⏱️ Lazy load detection complete: ${loadedCount} elements detected`,
        );
        resolve(loadedCount);
      }, timeoutMs);

      // Also resolve early if all elements are observed
      const checkComplete = setInterval(() => {
        if (
          observedElements.size >= potentialLazyElements.length ||
          Date.now() - startTime > timeoutMs
        ) {
          clearInterval(checkComplete);
          clearTimeout(timeoutId);
          observer.disconnect();
          resolve(loadedCount);
        }
      }, 500);
    });
  }

  // ============================================================================
  // SMOOTH SINGLE-PASS SCROLL
  // ============================================================================

  async function performSmoothScroll(
    onProgress?: (percent: number) => void,
  ): Promise<void> {
    const originalScrollY = window.scrollY;
    const viewportHeight = window.innerHeight;
    const documentHeight = Math.max(
      document.body.scrollHeight,
      document.documentElement.scrollHeight,
    );
    const totalScrollDistance = documentHeight - viewportHeight;
    const scrollStep = viewportHeight * 0.8; // Scroll 80% of viewport at a time
    const scrollDelay = 150; // ms between scroll steps

    console.log(
      `📜 Starting smooth scroll (document height: ${documentHeight}px)`,
    );

    if (totalScrollDistance <= 0) {
      console.log("📜 Page fits in viewport, no scroll needed");
      return;
    }

    let currentPosition = 0;
    let lastHeight = documentHeight;

    while (currentPosition < totalScrollDistance + viewportHeight) {
      // Smooth scroll to position
      window.scrollTo({
        top: currentPosition,
        behavior: "auto", // Use 'auto' for faster, more controlled scrolling
      });

      // Calculate progress
      const progress = Math.min(
        100,
        (currentPosition / totalScrollDistance) * 100,
      );
      if (onProgress) {
        onProgress(progress);
      }

      // Wait for scroll to settle and lazy content to load
      await new Promise((r) => setTimeout(r, scrollDelay));

      // Check if page height changed (infinite scroll)
      const newHeight = Math.max(
        document.body.scrollHeight,
        document.documentElement.scrollHeight,
      );

      if (newHeight > lastHeight) {
        console.log(`📜 Page grew from ${lastHeight}px to ${newHeight}px`);
        lastHeight = newHeight;
      }

      currentPosition += scrollStep;

      // Safety limit: don't scroll more than 15 screens
      if (currentPosition > viewportHeight * 15) {
        console.log("📜 Reached maximum scroll limit");
        break;
      }
    }

    // Wait for any final lazy-loaded content
    await waitForLazyLoadedElements(3000);

    // Restore original scroll position
    window.scrollTo({ top: originalScrollY, behavior: "auto" });
    console.log(`📜 Scroll complete, restored to ${originalScrollY}px`);
  }

  // ============================================================================
  // SCRIPT INJECTION
  // ============================================================================

  async function injectExtractionScript(): Promise<void> {
    console.log("💉 Injecting extraction script...");

    return new Promise((resolve, reject) => {
      // First try via background script (bypasses CSP)
      sendMessageToBackground<{ ok: boolean; error?: string }>({
        type: "INJECT_IN_PAGE_SCRIPT",
        files: ["injected-script.js"],
      })
        .then((response) => {
          if (response?.ok) {
            console.log("✅ Script injected via chrome.scripting API");
            resolve();
          } else {
            console.warn(
              "⚠️ Scripting API failed, trying DOM injection:",
              response?.error || "Unknown error",
            );
            injectViaDom();
          }
        })
        .catch((err) => {
          console.warn(
            "⚠️ Background injection failed (communication error), trying DOM injection:",
            err,
          );
          injectViaDom();
        });

      function injectViaDom(): void {
        console.log("💉 Attempting DOM script injection...");
        try {
          const script = document.createElement("script");
          script.src = chrome.runtime.getURL("injected-script.js");
          script.onload = () => {
            console.log("✅ Script injected via DOM");
            script.remove();
            resolve();
          };
          script.onerror = (error) => {
            // Note: 'error' event for scripts is minimal due to CORS
            console.error(
              "❌ DOM script injection failed (Likely strict CSP blocking external script)",
            );
            script.remove();
            reject(
              new Error(
                "Failed to inject extraction script via DOM (CSP block?)",
              ),
            );
          };
          (document.head || document.documentElement).appendChild(script);
        } catch (error) {
          console.error("❌ DOM injection threw synchronous error:", error);
          reject(error);
        }
      }
    });
  }

  // ============================================================================
  // CAPTURE MESSAGE HANDLING
  // ============================================================================

  function setupCaptureMessageListener(
    onDone: (schema: unknown, duration: number, nodeCount: number) => void,
    onError: (error: string, details?: unknown) => void,
    onProgress: (
      progress: number,
      phase: string,
      message: string,
      data?: any,
    ) => void,
  ): () => void {
    const messageHandler = (event: MessageEvent) => {
      // Only accept messages from our window
      if (event.source !== window) return;

      if (event.data?.type?.startsWith?.("CAPTURE_DONE")) {
        console.log(
          `📨 [content] Message Source Debug: origin=${event.origin}, source===window? ${event.source === window}`,
        );
      }

      const data = event.data as CaptureMessage;
      if (!data || typeof data.type !== "string") return;

      // Prevent infinite loop by ignoring our own proxy messages
      if ((data as any).type === "LOG_PROXY") return;
      if ((data as any).type === "EXTRACTION_PROGRESS") return; // Reduce noise from high-frequency updates

      // Proxy debug log to visible main world console
      window.postMessage(
        {
          type: "LOG_PROXY",
          message: `Listener received message: ${data.type} (Size: ${JSON.stringify(data).length})`,
        },
        "*",
      );

      try {
        switch (data.type) {
          case "CAPTURE_DONE":
            window.postMessage(
              {
                type: "LOG_PROXY",
                message: "✅ Received CAPTURE_DONE from injected script.",
              },
              "*",
            );
            onDone(data.schema, data.duration, data.nodeCount);
            break;

          case "CAPTURE_ERROR":
            window.postMessage(
              {
                type: "LOG_PROXY",
                message: `❌ Received CAPTURE_ERROR: ${data.error}`,
              },
              "*",
            );
            console.error(
              "❌ Received CAPTURE_ERROR from injected script:",
              data.error,
              data.details,
            );
            onError(data.error, data.details);
            break;

          case "CAPTURE_PROGRESS":
            console.log(
              `📊 Progress: ${data.progress}% - ${data.phase}: ${data.message}`,
            );
            onProgress(data.progress, data.phase, data.message, data);
            break;

          case "LAYOUT_PREVIEW":
            console.log(
              "📐 [content] Received LAYOUT_PREVIEW from injected script, forwarding to background",
            );
            sendMessageToBackground(data).catch((err) =>
              console.warn("⚠️ Failed to forward LAYOUT_PREVIEW:", err),
            );
            break;
        }
      } catch (err) {
        console.error("❌ Error in capture message listener:", err);
      }

      // Handle screenshot requests from injected script (separate from switch to always run)
      if (event.data?.type === "REQUEST_SCREENSHOT") {
        console.log("📸 [content] Screenshot requested by injected script");
        (async () => {
          try {
            const response = await sendMessageToBackground<{
              screenshot?: string;
              error?: string;
            }>({
              type: "CAPTURE_SCREENSHOT",
            });
            if (response.error) {
              window.postMessage(
                { type: "SCREENSHOT_RESULT", error: response.error },
                "*",
              );
            } else {
              window.postMessage(
                { type: "SCREENSHOT_RESULT", screenshot: response.screenshot },
                "*",
              );
            }
          } catch (error) {
            const errorMsg =
              error instanceof Error ? error.message : String(error);
            window.postMessage(
              { type: "SCREENSHOT_RESULT", error: errorMsg },
              "*",
            );
          }
        })();
      }

      // Handle element screenshot proxy requests (CDP Clip)
      if (event.data?.type === "CAPTURE_CDP_CLIP_PROXY") {
        const { requestId, clip } = event.data;
        // console.log(`📸 [content] Proxying CDP clip capture ${requestId}`);

        sendMessageToBackground({ type: "CAPTURE_CDP_CLIP", clip })
          .then((response) => {
            window.postMessage(
              {
                type: "CAPTURE_CDP_CLIP_PROXY_RESPONSE",
                requestId,
                response,
              },
              "*",
            );
          })
          .catch((error) => {
            console.warn(`❌ [content] CDP proxy failed:`, error);
            window.postMessage(
              {
                type: "CAPTURE_CDP_CLIP_PROXY_RESPONSE",
                requestId,
                response: { ok: false, error: String(error) },
              },
              "*",
            );
          });
      }

      // Handle element screenshot proxy requests (Visible Tab)
      if (event.data?.type === "CAPTURE_VISIBLE_TAB_PROXY") {
        const { requestId, rect } = event.data;
        // console.log(`📸 [content] Proxying Visible Tab capture ${requestId}`);

        sendMessageToBackground({ type: "CAPTURE_VISIBLE_TAB", rect })
          .then((response) => {
            window.postMessage(
              {
                type: "CAPTURE_VISIBLE_TAB_PROXY_RESPONSE",
                requestId,
                response,
              },
              "*",
            );
          })
          .catch((error) => {
            console.warn(`❌ [content] Visible Tab proxy failed:`, error);
            window.postMessage(
              {
                type: "CAPTURE_VISIBLE_TAB_PROXY_RESPONSE",
                requestId,
                response: { ok: false, error: String(error) },
              },
              "*",
            );
          });
      }

      // Handle generic message proxy requests from DOM extractor (MAIN world)
      if (event.data?.type === "FETCH_ASSET_PROXY") {
        const { requestId, message } = event.data;

        sendMessageToBackground(message)
          .then((response) => {
            window.postMessage(
              {
                type: "FETCH_ASSET_PROXY_RESPONSE",
                requestId,
                response,
              },
              "*",
            );
          })
          .catch((error) => {
            window.postMessage(
              {
                type: "FETCH_ASSET_PROXY_RESPONSE",
                requestId,
                response: { ok: false, error: String(error) },
              },
              "*",
            );
          });
      }
    };

    window.addEventListener("message", messageHandler);
    activeListeners.push({
      target: window,
      type: "message",
      listener: messageHandler,
    });

    // Return cleanup function
    return () => {
      window.removeEventListener("message", messageHandler);
      const index = activeListeners.findIndex(
        (l) => l.listener === messageHandler,
      );
      if (index > -1) activeListeners.splice(index, 1);
    };
  }

  // ============================================================================
  // FIGMA UPLOAD
  // ============================================================================

  async function uploadSchemaToFigma(
    schema: unknown,
  ): Promise<FigmaUploadResponse> {
    console.log("📤 Uploading schema to Figma...");

    try {
      const response = await sendMessageToBackground<FigmaUploadResponse>({
        type: "UPLOAD_SCHEMA_TO_FIGMA",
        schema,
      });

      if (response.success) {
        console.log("✅ Schema uploaded to Figma:", response.figmaUrl);
      } else {
        console.error("❌ Figma upload failed:", response.error);
      }

      return response;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.error("❌ Failed to upload to Figma:", errorMessage);
      return { success: false, error: errorMessage };
    }
  }

  // ============================================================================
  // HANDSHAKE WITH INJECTED SCRIPT
  // ============================================================================

  async function waitForInjectedScript(timeoutMs = 5000): Promise<void> {
    console.log("🤝 Waiting for injected script handshake...");
    return new Promise((resolve, reject) => {
      let resolved = false;

      const handler = (event: MessageEvent) => {
        if (event.source !== window) return;
        const type = event.data?.type;
        if (type === "SCRIPT_READY" || type === "PONG") {
          cleanup();
          resolved = true;
          console.log("✅ Injected script handshake complete");
          resolve();
        }
      };

      window.addEventListener("message", handler);

      // Ping periodically until we get a response
      const interval = setInterval(() => {
        window.postMessage({ type: "PING" }, "*");
      }, 100);

      const timeout = setTimeout(() => {
        cleanup();
        if (!resolved) {
          reject(
            new Error(
              "Injected script handshake failed: no response within timeout. " +
                "The extraction script did not initialize correctly.",
            ),
          );
        }
      }, timeoutMs);

      const cleanup = () => {
        window.removeEventListener("message", handler);
        clearInterval(interval);
        clearTimeout(timeout);
      };
    });
  }

  // ============================================================================
  // MAIN CAPTURE ORCHESTRATION
  // ============================================================================

  // Helper to update overlay AND relay progress to popup
  function updateProgress(
    message: string,
    phase: string,
    percent: number,
    data?: any,
  ): void {
    overlay.update(message, phase, percent);
    document.documentElement.setAttribute(
      "data-capture-progress",
      Math.round(percent).toString(),
    );
    document.documentElement.setAttribute("data-capture-status", "running");

    if (data?.nodesProcessed !== undefined) {
      document.documentElement.setAttribute(
        "data-capture-nodes",
        data.nodesProcessed.toString(),
      );
    }

    sendMessageToBackground({
      type: "EXTRACTION_PROGRESS",
      phase,
      message,
      percent,
      ...data,
    }).catch(() => {}); // Ignore send errors
  }

  async function performCapture(): Promise<void> {
    const startTime = Date.now();
    let cleanupMessageListener: (() => void) | null = null;

    try {
      // Step 1: Show overlay
      try {
        overlay.show("Initializing capture...", "Setup", 5);
      } catch (overlayError) {
        console.warn(
          "⚠️ Failed to show overlay (proceeding anyway):",
          overlayError,
        );
      }

      updateProgress("Initializing capture...", "Setup", 5);
      console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
      console.log("🎬 Starting Figma capture process");
      console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

      // Step 1.5: Preprocess stylesheets if enabled
      const preprocessEnabled = await stylesheetPreprocessor.isEnabled();
      const alreadyPreprocessed = document.documentElement.hasAttribute(
        "data-stylesheets-preprocessed",
      );

      if (preprocessEnabled && !alreadyPreprocessed) {
        updateProgress("Preprocessing stylesheets...", "Preprocess", 7);
        console.log("🔧 Stylesheet preprocessing enabled, checking server...");

        const serverAvailable =
          await stylesheetPreprocessor.checkServerHealth();

        if (serverAvailable) {
          try {
            console.log("🔧 Preprocessing stylesheets...");
            const result = await stylesheetPreprocessor.preprocess(
              window.location.href,
            );

            console.log("✅ Stylesheet preprocessing complete:", {
              stylesheets: result.stats.inlinedStylesheets,
              imports: result.stats.importRulesResolved,
              fonts: result.stats.fontFacesInlined,
              errors: result.stats.errors.length,
            });

            if (result.stats.errors.length > 0) {
              console.warn(
                "⚠️ Preprocessing encountered errors:",
                result.stats.errors.slice(0, 5),
              );
            }

            // Inject preprocessed styles directly into the document
            // This preserves page state, event listeners, and component hydration
            updateProgress("Applying preprocessed styles...", "Preprocess", 8);

            // Mark document as preprocessed to prevent infinite loop
            document.documentElement.setAttribute(
              "data-stylesheets-preprocessed",
              "true",
            );

            // Parse the preprocessed HTML to extract style elements
            const parser = new DOMParser();
            const preprocessedDoc = parser.parseFromString(
              result.html,
              "text/html",
            );

            // Remove all existing <link rel="stylesheet"> elements
            const existingLinks = document.querySelectorAll(
              'link[rel="stylesheet"]',
            );
            existingLinks.forEach((link) => link.remove());
            console.log(
              `🗑️ Removed ${existingLinks.length} external stylesheet links`,
            );

            // Extract and inject all <style> elements from preprocessed HTML
            const preprocessedStyles =
              preprocessedDoc.querySelectorAll("style");
            let injectedCount = 0;
            preprocessedStyles.forEach((style) => {
              const newStyle = document.createElement("style");
              newStyle.textContent = style.textContent;
              newStyle.setAttribute("data-preprocessed", "true");
              document.head.appendChild(newStyle);
              injectedCount++;
            });

            console.log(
              `✅ Injected ${injectedCount} preprocessed style blocks`,
            );
          } catch (preprocessError) {
            console.warn(
              "⚠️ Stylesheet preprocessing failed, continuing with original page:",
              preprocessError,
            );
            // Continue with normal capture on preprocessing failure
          }
        } else {
          console.warn(
            "⚠️ Handoff server not available, skipping preprocessing",
          );
        }
      } else if (alreadyPreprocessed) {
        console.log("✅ Page already preprocessed, skipping");
      }

      // Step 2: Request OAuth token
      updateProgress("Authenticating...", "OAuth", 10);
      const token = await requestOAuthToken();
      if (!token) {
        console.log("⚠️ Proceeding without OAuth token");
      }

      // Step 3: Scroll page to trigger lazy loading
      updateProgress("Scrolling page to load content...", "Scroll", 15);
      await performSmoothScroll((percent) => {
        updateProgress(
          `Scrolling page... ${Math.round(percent)}%`,
          "Scroll",
          15 + percent * 0.1, // 15-25%
        );
      });

      // Step 3.5: Wait for skeletons/stabilization
      updateProgress("Waiting for content stabilization...", "Stabilizing", 25);
      const skeletonResult = await waitForSkeletons(6000);
      console.log(
        `✅ Skeleton stabilization: ${skeletonResult.initialCount} -> ${skeletonResult.finalCount} in ${skeletonResult.waitedMs}ms`,
      );

      // Step 3.6: Wait for Turbo Frames (GitHub specific)
      updateProgress("Checking dynamic frames...", "Hydrating", 28);
      await waitForTurboFrames(6000);

      // Step 4: Wait for lazy-loaded elements
      updateProgress("Waiting for lazy-loaded content...", "Lazy Load", 30);
      const lazyCount = await waitForLazyLoadedElements(5000);
      console.log(`✅ Detected ${lazyCount} lazy-loaded elements`);

      // Step 5: Inject extraction script
      updateProgress("Preparing extraction engine...", "Injection", 35);
      await injectExtractionScript();

      // Ensure injected script is ready before sending commands
      await waitForInjectedScript(2000);

      // Step 6: Start capture via postMessage
      updateProgress("Extracting DOM structure...", "Extraction", 40);

      // Master timeout: 5 minutes to prevent indefinite hangs
      const CAPTURE_TIMEOUT_MS = 5 * 60 * 1000;
      let captureTimeoutId: ReturnType<typeof setTimeout> | null = null;
      let lastProgressTime = Date.now();

      const capturePromise = new Promise<{
        schema: unknown;
        duration: number;
        nodeCount: number;
      }>((resolve, reject) => {
        // Set up master timeout that resets on progress
        const checkTimeout = () => {
          const timeSinceProgress = Date.now() - lastProgressTime;
          if (timeSinceProgress > CAPTURE_TIMEOUT_MS) {
            console.error(
              `❌ Capture timed out after ${Math.round(
                CAPTURE_TIMEOUT_MS / 1000,
              )}s of no progress`,
            );
            reject(
              new Error(
                `Capture timed out after ${Math.round(
                  CAPTURE_TIMEOUT_MS / 1000,
                )}s - the page may be too complex or unresponsive`,
              ),
            );
            return;
          }
          // Check again in 30 seconds
          captureTimeoutId = setTimeout(checkTimeout, 30000);
        };
        captureTimeoutId = setTimeout(checkTimeout, 30000);

        cleanupMessageListener = setupCaptureMessageListener(
          (schema, duration, nodeCount) => {
            if (captureTimeoutId) clearTimeout(captureTimeoutId);
            resolve({ schema, duration, nodeCount });
          },
          (error, _details) => {
            if (captureTimeoutId) clearTimeout(captureTimeoutId);
            reject(new Error(error));
          },
          (progress, phase, message, extraData) => {
            // Reset timeout on any progress
            lastProgressTime = Date.now();
            const calculatedPercent = 40 + progress * 0.4; // 40-80%
            updateProgress(message, phase, calculatedPercent, extraData);
          },
        );
      });

      // Send start capture message to injected script
      console.log("📤 Sending START_CAPTURE to injected script");
      window.postMessage({ type: "START_CAPTURE" }, "*");

      // Wait for capture to complete
      const { schema, duration, nodeCount } = await capturePromise;

      console.log(`✅ Capture complete: ${nodeCount} nodes in ${duration}ms`);

      // Step 7: Send data to background for upload
      // Background will handle queuing and uploading to handoff server
      updateProgress("Sending to Figma...", "Upload", 85);

      // Use chunked transfer for large payloads to avoid message size limits
      await sendCaptureDataToBackground(
        schema,
        Date.now() - startTime,
        (progress) => {
          updateProgress("Sending to Figma...", "Upload", progress);
        },
      );

      // Show success on overlay (upload happens in background)
      overlay.animateSuccess();
      document.documentElement.setAttribute("data-capture-status", "complete");
      updateProgress(
        `Extraction complete! ${nodeCount} elements captured.`,
        "Complete",
        100,
      );

      // Hide overlay after success animation
      overlay.hide(2500);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.error("❌ Capture failed:", errorMessage);

      document.documentElement.setAttribute("data-capture-status", "error");
      document.documentElement.setAttribute("data-capture-error", errorMessage);
      overlay.animateError(errorMessage);

      // Notify background of error
      await sendMessageToBackground({
        type: "CAPTURE_ERROR",
        error: errorMessage,
        duration: Date.now() - startTime,
      }).catch(() => {});

      overlay.hide(3000);
    } finally {
      // Cleanup
      if (cleanupMessageListener) {
        cleanupMessageListener();
      }

      console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
      console.log(
        `⏱️ Total capture time: ${((Date.now() - startTime) / 1000).toFixed(2)}s`,
      );
      console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    }
  }

  // ============================================================================
  // MESSAGE LISTENER FROM BACKGROUND/POPUP
  // ============================================================================

  const runtimeMessageHandler = (
    message: { type: string; [key: string]: unknown },
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response?: unknown) => void,
  ): boolean => {
    console.log("📨 Received message from background:", message.type);

    if (message.type === "START_CAPTURE" || message.type === "start-capture") {
      console.log("🚀 Capture triggered from background/popup");

      // Acknowledge immediately
      sendResponse({ started: true });

      // Run capture asynchronously
      performCapture().catch((error) => {
        console.error("❌ Capture orchestration failed:", error);
      });

      return true; // Keep message channel open
    }

    if (message.type === "PING") {
      sendResponse({ pong: true, timestamp: Date.now() });
      return true;
    }

    return false;
  };

  chrome.runtime.onMessage.addListener(runtimeMessageHandler);
  activeListeners.push({
    target: chrome.runtime.onMessage as unknown as EventTarget,
    type: "message",
    listener:
      runtimeMessageHandler as unknown as EventListenerOrEventListenerObject,
  });

  // ============================================================================
  // WINDOW MESSAGE LISTENER FROM PUPPETEER/EXTERNAL
  // ============================================================================

  const windowMessageHandler = (event: MessageEvent) => {
    // Debug: Log all START_CAPTURE_TEST messages
    if (event.data?.type === "START_CAPTURE_TEST") {
      console.log(
        "🔍 [content] Saw START_CAPTURE_TEST. source===window?",
        event.source === window,
      );
    }

    // Only accept messages from our window (except for automation triggers which might cross worlds)
    if (event.source !== window && event.data?.type !== "START_CAPTURE_TEST")
      return;

    if (
      event.data?.type === "START_CAPTURE_TEST" ||
      event.data?.type === "START_CAPTURE_AUTOMATION"
    ) {
      console.log("🚀 Capture triggered from window message (Automation)");
      performCapture().catch((error) => {
        console.error("❌ Capture orchestration failed:", error);
      });
    }
  };
  window.addEventListener("message", windowMessageHandler);
  activeListeners.push({
    target: window,
    type: "message",
    listener: windowMessageHandler,
  });

  // ============================================================================
  // CLEANUP ON UNLOAD
  // ============================================================================

  const unloadHandler = () => {
    console.log("🧹 Cleaning up content script resources...");
    overlay.hide();

    // Note: Chrome runtime listeners are automatically cleaned up
    // but we log for debugging purposes
    console.log(`🧹 Removed ${activeListeners.length} active listeners`);
  };

  window.addEventListener("beforeunload", unloadHandler);

  console.log("✅ Content script initialization complete");
}
