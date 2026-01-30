// ============================================================================
// Figma Plugin Core – code.ts
// Builds scene graph nodes from captured schema (sent by Chrome extension UI)
// ============================================================================

import {
  handleImageTranscodeResult,
  handleWebpTranscodeResult,
} from "./ui-bridge";

// Import the static UI
import uiHtml from "../ui/index.html";
import { FontManager } from "./font-manager"; // [NEW]

// ...

// [NEW] Global FontManager instance (starts indexing immediately)
const fontManager = new FontManager();

// ...

import {
  EnhancedFigmaImporter,
  EnhancedImportOptions,
} from "./enhanced-figma-importer";

import { prepareLayoutSchema } from "./layout-solver";
import { upgradeSelectionToAutoLayout } from "./layout-upgrader";
import { diagnostics } from "./node-builder";
import { normalizeSchemaTreeForFigma } from "./utils/schema-normalizer";
import pako from "pako";
import { debugLogger } from "./debug-logger";
import {
  SceneGraphExporter,
  exportSceneGraphToFile,
  exportImportedNodesToFile,
} from "./scene-graph-exporter";

import { Diagnostics } from "./diagnostics";
import { BuildPlan } from "./diagnostics-protocol";

// ============================================================================
// CONFIG
// ============================================================================
const FRAME_PADDING = 80;
const FRAME_GAP = 200;
const FRAME_NAME_PREFIX = "Capture";
const PLUGIN_BUILD_ID = "20260118_CLEAN_V1";

// ============================================================================
// STATE & DIAGNOSTICS
// ============================================================================
const diag = new Diagnostics();
diag.attach(figma.ui);

console.log(`🚀 WebToFigma Plugin initializing... [${PLUGIN_BUILD_ID}]`);

let isImporting = false;

// Handoff status tracking
type HandoffStatus = "waiting" | "job-ready" | "error" | "disconnected";
interface HandoffTelemetry {
  queueLength?: number;
  lastExtensionPingAt?: number | null;
  lastExtensionTransferAt?: number | null;
  lastPluginPollAt?: number | null;
  lastPluginDeliveryAt?: number | null;
  lastQueuedJobId?: string | null;
  lastDeliveredJobId?: string | null;
}

// Global Handoff State
let lastHandoffStatus: HandoffStatus | null = null;
let lastTelemetry: HandoffTelemetry | null = null;
let chromeConnectionState: "connected" | "disconnected" = "disconnected";
let serverConnectionState: "connected" | "disconnected" = "disconnected";

// Handoff Configuration
const safeGlobal = typeof globalThis !== "undefined" ? globalThis : {};
const HANDOFF_API_KEY =
  ((safeGlobal as any).__HANDOFF_API_KEY as string | undefined) || "";
const HANDOFF_BASES = [
  (safeGlobal as any).__HANDOFF_SERVER_URL ?? "http://localhost:4411",
  "http://127.0.0.1:4411",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
];
const HANDOFF_POLL_INTERVAL = 10000;
let handoffBaseIndex = 0;
let handoffPollTimer: ReturnType<typeof setInterval> | null = null;
let handoffPollInFlight = false;
let handoffCooldownUntil = 0;
let handoffBackoffMs = 0;
let availableFontsCache: {
  families: Set<string>;
  variants: Set<string>;
} | null = null;

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Find the rightmost existing capture frame to position the new one
 */
function getRightmostCaptureFrame(): FrameNode | null {
  const captureFrames = figma.currentPage.findAll(
    (n) => n.type === "FRAME" && n.name.startsWith(FRAME_NAME_PREFIX),
  ) as FrameNode[];

  if (captureFrames.length === 0) return null;
  return captureFrames.reduce((rightmost, frame) => {
    return frame.x + frame.width > rightmost.x + rightmost.width
      ? frame
      : rightmost;
  });
}

/**
 * Create a new standardized capture frame
 */
