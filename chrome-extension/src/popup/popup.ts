import { SmartSkeleton, LayoutPreviewBlock } from "./smart-skeleton";
import { ThreeSkeleton } from "./threejs-skeleton";

import type { WebToFigmaSchema, ValidationIssue } from "../../../shared/schema";

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

/** Validation report structure from asset completeness checks */
interface ValidationReport {
  valid: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  stats: {
    totalNodes: number;
    validNodes: number;
    invalidNodes: number;
  };
}

/**
 * Captured data structure - can be single or multi-viewport capture.
 * Uses index signature for flexibility with legacy/extended properties.
 */
interface CapturedDataWithMeta {
  // Core schema properties (single viewport)
  root?: WebToFigmaSchema["root"];
  tree?: WebToFigmaSchema["root"]; // Legacy alias for root
  metadata?: WebToFigmaSchema["metadata"];
  assets?: WebToFigmaSchema["assets"];
  screenshot?: string;
  timestamp?: number;
  url?: string;
  viewport?: { width: number; height: number };
  // Multi-viewport properties
  multiViewport?: boolean;
  captures?: Array<{
    data?: { tree?: WebToFigmaSchema["root"]; [key: string]: unknown };
    tree?: WebToFigmaSchema["root"];
    [key: string]: unknown;
  }>;
  // Allow additional properties from schema extensions
  [key: string]: unknown;
}

// ============================================================================
// DETACHED WINDOW SUPPORT
// ============================================================================

/**
 * Check if we're running in a popup context (vs detached window)
 * Popups have specific characteristics we can detect
 */
function isRunningAsPopup(): boolean {
  // Check URL parameters for detached flag
  const params = new URLSearchParams(window.location.search);
  if (params.get("detached") === "true") {
    return false;
  }

  // Check if window was opened as a popup (has opener and specific size)
  // Popup windows are typically small and have no window features
  const isSmallWindow = window.innerWidth <= 400 && window.innerHeight <= 700;
  const hasPopupViews = typeof chrome.extension?.getViews === "function";

  if (hasPopupViews) {
    const popupViews = chrome.extension.getViews({ type: "popup" });
    return popupViews.includes(window);
  }

  // Fallback: assume popup if small window without detached param
  return isSmallWindow && !params.get("detached");
}

// Flag to track if we're in detached mode
const isDetached = !isRunningAsPopup();
console.log("🪟 [POPUP] Running as:", isDetached ? "detached window" : "popup");

let capturedData: CapturedDataWithMeta | null = null;
let validationReport: ValidationReport | null = null;
let previewWithOverlay: string | null = null;
let originalScreenshot: string | null = null;
let showingOverlay = false;

// Button elements
const captureBtn = document.getElementById(
  "capture-btn",
) as HTMLButtonElement | null;
const downloadBtn = document.getElementById(
  "download-btn",
) as HTMLButtonElement | null;
const sendToFigmaBtn = document.getElementById(
  "send-to-figma-btn",
) as HTMLButtonElement | null;

// Removed buttons in new UI
const captureDownloadBtn = document.getElementById(
  "capture-download-btn",
) as HTMLButtonElement | null;
const captureRemoteBtn = document.getElementById(
  "capture-remote-btn",
) as HTMLButtonElement | null;
// Status element removed from UI, redirecting updates to console
const statusEl = {
  set textContent(value: string | null) {
    if (value) console.log(`[Status]: ${value}`);
  },
} as HTMLDivElement;
const screenshotImg = document.getElementById("screenshot") as HTMLImageElement;
const screenshotContainer = document.getElementById(
  "screenshot-container",
) as HTMLDivElement;
const statsEl = document.getElementById("stats") as HTMLDivElement;
const actionsEl = document.getElementById("actions") as HTMLDivElement;
const statElements = document.getElementById(
  "stat-elements",
) as HTMLSpanElement;
const statSize = document.getElementById("stat-size") as HTMLSpanElement;
const handoffStatusEl = document.getElementById(
  "handoff-status",
) as HTMLDivElement;
const previewCard = document.getElementById("preview-card") as HTMLDivElement;
const previewTitleEl = document.getElementById(
  "preview-title",
) as HTMLSpanElement;
const previewUrlEl = document.getElementById("preview-url") as HTMLSpanElement;
const previewTimestampEl = document.getElementById(
  "preview-timestamp",
) as HTMLSpanElement;
const openPreviewBtn = document.getElementById(
  "open-preview-btn",
) as HTMLButtonElement;
const toggleOverlayBtn = document.getElementById(
  "toggle-overlay-btn",
) as HTMLButtonElement;
const validationSummary = document.getElementById(
  "validation-summary",
) as HTMLDivElement;
const validationStatus = document.getElementById(
  "validation-status",
) as HTMLSpanElement;
const validationDetails = document.getElementById(
  "validation-details",
) as HTMLSpanElement;
const serverIndicator = createIndicator("server");
const pluginIndicator = createIndicator("plugin");
const transferIndicator = createIndicator("transfer");
const defaultCaptureLabel =
  captureBtn?.textContent || "📸 Capture & Send to Figma";
const defaultSendBtnLabel = sendToFigmaBtn?.textContent || "🚀 Send to Figma";

// Progress elements
const progressSection = document.getElementById(
  "progress-section",
) as HTMLDivElement;
const progressPhaseEl = document.getElementById(
  "progress-phase",
) as HTMLSpanElement;
const progressPercentEl = document.getElementById(
  "progress-percent-text",
) as HTMLSpanElement;
const progressBar = document.getElementById(
  "animated-progress-bar",
) as HTMLDivElement;
const progressMessageEl = document.getElementById(
  "progress-message",
) as HTMLDivElement;

type IndicatorState = "idle" | "connected" | "warning" | "disconnected";
type TransferState = "idle" | "pending" | "delivered" | "error";

interface ConnectionIndicator {
  dot: HTMLSpanElement;
  detail: HTMLSpanElement;
}

interface ViewportSelection {
  name: string;
  width?: number;
  height?: number;
  deviceScaleFactor?: number;
}

interface HandoffTelemetry {
  queueLength?: number;
  lastExtensionPingAt?: number | null;
  lastExtensionTransferAt?: number | null;
  lastPluginPollAt?: number | null;
  lastPluginDeliveryAt?: number | null;
  lastQueuedJobId?: string | null;
  lastDeliveredJobId?: string | null;
}

interface BackgroundHandoffState {
  status: "idle" | "queued" | "sending" | "success" | "error";
  trigger?: "auto" | "manual" | null;
  lastAttemptAt?: number | null;
  lastSuccessAt?: number | null;
  error?: string | null;
  pendingCount?: number;
  nextRetryAt?: number | null;
}

// Layout preview data for skeleton animation

interface LayoutPreviewData {
  viewport: { width: number; height: number };
  page: { width: number; height: number };
  blocks: LayoutPreviewBlock[];
}

// Store layout preview for skeleton rendering
// Store layout preview for skeleton rendering
let storedLayoutPreview: LayoutPreviewData | null = null;
let smartSkeleton: SmartSkeleton | null = null;
let threeSkeleton: ThreeSkeleton | null = null;
// ScannerAnimation removed

let healthInterval: number | null = null;
let lastTelemetryTransferAt: number | null = null;
let currentTransferState: TransferState = "idle";
let captureReady = false;
let hasAutoDownloaded = false; // Prevent duplicate auto-downloads
let currentCaptureMode: "send" | "download" = "send";
let extractionTimeoutId: number | null = null;
let lastHandoffState: BackgroundHandoffState = {
  status: "idle",
  trigger: null,
  lastAttemptAt: null,
  lastSuccessAt: null,
  error: null,
  pendingCount: 0,
  nextRetryAt: null,
};

// Page preview elements
const pagePreviewImg = document.getElementById(
  "page-preview-img",
) as HTMLImageElement;
const pagePreviewPlaceholder = document.getElementById(
  "page-preview-placeholder",
) as HTMLDivElement;
const pagePreviewUrl = document.getElementById(
  "page-preview-url",
) as HTMLSpanElement;
const pagePreviewStatus = document.getElementById(
  "page-preview-status",
) as HTMLSpanElement;

// Viewport dropdown elements
const viewportDropdownBtn = document.getElementById("viewport-dropdown-btn");
const viewportPopover = document.getElementById("viewport-popover");
const selectedViewportsLabel = document.getElementById(
  "selected-viewports-label",
);

console.log("🎨 Popup loaded");
startConnectionMonitor();
updateTransferIndicator("idle", "Idle");
applyHandoffState(lastHandoffState);
void initializeHandoffState();
void loadPagePreview();
updateViewportLabel();

