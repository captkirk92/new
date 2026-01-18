// Figma Plugin Main Entry Point
console.log("🚀 WebToFigma Plugin initializing...");

import {
  handleImageTranscodeResult,
  handleWebpTranscodeResult,
} from "./ui-bridge";

// Import the static UI
import uiHtml from "../ui/index.html";
import {
  EnhancedFigmaImporter,
  EnhancedImportOptions,
} from "./enhanced-figma-importer";
import { prepareLayoutSchema } from "./layout-solver";
import { upgradeSelectionToAutoLayout } from "./layout-upgrader";
import { diagnostics } from "./node-builder";
import { normalizeSchemaTreeForFigma } from "./tree-normalizer";
import pako from "pako";
import { debugLogger } from "./debug-logger";
import {
  SceneGraphExporter,
  exportSceneGraphToFile,
  exportImportedNodesToFile,
} from "./scene-graph-exporter";

import { Diagnostics } from "./diagnostics";
import { BuildPlan } from "./diagnostics-protocol";

// Helper functions for Build Plan
function countNodes(node: any): number {
  let n = 1;
  const kids = node?.children || [];
  for (const c of kids) n += countNodes(c);
  return n;
}

function countImageRefs(schema: any): { referenced: number; embedded: number } {
  const referenced = new Set<string>();
  const embeddedKeys = schema?.assets?.images
    ? Object.keys(schema.assets.images)
    : [];
  const embedded = embeddedKeys.length;

  const walk = (node: any) => {
    const fills = node?.fills || [];
    for (const f of fills) {
      if (f?.imageHash) referenced.add(f.imageHash);
    }
    const backgrounds = node?.backgrounds || [];
    for (const b of backgrounds) {
      if (b?.imageHash) referenced.add(b.imageHash);
    }
    for (const c of node?.children || []) walk(c);
  };
  if (schema?.root) walk(schema.root);

  return { referenced: referenced.size, embedded };
}

function createBuildPlanFromSchema(schema: any): BuildPlan {
  const nodeCount = Array.isArray(schema?.root?.children)
    ? countNodes(schema.root)
    : 0;
  const imageRefs = countImageRefs(schema);

  const risks: BuildPlan["risks"] = [];
  if (imageRefs.referenced > 0 && imageRefs.embedded === 0) {
    risks.push({
      severity: "high",
      message:
        "Schema references imageHash values but assets.images is empty. Images may be missing.",
    });
  }

  return {
    schemaMeta: {
      nodeCount,
      imageRefs,
      schemaBytesApprox: JSON.stringify(schema).length,
    },
    risks,
    steps: [
      {
        stepId: "PREFLIGHT",
        label: "Preflight Checks",
        description: "Validate schema structure and assets.",
      },
      {
        stepId: "PREPARE_CANVAS",
        label: "Prepare Canvas",
        description: "Set up main frame and styles.",
      },
      {
        stepId: "BUILD_NODES",
        label: "Build Nodes",
        description: "Construct Figma node hierarchy.",
      },
      {
        stepId: "OPTIMIZE",
        label: "Optimize",
        description: "Apply layout and semantic optimizations.",
      },
      {
        stepId: "VERIFY",
        label: "Verify",
        description: "Check positioning and fidelity.",
      },
    ],
  };
}

const diag = new Diagnostics();
diag.attach(figma.ui);

// Import shared schema types (CRITICAL: Single source of truth)
import type { WebToFigmaSchema, ElementNode } from "../../shared/schema";

// Log the imported schema type at module load to verify import
console.log(
  "[SCHEMA IMPORT CHECK] WebToFigmaSchema type imported from shared/schema.ts",
);

// BUILD ID - Verify correct plugin version is loaded
const PLUGIN_BUILD_ID = "20260111_PROGRESS_ENHANCED_V1";
console.log(`🔧 [PLUGIN BUILD ID] ${PLUGIN_BUILD_ID}`);

// Type definitions for incoming data formats (extension → plugin)
// Using 'any' for now to maintain compatibility with existing code
// TODO: Add proper TypeScript types after verifying schema import works
type IncomingSchemaData = any;

// Type definitions for API responses
interface HandoffJobResponse {
  job?: {
    id: string;
    payload: any;
  };
  telemetry?: any;
}

interface HandoffHealthResponse {
  telemetry?: any;
  queueLength: number;
  ok: boolean;
}

interface HandoffHistoryItem {
  id: string;
  timestamp?: number;
  deliveredAt?: number;
  permalink?: string;
  hasScreenshot?: boolean;
  size?: number;
}

interface MissingFontReport {
  family: string;
  styles: string[];
}

figma.showUI(uiHtml, { width: 900, height: 700 });

function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    const msg = error.message || String(error);

    // Improve common network error messages
    if (msg.toLowerCase().includes("failed to fetch")) {
      return "Network request failed";
    }
    if (msg.includes("ECONNREFUSED") || msg.includes("connection refused")) {
      return "Connection refused - handoff server not running";
    }
    if (msg.includes("ENOTFOUND") || msg.includes("name resolution failed")) {
      return "Host not found - check server configuration";
    }
    if (msg.includes("timeout")) {
      return "Connection timeout - server may be overloaded";
    }

    return msg;
  }
  if (typeof error === "string") {
    // Handle string error messages
    if (error.toLowerCase().includes("failed to fetch")) {
      return "Network request failed";
    }
    return error;
  }
  if (error === null || error === undefined) return String(error);
  if (typeof error === "number" || typeof error === "boolean")
    return String(error);
  if (typeof error === "object") {
    const maybe = error as any;
    if (typeof maybe.message === "string" && maybe.message.trim()) {
      return formatUnknownError(maybe.message);
    }
    if (typeof maybe.error === "string" && maybe.error.trim()) {
      return formatUnknownError(maybe.error);
    }
    try {
      return JSON.stringify(error);
    } catch {
      return Object.prototype.toString.call(error);
    }
  }
  return String(error);
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
  usePixelPerfectPositioning: true,
  showValidationMarkers: false,
  // Production default: pixel-perfect import first.
  // Auto Layout is opt-in because it can collapse layout if applied broadly.
  applyAutoLayout: false,
  createStyles: true,
  // Production default: keep original DOM structure unless user opts in.
  useHierarchyInference: false,

  // Semantic Tree Optimization (opt-in; can reorder nodes)
  enableSemanticTreeOptimization: false,
  semanticNaming: true,
  detectComponents: false,
  groupByRole: false,
  addVisualMarkers: false,
  minComponentInstances: 3,
};

function sanitizeLargeVibrantPaletteFills(schema: any): number {
  // DISABLE: This heuristic aggressively removes valid backgrounds in dark mode apps
  // like YouTube, Spotify, etc., causing white-on-white text issues.
  return 0;
}

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
let lastHandoffStatus: HandoffStatus | null = null;
let lastTelemetry: HandoffTelemetry | null = null;
let chromeConnectionState: "connected" | "disconnected" = "disconnected";
let serverConnectionState: "connected" | "disconnected" = "disconnected";
// Capture service endpoints - configured for cloud deployment
// Handoff server configuration
const safeGlobal = typeof globalThis !== "undefined" ? globalThis : {};
const HANDOFF_API_KEY =
  ((safeGlobal as any).__HANDOFF_API_KEY as string | undefined) || "";

const HANDOFF_BASES = [
  (safeGlobal as any).__HANDOFF_SERVER_URL ?? "http://127.0.0.1:4411",
  "http://localhost:4411",
  // Legacy ports (kept for backward compatibility)
  "http://127.0.0.1:5511",
  "http://localhost:5511",
];
const HANDOFF_POLL_INTERVAL = 10000;
let handoffBaseIndex = 0;
let handoffPollTimer: ReturnType<typeof setInterval> | null = null;
let handoffPollInFlight = false;
let handoffCooldownUntil = 0; // pause polling after errors (e.g., 429)
let handoffBackoffMs = 0; // exponential backoff for rate limits
let availableFontsCache: {
  families: Set<string>;
  variants: Set<string>;
} | null = null;

figma.on("run", (runEvent) => {
  if (runEvent.command === "auto-import") {
    figma.ui.postMessage({ type: "auto-import-ready" });
  }
  startHandoffPolling();
});