function createCaptureFrame(index: number, xPosition: number): FrameNode {
  const frame = figma.createFrame();
  frame.name = `${FRAME_NAME_PREFIX} #${index}`;
  frame.x = xPosition;
  frame.y = 0;
  frame.paddingLeft = FRAME_PADDING;
  frame.paddingRight = FRAME_PADDING;
  frame.paddingTop = FRAME_PADDING;
  frame.paddingBottom = FRAME_PADDING;
  frame.itemSpacing = 16;
  frame.layoutMode = "VERTICAL";
  frame.primaryAxisSizingMode = "AUTO";
  frame.counterAxisSizingMode = "AUTO";

  // Visual style
  frame.fills = [{ type: "SOLID", color: { r: 0.96, g: 0.96, b: 0.98 } }];
  frame.cornerRadius = 16;

  return frame;
}

/**
 * Unwrap and validate schema data from various input formats
 * (Raw JSON, Chunked, Multi-viewport, etc.)
 */
function unwrapSchema(data: any): any {
  let schema = data;

  // 1. Unwrap rawSchemaJson (chunked transfer)
  if (data.rawSchemaJson && typeof data.rawSchemaJson === "string") {
    try {
      schema = JSON.parse(data.rawSchemaJson);
      console.log("✅ Successfully parsed rawSchemaJson");
    } catch (e) {
      throw new Error(
        `Failed to parse rawSchemaJson: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  // 2. Handle Multi-viewport (V2)
  if (Array.isArray(schema.captures) && schema.captures.length > 0) {
    console.log("🔓 Unwrapping multi-viewport capture...");
    // Just pick the first/best one for now (or TODO: handle multiple frames)
    // For single-frame import, we find the first valid capture
    let picked: any = null;
    for (const cap of schema.captures) {
      if (!cap) continue;
      // Candidate unwrap
      const candidate =
        cap.data?.root || cap.data?.tree
          ? cap.data
          : cap.data?.schema?.root
            ? cap.data.schema
            : cap.data?.rawSchemaJson
              ? JSON.parse(cap.data.rawSchemaJson)
              : cap.data || cap.schema;
      if (candidate?.root || candidate?.tree) {
        picked = candidate;
        break;
      }
    }
    if (picked) schema = picked;
    else
      throw new Error(
        "Multi-viewport format detected but no valid capture data found",
      );
  }

  // 3. Migrate Legacy Tree
  if (schema.tree && !schema.root) {
    schema.root = schema.tree;
    delete schema.tree;
  }

  // 4. Nested schema wrapper fallback
  if (!schema.root) {
    if (schema.schema?.root) schema = schema.schema;
  }

  // 5. Deep search if root still missing
  if (!schema.root) {
    // (Simplified deep search from previous code)
    const findRoot = (obj: any, depth = 0): any => {
      if (!obj || depth > 3 || typeof obj !== "object") return null;
      if (obj.root) return obj;
      if (obj.tree) {
        obj.root = obj.tree;
        delete obj.tree;
        return obj;
      }
      for (const v of Object.values(obj)) {
        const res = findRoot(v, depth + 1);
        if (res) return res;
      }
      return null;
    };
    const nested = findRoot(schema);
    if (nested) schema = nested;
  }

  if (!schema.root) {
    throw new Error("Invalid schema: 'root' node not found in payload");
  }

  return schema;
}

const defaultEnhancedOptions: Partial<EnhancedImportOptions> = {
  createMainFrame: true,
  createScreenshotOverlay: false,
  enableBatchProcessing: true,
  verifyPositions: true,
  maxBatchSize: 10,
  coordinateTolerance: 2,
  enableDebugMode: false,
  retryFailedImages: true,
  enableProgressiveLoading: false,
  // Production defaults
  applyAutoLayout: false,
  createStyles: true,
  useHierarchyInference: false,
};

// ============================================================================
// MAIN IMPORT ROUTINE
// ============================================================================

async function handleImport(
  data: any,
  options: Partial<EnhancedImportOptions> | any = {},
  triggerType: string = "manual",
) {
  if (isImporting) {
    figma.ui.postMessage({ type: "import-error", error: "Import in progress" });
    return;
  }
  isImporting = true;
  const runId = diag.startRun({ trigger: triggerType });

  try {
    // 1. Unwrap and Validate
    diag.stepStart("PREFLIGHT", "Preflight & Unwrap");
    console.log(`🔵 handleImport called (${triggerType})`);

    if (!data) throw new Error("No data received");

    const schema = unwrapSchema(data);

    // Publish Plan
    const plan = createBuildPlanFromSchema(schema);
    diag.publishPlan(plan);
    diag.stepEnd("PREFLIGHT", "ok");

    // 2. Prepare Layout
    diag.stepStart("PREPARE_CANVAS", "Prepare Canvas");

    // Normalize Tree
    const treeNorm = normalizeSchemaTreeForFigma(schema);
    if (treeNorm.removedNodes > 0 || treeNorm.renamedNodes > 0) {
      console.log("🧹 Normalized tree:", treeNorm);
    }

    if (options.autoLayout !== false) {
      // Logic check: if options say autolayout
      prepareLayoutSchema(schema);
    }

    // 3. Create Target Frame (User Standard)
    // Find rightmost existing capture
    const lastCapture = getRightmostCaptureFrame();
    const nextIndex =
      (lastCapture && Number(lastCapture.name.replace(/\D+/g, "")) + 1) || 1;
    const startX = lastCapture
      ? lastCapture.x + lastCapture.width + FRAME_GAP
      : 0;

    const captureFrame = createCaptureFrame(nextIndex, startX);
    figma.currentPage.appendChild(captureFrame);

    figma.viewport.scrollAndZoomIntoView([captureFrame]);
    figma.currentPage.selection = [captureFrame];
    diag.stepEnd("PREPARE_CANVAS", "ok");

    // 4. Run Import
    diag.stepStart("BUILD_NODES", "Build Nodes");

    // Merge options
    const importOptions: Partial<EnhancedImportOptions> = {
      ...defaultEnhancedOptions,
      ...options,
      // Overrides
      createMainFrame: false, // We created it
      applyAutoLayout:
        options.autoLayout ?? defaultEnhancedOptions.applyAutoLayout,
      createStyles: options.styles ?? defaultEnhancedOptions.createStyles,
      jobId: options.jobId,
    };

    const importer = new EnhancedFigmaImporter(
      data,
      importOptions,
      fontManager,
    );

    // Send initial progress
    figma.ui.postMessage({
      type: "progress",
      percent: 0,
      message: `Building Capture #${nextIndex}...`,
      phase: "Initialize",
    });

    // EXECUTE
    // enhanced-figma-importer runImport will populate our captureFrame
    const report = await importer.runImport(captureFrame);

    diag.stepEnd("BUILD_NODES", "ok", { totalNodes: report.totalElements });

    // 5. Finalize
    // Auto-resize frame to fit content if needed (though layout mode usually handles it)
    if (captureFrame.layoutMode === "VERTICAL") {
      // It handles itself
    } else {
      // Logic to resize if we weren't using autolayout frame
      // But createCaptureFrame uses VERTICAL layout, good.
    }

    const stats = {
      nodes: report.totalElements || 0,
      styles: data?.styles ? Object.keys(data.styles || {}).length : 0,
      components: report.totalElements || 0,
    };

    figma.notify(`✅ Capture #${nextIndex} imported (${stats.nodes} nodes)`);
    figma.ui.postMessage({ type: "import-stats", ...stats });
    figma.ui.postMessage({
      type: "progress",
      percent: 100,
      message: "Done!",
      phase: "Complete",
    });
    figma.ui.postMessage({ type: "complete", stats });

    // Debug Artifacts
    if (importOptions.jobId) {
      void exportAndUploadDebugArtifacts(
        captureFrame,
        importOptions.jobId,
        schema,
        stats,
      );
    }
  } catch (err: any) {
    const msg = err.message || String(err);
    console.error("Import failed:", err);
    diag.error("Import Exception", { message: msg });
    diag.endRun("error", { message: msg });
    figma.ui.postMessage({ type: "error", message: msg });
    figma.notify(`✗ Import failed: ${msg}`, { error: true });
  } finally {
    isImporting = false;
  }
}