// Viewport Dropdown Toggle
if (viewportDropdownBtn && viewportPopover) {
  viewportDropdownBtn.addEventListener("click", () => {
    viewportPopover.classList.toggle("hidden");
  });

  // Close when clicking outside
  document.addEventListener("click", (e) => {
    if (
      !viewportDropdownBtn.contains(e.target as Node) &&
      !viewportPopover.contains(e.target as Node)
    ) {
      viewportPopover.classList.add("hidden");
    }
  });
}

// Update label when checkboxes change
const viewportCheckboxes = document.querySelectorAll(
  '.viewport-checkbox-item input[type="checkbox"]',
);
viewportCheckboxes.forEach((cb) => {
  cb.addEventListener("change", updateViewportLabel);
});

function updateViewportLabel() {
  if (!selectedViewportsLabel) return;
  const checked = document.querySelectorAll(
    '.viewport-checkbox-item input[type="checkbox"]:checked',
  );
  if (checked.length === 0) {
    selectedViewportsLabel.textContent = "Select viewports";
  } else if (checked.length === 3) {
    selectedViewportsLabel.textContent = "All Viewports";
  } else {
    const names = Array.from(checked).map((c) => (c as HTMLInputElement).value);
    selectedViewportsLabel.textContent = names
      .map((n) => n.charAt(0).toUpperCase() + n.slice(1))
      .join(", ");
  }
}

// ============================================================================
// PAGE INFOBAR & QUEUE
// ============================================================================
async function loadPagePreview() {
  try {
    const [activeTab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (!activeTab?.id || !activeTab.url) {
      if (pagePreviewUrl) pagePreviewUrl.textContent = "No active tab";
      return;
    }

    // Show URL
    if (pagePreviewUrl) {
      try {
        const url = new URL(activeTab.url);
        pagePreviewUrl.textContent = url.hostname;
      } catch {
        pagePreviewUrl.textContent = activeTab.url.slice(0, 30);
      }
    }

    // Request screenshot from background
    chrome.runtime.sendMessage({ type: "REQUEST_EARLY_SCREENSHOT" }, (res) => {
      if (chrome.runtime.lastError) {
        console.warn("⚠️ Preview screenshot error:", chrome.runtime.lastError);
        return;
      }
      if (res?.success && res.screenshot) {
        if (pagePreviewImg) {
          pagePreviewImg.src = res.screenshot;
          pagePreviewImg.classList.add("loaded");
        }
        if (pagePreviewPlaceholder) {
          pagePreviewPlaceholder.style.display = "none";
        }
        // Auto-add current page to queue
        addPageToQueue(
          activeTab.url!,
          res.screenshot,
          activeTab.title || "Page",
        );
      }
    });
  } catch (error) {
    console.warn("Failed to load page info:", error);
  }
}

// ============================================================================
// PAGE QUEUE SIDEBAR
// ============================================================================
interface PageQueueItem {
  id: string;
  url: string;
  title: string;
  thumbnail: string;
  selected: boolean;
}

const pageQueue: PageQueueItem[] = [];
const pageQueueContainer = document.getElementById(
  "page-queue",
) as HTMLDivElement;
const addPageBtn = document.getElementById("add-page-btn") as HTMLButtonElement;
const clearAllBtn = document.getElementById(
  "clear-all-btn",
) as HTMLButtonElement;

function addPageToQueue(url: string, thumbnail: string, title: string) {
  // Check if page already in queue
  if (pageQueue.some((p) => p.url === url)) {
    console.log("Page already in queue:", url);
    return;
  }

  const item: PageQueueItem = {
    id: `page-${Date.now()}`,
    url,
    title,
    thumbnail,
    selected: true, // Default to selected
  };
  pageQueue.push(item);
  renderPageQueue();
  console.log("📄 Added page to queue:", title);
}

function removePageFromQueue(id: string) {
  const index = pageQueue.findIndex((p) => p.id === id);
  if (index >= 0) {
    pageQueue.splice(index, 1);
    renderPageQueue();
  }
}

function togglePageSelection(id: string) {
  const item = pageQueue.find((p) => p.id === id);
  if (item) {
    item.selected = !item.selected;
    renderPageQueue();
  }
}

function renderPageQueue() {
  if (!pageQueueContainer) return;

  pageQueueContainer.innerHTML = "";

  pageQueue.forEach((item, index) => {
    const thumb = document.createElement("div");
    thumb.className = `page-thumb ${item.selected ? "selected" : ""}`;
    thumb.title = item.title;

    // Create thumbnail structure
    thumb.innerHTML = `
      <img src="${item.thumbnail}" alt="${item.title}" />
      <span class="page-thumb-badge">${index + 1}</span>
      ${item.selected ? '<span class="page-thumb-indicator"></span>' : ""}
      <button class="page-thumb-remove" data-id="${item.id}" title="Remove">×</button>
    `;

    // Toggle selection on thumbnail click (but not on remove button)
    thumb.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      if (!target.classList.contains("page-thumb-remove")) {
        togglePageSelection(item.id);
      }
    });

    // Remove button handler
    const removeBtn = thumb.querySelector(".page-thumb-remove");
    if (removeBtn) {
      removeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        removePageFromQueue(item.id);
      });
    }

    pageQueueContainer.appendChild(thumb);
  });

  // Update capture button text with page count
  updateCaptureButtonText();
}

function clearAllPages() {
  pageQueue.length = 0;
  renderPageQueue();
  console.log("🗑️ Cleared all pages from queue");
}

function updateCaptureButtonText() {
  if (!captureBtn) return;

  const selectedCount = pageQueue.filter((p) => p.selected).length;

  if (selectedCount === 0) {
    captureBtn.textContent = "Capture Page";
  } else if (selectedCount === 1) {
    captureBtn.textContent = "Capture 1 Page";
  } else {
    captureBtn.textContent = `Capture ${selectedCount} Pages`;
  }
}

// Clear all button
if (clearAllBtn) {
  clearAllBtn.addEventListener("click", () => {
    if (pageQueue.length > 0) {
      const confirmed = confirm(
        `Remove all ${pageQueue.length} pages from queue?`,
      );
      if (confirmed) {
        clearAllPages();
      }
    }
  });
}