figma.ui.onmessage = async (msg) => {
  if (msg.type === "handoff-telemetry") {
    handleTelemetryFromUi(msg.telemetry as HandoffTelemetry | null);
    return;
  }
  if (msg.type === "ui-ready") {
    if (chromeConnectionState) {
      figma.ui.postMessage({
        type:
          chromeConnectionState === "connected"
            ? "chrome-extension-connected"
            : "chrome-extension-disconnected",
      });
    }
    if (serverConnectionState) {
      figma.ui.postMessage({
        type:
          serverConnectionState === "connected"
            ? "server-connected"
            : "server-disconnected",
      });
    }
    figma.ui.postMessage({
      type: "handoff-status",
      status: lastHandoffStatus || "waiting",
    });
    figma.ui.postMessage({
      type: "handoff-telemetry",
      telemetry: lastTelemetry,
    });
    return;
  }
  if (msg.type === "fetch-history") {
    await sendHandoffHistory();
    return;
  }
  if (msg.type === "import-history-job") {
    await importFromHistory(msg.jobId as string);
    return;
  }
  if (msg.type === "webp-transcoded") {
    handleWebpTranscodeResult(msg);
    return;
  }
  if (msg.type === "image-transcoded") {
    handleImageTranscodeResult(msg);
    return;
  }

  if (
    msg.type === "import" ||
    msg.type === "auto-import" ||
    msg.type === "live-import"
  ) {
    await handleImportRequest(msg.data, msg.options, msg.type);
    return;
  }

  if (msg.type === "import-enhanced") {
    await handleEnhancedImportV2(msg.data, msg.options);
    return;
  }

  if (msg.type === "fix-legacy-screenshot-layer") {
    const { removed, scannedScopes } = removeLegacyScreenshotBaseLayers(
      msg.scope === "page" ? "page" : "selection",
    );
    figma.ui.postMessage({
      type: "legacy-screenshot-fix-result",
      removed,
      scannedScopes,
    });
    if (removed > 0) {
      figma.notify(`✅ Removed ${removed} legacy Screenshot Base Layer(s)`, {
        timeout: 3000,
      });
    } else {
      figma.notify("No legacy Screenshot Base Layer found in scope", {
        timeout: 2500,
      });
    }
    return;
  }

  if (msg.type === "upgrade-auto-layout") {
    upgradeSelectionToAutoLayout();
    return;
  }

  if (msg.type === "poll-jobs") {
    console.log("⚡ UI requested forced poll");
    void pollHandoffJobs();
    return;
  }

  // Scene graph export for gap analysis
  if (msg.type === "export-scene-graph") {
    const selection = figma.currentPage.selection;
    if (selection.length === 0) {
      figma.notify("Please select a frame to export", { error: true });
      return;
    }
    const rootNode = selection[0];
    const importedOnly = msg.importedOnly === true;

    if (importedOnly) {
      exportImportedNodesToFile(rootNode);
    } else {
      exportSceneGraphToFile(rootNode);
    }
    return;
  }
};

function removeLegacyScreenshotBaseLayers(scope: "selection" | "page"): {
  removed: number;
  scannedScopes: number;
} {
  const roots =
    scope === "selection" && figma.currentPage.selection.length > 0
      ? figma.currentPage.selection
      : [figma.currentPage];

  let removed = 0;
  let scannedScopes = 0;

  for (const root of roots) {
    scannedScopes++;
    // If the root itself is the legacy layer.
    if (root.type === "RECTANGLE" && root.name === "Screenshot Base Layer") {
      root.remove();
      removed++;
      continue;
    }

    if ("findAll" in root && typeof (root as ChildrenMixin).findAll === "function") {
      const matches = (root as ChildrenMixin).findAll(
        (n: SceneNode) =>
          n.type === "RECTANGLE" && n.name === "Screenshot Base Layer",
      ) as RectangleNode[];

      for (const node of matches) {
        node.remove();
        removed++;
      }
    }
  }

  return { removed, scannedScopes };
}

/**
 * Generate summary statistics from Figma JSON export
 */
function generateFigmaSummary(figmaJson: any, mainFrame: FrameNode): any {
  const summary = {
    nodeCount: 0,
    nodeTypes: {} as Record<string, number>,
    textNodes: 0,
    imageNodes: 0,
    zeroSizedNodes: 0,
    outOfBoundsNodes: 0,
    largestNodes: [] as Array<{ id: string; name: string; area: number }>,
    warnings: [] as string[],
  };

  const viewportWidth = mainFrame.width;
  const viewportHeight = mainFrame.height;
  const largestNodesLimit = 10;
  const nodeSizes: Array<{ id: string; name: string; area: number }> = [];

  function traverse(node: any) {
    if (!node) return;

    summary.nodeCount++;
    const nodeType = node.type || "UNKNOWN";
    summary.nodeTypes[nodeType] = (summary.nodeTypes[nodeType] || 0) + 1;

    // Count text nodes
    if (nodeType === "TEXT") {
      summary.textNodes++;
    }

    // Count image nodes
    if (nodeType === "RECTANGLE" || nodeType === "FRAME") {
      const fills = node.fills || [];
      if (fills.some((f: any) => f?.type === "IMAGE")) {
        summary.imageNodes++;
      }
    }

    // Check for zero-sized nodes
    const bounds = node.absoluteBoundingBox || node.size;
    if (bounds) {
      const width = bounds.width || bounds.x || 0;
      const height = bounds.height || bounds.y || 0;

      if (width === 0 || height === 0) {
        summary.zeroSizedNodes++;
      }

      // Track largest nodes
      const area = width * height;
      if (area > 0) {
        nodeSizes.push({
          id: node.id || "unknown",
          name: node.name || "unnamed",
          area,
        });
      }

      // Check if out of bounds
      const x = bounds.x || 0;
      const y = bounds.y || 0;
      if (x < 0 || y < 0 || x > viewportWidth * 2 || y > viewportHeight * 2) {
        summary.outOfBoundsNodes++;
      }
    }

    // Recurse into children
    if (node.children && Array.isArray(node.children)) {
      node.children.forEach(traverse);
    }
  }

  // Traverse from document root
  if (figmaJson.document) {
    traverse(figmaJson.document);
  }

  // Sort and get largest nodes
  nodeSizes.sort((a, b) => b.area - a.area);
  summary.largestNodes = nodeSizes.slice(0, largestNodesLimit);

  // Add warnings
  if (summary.zeroSizedNodes > 0) {
    summary.warnings.push(`Found ${summary.zeroSizedNodes} zero-sized nodes`);
  }
  if (summary.outOfBoundsNodes > 0) {
    summary.warnings.push(
      `Found ${summary.outOfBoundsNodes} nodes outside expected viewport bounds`,
    );
  }
  if (summary.imageNodes === 0 && summary.nodeCount > 10) {
    summary.warnings.push("No image nodes detected in import");
  }

  return summary;
}

/**
 * AUTOMATED DEBUG: Export imported frame and upload comprehensive diagnostics to debug server
 *
 * Exports:
 * 1. import_render.png - Visual screenshot for pixel diffing
 * 2. import_report.json - Basic metadata and stats
 * 3. figma_nodes.json.gz - Full JSON_REST_V1 export (compressed)
 * 4. figma_summary.json - Compact diagnostic summary
 */
async function exportAndUploadDebugArtifacts(
  mainFrame: FrameNode,
  jobId: string,
  schema: any,
  stats: any,
  selectionMap?: Record<string, string>,
) {
  try {
    const baseUrl = "http://localhost:4411";
    const dpr = schema.metadata?.viewport?.devicePixelRatio || 1;

    console.log(`📤 [DEBUG] Starting artifact export for job ${jobId}...`);

    // 1. Export and upload PNG render
    console.log(`📸 [DEBUG] Exporting PNG render...`);
    const renderBytes = await mainFrame.exportAsync({
      format: "PNG",
      constraint: { type: "SCALE", value: dpr },
    });

    await fetch(`${baseUrl}/api/debug/${jobId}/import_render.png`, {
      method: "POST",
      headers: { "Content-Type": "image/png" },
      body: new Blob([renderBytes], { type: "image/png" }),
    });
    console.log(
      `✅ [DEBUG] Uploaded import_render.png (${(
        renderBytes.byteLength / 1024
      ).toFixed(1)} KB)`,
    );

    // 2. Upload basic import report
    const report = {
      jobId,
      fileKey: figma.fileKey,
      rootNodeId: mainFrame.id,
      viewport: {
        width: mainFrame.width,
        height: mainFrame.height,
      },
      scale: dpr,
      stats,
      timestamp: new Date().toISOString(),
    };

    await fetch(`${baseUrl}/api/debug/${jobId}/import_report.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(report),
    });
    console.log(`✅ [DEBUG] Uploaded import_report.json`);

    // 3. Export JSON_REST_V1 format (full Figma node tree)
    console.log(`🔍 [DEBUG] Exporting JSON_REST_V1...`);
    const figmaJson = await mainFrame.exportAsync({ format: "JSON_REST_V1" });
    const figmaJsonString = JSON.stringify(figmaJson);
    const jsonSizeKB = (figmaJsonString.length / 1024).toFixed(1);
    console.log(`📊 [DEBUG] JSON_REST_V1 size: ${jsonSizeKB} KB`);

    // Compress using pako (gzip)
    const compressed = pako.gzip(figmaJsonString);
    const compressedSizeKB = (compressed.byteLength / 1024).toFixed(1);
    console.log(
      `🗜️ [DEBUG] Compressed to: ${compressedSizeKB} KB (${(
        (1 - compressed.byteLength / figmaJsonString.length) *
        100
      ).toFixed(1)}% reduction)`,
    );

    await fetch(`${baseUrl}/api/debug/${jobId}/figma_nodes.json.gz`, {
      method: "POST",
      headers: {
        "Content-Type": "application/gzip",
        "Content-Encoding": "gzip",
      },
      body: compressed,
    });
    console.log(`✅ [DEBUG] Uploaded figma_nodes.json.gz`);

    // 4. Generate and upload summary diagnostics
    console.log(`📋 [DEBUG] Generating summary...`);
    const summary = generateFigmaSummary(figmaJson, mainFrame);

    await fetch(`${baseUrl}/api/debug/${jobId}/figma_summary.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(summary, null, 2),
    });
    console.log(`✅ [DEBUG] Uploaded figma_summary.json`);

    // 5. Upload selection map if available
    if (selectionMap) {
      console.log(`🗺️ [DEBUG] Uploading selection map...`);
      await fetch(`${baseUrl}/api/debug/${jobId}/figma_selection_map.json`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(selectionMap, null, 2),
      });
      console.log(`✅ [DEBUG] Uploaded figma_selection_map.json`);
    }

    // 6. Export and upload scene graph snapshot for gap analysis
    console.log(
      `🔬 [DEBUG] Exporting scene graph snapshot for gap analysis...`,
    );
    const sceneGraphExporter = new SceneGraphExporter();
    const sceneGraphSnapshot = sceneGraphExporter.exportFromNode(mainFrame);
    const sceneGraphJson = JSON.stringify(sceneGraphSnapshot, null, 2);
    const sceneGraphCompressed = pako.gzip(sceneGraphJson);

    await fetch(`${baseUrl}/api/debug/${jobId}/figma_scene_graph.json.gz`, {
      method: "POST",
      headers: {
        "Content-Type": "application/gzip",
        "Content-Encoding": "gzip",
      },
      body: sceneGraphCompressed,
    });
    console.log(
      `✅ [DEBUG] Uploaded figma_scene_graph.json.gz (${
        sceneGraphSnapshot.totalNodes
      } nodes, ${(sceneGraphCompressed.byteLength / 1024).toFixed(
        1,
      )} KB compressed)`,
    );

    console.log(
      `✅ [DEBUG] All artifacts uploaded successfully for job ${jobId}`,
    );
  } catch (e) {
    console.error("❌ [DEBUG] Failed to upload artifacts:", e);
    // Log but don't throw - we don't want to break the import if debug upload fails
  }
}