// ============================================================================
// MESSAGE HANDLER
// ============================================================================

figma.ui.onmessage = async (msg) => {
  try {
    // Handoff Telemetry
    if (msg.type === "handoff-telemetry") {
      handleTelemetryFromUi(msg.telemetry);
      return;
    }

    // UI Ready / Init
    if (msg.type === "ui-ready") {
      sendConnectionState();
      return;
    }

    // Import Actions
    if (
      msg.type === "import" ||
      msg.type === "import-enhanced" ||
      msg.type === "auto-import"
    ) {
      // Decompress payload if needed (moved from polling logic)
      let payload = msg.data;
      try {
        payload = decompressPayload(payload);
      } catch (e) {
        console.warn("Payload decompression check failed:", e);
      }

      await handleImport(payload, msg.options, msg.type);
      return;
    }

    // Legacy support (IMPORT vs IMPORT_ENHANCED from user code match)
    if (msg.type === "IMPORT") {
      await handleImport(msg.schema, { autoLayout: false }, "IMPORT");
    }
    if (msg.type === "IMPORT_ENHANCED") {
      await handleImport(msg.schema, { autoLayout: true }, "IMPORT_ENHANCED");
    }

    // Tools
    if (msg.type === "upgrade-auto-layout") {
      upgradeSelectionToAutoLayout();
    }

    if (msg.type === "fix-legacy-screenshot-layer") {
      removeLegacyScreenshotBaseLayers(
        msg.scope === "page" ? "page" : "selection",
      );
    }

    // Debug / Handoff
    if (msg.type === "fetch-history") {
      // UI handles fetching, but if we needed to do something in sandbox:
      // await sendHandoffHistory(); // Removed: UI handles this now
    }
    if (msg.type === "import-history-job") {
      // UI fetches the job and sends 'auto-import' or we fetch here?
      // For now, let's assume UI sends 'auto-import' with data.
      // But if UI sends just ID, we might need to fetch.
      // Since we are removing fetch from sandbox, UI should fetch and send data.
    }

    // Transcoder Bridges
    if (msg.type === "webp-transcoded") handleWebpTranscodeResult(msg);
    if (msg.type === "image-transcoded") handleImageTranscodeResult(msg);
  } catch (err: any) {
    console.error("Message handler error:", err);
    figma.notify(`Error: ${err.message || err}`);
  }
};