// Add current page button
if (addPageBtn) {
  addPageBtn.addEventListener("click", async () => {
    try {
      const [activeTab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      if (!activeTab?.url) return;

      chrome.runtime.sendMessage(
        { type: "REQUEST_EARLY_SCREENSHOT" },
        (res) => {
          if (res?.success && res.screenshot) {
            addPageToQueue(
              activeTab.url!,
              res.screenshot,
              activeTab.title || "Page",
            );
          }
        },
      );
    } catch (error) {
      console.warn("Failed to add page:", error);
    }
  });
}

// ============================================================================
// GLOWING BORDER EFFECT - Pointer Tracking
// ============================================================================
const containerEl = document.querySelector(".container") as HTMLElement;

if (containerEl) {
  const centerOfElement = (el: HTMLElement): [number, number] => {
    const { width, height } = el.getBoundingClientRect();
    return [width / 2, height / 2];
  };

  const pointerPositionRelativeToElement = (el: HTMLElement, e: MouseEvent) => {
    const { left, top, width, height } = el.getBoundingClientRect();
    const x = e.clientX - left;
    const y = e.clientY - top;
    const px = Math.max(0, Math.min(100, (100 / width) * x));
    const py = Math.max(0, Math.min(100, (100 / height) * y));
    return {
      pixels: [x, y] as [number, number],
      percent: [px, py] as [number, number],
    };
  };

  const distanceFromCenter = (
    el: HTMLElement,
    x: number,
    y: number,
  ): [number, number] => {
    const [cx, cy] = centerOfElement(el);
    return [x - cx, y - cy];
  };

  const angleFromPointerEvent = (dx: number, dy: number): number => {
    if (dx === 0 && dy === 0) return 0;
    let angleRadians = Math.atan2(dy, dx);
    let angleDegrees = angleRadians * (180 / Math.PI) + 90;
    if (angleDegrees < 0) angleDegrees += 360;
    return angleDegrees;
  };

  const closenessToEdge = (el: HTMLElement, x: number, y: number): number => {
    const [cx, cy] = centerOfElement(el);
    const [dx, dy] = distanceFromCenter(el, x, y);
    let k_x = Infinity;
    let k_y = Infinity;
    if (dx !== 0) k_x = cx / Math.abs(dx);
    if (dy !== 0) k_y = cy / Math.abs(dy);
    return Math.max(0, Math.min(1, 1 / Math.min(k_x, k_y)));
  };

  const updateGlow = (e: MouseEvent) => {
    const position = pointerPositionRelativeToElement(containerEl, e);
    const [px, py] = position.pixels;
    const [perx, pery] = position.percent;
    const [dx, dy] = distanceFromCenter(containerEl, px, py);
    const edge = closenessToEdge(containerEl, px, py);
    const angle = angleFromPointerEvent(dx, dy);

    containerEl.style.setProperty("--pointer-x", `${perx.toFixed(1)}%`);
    containerEl.style.setProperty("--pointer-y", `${pery.toFixed(1)}%`);
    containerEl.style.setProperty("--pointer-deg", `${angle.toFixed(1)}deg`);
    containerEl.style.setProperty("--pointer-d", `${(edge * 100).toFixed(1)}`);
  };

  containerEl.addEventListener("pointermove", updateGlow);
  console.log("✨ Glowing border effect initialized");
}

if (captureBtn) {
  captureBtn.addEventListener("click", () => {
    void startCapture("send");
  });
}

// These buttons are removed in the new UI, check for existence before adding listeners
if (captureDownloadBtn) {
  captureDownloadBtn.addEventListener("click", () => {
    void startCapture("download");
  });
}

if (captureRemoteBtn) {
  captureRemoteBtn.addEventListener("click", () => {
    void startRemoteCapture();
  });
}

async function startCapture(mode: "send" | "download" = "send") {
  console.log(
    "🔵 Capture requested",
    mode === "download" ? "(download only)" : "(auto-send enabled)",
  );
  currentCaptureMode = mode;

  const selectedViewports = getSelectedViewports();
  if (selectedViewports.length === 0) {
    statusEl.textContent = "⚠️ Please select at least one viewport";
    return;
  }

  // IMMEDIATE UI UPDATE: Show active state and progress UI before any async work
  captureReady = false;
  hasAutoDownloaded = false;
  applyHandoffState(lastHandoffState);
  setCaptureButtonLoading(true);

  // Set active state on container
  const container = document.querySelector(".container");
  container?.classList.add("capture-active");
  container?.classList.remove("capture-error");

  // Show status message
  const statusPrefix = `🔄 Capturing ${selectedViewports.length} viewport${
    selectedViewports.length > 1 ? "s" : ""
  }...`;
  statusEl.textContent =
    mode === "download"
      ? `${statusPrefix} JSON will download when complete.`
      : `${statusPrefix} Sending to Figma automatically when done.`;

  // Hide other UI elements
  handoffStatusEl?.classList.add("hidden");
  previewCard?.classList.add("hidden");
  screenshotContainer.classList.add("hidden");
  previewUrlEl.textContent = "";
  previewTimestampEl.textContent = "";
  openPreviewBtn.disabled = true;
  updateTransferIndicator("pending", "Capturing page…");

  // Reset and SHOW progress UI immediately (skeleton + progress bar)
  resetProgressUI();

  // Request early screenshot for 3D animation
  // Must be done BEFORE START_CAPTURE to avoid capturing the progress overlay
  try {
    console.log("📸 Requesting early screenshot...");
    await new Promise<void>((resolve) => {
      chrome.runtime.sendMessage(
        { type: "REQUEST_EARLY_SCREENSHOT" },
        (res) => {
          if (chrome.runtime.lastError) {
            console.warn(
              "⚠️ Early screenshot error:",
              chrome.runtime.lastError,
            );
          }
          if (res?.success && res.screenshot && threeSkeleton) {
            console.log(
              "📸 Early screenshot received, loading into 3D skeleton",
            );
            originalScreenshot = res.screenshot;
            threeSkeleton.loadScreenshot(res.screenshot);
          }
          resolve(); // Continue regardless of success/fail to avoid hanging
        },
      );
    });
  } catch (error) {
    console.warn("⚠️ Early screenshot request exception:", error);
  }

  // Capture directly from popup - no detaching

  // Capture directly from popup - no detaching

  // Target URL input removed - always capture current tab
  const targetUrlRaw = "";

  try {
    await chrome.runtime.sendMessage({ type: "SET_CAPTURE_MODE", mode });
  } catch (error) {
    console.warn("Failed to set capture mode:", error);
  }

  try {
    const captureTabId = await resolveCaptureTabId(targetUrlRaw);
    console.log(
      "📍 Capture tab ready:",
      captureTabId,
      targetUrlRaw || "active tab",
    );

    console.log(
      "📤 Sending START_CAPTURE to background script for tab:",
      captureTabId,
    );

    chrome.runtime.sendMessage(
      {
        type: "START_CAPTURE",
        tabId: captureTabId,
        viewports: selectedViewports,
        allowNavigation: false,
      },
      (response) => {
        console.log("📥 Response from background script:", response);
        if (!response || response.ok === false) {
          const error =
            response?.error || "Background script failed to start capture";
          console.error("❌ Capture failed to start:", error);
          statusEl.textContent = "❌ Failed: " + error;
          setCaptureButtonLoading(false);
          updateTransferIndicator("error", "Capture failed");
          progressSection.classList.add("hidden");
        } else {
          // Pickle Rick Fix: Update progress to 2% to confirm background ack
          if (progressPercentEl) progressPercentEl.textContent = "2%";
          if (progressBar) progressBar.style.width = "2%";
          if (progressMessageEl)
            progressMessageEl.textContent = "Capture started...";
        }
      },
    );
  } catch (error) {
    console.error("❌ Capture error:", error);
    statusEl.textContent =
      error instanceof Error
        ? `❌ Failed: ${error.message}`
        : "❌ Failed to capture";
    updateTransferIndicator("error", "Capture failed");
    setCaptureButtonLoading(false);

    // Clear extraction timeout and hide progress on error
    clearExtractionTimeout();
    progressSection.classList.add("hidden");
  }
}

async function startRemoteCapture() {
  console.log("☁️ Remote capture requested (Playwright/Puppeteer pipeline)");
  statusEl.textContent = "☁️ Preparing remote capture...";
  setCaptureButtonLoading(true);
  handoffStatusEl?.classList.add("hidden");
  previewCard?.classList.add("hidden");
  screenshotContainer.classList.add("hidden");
  actionsEl.classList.add("hidden");

  try {
    // Target URL input removed - always use current tab
    const manualUrl = "";
    const [activeTab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    const fallbackUrl = activeTab?.url || "";
    const targetUrl = manualUrl || fallbackUrl;

    if (!targetUrl) {
      throw new Error("No URL available to capture");
    }
    if (isRestrictedUrl(targetUrl)) {
      throw new Error("Cannot capture internal browser pages");
    }

    statusEl.textContent = `☁️ Server capturing ${targetUrl}...`;

    const response = await chrome.runtime.sendMessage({
      type: "REMOTE_CAPTURE_REQUEST",
      targetUrl,
    });

    if (!response?.ok || !response.data) {
      throw new Error(response?.error || "Remote capture failed");
    }

    capturedData = response.data;
    validationReport = response.validationReport;
    previewWithOverlay = response.previewWithOverlay;
    originalScreenshot = capturedData.screenshot || null;
    showingOverlay = false;
    captureReady = true;

    statusEl.textContent =
      "✅ Server capture complete! Ready to download or send.";
    actionsEl.classList.remove("hidden");
    downloadBtn.disabled = false;
    setCaptureButtonLoading(false);
    updateTransferIndicator("idle", "Ready to send");
  } catch (error) {
    const rawMessage =
      error instanceof Error ? error.message : "Remote capture failed";
    let hint = "";
    if (/Failed to fetch|NetworkError/i.test(rawMessage)) {
      hint = "Is the handoff server running on http://127.0.0.1:4411 ?";
    } else if (/injected script not built/i.test(rawMessage)) {
      hint =
        "Run `cd chrome-extension && npm run build` before starting the server.";
    }
    console.error("Remote capture failed:", error);
    statusEl.textContent = `❌ ${rawMessage}${hint ? ` — ${hint}` : ""}`;
    setCaptureButtonLoading(false);
    updateTransferIndicator("error", "Remote capture failed");
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log("📨 Popup received message:", message.type);

  if (message.type === "CAPTURE_PROGRESS") {
    // Update status with viewport progress
    const { status, current, total, viewport } = message;
    const safeStatus = status || "Processing...";

    if (current && total) {
      statusEl.textContent = `🔄 [${current}/${total}] ${safeStatus}`;

      // Update transfer indicator with more details
      const progressPercent = Math.round((current / total) * 100);
      updateTransferIndicator(
        "pending",
        `${viewport || "Viewport"} ${progressPercent}%`,
      );
    } else {
      statusEl.textContent = `🔄 ${safeStatus}`;
    }
  }

  // LAYOUT_PREVIEW: Store early layout data for skeleton animation
  if (message.type === "LAYOUT_PREVIEW") {
    console.log(
      "📐 [POPUP] Received LAYOUT_PREVIEW:",
      message.blocks?.length,
      "blocks",
    );
    console.log("📐 [POPUP] LAYOUT_PREVIEW viewport:", message.viewport);
    storedLayoutPreview = {
      viewport: message.viewport,
      page: message.page,
      blocks: message.blocks || [],
    };

    // Render 3D skeleton with layout blocks
    if (threeSkeleton && storedLayoutPreview) {
      // If we have an early screenshot, load it for slicing
      if (originalScreenshot) {
        threeSkeleton.loadScreenshot(originalScreenshot).then(() => {
          threeSkeleton!.render(
            storedLayoutPreview!.blocks,
            storedLayoutPreview!.viewport,
            storedLayoutPreview!.page,
          );
        });
      } else {
        // Render without screenshot (procedural placeholders)
        threeSkeleton.render(
          storedLayoutPreview.blocks,
          storedLayoutPreview.viewport,
          storedLayoutPreview.page,
        );
      }
      // Reveal initial set
      threeSkeleton.reveal(30);
    }
  }

  if (message.type === "EXTRACTION_PROGRESS") {
    // Show progress section
    progressSection.classList.remove("hidden");

    // Update animated progress bar and phase
    const { phase, message: progressMessage, percent, stats } = message;
    progressPhaseEl.textContent = phase.replace(/-/g, " ");
    if (progressPercentEl)
      progressPercentEl.textContent = `${Math.round(percent)}%`;
    // Update the animated progress bar width
    if (progressBar) progressBar.style.width = `${Math.round(percent)}%`;
    progressMessageEl.textContent = progressMessage || "";

    // Progressive Animation update
    if (threeSkeleton && typeof percent === "number") {
      threeSkeleton.reveal(percent);
      threeSkeleton.style(percent);
    }

    // Hide progress section when complete
    if (phase === "complete") {
      setTimeout(() => {
        progressSection.classList.add("hidden");
      }, 2000);
    }

    // Reset extraction timeout on each progress update
    resetExtractionTimeout();
  }

  if (message.type === "CAPTURE_COMPLETE") {
    // CRITICAL FIX: Unwrap schema from wrapper if present
    // Background returns { schema: {...}, screenshot: "..." } but we need capturedData to be the schema itself
    // for stats logic and manual download structure to be correct.
    if (
      message.data?.schema &&
      (message.data.schema.multiViewport || message.data.schema.root)
    ) {
      capturedData = message.data.schema;
      originalScreenshot = message.data.screenshot;
    } else {
      capturedData = message.data;
      originalScreenshot = capturedData?.screenshot;
    }

    validationReport = message.validationReport;
    previewWithOverlay = message.previewWithOverlay;
    // originalScreenshot is already set above
    showingOverlay = false;

    const dataSizeKB = message.dataSizeKB || "0";
    const completionMessage = `✅ Capture complete! (${dataSizeKB} KB)`;

    statusEl.textContent = completionMessage;

    // Stop scanner animation if it was running

    // Clear extraction timeout since capture completed
    clearExtractionTimeout();

    // Hide progress section for chunked transfers (regular transfers hide it via EXTRACTION_PROGRESS)
    if (message.chunked) {
      setTimeout(() => {
        progressSection.classList.add("hidden");
      }, 1500);
    }

    // Keep capture button disabled until handoff completes
    if (captureBtn) {
      captureBtn.disabled = true;
      captureBtn.textContent = "⏳ Preparing handoff...";
    }

    // Show screenshot (original by default)
    if (originalScreenshot) {
      screenshotImg.src = originalScreenshot;
      screenshotContainer.classList.remove("hidden");
      previewCard.classList.remove("hidden");

      // Enable overlay toggle if we have it
      if (previewWithOverlay) {
        toggleOverlayBtn.disabled = false;
        toggleOverlayBtn.classList.remove("active");
      }
    } else if (message.chunked) {
      // For chunked transfers, screenshot isn't in the message - fetch from background
      console.log(
        "📸 Fetching screenshot for chunked transfer from background...",
      );
      chrome.runtime.sendMessage({ type: "GET_HANDOFF_STATE" }, (response) => {
        if (response?.ok && response.restoreState?.screenshot) {
          originalScreenshot = response.restoreState.screenshot;
          screenshotImg.src = originalScreenshot;
          screenshotContainer.classList.remove("hidden");
          previewCard.classList.remove("hidden");
          console.log("📸 Screenshot restored from background cache");

          // Also update threeSkeleton if available
          if (threeSkeleton) {
            threeSkeleton.showSnapshot(originalScreenshot);
          }
        } else {
          console.warn("⚠️ No screenshot available in background cache");
        }
      });
    }

    // Display validation summary
    if (validationReport) {
      displayValidationSummary(validationReport);
    }

    updatePreviewMeta(capturedData);

    // Show stats
    let count = 0;
    if (capturedData) {
      if (capturedData.multiViewport && capturedData.captures) {
        // Sum elements from all viewports
        for (const capture of capturedData.captures) {
          count += countElements(capture.data?.tree);
        }
      } else {
        count = countElements(capturedData.tree);
      }
    }
    statElements.textContent = count.toString();
    statSize.textContent = `${dataSizeKB} KB`;
    statsEl.classList.remove("hidden");

    captureReady = true;
    downloadBtn.disabled = false;
    actionsEl.classList.remove("hidden");

    if (currentCaptureMode === "download") {
      statusEl.textContent = `${completionMessage} Downloading JSON…`;
      if (!hasAutoDownloaded) {
        hasAutoDownloaded = true;
        downloadCapturedData(false);
      }
      updateTransferIndicator("idle", "Ready to send");
    } else {
      statusEl.innerHTML = `${completionMessage} <button id="success-download-btn" class="text-blue-400 hover:underline">Download JSON</button>`;

      const successDownloadBtn = document.getElementById(
        "success-download-btn",
      );
      if (successDownloadBtn) {
        successDownloadBtn.addEventListener("click", () => {
          downloadCapturedData(true);
        });
      }

      applyHandoffState(lastHandoffState);

      // SHOW MODAL for manual captures
      if (currentCaptureMode === "send") {
        // If handoff is already successful or idle (meaning just capture done), modal might wait for handoff
        // But usually CAPTURE_COMPLETE means we are ready to send or have sent.
        // If auto-send is enabled, we might want to wait for HANDOFF_STATUS_UPDATE "success"
        // to show "Sent to Figma".
        // Let's show it now if we are not waiting for handoff, OR if handoff is fast.
        // Actually, better to wait for HANDOFF_STATUS_UPDATE if we are auto-sending.
      }
    }
    // Update: We'll rely on HANDOFF_STATUS_UPDATE for the "Sent to Figma" modal
    // BUT for "Download Only" mode, show it immediately here.
    if (currentCaptureMode === "download") {
      showFinishedModal(false);
    }

    currentCaptureMode = "send";
  }

  if (message.type === "CAPTURE_DOWNLOAD_READY") {
    capturedData = message.data;
    validationReport = message.validationReport || null;
    previewWithOverlay = message.previewWithOverlay || null;
    originalScreenshot = capturedData?.screenshot || null;

    // Show snapshot on 3D skeleton
    if (originalScreenshot && threeSkeleton) {
      threeSkeleton.showSnapshot(originalScreenshot);
    }

    showingOverlay = false;

    const sizeKB = message.dataSizeKB || "0";
    statusEl.textContent = `✅ Capture complete! (${sizeKB} KB) Downloading JSON…`;

    // Stop scanner animation if it was running

    setCaptureButtonLoading(false);
    captureReady = true;
    actionsEl.classList.remove("hidden");
    downloadBtn.disabled = false;
    if (!hasAutoDownloaded) {
      hasAutoDownloaded = true;
      downloadCapturedData(false);
    }
    updateTransferIndicator("idle", "Ready to send");
    currentCaptureMode = "send";
  }

  applyHandoffState(
    message.state as BackgroundHandoffState,
    message.hasCapture,
  );

  // Trigger modal upon successful handoff
  if (message.state?.status === "success") {
    showFinishedModal(true);
  }

  if (message.type === "CAPTURE_SIZE_WARNING") {
    const { sizeKB, maxSizeKB } = message;
    statusEl.textContent = `⚠️ Large capture (${sizeKB}KB) - using chunked transfer...`;
    console.warn(
      `Capture size ${sizeKB}KB exceeds recommended ${maxSizeKB}KB limit`,
    );
  }

  if (message.type === "HANDOFF_STARTED") {
    /* smartSkeleton removed */
    // Keep active state
  }

  if (message.type === "HANDOFF_COMPLETE") {
    const container = document.querySelector(".container");
    container?.classList.remove("capture-active");
  }

  if (message.type === "CAPTURE_ERROR") {
    const container = document.querySelector(".container");
    container?.classList.remove("capture-active");
    container?.classList.add("capture-error");
  }

  sendResponse({ received: true });
});

sendToFigmaBtn.addEventListener("click", () => {
  void sendCapturedDataToFigma();
});

downloadBtn.addEventListener("click", () => {
  downloadCapturedData(true);
});

openPreviewBtn.addEventListener("click", () => {
  if (!capturedData) return;

  const targetUrl = capturedData.metadata?.url;
  if (targetUrl) {
    chrome.tabs.create({ url: targetUrl });
    return;
  }
});

// ============================================================================
// FINISHED MODAL LOGIC
// ============================================================================
const finishedModal = document.getElementById(
  "finished-modal",
) as HTMLDivElement;
const modalDownloadBtn = document.getElementById(
  "modal-download-btn",
) as HTMLButtonElement;
const modalCloseBtn = document.getElementById(
  "modal-close-btn",
) as HTMLButtonElement;
const finishedSubtitle = document.getElementById(
  "finished-subtitle",
) as HTMLParagraphElement;

if (modalDownloadBtn) {
  modalDownloadBtn.addEventListener("click", () => {
    downloadCapturedData(true);
  });
}

if (modalCloseBtn) {
  modalCloseBtn.addEventListener("click", () => {
    finishedModal.classList.add("hidden");
  });
}

function showFinishedModal(sentToFigma: boolean) {
  if (!finishedModal) return;

  if (sentToFigma) {
    finishedSubtitle.textContent = "Successfully sent to Figma";
    finishedSubtitle.style.color = "var(--text-sub)";
  } else {
    finishedSubtitle.textContent = "Ready to download";
    finishedSubtitle.style.color = "var(--text-muted)";
  }

  finishedModal.classList.remove("hidden");

  // Trigger confetti or sound effect here if desired
  console.log("🎉 Showing finished modal");
}

function countElements(node: any): number {
  if (!node) return 0;
  let count = 1;
  for (const child of node.children || []) {
    count += countElements(child);
  }
  return count;
}

function updatePreviewMeta(data: any) {
  const title = data?.metadata?.title || "Preview ready";
  const url = data?.metadata?.url || "";
  const timestamp = data?.metadata?.timestamp;
  const canOpen = Boolean(url || data?.screenshot);
  openPreviewBtn.disabled = !canOpen;

  previewTitleEl.textContent =
    title.length > 60 ? `${title.slice(0, 57)}…` : title;

  if (url) {
    previewUrlEl.textContent = url;
    previewUrlEl.title = url;
  } else {
    previewUrlEl.textContent = "";
    previewUrlEl.title = "";
  }

  if (timestamp) {
    try {
      const formatted = new Date(timestamp).toLocaleString();
      previewTimestampEl.textContent = formatted;
    } catch {
      previewTimestampEl.textContent = "";
    }
  } else {
    previewTimestampEl.textContent = "";
  }
}

function isRestrictedUrl(url: string | undefined): boolean {
  if (!url) return true;
  const lower = url.toLowerCase();
  return (
    lower.startsWith("chrome://") ||
    lower.startsWith("edge://") ||
    lower.startsWith("about:") ||
    lower.startsWith("devtools://") ||
    lower.startsWith("chrome-extension://")
  );
}

function normalizeTargetUrl(raw?: string | null): string {
  if (!raw) return "";
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }
  return `https://${trimmed}`;
}

function startConnectionMonitor() {
  if (healthInterval) return;
  runHealthCheck();
  healthInterval = window.setInterval(runHealthCheck, 5000);
}

async function runHealthCheck() {
  try {
    const response = await chrome.runtime.sendMessage({
      type: "HANDOFF_HEALTH_CHECK",
    });
    if (!response || !response.ok || !response.health) {
      throw new Error(response?.error || "No health payload");
    }

    const telemetry = (response.health.telemetry || {}) as HandoffTelemetry;
    updateServerIndicator(telemetry);
    updatePluginIndicator(telemetry);
    syncTransferIndicatorFromTelemetry(telemetry);
    clearHandoffErrorIfResolved();
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Health check failed";
    setIndicator(serverIndicator, "disconnected", message);
    showHandoffError(`Handoff server offline: ${message}`);
  }
}

function updateServerIndicator(telemetry: HandoffTelemetry) {
  const queueLabel =
    typeof telemetry.queueLength === "number"
      ? `${telemetry.queueLength} in queue`
      : "Queue ready";
  const pluginHeartbeat = telemetry.lastPluginPollAt
    ? ` • Plugin ${formatRelativeTime(telemetry.lastPluginPollAt)}`
    : "";
  setIndicator(
    serverIndicator,
    "connected",
    `${queueLabel}${pluginHeartbeat}`.trim(),
  );
}

function updatePluginIndicator(telemetry: HandoffTelemetry) {
  const lastSeen = telemetry.lastPluginPollAt;
  if (!lastSeen) {
    setIndicator(pluginIndicator, "warning", "Waiting for plugin heartbeat…");
    return;
  }

  const ageMs = Date.now() - lastSeen;
  if (ageMs < 7000) {
    setIndicator(
      pluginIndicator,
      "connected",
      `Heartbeat ${formatRelativeTime(lastSeen)}`,
    );
  } else if (ageMs < 30000) {
    setIndicator(
      pluginIndicator,
      "warning",
      `Last seen ${formatRelativeTime(lastSeen)}`,
    );
  } else {
    setIndicator(
      pluginIndicator,
      "disconnected",
      `No contact ${formatRelativeTime(lastSeen)}`,
    );
  }
}

function syncTransferIndicatorFromTelemetry(telemetry: HandoffTelemetry) {
  if (!telemetry.lastExtensionTransferAt) return;
  if (lastTelemetryTransferAt === telemetry.lastExtensionTransferAt) return;
  lastTelemetryTransferAt = telemetry.lastExtensionTransferAt;
  if (currentTransferState === "pending") return;
  updateTransferIndicator(
    "delivered",
    `Last handoff ${formatRelativeTime(telemetry.lastExtensionTransferAt)}`,
  );
}

function updateTransferIndicator(state: TransferState, detail: string) {
  let indicatorState: IndicatorState = "idle";
  switch (state) {
    case "pending":
      indicatorState = "warning";
      break;
    case "delivered":
      indicatorState = "connected";
      break;
    case "error":
      indicatorState = "disconnected";
      break;
    default:
      indicatorState = "idle";
  }
  currentTransferState = state;
  setIndicator(transferIndicator, indicatorState, detail);
}

function createIndicator(
  prefix: "server" | "plugin" | "transfer",
): ConnectionIndicator {
  const dot = document.getElementById(
    `${prefix}-connection-dot`,
  ) as HTMLSpanElement;
  const detail = document.getElementById(
    `${prefix}-connection-detail`,
  ) as HTMLSpanElement;
  return {
    dot,
    detail,
  };
}

function setIndicator(
  indicator: ConnectionIndicator,
  state: IndicatorState,
  detail: string,
) {
  if (!indicator?.dot || !indicator?.detail) return;
  indicator.dot.classList.remove(
    "idle",
    "connected",
    "warning",
    "disconnected",
  );
  indicator.dot.classList.add(state);
  indicator.detail.textContent = detail;
}

function formatRelativeTime(timestamp?: number | null): string {
  if (!timestamp) return "no signal";
  const diffMs = timestamp - Date.now();
  if (diffMs > 0) {
    const futureSeconds = Math.round(diffMs / 1000);
    if (futureSeconds < 1) return "in a moment";
    if (futureSeconds < 60) return `in ${futureSeconds}s`;
    const futureMinutes = Math.floor(futureSeconds / 60);
    if (futureMinutes < 60) return `in ${futureMinutes}m`;
    const futureHours = Math.floor(futureMinutes / 60);
    return `in ${futureHours}h`;
  }

  const diffSeconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (diffSeconds < 1) return "just now";
  if (diffSeconds < 60) return `${diffSeconds}s ago`;
  const minutes = Math.floor(diffSeconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

function clearHandoffErrorIfResolved() {
  if (!handoffStatusEl) return;
  if (handoffStatusEl.classList.contains("error")) {
    handoffStatusEl.textContent = "✅ Handoff server online";
    handoffStatusEl.className = "handoff-status success";
    setTimeout(() => handoffStatusEl.classList.add("hidden"), 1500);
  }
}

function showHandoffError(message: string) {
  if (!handoffStatusEl) return;
  handoffStatusEl.textContent = `⚠️ ${message}`;
  handoffStatusEl.className = "handoff-status error";
  handoffStatusEl.classList.remove("hidden");
}

// Toggle overlay button handler
toggleOverlayBtn.addEventListener("click", () => {
  if (!originalScreenshot || !previewWithOverlay) return;

  showingOverlay = !showingOverlay;

  if (showingOverlay) {
    screenshotImg.src = previewWithOverlay;
    toggleOverlayBtn.classList.add("active");
    toggleOverlayBtn.title = "Show original screenshot";
  } else {
    screenshotImg.src = originalScreenshot;
    toggleOverlayBtn.classList.remove("active");
    toggleOverlayBtn.title = "Show element overlay";
  }
});

// Display validation summary
function displayValidationSummary(report: any) {
  if (!report || !validationSummary) return;

  validationSummary.classList.remove("hidden");

  const statusText = report.valid
    ? "✅ Layout Valid"
    : "⚠️ Layout Issues Found";
  validationStatus.textContent = statusText;
  validationStatus.className = `validation-status ${
    report.valid ? "valid" : "invalid"
  }`;

  const errors = report.issues.filter(
    (i: any) => i.severity === "error",
  ).length;
  const warnings = report.issues.filter(
    (i: any) => i.severity === "warning",
  ).length;
  const info = report.issues.filter((i: any) => i.severity === "info").length;

  const parts = [];
  if (errors > 0) parts.push(`${errors} error${errors > 1 ? "s" : ""}`);
  if (warnings > 0) parts.push(`${warnings} warning${warnings > 1 ? "s" : ""}`);
  if (info > 0) parts.push(`${info} info`);

  if (parts.length > 0) {
    validationDetails.textContent =
      parts.join(", ") + ` • ${report.totalNodes} nodes validated`;
  } else {
    validationDetails.textContent = `All ${report.totalNodes} nodes passed validation`;
  }
}

function getSelectedViewports(): ViewportSelection[] {
  const viewports: ViewportSelection[] = [];
  const mobile = document.getElementById("viewport-mobile") as HTMLInputElement;
  const tablet = document.getElementById("viewport-tablet") as HTMLInputElement;
  const desktop = document.getElementById(
    "viewport-desktop",
  ) as HTMLInputElement;

  // DESKTOP FIRST (Requirement 1)
  if (desktop?.checked) {
    // Use dynamic desktop size detection - let content script auto-detect the actual screen size
    viewports.push({ name: "Desktop" }); // No hardcoded dimensions - content script will detect them
  }

  // TABLET SECOND (Requirement 2)
  if (tablet?.checked) {
    viewports.push({
      name: "Tablet",
      width: 768,
      height: 1024,
      deviceScaleFactor: 2,
    });
  }

  // MOBILE THIRD (Requirement 3)
  if (mobile?.checked) {
    viewports.push({
      name: "Mobile",
      width: 375,
      height: 812,
      deviceScaleFactor: 2,
    });
  }

  return viewports;
}

function setCaptureButtonLoading(isLoading: boolean) {
  if (!captureBtn) return;
  captureBtn.disabled = isLoading;

  // Toggle loading class and update text for clean button
  if (isLoading) {
    captureBtn.classList.add("loading");
    captureBtn.textContent = "Capturing...";
  } else {
    captureBtn.classList.remove("loading");
    captureBtn.textContent = "Capture Page";
  }

  // Handle other buttons in case they exist
  if (captureDownloadBtn) {
    captureDownloadBtn.disabled = isLoading;
    captureDownloadBtn.textContent = isLoading
      ? "⏳ Capturing..."
      : "📸⬇️ Capture & Download JSON";
  }
  if (captureRemoteBtn) {
    captureRemoteBtn.disabled = isLoading;
  }
}

function resetProgressUI() {
  // Show progress section and reset all progress indicators
  console.log("📊 [POPUP] resetProgressUI called");
  console.log("📊 [POPUP] progressSection exists:", !!progressSection);
  console.log(
    "📊 [POPUP] progressSection classList before:",
    progressSection?.classList?.toString(),
  );

  if (!progressSection) {
    console.error(
      "❌ [POPUP] progressSection is null! Check HTML id='progress-section'",
    );
    return;
  }

  progressSection.classList.remove("hidden");
  console.log(
    "📊 [POPUP] progressSection classList after:",
    progressSection.classList.toString(),
  );
  console.log(
    "📊 [POPUP] progressSection display:",
    window.getComputedStyle(progressSection).display,
  );

  // Start skeleton in loading mode
  // Start skeleton in loading mode
  // Start skeleton in loading mode
  const skeletonContainer = document.getElementById("skeleton-animation");

  // FAILSAFE: Explicitly remove hidden class immediately
  if (skeletonContainer) {
    console.log("🦴 [POPUP] Found skeleton container, forcing visible");
    skeletonContainer.classList.remove("hidden");
    // Force block display to override any potential inline styles or specific rules
    skeletonContainer.style.display = "block";
    skeletonContainer.setAttribute("aria-hidden", "false");

    // Also insure parent progress section is visible
    if (progressSection) progressSection.classList.remove("hidden");
  } else {
    console.error("❌ [POPUP] Skeleton container used for animation NOT FOUND");
  }

  if (skeletonContainer) {
    console.log("🎭 [POPUP] Initializing ThreeSkeleton for new capture");
    const threeContainer = document.getElementById("three-skeleton-canvas");
    if (threeContainer) {
      // Destroy existing instance if any
      if (threeSkeleton) {
        threeSkeleton.destroy();
        threeSkeleton = null;
      }
      // Create fresh instance
      threeSkeleton = new ThreeSkeleton({
        container: threeContainer,
        debug: true,
      });
      // Start animation immediately with placeholder blocks
      threeSkeleton.start();
    } else {
      console.error("❌ [POPUP] Three.js skeleton container not found");
    }
  }

  if (!threeSkeleton) {
    console.warn(
      "⚠️ [POPUP] Failed to initialize ThreeSkeleton - container not found?",
    );
  }

  progressPhaseEl.textContent = "Initializing...";
  if (progressPercentEl) progressPercentEl.textContent = "1%";
  // Reset animated progress bar to small initial width to show activity
  if (progressBar) progressBar.style.width = "5%";
  progressMessageEl.textContent = "Initializing capture...";

  // Clear any existing extraction timeout
  clearExtractionTimeout();
}

function resetExtractionTimeout() {
  clearExtractionTimeout();
  // TIMEOUT REMOVED: Wait indefinitely for capture process.
  // The background script and content script manage their own state.
}

function clearExtractionTimeout() {
  if (extractionTimeoutId !== null) {
    clearTimeout(extractionTimeoutId);
    extractionTimeoutId = null;
  }
}

async function resolveCaptureTabId(targetUrlRaw: string): Promise<number> {
  const trimmed = targetUrlRaw.trim();

  try {
    // 1. Check for tabId in URL parameter (used for automation and detached window)
    const urlParams = new URLSearchParams(window.location.search);
    // Check both 'tabId' (legacy/automation) and 'targetTabId' (detached window)
    const forcedTabId = urlParams.get("tabId") || urlParams.get("targetTabId");
    if (forcedTabId) {
      const tid = parseInt(forcedTabId, 10);
      if (!isNaN(tid) && tid > 0) {
        console.log(`🤖 [AUTOMATION] Using forced tabId from URL: ${tid}`);
        return tid;
      }
    }

    const activeTab = await getActiveContentTab();

    if (trimmed) {
      const normalized = normalizeUrl(trimmed);
      if (!normalized) {
        throw new Error("Please enter a valid URL (https://example.com).");
      }

      if (activeTab && typeof activeTab.id === "number") {
        const activeUrl = activeTab.url || "";
        if (
          !isRestrictedUrl(activeUrl) &&
          normalizeForComparison(activeUrl) ===
            normalizeForComparison(normalized)
        ) {
          if (activeTab.status !== "complete") {
            await waitForTabToLoad(activeTab.id);
          }
          return activeTab.id;
        }

        try {
          await chrome.tabs.update(activeTab.id, {
            url: normalized,
            active: true,
          });
          await waitForTabToLoad(activeTab.id);
          return activeTab.id;
        } catch (error) {
          console.warn(
            "Failed to update existing tab, creating a new one instead.",
            error,
          );
          // Continue to create new tab below
        }
      }

      // Create new tab with enhanced error handling
      try {
        const newTab = await chrome.tabs.create({
          url: normalized,
          active: true,
        });
        if (!newTab?.id) {
          throw new Error(
            "Failed to create tab - browser may have blocked the request",
          );
        }
        await waitForTabToLoad(newTab.id);
        return newTab.id;
      } catch (tabError) {
        throw new Error(
          `Failed to open target URL: ${
            tabError instanceof Error ? tabError.message : "Unknown error"
          }`,
        );
      }
    }

    // Handle case where no URL is provided
    if (!activeTab || typeof activeTab.id !== "number") {
      throw new Error("No open webpage found. Enter a URL above to capture.");
    }

    if (isRestrictedUrl(activeTab.url)) {
      const suggestions = [
        "Try opening a regular website like https://example.com",
        "Navigate to a non-restricted page in the active tab",
        "Enter a specific URL in the field above",
      ];
      throw new Error(
        `Cannot capture restricted pages (${
          activeTab.url?.split("://")[0]
        }://). ${suggestions[Math.floor(Math.random() * suggestions.length)]}`,
      );
    }

    if (activeTab.status !== "complete") {
      await waitForTabToLoad(activeTab.id);
    }

    return activeTab.id;
  } catch (error) {
    // Enhanced error context for debugging
    if (error instanceof Error) {
      throw new Error(`Tab resolution failed: ${error.message}`);
    }
    throw new Error(`Tab resolution failed: ${String(error)}`);
  }
}

function normalizeUrl(input: string): string | null {
  if (!input.trim()) return null;
  try {
    const withScheme = /^[a-zA-Z]+:\/\//.test(input.trim())
      ? input.trim()
      : `https://${input.trim()}`;
    const url = new URL(withScheme);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function normalizeForComparison(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    parsed.search = "";
    let path = parsed.pathname || "/";
    path = path.replace(/\/+$/, "/");
    return `${parsed.origin}${path}`;
  } catch {
    return url;
  }
}

function waitForTabToLoad(tabId: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let completed = false;
    const timeout = window.setTimeout(() => {
      if (completed) return;
      completed = true;
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error("Timed out waiting for page to load"));
    }, 45000);

    const listener = (
      updatedTabId: number,
      changeInfo: chrome.tabs.TabChangeInfo,
    ) => {
      if (completed) return;
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        completed = true;
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };

    chrome.tabs.onUpdated.addListener(listener);

    chrome.tabs
      .get(tabId)
      .then((tab) => {
        if (completed) return;
        if (tab.status === "complete") {
          completed = true;
          clearTimeout(timeout);
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      })
      .catch(() => {
        // Ignore lookup failures; rely on listener/timeout
      });
  });
}

async function getActiveContentTab(): Promise<chrome.tabs.Tab | null> {
  try {
    const window = await chrome.windows.getLastFocused({
      populate: true,
      windowTypes: ["normal"],
    });
    const activeTab = window?.tabs?.find((tab) => tab.active);
    if (activeTab) {
      return activeTab;
    }
  } catch (error) {
    console.warn("Failed to get last focused normal window:", error);
  }

  const [tab] = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true,
    windowType: "normal",
  });
  return tab || null;
}