async function handleImportRequest(
  data: IncomingSchemaData,
  options: Partial<EnhancedImportOptions> | undefined,
  trigger: "import" | "auto-import" | "live-import",
): Promise<void> {
  const runId = diag.startRun({ trigger, mode: "request" });
  diag.stepStart("PREFLIGHT", "Preflight Checks");

  console.log("🔵 handleImportRequest called", {
    hasData: !!data,
    dataType: typeof data,
    trigger,
    isImporting,
  });

  if (!data) {
    console.error("❌ No data received");
    diag.error("No data received", {}, "PREFLIGHT");
    diag.stepEnd("PREFLIGHT", "error");
    diag.endRun("error", { message: "No data" });
    figma.ui.postMessage({
      type: "error",
      message: "No schema payload received.",
    });
    return;
  }

  if (isImporting) {
    console.warn("⚠️ Import already in progress");
    diag.warn("Import already in progress - blocking request", {}, "PREFLIGHT");
    diag.stepEnd("PREFLIGHT", "skipped");
    diag.endRun("warn", { message: "Busy" });
    figma.ui.postMessage({
      type: "import-busy",
      message: "An import is already running. Please wait for it to finish.",
    });
    return;
  }

  isImporting = true;
  console.log("✅ Import started");

  // Initialize diagnostics for this import
  const importUrl =
    data?.metadata?.url || data?.rawSchemaJson ? "chunked-transfer" : "unknown";
  diagnostics.startImport(importUrl);

  // Unwrap rawSchemaJson if present (chunked transfer format from Chrome extension)
  let schema = data;
  if (data.rawSchemaJson && typeof data.rawSchemaJson === "string") {
    console.log("🔓 Unwrapping rawSchemaJson string from chunked transfer...");
    try {
      schema = JSON.parse(data.rawSchemaJson);
      console.log("✅ Successfully parsed rawSchemaJson");
      diag.info(
        "Unwrapped rawSchemaJson",
        { length: data.rawSchemaJson.length },
        "PREFLIGHT",
      );
    } catch (parseError) {
      const errorMsg =
        parseError instanceof Error ? parseError.message : "Parse failed";
      console.error("❌ Failed to parse rawSchemaJson:", errorMsg);
      diag.error(
        "Failed to parse rawSchemaJson",
        { error: errorMsg },
        "PREFLIGHT",
      );
      diag.stepEnd("PREFLIGHT", "error");
      diag.endRun("error", { message: errorMsg });
      figma.ui.postMessage({
        type: "error",
        message: `Failed to parse schema data: ${errorMsg}`,
      });
      isImporting = false;
      return;
    }
  }

  // Handle multi-viewport format: create separate frames for each viewport
  // CRITICAL FIX: Process ALL captures, not just the first one!
  if (
    schema.multiViewport &&
    Array.isArray(schema.captures) &&
    schema.captures.length > 0
  ) {
    console.log(
      `🔓 Multi-viewport bundle detected with ${schema.captures.length} captures`,
    );
    diag.info(
      "Multi-viewport format detected",
      { captures: schema.captures.length },
      "PREFLIGHT",
    );

    // Store all captures for processing
    const allCaptures = schema.captures;
    let successCount = 0;
    let errorCount = 0;

    diag.stepEnd("PREFLIGHT", "ok");

    // Process each viewport capture sequentially
    for (let i = 0; i < allCaptures.length; i++) {
      const capture = allCaptures[i];
      if (!capture) continue;

      const viewportName = capture.viewport || `Viewport ${i + 1}`;
      console.log(
        `\n📐 [VIEWPORT ${i + 1}/${
          allCaptures.length
        }] Processing: ${viewportName}`,
      );

      // Extract schema from capture
      let viewportSchema: any = null;
      const candidate =
        capture.data?.root || capture.data?.tree
          ? capture.data
          : capture.data?.schema?.root || capture.data?.schema?.tree
            ? capture.data.schema
            : capture.data?.rawSchemaJson
              ? JSON.parse(capture.data.rawSchemaJson)
              : capture.data || capture.schema;

      if (candidate?.root || candidate?.tree) {
        viewportSchema = candidate;
      } else {
        console.warn(
          `⚠️ Viewport ${viewportName} has no valid schema, skipping`,
        );
        errorCount++;
        continue;
      }

      // Apply migration if legacy tree exists
      if (viewportSchema.tree && !viewportSchema.root) {
        viewportSchema.root = viewportSchema.tree;
        delete viewportSchema.tree;
      }

      // Final validation: ensure we have root data
      if (!viewportSchema.root) {
        console.warn(`⚠️ Viewport ${viewportName} has no root data, skipping`);
        errorCount++;
        continue;
      }

      try {
        diag.stepStart("BUILD_NODES", `Building ${viewportName}`);

        const resolvedOptions: Partial<EnhancedImportOptions> = {
          ...defaultEnhancedOptions,
          ...(options || {}),
        };

        // Prepare canvas for this viewport
        const treeNorm = normalizeSchemaTreeForFigma(viewportSchema);
        if (resolvedOptions.applyAutoLayout !== false) {
          prepareLayoutSchema(viewportSchema);
        }
        sanitizeLargeVibrantPaletteFills(viewportSchema);

        const enhancedOptions: Partial<EnhancedImportOptions> = {
          createMainFrame: true,
          enableBatchProcessing: resolvedOptions.enableBatchProcessing ?? true,
          verifyPositions: false,
          maxBatchSize: resolvedOptions.maxBatchSize ?? 10,
          coordinateTolerance: resolvedOptions.coordinateTolerance ?? 2,
          enableDebugMode: resolvedOptions.enableDebugMode ?? false,
          retryFailedImages: resolvedOptions.retryFailedImages ?? true,
          enableProgressiveLoading:
            resolvedOptions.enableProgressiveLoading ?? false,
          applyAutoLayout: resolvedOptions.applyAutoLayout,
          useHierarchyInference: resolvedOptions.useHierarchyInference ?? false,
          enableSemanticTreeOptimization:
            resolvedOptions.enableSemanticTreeOptimization ?? false,
          parseMetaTags: resolvedOptions.parseMetaTags ?? true,
          // CRITICAL FIX: Explicitly propagate optimization options
          // Use false as default to prevent unwanted visual changes
          semanticNaming: resolvedOptions.semanticNaming ?? false,
          detectComponents: resolvedOptions.detectComponents ?? false,
          groupByRole: resolvedOptions.groupByRole ?? false,
          addVisualMarkers: resolvedOptions.addVisualMarkers ?? false,
          colorCodeByRole: resolvedOptions.colorCodeByRole ?? false,
          minComponentInstances: resolvedOptions.minComponentInstances ?? 3,
        };

        const importer = new EnhancedFigmaImporter(
          viewportSchema,
          enhancedOptions,
        );
        const verificationReport = await importer.runImport();

        // Rename the main frame to include viewport name
        const mainFrame = importer.getMainFrame();
        if (mainFrame) {
          const originalName = mainFrame.name;
          mainFrame.name = `${viewportName} - ${originalName}`;

          // Position frames horizontally with spacing
          mainFrame.x = i * (mainFrame.width + 100);
          mainFrame.y = 0;

          console.log(
            `✅ Created frame: ${mainFrame.name} (${mainFrame.width}x${mainFrame.height}px)`,
          );
        }

        diag.stepEnd("BUILD_NODES", "ok", {
          viewport: viewportName,
          nodes: verificationReport.totalElements,
        });

        successCount++;
      } catch (viewportError) {
        const message =
          viewportError instanceof Error
            ? viewportError.message
            : "Viewport import failed";
        console.error(`❌ Failed to import viewport ${viewportName}:`, message);
        diag.error(`Viewport ${viewportName} failed`, { message });
        errorCount++;
      }
    }

    // Final status
    diag.stepStart("VERIFY", "Finalizing");
    const enhancedStats = {
      viewports: allCaptures.length,
      successful: successCount,
      failed: errorCount,
    };

    figma.ui.postMessage({ type: "complete", stats: enhancedStats });
    diag.stepEnd("VERIFY", "ok");
    diag.endRun("ok", { viewports: successCount });

    figma.notify(`✓ Imported ${successCount}/${allCaptures.length} viewports`);
    postHandoffStatus("waiting");
    isImporting = false;
    return;
  }

  // Apply migration if legacy tree exists
  if (schema.tree && !schema.root) {
    schema.root = schema.tree;
    delete schema.tree;
  }

  // Final validation: ensure we have root data
  if (!schema.root) {
    diag.error(
      "Missing root in schema",
      { keys: Object.keys(schema) },
      "PREFLIGHT",
    );
    diag.stepEnd("PREFLIGHT", "error");
    diag.endRun("error", { message: "No root data" });
    figma.ui.postMessage({
      type: "error",
      message: "No root data available for import.",
    });
    isImporting = false;
    return;
  }

  const resolvedOptions: Partial<EnhancedImportOptions> = {
    ...defaultEnhancedOptions,
    ...(options || {}),
  };

  try {
    // Publish build plan
    const plan = createBuildPlanFromSchema(schema);
    diag.publishPlan(plan);
    diag.stepEnd("PREFLIGHT", "ok");

    diag.stepStart("PREPARE_CANVAS", "Prepare Canvas");
    const treeNorm = normalizeSchemaTreeForFigma(schema);
    diag.info("Normalized schema tree", treeNorm as any, "PREPARE_CANVAS");

    if (resolvedOptions.applyAutoLayout !== false) {
      prepareLayoutSchema(schema);
    }

    const removedPaletteFills = sanitizeLargeVibrantPaletteFills(schema);
    diag.stepEnd("PREPARE_CANVAS", "ok");

    diag.stepStart("BUILD_NODES", "Build Nodes");
    const enhancedOptions: Partial<EnhancedImportOptions> = {
      createMainFrame: resolvedOptions.createMainFrame,
      enableBatchProcessing: resolvedOptions.enableBatchProcessing ?? true,
      verifyPositions: false,
      maxBatchSize: resolvedOptions.maxBatchSize ?? 10,
      coordinateTolerance: resolvedOptions.coordinateTolerance ?? 2,
      enableDebugMode: resolvedOptions.enableDebugMode ?? false,
      retryFailedImages: resolvedOptions.retryFailedImages ?? true,
      enableProgressiveLoading:
        resolvedOptions.enableProgressiveLoading ?? false,
      applyAutoLayout: resolvedOptions.applyAutoLayout,
      useHierarchyInference: resolvedOptions.useHierarchyInference ?? false,
    };

    const importer = new EnhancedFigmaImporter(schema, enhancedOptions);
    const verificationReport = await importer.runImport();
    diag.stepEnd("BUILD_NODES", "ok", {
      nodes: verificationReport.totalElements,
    });

    diag.stepStart("VERIFY", "Finalizing");
    const enhancedStats = {
      elements: verificationReport.totalElements,
      images: verificationReport.imagesProcessed,
      processingTime: verificationReport.totalProcessingTime,
    };

    figma.ui.postMessage({ type: "complete", stats: enhancedStats });
    diag.stepEnd("VERIFY", "ok");
    diag.endRun("ok", { nodes: verificationReport.totalElements });

    // AUTOMATED DEBUG EXPORT
    const mainFrame = importer.getMainFrame();
    const jobId =
      options?.jobId ||
      (schema.metadata?.url ? "job_" + Date.now() : "unknown_job");
    if (mainFrame) {
      const selectionMap = importer.getSelectionMap();
      await exportAndUploadDebugArtifacts(
        mainFrame,
        jobId,
        schema,
        enhancedStats,
        selectionMap,
      );
    }

    postHandoffStatus("waiting");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Import failed";
    diag.error("Import execution failed", {
      message,
      stack: error instanceof Error ? error.stack : "",
    });
    diag.endRun("error", { message });

    figma.ui.postMessage({ type: "error", message });
    figma.notify(`✗ Import failed: ${message}`, { error: true });
    postHandoffStatus("error", message);
  } finally {
    isImporting = false;
  }
}