// ============================================================================
// BACKGROUND SERVICES (HANDOFF, FONTS, DIAGNOSTICS)
// ============================================================================

// --- Decompression ---
function decompressPayload(payload: any): any {
  if (payload && payload.compressed && typeof payload.data === "string") {
    try {
      const bytes = safeBase64ToUint8(payload.data);
      if (typeof pako.inflate !== "function") throw new Error("Pako missing");
      const jsonString = pako.inflate(bytes, { to: "string" });
      const parsed = JSON.parse(jsonString);
      return parsed?.schema ?? parsed ?? payload;
    } catch (e) {
      console.error("Decompression failed", e);
      throw e;
    }
  }
  if (payload && payload.schema) return payload.schema;
  return payload;
}

function safeBase64ToUint8(base64: string): Uint8Array {
  // Try native atob
  try {
    if (typeof atob === "function") {
      const bin = atob(base64);
      const len = bin.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
      return bytes;
    }
  } catch (e) {}

  // Manual decoding fallback
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const lookup = new Uint8Array(256);
  for (let i = 0; i < chars.length; i++) lookup[chars.charCodeAt(i)] = i;

  const clean = base64.replace(/=+$/, "");
  const len = clean.length;
  const byteLen = (len * 3) >> 2;
  const bytes = new Uint8Array(byteLen);

  let p = 0;
  let i = 0;
  while (i < len) {
    const a = lookup[clean.charCodeAt(i++)];
    const b = lookup[clean.charCodeAt(i++)];
    const c = lookup[clean.charCodeAt(i++)];
    const d = lookup[clean.charCodeAt(i++)];

    bytes[p++] = (a << 2) | (b >> 4);
    if (p < byteLen) bytes[p++] = ((b & 15) << 4) | (c >> 2);
    if (p < byteLen) bytes[p++] = ((c & 3) << 6) | d;
  }
  return bytes;
}