async function sendCapturedDataToFigma(manualTriggered = true) {
  console.log(
    manualTriggered
      ? "🚀 Send to Figma clicked"
      : "🤖 Background resend requested",
  );

  // Error boundary wrapper
  const handleError = (error: unknown, context: string) => {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(`❌ Error in ${context}:`, error);
    statusEl.textContent = `❌ Failed to send: ${message}`;

    if (handoffStatusEl) {
      handoffStatusEl.textContent = `⚠️ Failed: ${message}`;
      handoffStatusEl.className = "handoff-status error";
      handoffStatusEl.classList.remove("hidden");
    }
    updateTransferIndicator("error", "Send failed");
  };

  try {
    // Validate captured data before sending
    if (!capturedData) {
      if (captureReady) {
        statusEl.textContent =
          "⏳ Fetching full capture data from background...";
        await fetchFullCapture();
      }
      if (!capturedData) {
        throw new Error("No capture data available to send");
      }
    }

    // Validate data size
    const dataSize = JSON.stringify(capturedData).length;
    const maxSize = 32 * 1024 * 1024; // 32MB limit

    if (dataSize > maxSize) {
      throw new Error(
        `Capture data too large: ${(dataSize / 1024 / 1024).toFixed(
          1,
        )}MB exceeds 32MB limit`,
      );
    }

    if (manualTriggered) {
      statusEl.textContent = "📡 Sending capture to Figma...";
    }

    const response = await chrome.runtime.sendMessage({
      type: "SEND_TO_HANDOFF",
      data: capturedData,
    });

    if (!response || !response.ok) {
      throw new Error(response?.error || "Failed to contact handoff server");
    }
  } catch (error) {
    handleError(error, "sendCapturedDataToFigma");
  }
}