function postHandoffStatus(
  status: HandoffStatus,
  detail?: string,
  meta?: Record<string, any>,
) {
  if (status === "error") {
    diag.error(`Handoff Status: ${status}`, { detail, ...meta });
  } else if (status === "job-ready") {
    diag.info(`Handoff Status: ${status}`, { detail, ...meta });
  } else {
    diag.debug(`Handoff Status: ${status}`, { detail, ...meta });
  }

  if (status === lastHandoffStatus && status !== "job-ready") {
    return;
  }

  lastHandoffStatus = status;
  figma.ui.postMessage({ type: "handoff-status", status, detail, meta });
}

function updateChromeConnection(state: "connected" | "disconnected") {
  if (state === chromeConnectionState) return;
  chromeConnectionState = state;

  figma.ui.postMessage({
    type:
      state === "connected"
        ? "chrome-extension-connected"
        : "chrome-extension-disconnected",
  });
}

function updateServerConnection(state: "connected" | "disconnected") {
  if (state === serverConnectionState) return;
  serverConnectionState = state;

  figma.ui.postMessage({
    type: state === "connected" ? "server-connected" : "server-disconnected",
  });
}

function handleTelemetryFromUi(telemetry?: HandoffTelemetry | null) {
  lastTelemetry = telemetry || null;
  figma.ui.postMessage({
    type: "handoff-telemetry",
    telemetry: telemetry || null,
  });

  if (!telemetry) {
    updateServerConnection("disconnected");
    updateChromeConnection("disconnected");
    return;
  }

  const now = Date.now();
  // Sync with UI's 120s TTL
  const TTL = 120000;
  const extensionHeartbeat =
    typeof telemetry.lastExtensionPingAt === "number" &&
    now - telemetry.lastExtensionPingAt < TTL;
  const pluginPolling =
    typeof telemetry.lastPluginPollAt === "number" &&
    now - telemetry.lastPluginPollAt < TTL;

  updateChromeConnection(extensionHeartbeat ? "connected" : "disconnected");
  updateServerConnection(pluginPolling ? "connected" : "disconnected");
}

function applyTelemetry(telemetry?: HandoffTelemetry | null): boolean {
  if (!telemetry) return false;

  console.log("📡 Applying telemetry:", telemetry);
  lastTelemetry = telemetry;

  const now = Date.now();
  const TTL = 120000;
  const extensionHeartbeat =
    typeof telemetry.lastExtensionPingAt === "number" &&
    now - telemetry.lastExtensionPingAt < TTL;

  updateChromeConnection(extensionHeartbeat ? "connected" : "disconnected");
  updateServerConnection("connected");
  figma.ui.postMessage({ type: "handoff-telemetry", telemetry });
  return true;
}

async function checkServer(url: string): Promise<boolean> {
  try {
    const fetchPromise = fetch(`${url}/api/health?source=discovery`, {
      method: "GET",
      headers: { "cache-control": "no-cache" },
    });

    const timeoutPromise = new Promise<Response>((_, reject) =>
      setTimeout(() => reject(new Error("Timeout")), 1500),
    );

    const resp = await Promise.race([fetchPromise, timeoutPromise]);
    return resp.ok;
  } catch (e) {
    return false;
  }
}

async function discoverServerAndStartPolling() {
  figma.ui.postMessage({
    type: "handoff-status",
    status: "waiting",
    detail: "Connecting...",
  });

  let found = false;
  for (let i = 0; i < HANDOFF_BASES.length; i++) {
    const url = HANDOFF_BASES[i];
    console.log(`[CONN] Checking ${url}...`);
    if (await checkServer(url)) {
      console.log(`[CONN] Connected to ${url}`);
      handoffBaseIndex = i;
      found = true;
      break;
    }
  }

  if (!found) {
    console.warn("[CONN] Could not connect to any server");
    postHandoffStatus(
      "error",
      "Could not connect to helper app. Please check if start.sh is running.",
    );
  }

  // Start polling regardless, to keep trying if server comes up later
  void pollHandoffJobs();
  if (!handoffPollTimer) {
    let lastPollStart = 0;
    handoffPollTimer = setInterval(() => {
      // WATCHDOG: Warn if poll is stuck, but don't auto-reset
      // Large imports (YouTube, Spotify) can legitimately take 2-5 minutes
      const pollDuration = Date.now() - lastPollStart;
      if (handoffPollInFlight && pollDuration > 120_000) {
        // Only warn once per minute to avoid log spam
        if (pollDuration % 60_000 < HANDOFF_POLL_INTERVAL) {
          console.warn(
            `[POLL] Watchdog: Import running for ${Math.floor(pollDuration / 60_000)}+ minutes`,
          );
        }
        // After 5 minutes, notify user but still don't auto-reset (could corrupt state)
        if (pollDuration > 300_000 && pollDuration < 300_000 + HANDOFF_POLL_INTERVAL) {
          postHandoffStatus(
            "error",
            "Import taking unusually long. Reload plugin if stuck.",
          );
        }
      }

      if (handoffPollInFlight) return;
      lastPollStart = Date.now();
      void pollHandoffJobs();
    }, HANDOFF_POLL_INTERVAL);
  }
}