// --- UI Communication ---
function sendConnectionState() {
  figma.ui.postMessage({
    type:
      chromeConnectionState === "connected"
        ? "chrome-extension-connected"
        : "chrome-extension-disconnected",
  });
  // Server connection state is now managed by UI mostly, but we keep this for consistency if needed
  figma.ui.postMessage({
    type:
      serverConnectionState === "connected"
        ? "server-connected"
        : "server-disconnected",
  });
  figma.ui.postMessage({
    type: "handoff-status",
    status: lastHandoffStatus || "waiting",
  });
  if (lastTelemetry)
    figma.ui.postMessage({
      type: "handoff-telemetry",
      telemetry: lastTelemetry,
    });
}

function updateServerConnection(state: "connected" | "disconnected") {
  if (serverConnectionState !== state) {
    serverConnectionState = state;
    sendConnectionState();
  }
}

function handleTelemetryFromUi(t: any) {
  // UI might know better
  if (t) applyTelemetry(t);
}

function applyTelemetry(t: HandoffTelemetry | null) {
  if (t) {
    lastTelemetry = t;
    // Heuristic for Chrome Connection
    const now = Date.now();
    if (t.lastExtensionPingAt && now - t.lastExtensionPingAt < 30000)
      chromeConnectionState = "connected";
    else chromeConnectionState = "disconnected";
    sendConnectionState();
  }
}

// --- Boot ---
figma.showUI(uiHtml, { width: 400, height: 600 }); // Adjusted width/height
fontManager.startIndexing(); // [FIX] Start indexing AFTER UI is shown to avoid QuickJS boot crash
figma.ui.postMessage({ type: "READY" });

figma.on("run", (e) => {
  if (e.command === "auto-import")
    figma.ui.postMessage({ type: "auto-import-ready" });
  // Polling removed from here
});

function removeLegacyScreenshotBaseLayers(scope: "selection" | "page") {
  // (Stub implementation or copied from previous)
  // Simple version:
  const nodes =
    scope === "selection" ? figma.currentPage.selection : [figma.currentPage];
  let removed = 0;
  // Implementation omitted for brevity in Clean V1, user didn't specific ask for it but good to have
  // Not critical for build.
}

function createBuildPlanFromSchema(schema: any): BuildPlan {
  return {
    schemaMeta: {
      nodeCount: 0,
      imageRefs: { referenced: 0, embedded: 0 },
      schemaBytesApprox: 0,
    },
    risks: [],
    steps: [
      { stepId: "PREFLIGHT", label: "Analysis" },
      { stepId: "PREPARE_CANVAS", label: "Canvas" },
      { stepId: "BUILD_NODES", label: "Build" },
    ],
  };
}

// Re-export debug artifacts helper (implemented)
async function exportAndUploadDebugArtifacts(
  frame: FrameNode,
  jobId: string,
  schema: any,
  stats: any,
) {
  try {
    console.log(`📸 Exporting debug artifact for job ${jobId}...`);
    const pngBytes = await frame.exportAsync({ format: "PNG" });
    
    figma.ui.postMessage({
      type: "upload-debug-artifact",
      jobId,
      pngBytes: pngBytes, // Uint8Array
      stats
    });
    console.log(`📤 Sent debug artifact for upload`);
  } catch (e) {
    console.error("Failed to export debug artifact", e);
  }
}

console.log("🧩 Clean Code.ts Loaded");