async function downloadCapturedData(manualTrigger = false) {
  console.log("💾 Download requested", manualTrigger ? "(manual)" : "(auto)");
  if (!capturedData) {
    if (captureReady && manualTrigger) {
      statusEl.textContent = "⏳ Fetching full capture data from background...";
      await fetchFullCapture();
    }

    if (!capturedData) {
      if (manualTrigger) {
        statusEl.textContent = "⚠️ No capture is ready to download yet.";
      }
      return;
    }
  }

  try {
    if (manualTrigger) {
      statusEl.textContent = "💾 Preparing download…";
    }
    const serialized = JSON.stringify(capturedData);
    const blob = new Blob([serialized], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `capture-${Date.now()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to prepare download";
    console.error("Download failed:", error);
    statusEl.textContent = `❌ Download failed: ${message}`;
  }
}

async function fetchFullCapture(): Promise<void> {
  try {
    const response = await chrome.runtime.sendMessage({
      type: "GET_FULL_CAPTURE",
    });
    if (response?.ok && response.data) {
      // CRITICAL: mimic the unwrap logic we added to CAPTURE_COMPLETE
      if (
        response.data.schema &&
        (response.data.schema.multiViewport || response.data.schema.root)
      ) {
        capturedData = response.data.schema;
        originalScreenshot = response.data.screenshot;
      } else {
        capturedData = response.data;
        originalScreenshot = capturedData?.screenshot;
      }
    }
  } catch (err) {
    console.error("Failed to fetch full capture", err);
  }
}

async function initializeHandoffState() {
  try {
    // 1. Get high-level handoff state (server status, finished capture metadata)
    const handoffResponse = await chrome.runtime.sendMessage({
      type: "GET_HANDOFF_STATE",
    });

    if (handoffResponse?.ok && handoffResponse.state) {
      if (handoffResponse.hasCapture) {
        captureReady = true;
        actionsEl.classList.remove("hidden");

        // --- Restore UI from metadata (Finished State) ---
        if (handoffResponse.restoreState) {
          console.log("♻️ Restoring UI state from background metadata");
          const { screenshot, dataSizeKB, elementCount } =
            handoffResponse.restoreState;

          // Restore screenshot
          if (screenshot) {
            originalScreenshot = screenshot;
            screenshotImg.src = screenshot;
            screenshotContainer.classList.remove("hidden");
            previewCard.classList.remove("hidden");

            // If finished, show snapshot in 3D skeleton container too
            if (threeSkeleton) threeSkeleton.showSnapshot(screenshot);
          }

          // Restore Stats
          if (statElements)
            statElements.textContent = elementCount?.toString() || "0";
          if (statSize) statSize.textContent = `${dataSizeKB || 0} KB`;
          if (statsEl) statsEl.classList.remove("hidden");

          // Update status text
          statusEl.textContent = `✅ Capture complete! (Restored)`;

          // Allow download/send
          downloadBtn.disabled = false;
        }
      }
      applyHandoffState(
        handoffResponse.state as BackgroundHandoffState,
        handoffResponse.hasCapture,
      );
    }

    // 2. Get detailed in-progress capture state (Progress bar & Skeleton)
    const captureResponse = await chrome.runtime.sendMessage({
      type: "GET_CAPTURE_STATE",
    });

    if (captureResponse?.state) {
      const { isCapturing, progress, stage, statusMessage, layoutPreview } =
        captureResponse.state;

      console.log(
        `♻️ [POPUP] Restoring active capture state: capturing=${isCapturing}, progress=${progress}%`,
      );

      if (isCapturing) {
        // Ensure progress UI is visible
        resetProgressUI();

        // Restore progress bar
        if (progressBar) progressBar.style.width = `${progress}%`;
        if (progressPercentEl)
          progressPercentEl.textContent = `${Math.round(progress)}%`;
        if (progressPhaseEl) progressPhaseEl.textContent = stage;
        if (progressMessageEl) progressMessageEl.textContent = statusMessage;

        // Restore Skeleton if data is available
        if (layoutPreview && smartSkeleton) {
          console.log(
            "🦴 [POPUP] Restoring skeleton from persisted layout preview",
          );
          storedLayoutPreview = layoutPreview;
          smartSkeleton.render(layoutPreview.blocks, layoutPreview.viewport);
          smartSkeleton.reveal(progress);
          smartSkeleton.style(progress);
        }
      }
    }
  } catch (error) {
    console.warn("⚠️ Failed to initialize handoff state", error);
  }
}

function applyHandoffState(
  state: BackgroundHandoffState,
  hasCaptureFromBackground?: boolean,
) {
  if (!state) return;

  lastHandoffState = {
    status: state.status,
    trigger: state.trigger ?? null,
    lastAttemptAt: state.lastAttemptAt ?? null,
    lastSuccessAt: state.lastSuccessAt ?? null,
    error: state.error ?? null,
  };

  if (hasCaptureFromBackground) {
    captureReady = true;
  }

  const hasCapture = captureReady || Boolean(hasCaptureFromBackground);
  const isSending = state.status === "sending";

  if (hasCapture) {
    actionsEl.classList.remove("hidden");
  }

  sendToFigmaBtn.disabled = !hasCapture || isSending;
  sendToFigmaBtn.textContent = isSending
    ? state.trigger === "auto"
      ? "🚀 Auto-sending..."
      : "🚀 Sending..."
    : defaultSendBtnLabel;

  switch (state.status) {
    case "sending": {
      const detail =
        state.trigger === "auto"
          ? "Auto-sending to handoff server..."
          : "Sending to handoff server...";
      updateTransferIndicator("pending", detail);
      if (handoffStatusEl) {
        handoffStatusEl.textContent = detail;
        handoffStatusEl.className = "handoff-status";
        handoffStatusEl.classList.remove("hidden");
      }
      break;
    }
    case "queued": {
      const detail =
        state.pendingCount && state.pendingCount > 0
          ? `Waiting to send (${state.pendingCount} in queue)`
          : "Waiting to send to handoff server...";
      updateTransferIndicator("pending", detail);
      if (handoffStatusEl) {
        handoffStatusEl.textContent = state.nextRetryAt
          ? `${detail} • retry ${formatRelativeTime(state.nextRetryAt)}`
          : detail;
        handoffStatusEl.className = "handoff-status";
        handoffStatusEl.classList.remove("hidden");
      }
      statusEl.textContent = "⏳ Capture queued for delivery…";
      break;
    }
    case "success": {
      updateTransferIndicator("delivered", "Delivered to handoff server");
      statusEl.textContent = "✅ Sent to Figma! Check the plugin.";
      if (handoffStatusEl) {
        handoffStatusEl.textContent =
          "✅ Data sent to handoff server for Figma plugin";
        handoffStatusEl.className = "handoff-status success";
        handoffStatusEl.classList.remove("hidden");
      }
      // Re-enable capture button after successful handoff
      if (captureBtn) {
        setCaptureButtonLoading(false);
      }
      break;
    }
    case "error": {
      updateTransferIndicator("error", "Send failed");
      const message = state.error || "Unknown error";
      statusEl.textContent = `❌ Failed to send: ${message}`;
      if (handoffStatusEl) {
        handoffStatusEl.textContent = `⚠️ Failed: ${message}`;
        handoffStatusEl.className = "handoff-status error";
        handoffStatusEl.classList.remove("hidden");
      }
      // Re-enable capture button after error
      if (captureBtn) {
        setCaptureButtonLoading(false);
      }
      sendToFigmaBtn.disabled = !hasCapture;
      sendToFigmaBtn.textContent = hasCapture
        ? "Retry Send to Figma"
        : defaultSendBtnLabel;
      break;
    }
    default: {
      if (hasCapture) {
        updateTransferIndicator("idle", "Ready to send");
      }
      if (handoffStatusEl && handoffStatusEl.classList.contains("success")) {
        setTimeout(() => handoffStatusEl.classList.add("hidden"), 1500);
      }
      break;
    }
  }
}

// Initialize desktop viewport label with actual screen dimensions
function updateDesktopViewportLabel() {
  const desktopLabel = document.getElementById("desktop-viewport-label");
  if (!desktopLabel) return;

  // Get current tab to access screen dimensions
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]) {
      // Execute script in the current tab to get screen dimensions
      chrome.scripting.executeScript(
        {
          target: { tabId: tabs[0].id! },
          func: () => {
            const screenWidth = screen.width;
            const screenHeight = screen.height;
            const viewportWidth = Math.max(
              document.documentElement.clientWidth,
              window.innerWidth || 0,
            );
            const viewportHeight = Math.max(
              document.documentElement.clientHeight,
              window.innerHeight || 0,
            );
            const devicePixelRatio = window.devicePixelRatio || 1;

            return {
              screenWidth,
              screenHeight,
              viewportWidth,
              viewportHeight,
              devicePixelRatio,
            };
          },
        },
        (results) => {
          if (results && results[0] && results[0].result) {
            const { screenWidth, screenHeight, viewportWidth, viewportHeight } =
              results[0].result;
            const displayWidth = screenWidth || viewportWidth || 1440;
            const displayHeight = screenHeight || viewportHeight || 900;
            desktopLabel.textContent = `💻 Desktop (${displayWidth}×${displayHeight})`;
          }
        },
      );
    }
  });
}

// Auto-fill URL from query parameter (removed - no longer have URL input)
function autoFillUrlFromQueryParam() {
  // URL input removed
}

/**
 * Check URL parameters for auto-capture mode (used by detached window)
 * Handles: ?detached=true&autoCapture=send&viewports=mobile,tablet,desktop
 */
function checkAutoCapture() {
  const params = new URLSearchParams(window.location.search);
  const autoCapture = params.get("autoCapture");
  const viewportsParam = params.get("viewports");

  if (!autoCapture) {
    console.log("🪟 [AUTO] No auto-capture requested");
    return;
  }

  console.log(
    "🪟 [AUTO] Auto-capture detected:",
    autoCapture,
    "viewports:",
    viewportsParam,
  );

  // Set viewport checkboxes based on URL params (case-insensitive)
  if (viewportsParam) {
    const requestedViewports = viewportsParam.toLowerCase().split(",");
    const mobileCheckbox = document.getElementById(
      "viewport-mobile",
    ) as HTMLInputElement;
    const tabletCheckbox = document.getElementById(
      "viewport-tablet",
    ) as HTMLInputElement;
    const desktopCheckbox = document.getElementById(
      "viewport-desktop",
    ) as HTMLInputElement;

    if (mobileCheckbox)
      mobileCheckbox.checked = requestedViewports.includes("mobile");
    if (tabletCheckbox)
      tabletCheckbox.checked = requestedViewports.includes("tablet");
    if (desktopCheckbox)
      desktopCheckbox.checked = requestedViewports.includes("desktop");
  }

  // Start capture after a brief delay to ensure everything is initialized
  setTimeout(() => {
    console.log("🪟 [AUTO] Starting auto-capture...");
    const mode = autoCapture === "download" ? "download" : "send";
    void startCapture(mode as "send" | "download");
  }, 300);
}

// Initialize the popup when DOM content is loaded
console.log("🦴 [POPUP] Script loading, readyState:", document.readyState);

function initializeSkeletonContainer() {
  // Initialize skeleton on page load so it's ready for captures
  const skeletonContainer = document.getElementById("skeleton-animation");
  if (skeletonContainer && !smartSkeleton) {
    console.log("🦴 [POPUP] Initializing SmartSkeleton at page load");
    // smartSkeleton = new SmartSkeleton({
    //   container: skeletonContainer,
    //   maxBlocks: 50,
    //   minBlockSize: 0.01,
    //   debug: true, // Enable debug logging
    // });
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => {
    console.log("🦴 [POPUP] DOMContentLoaded fired");
    autoFillUrlFromQueryParam();
    updateDesktopViewportLabel();

    initializeSkeletonContainer();

    // Check for auto-capture (detached window mode)
    checkAutoCapture();
  });
} else {
  console.log("🦴 [POPUP] DOM already ready, initializing immediately");
  autoFillUrlFromQueryParam();
  updateDesktopViewportLabel();

  initializeSkeletonContainer();

  // Check for auto-capture (detached window mode)
  checkAutoCapture();
}

// ============================================================================
// CLEANUP ON UNLOAD
// ============================================================================
// Clean up timers and intervals when popup closes to prevent memory leaks
window.addEventListener("beforeunload", () => {
  clearExtractionTimeout();
  if (healthInterval !== null) {
    clearInterval(healthInterval);
    healthInterval = null;
  }
  console.log("🧹 [POPUP] Cleaned up timers on unload");
});