function startHandoffPolling() {
  if (handoffPollTimer) return;
  void discoverServerAndStartPolling();
}

function currentHandoffBase(): string {
  return HANDOFF_BASES[handoffBaseIndex] || "http://127.0.0.1:4411";
}

function rotateHandoffBase() {
  handoffBaseIndex = (handoffBaseIndex + 1) % HANDOFF_BASES.length;
  console.log(
    `[HANDOFF] Rotated to base index ${handoffBaseIndex}: ${currentHandoffBase()}`,
  );
}

// Reset to primary port (4411) when we know it's working
function resetHandoffToPrimary() {
  if (handoffBaseIndex !== 0) {
    console.log(
      `[HANDOFF] Resetting from fallback port (index ${handoffBaseIndex}) back to primary (4411)`,
    );
    handoffBaseIndex = 0;
  }
}

function buildHandoffHeaders(
  base: Record<string, string> = {},
): Record<string, string> {
  const headers = { ...base };
  if (HANDOFF_API_KEY) headers["x-api-key"] = HANDOFF_API_KEY;
  return headers;
}

async function loadAvailableFonts(): Promise<{
  families: Set<string>;
  variants: Set<string>;
}> {
  if (availableFontsCache) return availableFontsCache;
  const fonts = await figma.listAvailableFontsAsync();
  const families = new Set<string>();
  const variants = new Set<string>();
  for (const font of fonts) {
    families.add(font.fontName.family);
    variants.add(`${font.fontName.family}::${font.fontName.style}`);
  }
  availableFontsCache = { families, variants };
  return availableFontsCache;
}

function weightToStyle(weight: number): string {
  if (weight >= 900) return "Black";
  if (weight >= 800) return "Extra Bold";
  if (weight >= 700) return "Bold";
  if (weight >= 600) return "Semi Bold";
  if (weight >= 500) return "Medium";
  if (weight >= 300) return "Light";
  return "Regular";
}

async function findMissingFonts(schema: any): Promise<MissingFontReport[]> {
  const missing: Map<string, Set<string>> = new Map();
  const { families, variants } = await loadAvailableFonts();

  const addMissing = (family: string, style: string) => {
    if (!family) return;
    const key = family;
    if (!missing.has(key)) missing.set(key, new Set<string>());
    missing.get(key)!.add(style);
  };

  // From metadata fonts
  if (schema?.metadata?.fonts) {
    for (const font of schema.metadata.fonts) {
      const family = font.family;
      const weights: number[] = font.weights || [400];
      const styles = weights.map((w) => weightToStyle(w));
      styles.forEach((style) => {
        if (!variants.has(`${family}::${style}`)) {
          addMissing(family, style);
        }
      });
    }
  }

  // From assets.fonts (captured @font-face)
  if (schema?.assets?.fonts) {
    Object.values(schema.assets.fonts).forEach((f: any) => {
      const family = f.family || "";
      const style = f.style || weightToStyle(parseInt(f.weight || "400", 10));
      if (!variants.has(`${family}::${style}`)) {
        addMissing(family, style);
      }
    });
  }

  // If any text nodes carry explicit font styles, sample a small walk
  const walkTextFonts = (node: any) => {
    if (!node) return;
    if (node.type === "TEXT" && node.textStyle) {
      const family = node.textStyle.fontFamily;
      const style = node.textStyle.fontStyle
        ? node.textStyle.fontStyle
        : weightToStyle(node.textStyle.fontWeight || 400);
      if (!variants.has(`${family}::${style}`)) {
        addMissing(family, style);
      }
    }
    if (node.children) {
      for (const child of node.children) walkTextFonts(child);
    }
  };
  walkTextFonts(schema?.root);

  return Array.from(missing.entries()).map(([family, styles]) => ({
    family,
    styles: Array.from(styles),
  }));
}

async function fetchHandoffHistory(): Promise<{
  jobs: HandoffHistoryItem[];
  telemetry?: HandoffTelemetry | null;
}> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < HANDOFF_BASES.length; attempt++) {
    handoffBaseIndex = attempt;
    try {
      const response = await fetch(`${currentHandoffBase()}/api/jobs/history`, {
        headers: buildHandoffHeaders({ "cache-control": "no-cache" }),
      });
      if (!response.ok) {
        lastError = new Error(
          `History request failed: HTTP ${response.status}`,
        );
        continue;
      }
      const body = (await response.json()) as {
        jobs?: HandoffHistoryItem[];
        telemetry?: HandoffTelemetry | null;
      };
      applyTelemetry(body?.telemetry || null);
      return { jobs: body?.jobs || [], telemetry: body?.telemetry || null };
    } catch (err) {
      lastError =
        err instanceof Error ? err : new Error(formatUnknownError(err));
      continue;
    }
  }
  throw lastError || new Error("History request failed");
}

async function fetchHandoffJob(jobId: string): Promise<any> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < HANDOFF_BASES.length; attempt++) {
    handoffBaseIndex = attempt;
    try {
      const response = await fetch(
        `${currentHandoffBase()}/api/jobs/${jobId}`,
        {
          headers: buildHandoffHeaders({ "cache-control": "no-cache" }),
        },
      );
      if (!response.ok) {
        lastError = new Error(`Job fetch failed: HTTP ${response.status}`);
        continue;
      }
      const body = (await response.json()) as {
        job?: { id: string; payload?: any; permalink?: string };
        telemetry?: HandoffTelemetry | null;
      };
      applyTelemetry(body?.telemetry || null);
      const payload = decompressPayload(body?.job?.payload);
      return { job: body?.job, payload };
    } catch (err) {
      lastError =
        err instanceof Error ? err : new Error(formatUnknownError(err));
      continue;
    }
  }
  throw lastError || new Error("Job fetch failed");
}

async function pollHandoffJobs(): Promise<void> {
  handoffPollInFlight = true;
  try {
    console.log("[POLL] Starting poll cycle", {
      isImporting,
      currentBase: currentHandoffBase(),
    });

    // Respect cooldown to avoid hammering the server (e.g., after 429)
    const now = Date.now();
    if (handoffCooldownUntil && now < handoffCooldownUntil) {
      postHandoffStatus(
        "waiting",
        `Cooling down… retrying in ${Math.ceil(
          (handoffCooldownUntil - now) / 1000,
        )}s`,
      );
      return;
    }
    // Reset cooldown/backoff when we're allowed to poll again
    if (handoffCooldownUntil && now >= handoffCooldownUntil) {
      handoffCooldownUntil = 0;
    }

    // Try a lightweight health ping each cycle to update connection lights
    await pingHandoffHealth();

    if (isImporting) {
      console.log("[POLL] Skipping job check - already importing");
      return;
    }

    const endpoint = `${currentHandoffBase()}/api/jobs/next`;
    console.log("[POLL] Fetching jobs from:", endpoint);

    const headers: Record<string, string> = buildHandoffHeaders({
      "cache-control": "no-cache",
    });

    // CRITICAL FIX: Increase timeout to 60s to handle large payloads
    // Large imports (10MB+) can take >30s to transfer and decompress
    let signal: AbortSignal | undefined;
    let timeoutId: any;

    if (typeof AbortController !== "undefined") {
      const controller = new AbortController();
      timeoutId = setTimeout(() => controller.abort(), 60000); // 60s timeout
      signal = controller.signal;
    }

    try {
      const fetchOptions: any = {
        method: "GET",
        headers,
      };
      if (signal) {
        fetchOptions.signal = signal;
      }

      const response = await fetch(endpoint, fetchOptions);
      clearTimeout(timeoutId);

      console.log(
        "[POLL] Response status:",
        response.status,
        "at",
        currentHandoffBase(),
      );

      if (!response.ok) {
        if (response.status === 429) {
          // Rate limited: back off polling for a bit
          handoffBackoffMs = handoffBackoffMs
            ? Math.min(handoffBackoffMs * 2, 120000)
            : 15000;
          handoffCooldownUntil = Date.now() + handoffBackoffMs;
          postHandoffStatus(
            "error",
            `Server rate limited. Retrying in ${Math.ceil(
              handoffBackoffMs / 1000,
            )}s`,
          );
          updateServerConnection("disconnected");
          return;
        }
        // REMOVED: Server no longer returns 204, always returns 200 with telemetry

        // ENHANCED: Log full error details for debugging
        const errorText = await response.text().catch(() => "");
        console.error(
          `[POLL] HTTP ${response.status} from ${currentHandoffBase()}:`,
          errorText,
        );
        throw new Error(
          `HTTP ${response.status}: ${errorText || "Unknown error"}`,
        );
      }

      // Success; reset backoff
      handoffBackoffMs = 0;
      handoffCooldownUntil = 0;
      updateServerConnection("connected");

      // ENHANCED: Reset to primary port when we successfully connect to fallback
      if (handoffBaseIndex !== 0) {
        console.log(
          `[POLL] ✅ Successfully connected to fallback port, resetting to primary`,
        );
        resetHandoffToPrimary();
      }

      // Localhost handoff format: { job: { id, payload }, telemetry }
      const body = (await response.json()) as HandoffJobResponse;
      console.log("[POLL] Response body:", {
        hasJob: !!body?.job,
        hasPayload: !!body?.job?.payload,
        hasTelemetry: !!body?.telemetry,
        jobId: body?.job?.id,
      });

      applyTelemetry(body?.telemetry || null);

      if (body?.job?.payload) {
        console.log(`[POLL] ✅ Job ${body.job.id} found! Starting import...`);
        const payload = decompressPayload(body.job.payload);
        postHandoffStatus("job-ready", `Importing job ${body.job.id}`);
        await handleImportRequest(
          payload,
          { jobId: body.job.id },
          "auto-import",
        );
      } else {
        console.log("[POLL] No job in response");
        postHandoffStatus("waiting");
      }
      updateServerConnection("connected");
    } catch (fetchError: any) {
      clearTimeout(timeoutId);
      if (fetchError.name === "AbortError") {
        console.error(
          `[POLL] ⏱️ Request timed out after 60s at ${currentHandoffBase()}`,
        );
        throw new Error(
          `Request timed out after 60s (trying ${currentHandoffBase()})`,
        );
      }
      throw fetchError;
    }
  } catch (error) {
    console.error("[POLL] ❌ Error during poll:", error);
    const message = formatUnknownError(error);
    const baseUrl = currentHandoffBase();

    // ENHANCED: Provide better context about which server failed
    const contextualMessage = `${message} (server: ${baseUrl})`;

    postHandoffStatus("error", contextualMessage);
    updateServerConnection("disconnected");

    // ENHANCED: Only rotate if we haven't tried all bases yet
    const nextIndex = (handoffBaseIndex + 1) % HANDOFF_BASES.length;
    if (nextIndex !== 0) {
      console.log(
        `[POLL] 🔄 Rotating to next server (${HANDOFF_BASES[nextIndex]})`,
      );
      rotateHandoffBase();
    } else {
      console.error(
        `[POLL] ❌ All ${HANDOFF_BASES.length} server(s) failed, will retry on next poll`,
      );
    }
  } finally {
    handoffPollInFlight = false;
  }
}

// Enhanced decompression function with comprehensive debugging
function decompressPayload(payload: any): any {
  console.log("🔍 [DECOMPRESS] Starting payload analysis...", {
    hasPayload: !!payload,
    payloadType: typeof payload,
    isCompressed: !!(payload && payload.compressed),
    hasData: !!(payload && payload.data),
    dataType: payload && payload.data ? typeof payload.data : "none",
    hasSchema: !!(payload && payload.schema),
    payloadKeys:
      payload && typeof payload === "object" ? Object.keys(payload) : [],
  });

  // Handle compressed payload
  if (payload && payload.compressed && typeof payload.data === "string") {
    console.log("📦 [DECOMPRESS] Processing compressed payload...", {
      dataLength: payload.data.length,
      compressionType: payload.compressionType || "pako",
    });

    try {
      console.log("📦 [DECOMPRESS] Step 1: Base64 decode...");
      const compressedData = safeBase64ToUint8(payload.data);
      console.log("✅ [DECOMPRESS] Base64 decoded successfully", {
        originalSize: payload.data.length,
        binarySize: compressedData.length,
      });

      console.log("📦 [DECOMPRESS] Step 2: Pako inflate...");
      if (typeof pako.inflate !== "function") {
        throw new Error("Pako inflate function not available");
      }

      // OPTIMIZATION: Inflate to string directly.
      // In Figma's plugin environment, TextDecoder is not available in the main thread.
      // Pako's to: 'string' option handles the decoding internally using a fallback
      // that works in limited JS environments like QuickJS.
      console.log("📦 [DECOMPRESS] Step 2: Pako inflate to string...");
      const jsonString = pako.inflate(compressedData, { to: "string" });
      console.log("✅ [DECOMPRESS] Pako inflate successful", {
        stringLength: jsonString.length,
        preview: jsonString.substring(0, 200) + "...",
      });

      console.log("📦 [DECOMPRESS] Step 3: JSON parse...");
      const parsed = JSON.parse(jsonString);
      console.log("✅ [DECOMPRESS] JSON parse successful", {
        hasRoot: !!(parsed && parsed.root),
        hasTree: !!(parsed && parsed.tree),
        hasMetadata: !!(parsed && parsed.metadata),
        parsedKeys:
          parsed && typeof parsed === "object" ? Object.keys(parsed) : [],
        rootChildren:
          parsed && parsed.root && parsed.root.children
            ? parsed.root.children.length
            : 0,
        treeChildren:
          parsed && parsed.tree && parsed.tree.children
            ? parsed.tree.children.length
            : 0,
      });

      // Return the most appropriate data structure
      const result = parsed?.schema ?? parsed ?? payload;
      console.log("✅ [DECOMPRESS] Decompression completed", {
        resultType: typeof result,
        hasRoot: !!(result && result.root),
        hasTree: !!(result && result.tree),
        finalKeys:
          result && typeof result === "object" ? Object.keys(result) : [],
      });

      // Validate result has expected schema structure
      if (!result || typeof result !== "object") {
        throw new Error(
          `Decompressed payload is not an object: ${typeof result}`,
        );
      }
      // Accept either:
      // 1. Single-viewport format with root/tree
      // 2. Multi-viewport format with multiViewport flag and captures array
      const isSingleViewport = !!(result.root || result.tree);
      const isMultiViewport = !!(
        result.multiViewport && Array.isArray(result.captures)
      );
      if (!isSingleViewport && !isMultiViewport) {
        throw new Error(
          `Decompressed payload missing expected fields. Need 'root'/'tree' for single-viewport or 'multiViewport'+'captures' for multi-viewport. Keys: ${Object.keys(
            result,
          ).join(", ")}`,
        );
      }

      return result;
    } catch (e) {
      // CRITICAL FIX: Don't stringify large payloads - causes OOM errors
      const getSafePayloadPreview = (p: any): string => {
        if (!p || typeof p !== "object") return String(p).substring(0, 100);
        const keys = Object.keys(p).slice(0, 5);
        return `Payload keys: [${keys.join(", ")}]`;
      };

      console.error("❌ [DECOMPRESS] Decompression failed:", {
        error: e instanceof Error ? e.message : String(e),
        stack: e instanceof Error ? e.stack?.substring(0, 500) : undefined,
        payloadPreview: getSafePayloadPreview(payload),
      });

      // Handle specific error cases
      const msg = e instanceof Error ? e.message : String(e);

      // Truncated JSON (common with large captures or network issues)
      if (msg.includes("Unexpected end of JSON input")) {
        throw new Error(
          "Capture data is corrupt (truncated). The page may be too large to transfer reliably. Please try capturing a smaller section or use 'Server Capture'.",
        );
      }

      // CRITICAL: Don't silently return corrupted data
      // If we failed to parse/inflate, it's a hard failure
      if (msg.match(/memory/i)) {
        throw new Error(
          "Out of memory during import. The web page is too large for Figma to process at once. Try capturing a smaller section.",
        );
      }
      throw e;
    }
  }

  // Handle schema wrapper
  if (payload && payload.schema) {
    console.log("🔍 [DECOMPRESS] Found schema wrapper, unwrapping...", {
      schemaType: typeof payload.schema,
      schemaKeys:
        payload.schema && typeof payload.schema === "object"
          ? Object.keys(payload.schema)
          : [],
      hasRoot: !!(payload.schema && payload.schema.root),
    });
    return payload.schema;
  }

  // Handle direct payload
  console.log(
    "🔍 [DECOMPRESS] Using payload directly (no compression or wrapping detected)",
    {
      hasRoot: !!(payload && payload.root),
      hasTree: !!(payload && payload.tree),
      directKeys:
        payload && typeof payload === "object" ? Object.keys(payload) : [],
    },
  );

  return payload;
}

function safeBase64ToUint8(base64: string): Uint8Array {
  try {
    if (typeof atob === "function") {
      const binary = atob(base64);
      const len = binary.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      return bytes;
    }
  } catch (err) {
    console.warn("atob failed, falling back to manual decoder", err);
  }

  // Manual base64 decode
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const lookup: Record<string, number> = {};
  for (let i = 0; i < chars.length; i++) lookup[chars[i]] = i;

  const cleaned = base64.replace(/=+$/, "");
  const bufferLength = (cleaned.length * 3) / 4;
  const bytes = new Uint8Array(bufferLength | 0);

  let p = 0;
  for (let i = 0; i < cleaned.length; i += 4) {
    const encoded1 = lookup[cleaned[i]] ?? 0;
    const encoded2 = lookup[cleaned[i + 1]] ?? 0;
    const encoded3 = lookup[cleaned[i + 2]] ?? 0;
    const encoded4 = lookup[cleaned[i + 3]] ?? 0;

    const triplet =
      (encoded1 << 18) | (encoded2 << 12) | (encoded3 << 6) | encoded4;

    if (p < bytes.length) bytes[p++] = (triplet >> 16) & 0xff;
    if (p < bytes.length) bytes[p++] = (triplet >> 8) & 0xff;
    if (p < bytes.length) bytes[p++] = triplet & 0xff;
  }

  return bytes;
}

async function pingHandoffHealth(): Promise<void> {
  try {
    const response = await fetch(
      `${currentHandoffBase()}/api/health?source=plugin`,
      {
        headers: buildHandoffHeaders({ "cache-control": "no-cache" }),
      },
    );
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`HTTP ${response.status} ${text || ""}`.trim());
    }
    const body = (await response.json()) as HandoffHealthResponse;
    applyTelemetry(body?.telemetry || null);
    console.log("[handoff] Health OK", {
      base: currentHandoffBase(),
      queueLength: body.queueLength,
    });

    // If we're on a fallback port but primary (4411) is now responding, reset to primary
    if (handoffBaseIndex !== 0 && currentHandoffBase().includes("4411")) {
      resetHandoffToPrimary();
    }

    updateServerConnection("connected");
    figma.ui.postMessage({
      type: "handoff-health",
      base: currentHandoffBase(),
      status: "ok",
      queueLength: body.queueLength,
    });
  } catch (error) {
    const message = formatUnknownError(error);
    const baseUrl = currentHandoffBase();

    // Provide context about which server failed
    const contextualMessage = message.includes("localhost:4411")
      ? message
      : `${message} (checking ${baseUrl})`;

    updateServerConnection("disconnected");
    postHandoffStatus("error", contextualMessage);
    rotateHandoffBase();
    console.warn(
      "[handoff] Health check failed, rotating base",
      contextualMessage,
    );
    figma.ui.postMessage({
      type: "handoff-health",
      base: currentHandoffBase(),
      status: `error: ${contextualMessage}`,
      queueLength: null,
    });
  }
}

// Options from the enhanced UI
interface EnhancedUIOptions {
  autoLayout?: boolean;
  components?: boolean;
  styles?: boolean;
  variants?: boolean;
}

// Enhanced import handler for the new UI
async function handleEnhancedImport(
  data: any,
  options: EnhancedUIOptions | undefined,
): Promise<void> {
  if (isImporting) {
    figma.ui.postMessage({
      type: "import-error",
      error: "Another import is already in progress",
    });
    return;
  }

  if (!data) {
    figma.ui.postMessage({
      type: "import-error",
      error: "No data provided for import",
    });
    return;
  }

  isImporting = true;

  try {
    // Send initial progress
    figma.ui.postMessage({
      type: "progress",
      percent: 0,
      message: "Preparing import...",
      phase: "Initialize",
    });

    const treeNorm = normalizeSchemaTreeForFigma(data);
    if (treeNorm.removedNodes > 0 || treeNorm.renamedNodes > 0) {
      console.log(
        "🧹 Normalized schema tree for professional nesting:",
        treeNorm,
      );
    }

    if (options?.autoLayout !== false) {
      console.log("✅ Preparing layout schema (Auto Layout enabled)...");
      prepareLayoutSchema(data);
      console.log("✅ Layout schema prepared.");
    } else {
      console.log(
        "🧷 Pixel-perfect mode: skipping prepareLayoutSchema() (Auto Layout disabled)",
      );
    }

    // Transform options from enhanced UI format
    const enhancedOptions: Partial<EnhancedImportOptions> = {
      ...defaultEnhancedOptions,
      // UI overrides (optional). Defaults come from defaultEnhancedOptions.
      applyAutoLayout:
        options?.autoLayout ?? defaultEnhancedOptions.applyAutoLayout,
      createStyles: options?.styles ?? defaultEnhancedOptions.createStyles,
      // These toggles map to our enhanced importer capabilities
      createMainFrame: true,
      enableBatchProcessing: true,
      verifyPositions: true,
      useHierarchyInference: false, // CRITICAL FIX: Disable hierarchy inference - it collapses nodes incorrectly
    };

    const importer = new EnhancedFigmaImporter(data, enhancedOptions);
    const verificationReport = await importer.runImport();

    const stats = {
      nodes: verificationReport.totalElements || 0,
      styles: data?.styles ? Object.keys(data.styles || {}).length : 0,
      components: verificationReport.totalElements || 0,
    };

    figma.ui.postMessage({ type: "import-stats", ...stats });
    figma.ui.postMessage({
      type: "progress",
      percent: 100,
      message: "Import completed!",
      phase: "Complete",
    });
    figma.ui.postMessage({ type: "complete", stats });

    figma.notify(`✓ Successfully imported ${stats.nodes} elements!`, {
      timeout: 3000,
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Import failed. See console for details.";
    diag.error("Import failed exception", {
      message,
      stack: String(error instanceof Error ? error.stack : ""),
    });
    // Close open steps with error (best effort)
    diag.endRun("error", { message });

    figma.ui.postMessage({ type: "error", message });
    figma.notify(`✗ Import failed: ${message}`, { error: true });
  } finally {
    isImporting = false;
  }
}

// Enhanced import handler V2 with pixel-perfect positioning and verification
async function handleEnhancedImportV2(
  data: IncomingSchemaData,
  options: Partial<EnhancedImportOptions> | undefined,
): Promise<void> {
  if (isImporting) {
    figma.ui.postMessage({
      type: "import-error",
      error: "Another import is already in progress",
    });
    return;
  }

  if (!data) {
    figma.ui.postMessage({
      type: "import-error",
      error: "No data provided for import",
    });
    return;
  }

  isImporting = true;
  const runId = diag.startRun({ type: "enhanced-v2" });

  try {
    // CRITICAL DEBUG: Log incoming data structure before processing
    diag.stepStart("PREFLIGHT", "Preflight Checks");
    console.log("[SCHEMA DEBUG] Incoming data structure:", {
      hasRoot: !!data?.root,
      hasTree: !!data?.tree,
      hasCaptures: !!data?.captures,
      hasRawSchemaJson: !!data?.rawSchemaJson,
      hasSchema: !!data?.schema,
      capturesLength: data?.captures?.length,
      dataKeys: data ? Object.keys(data).slice(0, 20) : [],
      firstCaptureKeys: data?.captures?.[0]
        ? Object.keys(data.captures[0]).slice(0, 20)
        : [],
      firstCaptureDataKeys: data?.captures?.[0]?.data
        ? Object.keys(data.captures[0].data).slice(0, 20)
        : [],
    });

    // Unwrap rawSchemaJson if present (chunked transfer format from Chrome extension)
    let schema = data;
    if (data.rawSchemaJson && typeof data.rawSchemaJson === "string") {
      console.log(
        "🔓 Unwrapping rawSchemaJson string from chunked transfer...",
      );
      try {
        schema = JSON.parse(data.rawSchemaJson);
        console.log("✅ Successfully parsed rawSchemaJson", {
          hasRoot: !!schema?.root,
          hasTree: !!schema?.tree,
        });
      } catch (parseError) {
        const errorMsg =
          parseError instanceof Error ? parseError.message : "Parse failed";
        console.error("❌ Failed to parse rawSchemaJson:", errorMsg);
        figma.ui.postMessage({
          type: "error",
          message: `Failed to parse schema data: ${errorMsg}`,
        });
        isImporting = false;
        return;
      }
    }

    // Unwrap multi-viewport format if present
    if (Array.isArray(schema.captures) && schema.captures.length > 0) {
      console.log("🔓 Unwrapping multi-viewport capture format (V2)...");
      let picked: any = null;
      for (const cap of schema.captures) {
        if (!cap) continue;
        // Check for both modern 'root' and legacy 'tree' fields
        const candidate =
          cap.data?.root || cap.data?.tree
            ? cap.data
            : cap.data?.schema?.root || cap.data?.schema?.tree
              ? cap.data.schema
              : cap.data?.rawSchemaJson
                ? JSON.parse(cap.data.rawSchemaJson)
                : cap.data || cap.schema;
        if (candidate?.root || candidate?.tree) {
          picked = candidate;
          console.log(
            `✅ Using viewport: ${
              cap.viewport || cap.name || "unnamed"
            } (V2), has ${candidate.root ? "root" : "tree"}`,
          );
          break;
        }
        if (cap?.rawSchemaJson && !picked) {
          try {
            const parsed = JSON.parse(cap.rawSchemaJson);
            if (parsed?.root || parsed?.tree) {
              picked = parsed;
              console.log(
                `✅ Parsed rawSchemaJson for viewport: ${
                  cap.viewport || cap.name || "unnamed"
                } (V2)`,
              );
              break;
            }
          } catch {
            // ignore parse error
          }
        }
      }
      if (picked) {
        schema = picked;
      } else {
        console.error(
          "❌ Multi-viewport format detected but no valid capture data found (V2)",
        );
        figma.ui.postMessage({
          type: "error",
          message: "Multi-viewport format is invalid - no data in captures",
        });
        isImporting = false;
        return;
      }
    }

    // Apply migration if legacy tree exists
    if (schema.tree && !schema.root) {
      console.log(
        "🔄 [V2-MIGRATION] Converting legacy 'tree' to canonical 'root'",
      );
      schema.root = schema.tree;
      delete schema.tree;
    }

    // Fallback: unwrap rawSchemaJson or nested schema if root missing
    if (!schema.root) {
      if (schema.rawSchemaJson && typeof schema.rawSchemaJson === "string") {
        try {
          const parsed = JSON.parse(schema.rawSchemaJson);
          if (parsed?.root) {
            schema = parsed;
          } else if (parsed?.tree) {
            console.log(
              "🔄 [NESTED-IMPORT] Converting rawSchemaJson legacy 'tree' to canonical 'root'",
            );
            parsed.root = parsed.tree;
            delete parsed.tree;
            schema = parsed;
          }
        } catch {
          // ignore
        }
      } else if (schema.schema?.root) {
        schema = schema.schema;
      } else if (schema.schema?.tree) {
        console.log(
          "🔄 [NESTED-IMPORT] Converting nested legacy 'tree' to canonical 'root'",
        );
        schema.schema.root = schema.schema.tree;
        delete schema.schema.tree;
        schema = schema.schema;
      }
    }

    // Deep search for any nested object that contains a root or tree
    if (!schema.root) {
      const visited = new Set<any>();
      const findSchemaWithRoot = (obj: any): any | null => {
        if (!obj || typeof obj !== "object") return null;
        if (visited.has(obj)) return null;
        visited.add(obj);
        if ((obj as any).root || (obj as any).tree) return obj;
        for (const value of Object.values(obj)) {
          if (value && typeof value === "object") {
            const found = findSchemaWithRoot(value);
            if (found) return found;
          }
        }
        return null;
      };
      const nested = findSchemaWithRoot(schema);
      if (nested) {
        console.log("✅ Found nested schema with root/tree (V2), using it");
        schema = nested;
        // Migrate if tree found
        if (nested.tree && !nested.root) {
          console.log(
            "🔄 [NESTED-V2] Converting nested 'tree' to canonical 'root'",
          );
          nested.root = nested.tree;
          delete nested.tree;
        }
      }
    }

    // Final validation

    if (!schema.root) {
      // CRITICAL FIX: Don't stringify large schemas - causes OOM errors

      const getSafePreview = (obj: any): string => {
        if (!obj || typeof obj !== "object")
          return String(obj).substring(0, 200);

        const keys = Object.keys(obj).slice(0, 10);

        return `Object with keys: [${keys.join(", ")}${
          keys.length >= 10 ? "..." : ""
        }]`;
      };

      console.error("❌ No root data available (V2). Data structure:", {
        hasData: !!schema,

        dataKeys:
          schema && typeof schema === "object" ? Object.keys(schema) : [],

        dataType: typeof schema,

        dataPreview: getSafePreview(schema),
      });

      diag.error(
        "No root data available (V2)",
        { keys: schema ? Object.keys(schema) : [] },
        "PREFLIGHT",
      );

      diag.stepEnd("PREFLIGHT", "error");

      diag.endRun("error", { message: "No root data" });

      figma.ui.postMessage({
        type: "error",

        message:
          "No root data available for import. The schema may be in an unsupported format.",
      });

      isImporting = false;

      return;
    }

    console.log("🚀 Starting enhanced import V2 with schema:", {
      version: schema.version,

      rootPresent: !!schema.root,

      rootType: schema.root?.type,

      rootName: schema.root?.name,

      rootChildren: schema.root?.children?.length || 0,

      assets: schema.assets
        ? Object.keys(schema.assets.images || {}).length
        : 0,

      metadata: schema.metadata ? "present" : "missing",
    });

    // Publish build plan

    const plan = createBuildPlanFromSchema(schema);

    diag.publishPlan(plan);

    diag.stepEnd("PREFLIGHT", "ok");

    // ✅ IMPORTANT: run the same layout preprocessing as the other path

    // (unless pixel-perfect mode disables Auto Layout)

    diag.stepStart("PREPARE_CANVAS", "Prepare Canvas");

    console.log("✅ Preparing layout schema (V2)...");

    const treeNorm = normalizeSchemaTreeForFigma(schema);

    if (treeNorm.removedNodes > 0 || treeNorm.renamedNodes > 0) {
      console.log(
        "🧹 Normalized schema tree for professional nesting:",

        treeNorm,
      );

      diag.info("Normalized schema tree", treeNorm as any, "PREPARE_CANVAS");
    }

    if (options?.applyAutoLayout !== false) {
      prepareLayoutSchema(schema);

      console.log("✅ Layout schema prepared (V2).");
    } else {
      console.log(
        "🧷 Pixel-perfect mode: skipping prepareLayoutSchema() (Auto Layout disabled)",
      );
    }

    const removedPaletteFills = sanitizeLargeVibrantPaletteFills(schema);

    if (removedPaletteFills > 0) {
      console.warn(
        `⚠️ Removed ${removedPaletteFills} large-node Vibrant palette fill(s) for pixel fidelity`,
      );

      diag.warn(
        `Removed ${removedPaletteFills} vibrant fills`,
        {},
        "PREPARE_CANVAS",
      );
    }

    diag.stepEnd("PREPARE_CANVAS", "ok");

    // Transform options to enhanced format

    const enhancedOptions: Partial<EnhancedImportOptions> = {
      createMainFrame: true,

      enableBatchProcessing: true,

      verifyPositions: false,

      maxBatchSize: 10,

      coordinateTolerance: 2,

      enableDebugMode: false,

      retryFailedImages: true,

      enableProgressiveLoading: false,

      useHierarchyInference: false, // CRITICAL FIX: Disable hierarchy inference - it collapses nodes incorrectly

      ...options,
    };

    // Create enhanced importer instance

    const enhancedImporter = new EnhancedFigmaImporter(schema, enhancedOptions);

    // Set up progress callback if available (assuming EnhancedFigmaImporter supports it or we add it)

    // Note: EnhancedFigmaImporter might not have setProgressCallback exposed yet,

    // but we should try to hook it up if possible or add it.

    // For now, we'll send a starting progress message.

    figma.ui.postMessage({
      type: "progress",

      percent: 10,

      message: "Starting enhanced import...",

      phase: "Initialize",
    });

    // Run the enhanced import with verification

    diag.stepStart("BUILD_NODES", "Build Nodes");

    const verificationReport = await enhancedImporter.runImport();

    diag.stepEnd("BUILD_NODES", "ok", {
      totalNodes: verificationReport.totalElements,
    });

    diag.stepStart("VERIFY", "Verify Import");

    // Send enhanced statistics including verification report

    const stats = {
      nodes: verificationReport.totalElements,

      styles: 0, // Will be enhanced later

      components: 0, // Will be enhanced later

      images: verificationReport.imagesProcessed,

      verification: {
        totalElements: verificationReport.totalElements,

        positionsVerified: verificationReport.positionsVerified,

        positionsWithinTolerance: verificationReport.positionsWithinTolerance,

        positionsOutsideTolerance: verificationReport.positionsOutsideTolerance,

        maxDeviation: verificationReport.maxDeviation,

        averageDeviation: verificationReport.averageDeviation,

        problematicElements: verificationReport.problematicElements.length,
      },
    };

    figma.ui.postMessage({ type: "import-stats", ...stats });

    figma.ui.postMessage({ type: "complete", stats });

    // AUTOMATED DEBUG EXPORT
    const mainFrame = enhancedImporter.getMainFrame();
    const jobId =
      options?.jobId ||
      (schema.metadata?.url ? "job_" + Date.now() : "unknown_job");
    if (mainFrame) {
      const selectionMap = enhancedImporter.getSelectionMap();
      await exportAndUploadDebugArtifacts(
        mainFrame,
        jobId,
        schema,
        stats,
        selectionMap,
      );
    }

    // Show enhanced notification with verification info

    if (verificationReport.positionsOutsideTolerance > 0) {
      const msg = `Import complete with ${verificationReport.positionsOutsideTolerance} mismatches`;

      figma.notify(msg, { timeout: 4000 });

      diag.warn(msg, stats.verification, "VERIFY");

      diag.stepEnd("VERIFY", "warn", stats.verification);
    } else {
      figma.notify("✅ Import complete with pixel-perfect accuracy!", {
        timeout: 3000,
      });

      diag.stepEnd("VERIFY", "ok", stats.verification);
    }

    diag.endRun("ok", { totalNodes: verificationReport.totalElements });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Import failed. See console for details.";

    diag.error("Import failure", {
      message,
      stack: error instanceof Error ? error.stack : "",
    });

    diag.endRun("error", { message });

    figma.ui.postMessage({ type: "error", message });

    figma.notify(`✗ Import failed: ${message}`, { error: true });
  } finally {
    isImporting = false;
  }
}

async function sendHandoffHistory(): Promise<void> {
  figma.ui.postMessage({ type: "history-loading" });
  try {
    const { jobs } = await fetchHandoffHistory();
    figma.ui.postMessage({ type: "history", jobs });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to load history";
    figma.ui.postMessage({ type: "history-error", message });
  }
}

async function importFromHistory(jobId: string): Promise<void> {
  if (!jobId) {
    figma.ui.postMessage({
      type: "history-error",
      message: "Missing job id",
    });
    return;
  }

  figma.ui.postMessage({
    type: "history-loading",
  });

  try {
    const { payload } = await fetchHandoffJob(jobId);
    if (!payload) {
      throw new Error("No payload found for this job");
    }
    await handleImportRequest(payload, { jobId }, "auto-import");
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to import from history";
    figma.ui.postMessage({
      type: "history-error",
      message,
    });
  }
}
