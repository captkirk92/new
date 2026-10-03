/**
 * Production-Grade Enhanced Figma Importer v2.0
 *
 * Implements pixel-perfect reconstruction with enterprise-grade reliability:
 * - Comprehensive runtime type validation
 * - Robust text node validation and font fallback
 * - NaN/Infinity guards for all numeric operations
 * - Enhanced error reporting with failed node tracking
 * - Memory management and cleanup
 * - Performance monitoring and telemetry
 * - Defensive programming patterns throughout
 * - Graceful error handling for network failures
 */

import { FontManager } from "./font-manager";
import { NodeBuilder } from "./node-builder";

// ... (other imports)

// ...

import { fetchWithProxy } from "./utils/asset-proxy";
import { StyleManager } from "./style-manager";
import { ComponentManager } from "./component-manager";
import { ImportOptions } from "./import-options";
import { ScreenshotOverlay } from "./screenshot-overlay";
import { TreeValidator } from "./tree-validator";
import { DesignTokensManager } from "./design-tokens-manager";
import { requestImageTranscode, requestWebpTranscode } from "./ui-bridge";
import { createHoverVariants } from "./hover-variant-mapper";
import {
  inferHierarchy,
  convertInferredTreeToElementNode,
} from "./hierarchy-inference";
import {
  generateTreeQualityReport,
  printTreeQualityReport,
  exportDebugArtifact,
} from "./hierarchy-inference/diagnostics";
import { ProfessionalLayoutSolver, prepareLayoutSchema } from "./layout-solver";
import {
  optimizeFigmaTree,
  type FigmaOptimizationOptions,
} from "./figma-tree-optimizer";
import { buildRenderTree, getRenderTreeStats } from "./render-tree-builder";
import { optimizeLayerTree, validateCleanup } from "./layer-cleanup-optimizer";

// Import tree chunker for large import splitting
import { chunkTree, TreeChunk, countNodes } from "./tree-chunker";

// Import shared schema types (CRITICAL: Single source of truth)
import type {
  WebToFigmaSchema,
  ElementNode,
  ValidationIssue,
  ValidationIssueSeverity,
} from "../../shared/schema";

// Import diagnostic collector for fidelity debugging
import { DiagnosticCollector } from "./diagnostic-collector";

// Import performance tracker for instrumentation
import { perfTracker, PerfPhase, yieldToMain } from "./perf-tracker";

// Import hierarchy validator for parent mismatch reporting
import { hierarchyValidator } from "./hierarchy-validation";

// ============================================================================
// TYPE DEFINITIONS WITH STRICT VALIDATION
// ============================================================================

export interface EnhancedImportOptions {
  createMainFrame: boolean;
  enableBatchProcessing: boolean;
  verifyPositions: boolean;
  maxBatchSize: number;
  coordinateTolerance: number;
  enableDebugMode: boolean;
  retryFailedImages: boolean;
  enableProgressiveLoading: boolean;
  createScreenshotOverlay?: boolean;
  usePixelPerfectPositioning?: boolean;
  showValidationMarkers?: boolean;
  applyAutoLayout?: boolean;
  createStyles?: boolean;
  maxImportDuration?: number; // Timeout in ms
  enableMemoryCleanup?: boolean;
  validateTextNodes?: boolean;
  useHierarchyInference?: boolean; // Default: true - use hierarchy inference to improve tree structure
  strictCloneMode?: boolean; // PIXEL-PERFECT: Rasterize text when exact font isn't available (preserves pixel-perfect fidelity)
  jobId?: string; // AUTOMATED DEBUG: Job ID for artifact association

  // Semantic Tree Optimization
  enableSemanticTreeOptimization?: boolean; // Enable post-import tree structure improvements
  semanticNaming?: boolean; // Apply semantic naming (Header, Navigation, etc.)
  detectComponents?: boolean; // Find and create reusable component patterns
  groupByRole?: boolean; // Group into Header/Main/Footer sections
  addVisualMarkers?: boolean; // Add emoji prefixes and color coding
  colorCodeByRole?: boolean; // Apply color coding to roles
  minComponentInstances?: number; // Minimum instances to create component (default: 3)
  parseMetaTags?: boolean; // Parse meta tags for SEO and metadata

  // Render Tree Optimization (SERVER Module)
  enableRenderTreeOptimization?: boolean; // Build render tree instead of using raw DOM tree (removes invisible nodes, materializes pseudo-elements)

  // Layer Cleanup Optimization (BUILDER Module)
  enableLayerCleanup?: boolean; // Remove wrappers, merge duplicates, flatten nesting for human-quality output
}

export interface ImageCreationResult {
  success: boolean;
  imageHash?: string;
  error?: string;
  retryAttempts: number;
  processingTime: number;
  originalHash: string;
}

export interface PositionVerificationResult {
  elementId: string;
  expected: { x: number; y: number };
  actual: { x: number; y: number };
  deviation: number;
  withinTolerance: boolean;
}

export interface TextValidationResult {
  elementId: string;
  success: boolean;
  fontLoaded: boolean;
  contentMatches: boolean;
  boundsReasonable: boolean;
  errors: string[];
}

// Deterministic reason codes for node failures/skips
export enum NodeFailureReason {
  SKIP_UNSUPPORTED_NODE_TYPE = "SKIP_UNSUPPORTED_NODE_TYPE",
  FAIL_VALIDATION = "FAIL_VALIDATION",
  FAIL_HOOK_NOT_FUNCTION = "FAIL_HOOK_NOT_FUNCTION",
  FAIL_MISSING_BOUNDS_HASRECT_FALSE = "FAIL_MISSING_BOUNDS_HASRECT_FALSE",
  FAIL_NONFINITE_GEOMETRY = "FAIL_NONFINITE_GEOMETRY",
  FAIL_IMAGE_FETCH = "FAIL_IMAGE_FETCH",
  FAIL_FONT_LOAD = "FAIL_FONT_LOAD",
  FAIL_FILL_UNSUPPORTED = "FAIL_FILL_UNSUPPORTED",
  FAIL_EFFECT_UNSUPPORTED = "FAIL_EFFECT_UNSUPPORTED",
  FAIL_SVG_PARSE = "FAIL_SVG_PARSE",
  FAIL_NODE_CREATION_NULL = "FAIL_NODE_CREATION_NULL",
  FAIL_UNKNOWN_EXCEPTION = "FAIL_UNKNOWN_EXCEPTION",
  SKIP_HIDDEN = "SKIP_HIDDEN",
}

export interface FailedNodeReport {
  id: string;
  type: string;
  error: string;
  reasonCode: NodeFailureReason;
  stack?: string;
  nodeData: any;
  parentId?: string;
  hasLayout?: boolean;
  hasRect?: boolean;
  geometry?: { width?: number; height?: number; x?: number; y?: number };
  timestamp: number;
}

export interface ImportVerificationReport {
  totalElements: number;
  successfulElements: number;
  failedElements: number;
  positionsVerified: number;
  positionsWithinTolerance: number;
  positionsOutsideTolerance: number;
  maxDeviation: number;
  averageDeviation: number;
  problematicElements: PositionVerificationResult[];
  imagesProcessed: number;
  imagesSuccessful: number;
  imagesFailed: number;
  totalProcessingTime: number;
  textNodesValidated: number;
  textValidationFailures: number;
  failedNodes: FailedNodeReport[];
  samplingUsed?: boolean;
  sampleSize?: number;
  estimatedAccuracy?: number;
  memoryUsage?: {
    imageCache: number;
    nodeCache: number;
    verificationData: number;
  };
}

interface LayoutData {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  left?: number;
  top?: number;
  right?: number;
  bottom?: number;
  pageX?: number;
  pageY?: number;
  relativeX?: number;
  relativeY?: number;
  boxSizing?: "border-box" | "content-box";
  position?: string;
}

interface ValidatedNodeData {
  id: string;
  type: string;
  htmlTag?: string;
  name?: string;
  layout?: LayoutData;
  absoluteLayout?: LayoutData;
  boundingBox?: {
    x: number;
    y: number;
    width: number;
    height: number;
    viewportX: number;
    viewportY: number;
    hasTransform: boolean;
  };
  computedPosition?: {
    position: "static" | "relative" | "absolute" | "fixed" | "sticky";
    transform: string | null;
    zIndex: number;
  };
  viewport?: {
    scrollX: number;
    scrollY: number;
    devicePixelRatio: number;
  };
  fills?: any[];
  backgrounds?: any[];
  imageHash?: string;
  children?: any[];
  characters?: string;
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: number;
  lineHeight?: number;
  letterSpacing?: number;
  textAlign?: string;
  autoLayout?: any;
  layoutMode?: string;
  position?: string;
  zIndex?: number;
  pseudoElements?: any;
  isShadowHost?: boolean;
  mlUIType?: string;
  mlConfidence?: number;
  suggestedAutoLayout?: boolean;
  suggestedLayoutMode?: string;
  layoutGrow?: number;
  layoutAlign?: string;
  strokeWeight?: number;
  [key: string]: any;
}

// ============================================================================
// VALIDATION UTILITIES
// ============================================================================

class ValidationUtils {
  static isValidNumber(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value);
  }

  static safeParseFloat(value: unknown, fallback: number = 0): number {
    if (typeof value === "number") {
      return Number.isFinite(value) ? value : fallback;
    }
    if (typeof value === "string") {
      const parsed = parseFloat(value);
      return Number.isFinite(parsed) ? parsed : fallback;
    }
    return fallback;
  }

  static clampNumber(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
  }

  static validateNodeData(data: unknown): ValidatedNodeData | null {
    if (!data || typeof data !== "object") {
      console.error("❌ [VALIDATION] Invalid node data: not an object", {
        data,
      });
      return null;
    }

    const node = data as any;

    // Required fields
    if (!node.id || typeof node.id !== "string") {
      console.error(
        "❌ [VALIDATION] Invalid node data: missing or invalid id",
        {
          hasId: !!node.id,
          idType: typeof node.id,
          node: node,
        },
      );
      return null;
    }

    // CRITICAL FIX: Migrate 'tagName' OR 'htmlTag' (from shared schema) to 'type'
    // The shared/schema.ts uses 'htmlTag'/'tagName' but the plugin expects 'type'
    if (!node.type) {
      if (node.htmlTag && typeof node.htmlTag === "string") {
        // Standardize on FRAME for most HTML elements, TEXT for text nodes if not specified
        // Logic: specific types (TEXT, IMAGE, VECTOR) should be set by extension
        // If missing, default to FRAME which is the safe container type
        node.type = "FRAME";

        // Use htmlTag as name if name is missing
        if (!node.name) node.name = node.htmlTag;
      } else if (node.tagName && typeof node.tagName === "string") {
        // Legacy schema compatibility
        node.type = "FRAME";
        if (!node.name) node.name = node.tagName;
      }
    }

    if (!node.type || typeof node.type !== "string") {
      console.warn(
        `⚠️ [VALIDATION] Node ${node.id}: missing type, defaulting to FRAME`,
      );
      node.type = "FRAME";
    }

    // Validate layout if present
    if (node.layout && typeof node.layout === "object") {
      const layout = node.layout;
      if (layout.width !== undefined && !this.isValidNumber(layout.width)) {
        console.warn(`⚠️ Node ${node.id}: invalid layout.width`);
        layout.width = 0;
      }
      if (layout.height !== undefined && !this.isValidNumber(layout.height)) {
        console.warn(`⚠️ Node ${node.id}: invalid layout.height`);
        layout.height = 0;
      }
    }

    return node as ValidatedNodeData;
  }

  static validateBase64(data: string): boolean {
    if (!data || typeof data !== "string") return false;

    const normalized = this.normalizeBase64Payload(data);
    if (normalized.length === 0) return false;
    const base64Regex = /^[A-Za-z0-9+/]+={0,2}$/;
    return base64Regex.test(normalized);
  }

  static normalizeBase64Payload(data: string): string {
    if (!data || typeof data !== "string") return "";
    const base64Data = data.includes(",") ? data.split(",")[1] : data;
    let normalized = base64Data.replace(/\s/g, "");
    try {
      normalized = decodeURIComponent(normalized);
    } catch {
      // ignore
    }
    normalized = normalized.replace(/-/g, "+").replace(/_/g, "/");
    normalized = normalized.replace(/[^A-Za-z0-9+/=]/g, "");
    while (normalized.length % 4 !== 0) {
      normalized += "=";
    }
    return normalized;
  }

  static isWebP(base64: string): boolean {
    try {
      const clean = this.normalizeBase64Payload(base64);
      // WebP magic number in base64: "UklGR" (RIFF) followed by WebP signature
      return clean.startsWith("UklGR") && clean.substring(16, 20) === "V0VC";
    } catch {
      return false;
    }
  }

  static sanitizeText(text: string): string {
    if (!text || typeof text !== "string") return "";

    // Remove null bytes and control characters except newlines/tabs
    return text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "").trim();
  }

  static validateFontName(fontName: unknown): fontName is FontName {
    if (!fontName || typeof fontName !== "object") return false;
    const font = fontName as any;
    return (
      typeof font.family === "string" &&
      font.family.length > 0 &&
      typeof font.style === "string" &&
      font.style.length > 0
    );
  }
}

// ============================================================================
// MAIN IMPORTER CLASS
// ============================================================================

export class EnhancedFigmaImporter {
  private options: EnhancedImportOptions;
  private nodeBuilder: NodeBuilder;
  private styleManager: StyleManager;
  private designTokensManager?: DesignTokensManager;
  private imageCreationCache = new Map<string, string>();
  private createdNodes = new Map<string, SceneNode>();
  private failedNodes: FailedNodeReport[] = [];
  private textValidationResults: TextValidationResult[] = [];
  private verificationData: Array<{
    elementId: string;
    originalData: ValidatedNodeData;
    figmaNode: SceneNode;
  }> = [];
  private scaleFactor: number = 1;
  // Coordinate-space normalization (shifts negative global coords onto-canvas)
  private coordinateOffset: { x: number; y: number } = { x: 0, y: 0 };
  private importStartTime: number = 0;
  private processedNodeCount: number = 0;
  // DIAGNOSTIC: Node creation statistics for tracking content loss
  private nodeCreationStats = {
    attempted: 0,
    created: 0,
    failed: 0,
    nullValidation: 0,
    byType: new Map<
      string,
      { attempted: number; created: number; failed: number }
    >(),
  };
  private loadedFonts = new Set<string>();
  private mainFrame: FrameNode | null = null;
  public diagnosticCollector: DiagnosticCollector; // Public so NodeBuilder can access

  public getMainFrame(): FrameNode | null {
    return this.mainFrame;
  }

  public getSelectionMap(): Record<string, string> {
    const map: Record<string, string> = {};
    this.createdNodes.forEach((node, schemaId) => {
      map[schemaId] = node.id;
    });
    return map;
  }

  constructor(
    private data: any,
    options: Partial<EnhancedImportOptions> = {},
    private fontManager?: FontManager,
  ) {
    (this as any).importStartTime = Date.now();
    // DEBUG: Log what schema data we received
    console.log("🔍 [EnhancedFigmaImporter] Constructor received data:", {
      hasData: !!data,
      hasRoot: !!data?.root,
      rootType: data?.root?.type,
      rootChildren: data?.root?.children?.length || 0,
      dataKeys:
        data && typeof data === "object" ? Object.keys(data) : "not-object",
    });
    this.options = {
      createMainFrame: true,
      enableBatchProcessing: true,
      verifyPositions: true, // Re-enabled with optimized sampling
      maxBatchSize: 10,
      coordinateTolerance: 2,
      enableDebugMode: false,
      retryFailedImages: true,
      enableProgressiveLoading: false,
      maxImportDuration: 1800000, // 30 minutes (increased for very complex pages like YouTube)
      enableMemoryCleanup: true,
      validateTextNodes: true,
      useHierarchyInference: false, // Default: disabled (hierarchy inference has bugs that collapse nodes)
      ...options,
    };

    // Validate data structure
    if (!this.validateDataStructure(data)) {
      throw new Error("Invalid data structure provided to importer");
    }

    this.logImporterInit();

    // Initialize diagnostic collector for fidelity debugging
    const sourceUrl = data?.url || data?.metadata?.url || "unknown";
    this.diagnosticCollector = new DiagnosticCollector(sourceUrl);

    // CRITICAL MEMORY OPTIMIZATION: Disable full diagnostics for very large pages
    // For imports with > 5000 nodes, tracking every node state in memory often causes OOM
    const estimatedNodes = data.root?.children?.length || 0; // Simple estimate first

    // SAFETY RAIL: Force disable Auto Layout for large imports to prevent WASM OOM
    // The "Low confidence layout" thrashing seen in logs consumes massive memory
    if (
      estimatedNodes > 1000 ||
      (data.metadata?.extractionSummary?.totalElements > 1000 &&
        this.options.applyAutoLayout)
    ) {
      console.warn(
        `⚠️ [MEMORY SAFETY] Large import detected (>1000 nodes). Forcing Auto Layout OFF to prevent crash.`,
      );
      this.options.applyAutoLayout = false;

      // Also disable verification to save memory
      if (this.options.verifyPositions) {
        console.warn(
          `⚠️ [MEMORY SAFETY] Large import detected. Disabling position verification to save memory.`,
        );
        this.options.verifyPositions = false;
      }
    }

    if (
      estimatedNodes > 1000 ||
      data.metadata?.extractionSummary?.totalElements > 5000
    ) {
      console.warn(
        `🚀 [MEMORY] Large import detected (>5000 nodes). Enabling FAILURE_ONLY diagnostics to prevent OOM.`,
      );
      this.diagnosticCollector.failureOnlyMode = true;
    }

    console.log(
      "📊 [DIAGNOSTICS] Diagnostic collector initialized for import tracking",
    );

    // ENHANCED: Scale factor is now fixed at 1.0 because the extractor provides CSS pixels.
    // Legacy support for devicePixelRatio is kept for logging but NOT used for scaling coordinates.
    const devicePixelRatio = data.metadata?.devicePixelRatio || 1;
    this.scaleFactor = 1;
    console.log(
      `📏 [SCALE FACTOR] Fixed scale factor: ${this.scaleFactor} (extraction dpr was: ${devicePixelRatio})`,
    );

    // Initialize managers
    this.styleManager = new StyleManager(data.styles);

    const builderImportOptions: ImportOptions = {
      createMainFrame: true, // ✅ Keep main frame
      createVariantsFrame: false, // ❌ Disable - user wants only one frame
      createComponentsFrame: false, // ❌ Disable - user wants only one frame
      createDesignSystem: false, // ❌ Disable - user wants only one frame
      applyAutoLayout: this.options.applyAutoLayout ?? false,
      createStyles: !!data.styles,
      usePixelPerfectPositioning: !this.options.applyAutoLayout,
      createScreenshotOverlay: false,
      showValidationMarkers: false,
      strictCloneMode: this.options.strictCloneMode ?? true, // FIDELITY FIX: Default to true for pixel-perfect text rendering
    };

    this.nodeBuilder = new NodeBuilder(
      this.styleManager,
      new ComponentManager(data.components),
      builderImportOptions,
      { ...(data.assets || {}), baseUrl: data?.metadata?.url },
      undefined, // designTokensManager (none at import time)
      data, // schema -> pass full capture data so NodeBuilder can access metadata (viewport, DPR, etc.)
      this.diagnosticCollector,
      this.fontManager,
    );

    // MEMORY SAFETY: Enable memory safety mode for large imports
    // This disables expensive layout intelligence analysis per-node
    if (
      estimatedNodes > 1000 ||
      data.metadata?.extractionSummary?.totalElements > 1000
    ) {
      this.nodeBuilder.memorySafetyMode = true;
      console.warn(
        `🛡️ [MEMORY SAFETY] Enabling memory safety mode for NodeBuilder - skipping layout intelligence analysis`,
      );
    }

    // PIXEL-PERFECT FIX: Validate assets were passed correctly
    console.log(`📊 [IMPORT VALIDATION] Checking assets structure...`);
    const assetsCheck = {
      hasAssets: !!this.data.assets,
      hasImages: !!this.data.assets?.images,
      imageCount: this.data.assets?.images
        ? Object.keys(this.data.assets.images).length
        : 0,
      hasSvgs: !!this.data.assets?.svgs,
      svgCount: this.data.assets?.svgs
        ? Object.keys(this.data.assets.svgs).length
        : 0,
    };

    console.log(`  Assets validation:`, assetsCheck);

    if (assetsCheck.imageCount === 0) {
      console.error(
        `❌ [IMPORT VALIDATION] NO IMAGES IN ASSETS! This will cause all images to fail.`,
      );
      console.error(`   Check extension console for asset finalization logs.`);
    } else {
      // Log sample asset keys to verify hash format
      const sampleKeys = Object.keys(this.data.assets.images).slice(0, 3);
      console.log(`  📸 Sample asset hashes:`, sampleKeys);

      // Check if assets have base64 or URLs
      const sampleAsset = this.data.assets.images[sampleKeys[0]];
      if (sampleAsset) {
        console.log(`  📊 Sample asset structure:`, {
          hasData: !!sampleAsset.data,
          hasBase64: !!sampleAsset.base64,
          hasUrl: !!sampleAsset.url,
          url: sampleAsset.url
            ? sampleAsset.url.substring(0, 60) + "..."
            : "NONE",
        });

        // P0 FIX: Enhanced validation for URL-only assets
        const allImages = Object.values(this.data.assets.images);
        const urlOnlyCount = allImages.filter(
          (a: any) => !a.data && !a.base64 && a.url,
        ).length;
        const totalCount = allImages.length;

        if (urlOnlyCount > 0) {
          console.warn(
            `⚠️ [ASSET VALIDATION] ${urlOnlyCount}/${totalCount} assets are URL-only (no embedded data).`,
          );
          console.warn(`   These will use the proxy fallback in NodeBuilder.`);
        }

        if (!sampleAsset.data && !sampleAsset.base64 && !sampleAsset.url) {
          console.error(
            `❌ [IMPORT VALIDATION] Sample asset has NO data, NO base64, AND NO url!`,
          );
          console.error(
            `   Image resolution will FAIL. Check extension finalizeAssets logic.`,
          );
        } else if (!sampleAsset.data && !sampleAsset.base64) {
          console.warn(
            `⚠️ [IMPORT VALIDATION] Assets are URL-only (no embedded data)`,
          );
          console.warn(
            `   Ensure handoff server proxy is running at http://localhost:4411`,
          );
          console.warn(
            `   All images will be fetched via proxy. This may be slower.`,
          );
        }
      }
    }

    console.log("🎯 Production-grade importer initialized:", this.options);
  }

  // ============================================================================
  // VALIDATION & INITIALIZATION
  // ============================================================================

  private validateDataStructure(data: any): boolean {
    console.log(
      "🔍 [VALIDATION] Starting comprehensive data structure validation...",
      {
        hasData: !!data,
        dataType: typeof data,
        dataKeys: data && typeof data === "object" ? Object.keys(data) : [],
        dataStringified:
          data && typeof data === "object"
            ? JSON.stringify(data).substring(0, 300) + "..."
            : String(data),
      },
    );

    if (!data || typeof data !== "object") {
      console.error("❌ [VALIDATION] Data is not an object", {
        received: typeof data,
        value: String(data).substring(0, 100),
      });
      return false;
    }

    if (!data.root) {
      console.error("❌ [VALIDATION] Missing root data", {
        availableKeys: Object.keys(data),
        hasRootProperty: "root" in data,
        rootValue: data.root,
      });
      return false;
    }

    console.log("✅ [VALIDATION] Root exists, validating structure...", {
      rootType: typeof data.root,
      rootKeys:
        data.root && typeof data.root === "object"
          ? Object.keys(data.root)
          : [],
      hasId: !!(data.root && data.root.id),
      hasType: !!(data.root && data.root.type),
      hasChildren: !!(data.root && data.root.children),
      childrenCount:
        data.root && data.root.children ? data.root.children.length : 0,
    });

    if (!data.root.id || !data.root.type) {
      console.error("❌ [VALIDATION] Invalid root node - missing id or type", {
        hasId: !!(data.root && data.root.id),
        hasType: !!(data.root && data.root.type),
        rootId: data.root?.id,
        rootType: data.root?.type,
        rootStructure: JSON.stringify(data.root).substring(0, 200),
      });
      return false;
    }

    console.log("✅ [VALIDATION] Data structure validation passed", {
      rootId: data.root.id,
      rootType: data.root.type,
      childrenCount: data.root.children ? data.root.children.length : 0,
      hasMetadata: !!data.metadata,
      hasAssets: !!data.assets,
      hasStyles: !!data.styles,
    });

    return true;
  }

  private logImporterInit(): void {
    const diagnostics = {
      hasData: !!this.data,
      hasRoot: !!this.data?.root,
      hasAssets: !!this.data?.assets,
      hasStyles: !!this.data?.styles,
      rootNodeCount: Array.isArray(this.data?.root?.children)
        ? this.data.root.children.length
        : 0,
      imageCount: this.data?.assets?.images
        ? Object.keys(this.data.assets.images).length
        : 0,
    };

    console.log("🔍 Importer initialization diagnostics:", diagnostics);

    // Agent logging
    this.sendAgentLog("importer-initialized", {
      importerVersion: "2.0.0-production",
      ...diagnostics,
    });
  }

  private sendAgentLog(location: string, data: any): void {
    try {
      /*
      fetch(
        "http://127.0.0.1:7242/ingest/ec6ff4c5-673b-403d-a943-70cb2e5565f2",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            location,
            message: "Production importer event",
            data,
            timestamp: Date.now(),
            sessionId: "prod-session",
            runId: "prod-run",
            hypothesisId: "production",
          }),
        }
      ).catch(() => {});
      */
    } catch {
      // Silent fail for logging
    }
  }

  // ============================================================================
  // MAIN IMPORT ORCHESTRATION
  // ============================================================================

  /**
   * PHASE 7: Generate Build Summary Report
   * Aggregates validation issues and prints a summary.
   */
  private generateValidationReport(): void {
    console.log("📊 [VALIDATION] Generating Build Summary Report...");

    let totalNodes = 0;
    let validatedNodes = 0;
    const issueCounts: Record<string, number> = {};
    const severityCounts: Record<string, number> = {
      INFO: 0,
      WARN: 0,
      ERROR: 0,
      FATAL: 0,
    };
    const significantDisplacements: {
      id: string;
      name: string;
      dx: number;
      dy: number;
    }[] = [];

    // Recursive traversal to collect stats
    const traverse = (node: any) => {
      if (!node) return;
      totalNodes++;

      if (
        node.id === "root" ||
        node.type === "DOCUMENT" ||
        node.type === "PAGE"
      ) {
        // skip root container for validation stats usually
      }

      if (node.validation) {
        validatedNodes++;
        const issues = node.validation.issues as ValidationIssue[];
        if (issues && issues.length > 0) {
          issues.forEach((issue) => {
            issueCounts[issue.code] = (issueCounts[issue.code] || 0) + 1;
            severityCounts[issue.severity] =
              (severityCounts[issue.severity] || 0) + 1;
          });
        }

        // Check deltas
        if (node.validation.deltas) {
          const { positionDx, positionDy } = node.validation.deltas;
          if (
            typeof positionDx === "number" &&
            typeof positionDy === "number"
          ) {
            const disp = Math.abs(positionDx) + Math.abs(positionDy);
            if (disp > 2) {
              // Threshold for "significant" reporting
              significantDisplacements.push({
                id: node.id,
                name: node.name,
                dx: positionDx,
                dy: positionDy,
              });
            }
          }
        }
      }

      if (node.children && Array.isArray(node.children)) {
        node.children.forEach(traverse);
      }
    };

    if (this.data.root) {
      traverse(this.data.root);
    }

    // Sort displacements descending
    significantDisplacements.sort(
      (a, b) =>
        Math.abs(b.dx) + Math.abs(b.dy) - (Math.abs(a.dx) + Math.abs(a.dy)),
    );
    const topDisplacements = significantDisplacements.slice(0, 10);

    // Print Report
    console.log(`
================================================================================
🏗️  BUILD VALIDATION SUMMARY
================================================================================
Nodes Processed: ${totalNodes}
Nodes Validated: ${validatedNodes}
Validation Coverage: ${
      totalNodes > 0 ? ((validatedNodes / totalNodes) * 100).toFixed(1) : 0
    }%

🚨 ISSUES BY SEVERITY:
   FATAL: ${severityCounts.FATAL}
   ERROR: ${severityCounts.ERROR}
   WARN:  ${severityCounts.WARN}
   INFO:  ${severityCounts.INFO}

📋 TOP ISSUES:
${Object.entries(issueCounts)
  .sort(([, a], [, b]) => b - a)
  .slice(0, 10)
  .map(([code, count]) => `   - ${code}: ${count}`)
  .join("\n")}

📐 TOP DISPLACEMENTS (>2px):
${
  topDisplacements.length > 0
    ? topDisplacements
        .map(
          (d) =>
            `   - ${d.name} (${d.id}): dx=${d.dx.toFixed(1)}, dy=${d.dy.toFixed(
              1,
            )}`,
        )
        .join("\n")
    : "   (None)"
}
================================================================================
    `);

    // In strict mode, throw if FATAL > 0
    // (Optional: currently just logging)
    if (this.options.enableDebugMode && severityCounts.FATAL > 0) {
      console.error(
        "❌ CRITICAL: Fatal validation issues detected during build.",
      );
    }
  }

  async runImport(targetFrame?: FrameNode): Promise<ImportVerificationReport> {
    this.importStartTime = Date.now();

    // Start performance tracking
    perfTracker.reset();
    perfTracker.startPhase(PerfPhase.TOTAL_IMPORT);

    try {
      // Check timeout
      this.checkTimeout();

      this.postProgress("Starting production-grade import...", 0);

      // Step 1: PHASE 1 OPTIMIZATION - Fonts are now pre-loaded during node processing
      // (Moved to processNodesWithBatchingRobust for better parallelization)
      this.checkTimeout();

      // Step 1.5: Build render tree from DOM tree (SERVER Module)
      if (
        this.options.enableRenderTreeOptimization !== false &&
        this.data.root
      ) {
        this.postProgress("Building render tree...", 5);
        console.log("[RENDER_TREE] Converting DOM tree to render tree...");

        try {
          const renderTreeRoot = buildRenderTree(this.data.root, {
            materializePseudoElements: true,
            flattenStackingContexts: false, // CRITICAL FIX: Flattening destroys hierarchy/nesting
            removeInvisible: true,
            resolveShadowDOM: false,
          });

          if (renderTreeRoot) {
            const stats = getRenderTreeStats(this.data.root, renderTreeRoot);
            console.log("[RENDER_TREE] Transformation complete:", {
              originalNodes: stats.originalNodeCount,
              renderNodes: stats.renderNodeCount,
              removedNodes: stats.removedNodes,
              pseudoElementsAdded: stats.pseudoElementsAdded,
            });

            // Replace DOM tree with render tree
            this.data.root = renderTreeRoot;

            // Track stats in diagnostics
            this.diagnosticCollector.addMetric("renderTree", {
              originalNodeCount: stats.originalNodeCount,
              renderNodeCount: stats.renderNodeCount,
              removedNodes: stats.removedNodes,
              pseudoElementsAdded: stats.pseudoElementsAdded,
            });
          } else {
            console.warn(
              "[RENDER_TREE] Failed to build render tree, using original DOM tree",
            );
          }
        } catch (renderTreeError) {
          console.error(
            "[RENDER_TREE] Error building render tree:",
            renderTreeError,
          );
          // Continue with original tree on error
        }

        this.checkTimeout();
      }

      // Step 2: Create Figma styles
      if (this.options.createStyles) {
        this.postProgress("Creating local styles with hang protection...", 8);
        try {
          const styleStartTime = Date.now();
          await Promise.race([
            this.styleManager.createFigmaStyles(),
            new Promise((_, reject) => {
              setTimeout(
                () => reject(new Error("Style creation timeout")),
                30000,
              );
            }),
          ]);
          const styleTime = Date.now() - styleStartTime;
          this.postProgress(`Styles created successfully (${styleTime}ms)`, 12);

          if (this.data.colorPalette?.palette) {
            await this.integrateColorPalette(this.data.colorPalette);
          }
          if (this.data.typography?.tokens) {
            await this.integrateTypographyAnalysis(this.data.typography);
          }
        } catch (styleError) {
          console.warn(
            "⚠️ [ENHANCED-IMPORTER] Style creation failed/timeout, continuing:",
            styleError,
          );
          this.postProgress(
            "Skipping styles due to timeout, continuing import...",
            12,
          );
          // Continue without styles rather than hanging
        }

        if (this.data.typography?.tokens) {
          await this.integrateTypographyAnalysis(this.data.typography);
        }
      }
      this.checkTimeout();

      // Step 3: Create design tokens
      if (this.data.designTokensRegistry?.variables) {
        this.postProgress("Creating design tokens...", 10);
        this.designTokensManager = new DesignTokensManager(
          this.data.designTokensRegistry,
        );
        await this.designTokensManager.createFigmaVariables();
      }
      this.checkTimeout();

      // Step 4: Create or use main frame
      if (targetFrame) {
        this.mainFrame = targetFrame;
        // Ensure the frame is properly set up with data
        if (this.data.metadata?.documentBackgroundColor) {
          // Optional: apply background color if needed, or respect the frame as-is
        }
      } else {
        this.mainFrame = await this.createMainFrameRobust();
      }
      const mainFrame = this.mainFrame;
      this.checkTimeout();

      // Step 5: Screenshot overlay / empty-tree fallback.
      // Runtime evidence: some captures (notably YouTube) can arrive with treeNodeCount=0,
      // which would otherwise produce a blank white frame. If we have a screenshot, render
      // it as a locked base layer so the import is never visually empty.
      const rootChildrenCount = Array.isArray(this.data?.root?.children)
        ? this.data.root.children.length
        : 0;
      const hasScreenshot = !!this.data?.screenshot;
      const shouldForceScreenshotFallback =
        rootChildrenCount === 0 && hasScreenshot;

      if (rootChildrenCount === 0) {
        console.warn(
          `⚠️ [EMPTY TREE] Schema has 0 children in root. Has screenshot: ${hasScreenshot}. Will ${
            shouldForceScreenshotFallback ? "force" : "skip"
          } screenshot fallback.`,
        );
      }

      if (shouldForceScreenshotFallback) {
        // removed agent log block
      }

      // Optional reference screenshot overlay (for validation/debugging)
      // Never render the screenshot as the main frame background unless explicitly enabled,
      // EXCEPT the empty-tree fallback where we must ensure something is visible.
      if (
        (this.options.createScreenshotOverlay ||
          shouldForceScreenshotFallback) &&
        hasScreenshot
      ) {
        const screenshotDataUrl = this.normalizeScreenshotToDataUrl(
          this.data.screenshot,
        );
        if (screenshotDataUrl) {
          const overlay = await ScreenshotOverlay.createReferenceOverlay(
            screenshotDataUrl,
            mainFrame,
            {
              opacity: shouldForceScreenshotFallback ? 1 : 0.3,
              // CRITICAL FIX: Hide overlay by default unless it's the fallback or explicitly requested
              visible: shouldForceScreenshotFallback,
              position: "background",
            },
          );

          // Track screenshot overlay in diagnostics for empty tree fallback
          if (overlay) {
            this.diagnosticCollector.initNode("screenshot-overlay");
            this.diagnosticCollector.setFigmaNodeId(
              "screenshot-overlay",
              overlay.id,
            );
            this.diagnosticCollector.recordPhase(
              "screenshot-overlay",
              "COMPLETE",
            );
            console.log(
              "✅ [DIAGNOSTICS] Tracked screenshot overlay node for empty tree fallback",
            );
          }

          // removed agent log block
        }
      }
      this.checkTimeout();

      // Step 5.5: Validate schema tree structure before processing
      console.log("🔍 [TREE VALIDATION] Validating schema tree structure...");
      const treeValidator = new TreeValidator();
      const schemaValidation = treeValidator.validateSchemaTree(this.data);

      if (!schemaValidation.isValid) {
        console.error(
          "❌ [TREE VALIDATION] Schema tree structure has errors:",
          schemaValidation,
        );
        // Log tree diagram for debugging
        if (this.data.root || this.data.tree) {
          console.log("📊 [TREE DIAGRAM] Schema tree structure:");
          console.log(
            treeValidator.generateTreeDiagram(this.data.root || this.data.tree),
          );
        }
      } else {
        console.log(
          "✅ [TREE VALIDATION] Schema tree structure is valid -",
          schemaValidation.summary,
        );
      }

      // Step 5.6: CRITICAL FIX - Pre-load all images before node processing
      // This was missing, causing images to never be cached and resulting in "0 images processed"
      this.postProgress("Pre-loading images...", 40);
      console.log(
        "🖼️ [IMAGE PRELOAD] Starting image preloading before node processing...",
      );
      try {
        await this.batchProcessImagesRobust([]);
        console.log(
          `✅ [IMAGE PRELOAD] Image preloading complete. Cached ${this.imageCreationCache.size} images.`,
        );
      } catch (imagePreloadError) {
        console.warn(
          "⚠️ [IMAGE PRELOAD] Image preloading failed, continuing:",
          imagePreloadError,
        );
        // Continue without preloaded images - NodeBuilder will attempt fallback
      }
      this.checkTimeout();

      // Step 6: Process all nodes with batching
      await this.processNodesWithBatchingRobust(mainFrame);
      this.checkTimeout();

      // Step 7: Semantic Tree Optimization (NEW)
      if (this.options.enableSemanticTreeOptimization !== false) {
        this.postProgress("Optimizing tree structure...", 85);
        console.log("🎨 [OPTIMIZER] Starting semantic tree optimization...");

        const optimizationOptions: FigmaOptimizationOptions = {
          enableAutoLayout: this.options.applyAutoLayout ?? true,
          // CRITICAL FIX: Default all destructive optimizations to FALSE
          detectComponents: this.options.detectComponents ?? false,
          groupByRole: this.options.groupByRole ?? false,
          applyNamingConventions: this.options.semanticNaming ?? false,
          addVisualMarkers: this.options.addVisualMarkers ?? false,
          colorCodeByRole: this.options.colorCodeByRole ?? false,
          minComponentInstances: this.options.minComponentInstances ?? 3,
          createComponentVariants: false, // Don't replace instances by default
          useAutoLayoutPadding: true,
          addSectionDividers: false,
        };

        try {
          await optimizeFigmaTree(
            mainFrame,
            this.data.root,
            optimizationOptions,
          );
          console.log("✅ [OPTIMIZER] Tree optimization complete");
          this.postProgress("Tree optimization complete", 90);
        } catch (optimizationError) {
          console.warn(
            "⚠️ [OPTIMIZER] Tree optimization failed, continuing:",
            optimizationError,
          );
          // Continue without optimization rather than failing the entire import
        }
      }
      this.checkTimeout();

      // CRITICAL FIX: Ensure main frame background matches document background color
      // This prevents root element backgrounds from overriding the main frame
      // But we should respect the actual document background (black, white, etc.)
      const documentBgColor = this.data.metadata?.documentBackgroundColor;

      if (mainFrame.fills && Array.isArray(mainFrame.fills)) {
        // Check if fills match the document background color
        const hasMatchingFill =
          documentBgColor &&
          mainFrame.fills.some((fill) => {
            if (fill.type === "SOLID" && fill.color) {
              // Parse document background and compare
              const docColor =
                this.nodeBuilder.parseColorString(documentBgColor);
              if (docColor) {
                const fillMatches =
                  Math.abs(fill.color.r - docColor.r) < 0.01 &&
                  Math.abs(fill.color.g - docColor.g) < 0.01 &&
                  Math.abs(fill.color.b - docColor.b) < 0.01;
                return fillMatches;
              }
            }
            return false;
          });

        // Only clear fills if they don't match the document background
        // This allows dark backgrounds (black) to be preserved
        if (!hasMatchingFill) {
          const hasImageFill = mainFrame.fills.some(
            (fill) => fill.type === "IMAGE",
          );
          if (hasImageFill) {
            // Restore document background color (or white if not specified)
            const docColor = documentBgColor
              ? this.nodeBuilder.parseColorString(documentBgColor)
              : null;

            if (docColor) {
              let alpha = 1;
              const rgbaMatch = /rgba?\([^)]+\)/.exec(documentBgColor);
              if (rgbaMatch) {
                const rgbaParts = rgbaMatch[0].match(/[\d.]+/g);
                if (rgbaParts && rgbaParts.length >= 4) {
                  alpha = Math.max(0, Math.min(1, parseFloat(rgbaParts[3])));
                }
              }
              mainFrame.fills = [
                {
                  type: "SOLID",
                  color: { r: docColor.r, g: docColor.g, b: docColor.b },
                  opacity: alpha,
                },
              ];
              console.log(
                `🛡️ Main frame had image fill, restoring document background color: ${documentBgColor}`,
              );
            } else {
              mainFrame.fills = [
                { type: "SOLID", color: { r: 1, g: 1, b: 1 } },
              ];
              console.log(
                `🛡️ Main frame had image fill, restoring white solid background (no document color)`,
              );
            }
          }
        }
      } else if (documentBgColor) {
        // If no fills but we have document background, set it
        const docColor = this.nodeBuilder.parseColorString(documentBgColor);
        if (docColor) {
          let alpha = 1;
          const rgbaMatch = /rgba?\([^)]+\)/.exec(documentBgColor);
          if (rgbaMatch) {
            const rgbaParts = rgbaMatch[0].match(/[\d.]+/g);
            if (rgbaParts && rgbaParts.length >= 4) {
              alpha = Math.max(0, Math.min(1, parseFloat(rgbaParts[3])));
            }
          }
          mainFrame.fills = [
            {
              type: "SOLID",
              color: { r: docColor.r, g: docColor.g, b: docColor.b },
              opacity: alpha,
            },
          ];
        }
      } else {
        // Default to white if no document background color
        mainFrame.fills = [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }];
      }

      // Step 7: Create hover variants
      // DISABLED: Keep all elements in the main frame without creating separate component variants
      // if (this.data.hoverStates?.length > 0) {
      //   this.postProgress(
      //     `Creating ${this.data.hoverStates.length} hover variants...`,
      //     82
      //   );
      //   await createHoverVariants(this.data.hoverStates, this.createdNodes);
      // }
      this.checkTimeout();

      // Step 7.5: Create interactive prototype frame
      // DISABLED: Keep all interactive elements in the main frame instead of creating a separate prototype frame
      // const interactiveFrame = await this.createInteractivePrototypeFrame(
      //   mainFrame
      // );
      // if (interactiveFrame) {
      //   this.postProgress("Interactive prototype frame created", 85);
      //   // Set up prototype connections
      //   await this.setupPrototypeConnections(mainFrame, interactiveFrame);
      // }
      this.checkTimeout();

      // Step 8: Validate text nodes if enabled
      if (this.options.validateTextNodes) {
        await this.validateAllTextNodes();
      }

      // Step 9: Position verification (optional)
      let verificationReport: ImportVerificationReport | null = null;
      if (this.options.verifyPositions) {
        verificationReport = await this.verifyImportAccuracyRobust();
      }

      // Step 10: Focus viewport
      figma.viewport.scrollAndZoomIntoView([mainFrame]);
      figma.currentPage.selection = [mainFrame];

      // Step 11: Layer cleanup optimization (BUILDER Module)
      if (this.options.enableLayerCleanup !== false && mainFrame) {
        this.postProgress("Optimizing layer structure...", 95);
        console.log("[CLEANUP] Starting layer cleanup optimization...");

        try {
          const originalBounds = {
            width: mainFrame.width,
            height: mainFrame.height,
          };

          const cleanupStats = await optimizeLayerTree(mainFrame, {
            removeNonVisualWrappers: true,
            mergeAdjacentRectangles: true,
            mergeConsecutiveText: true,
            flattenUnnecessaryNesting: true,
            maxNestingDepth: 10,
          });

          console.log("[CLEANUP] Layer cleanup complete:", {
            originalLayerCount: cleanupStats.originalLayerCount,
            finalLayerCount: cleanupStats.finalLayerCount,
            reduction:
              cleanupStats.originalLayerCount - cleanupStats.finalLayerCount,
            reductionPercent: Math.round(
              ((cleanupStats.originalLayerCount -
                cleanupStats.finalLayerCount) /
                cleanupStats.originalLayerCount) *
                100,
            ),
            wrappersRemoved: cleanupStats.wrappersRemoved,
            rectanglesMerged: cleanupStats.rectanglesMerged,
            textNodesMerged: cleanupStats.textNodesMerged,
            layersFlattened: cleanupStats.layersFlattened,
          });

          // Validate cleanup didn't break visual correctness
          const validation = validateCleanup(originalBounds, mainFrame);
          if (!validation.valid) {
            console.warn(
              "[CLEANUP] Validation warnings (non-critical):",
              validation.errors,
            );
          } else {
            console.log(
              "[CLEANUP] Validation passed - visual integrity preserved",
            );
          }

          // Track cleanup stats in diagnostics
          this.diagnosticCollector.addMetric("layerCleanup", {
            originalLayerCount: cleanupStats.originalLayerCount,
            finalLayerCount: cleanupStats.finalLayerCount,
            wrappersRemoved: cleanupStats.wrappersRemoved,
            rectanglesMerged: cleanupStats.rectanglesMerged,
            textNodesMerged: cleanupStats.textNodesMerged,
            layersFlattened: cleanupStats.layersFlattened,
            validationPassed: validation.valid,
          });
        } catch (cleanupError) {
          console.error("[CLEANUP] Error during layer cleanup:", cleanupError);
          // Continue with non-optimized tree on error
        }

        this.checkTimeout();
      }

      // PHASE 7: Generate Build Validation Report
      this.generateValidationReport();

      // End performance tracking and print summary
      perfTracker.endPhase(PerfPhase.TOTAL_IMPORT);
      perfTracker.printSummary();

      // HIERARCHY VALIDATION: Validate parent-child relationships and print report
      const hierarchyReport = hierarchyValidator.validate();
      hierarchyValidator.printReport(hierarchyReport);

      // Generate final report
      const totalTime = Date.now() - this.importStartTime;
      const report = this.generateFinalReport(totalTime, verificationReport);

      // Cleanup
      if (this.options.enableMemoryCleanup) {
        this.performMemoryCleanup();
      }

      this.postComplete(report);

      // Enhanced completion report with schema statistics
      this.logImportCompletionReport(report);

      const figmaValidation = treeValidator.validateFigmaTree(
        mainFrame,
        this.data.root || this.data.tree,
      );

      if (!figmaValidation.isValid) {
        console.error(
          "❌ [TREE VALIDATION] Figma tree structure doesn't match schema:",
          figmaValidation,
        );
      } else {
        console.log(
          "✅ [TREE VALIDATION] Figma tree structure matches schema -",
          figmaValidation.summary,
        );
      }

      // Export tree structure for external analysis
      const treeStructure = treeValidator.exportTreeStructure(
        this.data.root || this.data.tree,
      );
      console.log("📤 [TREE EXPORT] Tree structure available for inspection");
      console.log("📊 [TREE DIAGRAM] Figma tree structure:");
      if (mainFrame) {
        const figmaTree = this.buildFigmaTreeForDiagram(mainFrame);
        console.log(treeValidator.generateTreeDiagram(figmaTree));
      }

      // Export diagnostic data for fidelity debugging
      this.exportDiagnosticReport();

      return report;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      const stackTrace = error instanceof Error ? error.stack : undefined;

      console.error("❌ Production import failed:", error);

      figma.ui.postMessage({
        type: "error",
        message: errorMessage,
        details: stackTrace,
      });

      // Log the error but DO throw it for now to maintain original behavior
      // while we investigate the root cause of the applyPositioning errors
      console.error("❌ [IMPORT] CRITICAL: Import failed before completion");
      console.error("❌ [IMPORT] Error details:", errorMessage);
      console.error("❌ [IMPORT] Stack:", stackTrace);
      console.error(
        "❌ [IMPORT] Nodes created before failure:",
        this.createdNodes.size,
      );
      console.error("❌ [IMPORT] Failed nodes:", this.failedNodes.length);

      throw error;
    }
  }

  /**
   * Build a tree representation of Figma nodes for diagram generation
   */
  private buildFigmaTreeForDiagram(node: SceneNode): any {
    const tree: any = {
      id: node.id,
      name: node.name,
      type: node.type,
      children: [],
    };

    if ("children" in node) {
      tree.children = (node as FrameNode).children.map((child) =>
        this.buildFigmaTreeForDiagram(child),
      );
    }

    return tree;
  }

  private checkTimeout(): void {
    if (!this.options.maxImportDuration) return;

    const elapsed = Date.now() - this.importStartTime;
    const remaining = this.options.maxImportDuration - elapsed;

    // Log progress at 50%, 75%, and 90% of timeout
    const percentUsed = (elapsed / this.options.maxImportDuration) * 100;
    if (percentUsed >= 90 && !this._logged90Timeout) {
      this._logged90Timeout = true;
      console.warn(
        `⚠️ [TIMEOUT] 90% of timeout used: ${Math.round(
          elapsed / 1000,
        )}s / ${Math.round(this.options.maxImportDuration / 1000)}s`,
      );
      console.warn(
        `⚠️ [TIMEOUT] ${this.processedNodeCount} nodes processed so far`,
      );
    } else if (percentUsed >= 75 && !this._logged75Timeout) {
      this._logged75Timeout = true;
      console.warn(
        `⚠️ [TIMEOUT] 75% of timeout used: ${Math.round(
          elapsed / 1000,
        )}s / ${Math.round(this.options.maxImportDuration / 1000)}s`,
      );
    } else if (percentUsed >= 50 && !this._logged50Timeout) {
      this._logged50Timeout = true;
      console.log(
        `ℹ️ [TIMEOUT] 50% of timeout used: ${Math.round(
          elapsed / 1000,
        )}s / ${Math.round(this.options.maxImportDuration / 1000)}s`,
      );
    }

    if (elapsed > this.options.maxImportDuration) {
      console.error(
        `❌ [TIMEOUT] Import timeout exceeded after processing ${this.processedNodeCount} nodes`,
      );
      throw new Error(
        `Import timeout exceeded: ${elapsed}ms > ${this.options.maxImportDuration}ms (${this.processedNodeCount} nodes processed)`,
      );
    }
  }

  // Timeout logging flags
  private _logged50Timeout = false;
  private _logged75Timeout = false;
  private _logged90Timeout = false;

  // ============================================================================
  // FONT LOADING WITH ROBUST FALLBACKS
  // ============================================================================

  /**
   * PHASE 1 OPTIMIZATION: Pre-load fonts with smart fallback and caching
   */
  private async preloadFontsWithSmartFallback(
    requiredFonts: Set<string>,
  ): Promise<Map<string, FontName>> {
    const fontMap = new Map<string, FontName>();
    const fontPromises: Array<
      Promise<{ fontKey: string; loaded: FontName | null }>
    > = [];

    // Convert Set to FontName array
    const fontsToLoad: FontName[] = Array.from(requiredFonts).map((fontKey) => {
      const [family, style] = fontKey.split("|");
      return { family, style };
    });

    console.log(`📝 Pre-loading ${fontsToLoad.length} fonts in parallel...`);

    // Load fonts in parallel with concurrency limit
    const concurrency = 10;
    for (let i = 0; i < fontsToLoad.length; i += concurrency) {
      const batch = fontsToLoad.slice(i, i + concurrency);
      const batchPromises = batch.map(async (font) => {
        const fontKey = `${font.family}|${font.style}`;
        try {
          // Use NodeBuilder's font loading with fallbacks
          const loaded = await this.nodeBuilder.loadFontWithFallbacks(
            font.family,
            font.style,
          );
          return { fontKey, loaded };
        } catch (error) {
          console.warn(`⚠️ Failed to load font ${fontKey}:`, error);
          return { fontKey, loaded: null };
        }
      });
      fontPromises.push(...batchPromises);
    }

    const results = await Promise.allSettled(fontPromises);
    results.forEach((result) => {
      if (result.status === "fulfilled" && result.value.loaded) {
        fontMap.set(result.value.fontKey, result.value.loaded);
      }
    });

    console.log(`✅ Pre-loaded ${fontMap.size}/${fontsToLoad.length} fonts`);

    // Always ensure fallback font is loaded
    await this.ensureFallbackFont();

    return fontMap;
  }

  private async loadAllFontsRobust(): Promise<void> {
    this.postProgress("Loading fonts with validation...", 5);

    const requiredFonts = this.extractRequiredFontsRobust();
    console.log(`📝 Attempting to load ${requiredFonts.length} fonts`);

    const results = await Promise.allSettled(
      requiredFonts.map((font) => this.loadFontWithValidation(font)),
    );

    const successful = results.filter((r) => r.status === "fulfilled").length;
    const failed = results.filter((r) => r.status === "rejected").length;

    console.log(
      `✅ Font loading complete: ${successful} succeeded, ${failed} failed`,
    );

    // Always ensure fallback font is loaded
    await this.ensureFallbackFont();
  }

  private async loadFontWithValidation(fontName: FontName): Promise<void> {
    if (!ValidationUtils.validateFontName(fontName)) {
      throw new Error(`Invalid font name: ${JSON.stringify(fontName)}`);
    }

    const fontKey = `${fontName.family}-${fontName.style}`;

    if (this.loadedFonts.has(fontKey)) {
      return; // Already loaded
    }

    try {
      await figma.loadFontAsync(fontName);
      this.loadedFonts.add(fontKey);
      console.log(`✅ Loaded font: ${fontKey}`);
    } catch (error) {
      console.warn(`⚠️ Failed to load font ${fontKey}:`, error);
      throw error;
    }
  }

  private async ensureFallbackFont(): Promise<void> {
    const fallbackFonts: FontName[] = [
      { family: "Inter", style: "Regular" },
      { family: "Roboto", style: "Regular" },
      { family: "Arial", style: "Regular" },
    ];

    for (const font of fallbackFonts) {
      try {
        await this.loadFontWithValidation(font);
        console.log(`✅ Fallback font loaded: ${font.family}`);
        return;
      } catch {
        continue;
      }
    }

    console.error("❌ Failed to load any fallback font!");
  }

  private extractRequiredFontsRobust(): FontName[] {
    const fonts = new Set<string>();

    // Extract from metadata
    if (this.data.metadata?.fonts) {
      Object.values(this.data.metadata.fonts).forEach((font: any) => {
        if (font.family && typeof font.family === "string") {
          fonts.add(`${font.family}|Regular`);

          if (Array.isArray(font.weights)) {
            font.weights.forEach((weight: number) => {
              if (ValidationUtils.isValidNumber(weight)) {
                const style = this.weightToStyle(weight);
                fonts.add(`${font.family}|${style}`);
              }
            });
          }
        }
      });
    }

    // Extract from text nodes in tree
    this.extractFontsFromTree(this.data.root, fonts);

    // Convert to FontName format with validation
    const result: FontName[] = [];
    fonts.forEach((fontStr) => {
      const [family, style] = fontStr.split("|");
      if (family && style) {
        result.push({ family, style });
      }
    });

    return result;
  }

  private extractFontsFromTree(node: any, fonts: Set<string>): void {
    if (!node) return;

    if (node.type === "TEXT" && node.fontFamily) {
      const family = node.fontFamily;
      const weight = node.fontWeight || 400;
      const style = this.weightToStyle(weight);
      fonts.add(`${family}|${style}`);
    }

    if (Array.isArray(node.children)) {
      node.children.forEach((child: any) =>
        this.extractFontsFromTree(child, fonts),
      );
    }
  }

  private weightToStyle(weight: number): string {
    if (weight >= 700) return "Bold";
    if (weight >= 600) return "SemiBold";
    if (weight >= 500) return "Medium";
    if (weight >= 300) return "Light";
    if (weight >= 100) return "Thin";
    return "Regular";
  }

  // ============================================================================
  // FRAME CREATION WITH VALIDATION
  // ============================================================================

  private async createMainFrameRobust(): Promise<FrameNode> {
    const frame = figma.createFrame();
    frame.name = `Import ${new Date().toLocaleTimeString()}`;

    // Calculate dimensions with validation
    const viewport = this.data.metadata?.viewport || {};

    const layoutWidth = ValidationUtils.safeParseFloat(
      this.data.metadata?.viewport?.width ||
        this.data.metadata?.viewportWidth ||
        viewport.layoutViewportWidth ||
        viewport.width ||
        this.data.root?.layout?.width,
      1440,
    );

    const viewportHeight = ValidationUtils.safeParseFloat(
      this.data.metadata?.viewportHeight ||
        this.data.metadata?.scrollHeight ||
        viewport.scrollHeight ||
        viewport.layoutViewportHeight ||
        viewport.height,
      900,
    );

    const treeHeight = ValidationUtils.safeParseFloat(
      this.data.root?.layout?.height,
      0,
    );

    const scrollHeight = Math.max(viewportHeight, treeHeight);

    // Clamp to reasonable bounds
    const finalWidth = ValidationUtils.clampNumber(layoutWidth, 1, 16000);
    const finalHeight = ValidationUtils.clampNumber(scrollHeight, 1, 16000);

    frame.resize(finalWidth, finalHeight);
    frame.clipsContent = false; // Allow off-canvas elements to be visible for debugging

    // Position to avoid overlap
    const nextPos = this.getNextImportPosition(finalWidth, finalHeight);
    frame.x = nextPos.x;
    frame.y = nextPos.y;

    // CRITICAL FIX: Use actual document background color instead of always white
    // This allows dark themes (black) and other backgrounds to be preserved
    const documentBgColor = this.data.metadata?.documentBackgroundColor;
    let mainFrameFill: SolidPaint;

    if (documentBgColor) {
      // Parse the document background color using NodeBuilder's parseColorString
      const parsedColor = this.nodeBuilder.parseColorString(documentBgColor);
      if (parsedColor) {
        // Extract alpha if available (rgba format)
        let alpha = 1;
        const rgbaMatch = /rgba?\([^)]+\)/.exec(documentBgColor);
        if (rgbaMatch) {
          const rgbaParts = rgbaMatch[0].match(/[\d.]+/g);
          if (rgbaParts && rgbaParts.length >= 4) {
            alpha = Math.max(0, Math.min(1, parseFloat(rgbaParts[3])));
          }
        }

        mainFrameFill = {
          type: "SOLID",
          color: { r: parsedColor.r, g: parsedColor.g, b: parsedColor.b },
          opacity: alpha,
        };
        console.log(
          `🎨 [BACKGROUND] Using document background color: ${documentBgColor} → RGB(${Math.round(
            parsedColor.r * 255,
          )}, ${Math.round(parsedColor.g * 255)}, ${Math.round(
            parsedColor.b * 255,
          )})`,
        );
      } else {
        // Fallback to white if parsing fails
        mainFrameFill = { type: "SOLID", color: { r: 1, g: 1, b: 1 } };
        console.warn(
          `⚠️ [BACKGROUND] Failed to parse document background color: ${documentBgColor}. Using white fallback.`,
        );
      }
    } else {
      // Default to white if no background color is specified
      mainFrameFill = { type: "SOLID", color: { r: 1, g: 1, b: 1 } };
      console.log(
        `🎨 [BACKGROUND] No document background color found. Using white default.`,
      );
    }

    frame.fills = [mainFrameFill];

    figma.currentPage.appendChild(frame);

    // Store absolute coordinates
    this.safeSetPluginData(frame, "absoluteX", "0");
    this.safeSetPluginData(frame, "absoluteY", "0");

    console.log(`📐 Main frame created: ${finalWidth}×${finalHeight}`);
    console.log(`📐 [FRAME-DEBUG] Frame position: x=${frame.x}, y=${frame.y}`);
    console.log(
      `📐 [FRAME-DEBUG] Input dimensions: viewportHeight=${viewportHeight}, treeHeight=${treeHeight}, scrollHeight=${scrollHeight}`,
    );

    // Track main frame in diagnostics
    this.diagnosticCollector.initNode("main-frame");
    this.diagnosticCollector.setFigmaNodeId("main-frame", frame.id);
    this.diagnosticCollector.recordPhase("main-frame", "COMPLETE");

    return frame;
  }

  private getNextImportPosition(
    width: number,
    height: number,
  ): { x: number; y: number } {
    const siblings = figma.currentPage.children.filter(
      (n) =>
        n.type === "FRAME" || n.type === "COMPONENT" || n.type === "INSTANCE",
    ) as Array<FrameNode | ComponentNode | InstanceNode>;

    if (siblings.length === 0) {
      return { x: 0, y: 0 };
    }

    let maxRight = 0;
    let minY = 0;

    siblings.forEach((n) => {
      const right = n.x + n.width;
      if (right > maxRight) maxRight = right;
      if (n.y < minY) minY = n.y;
    });

    return { x: maxRight + 200, y: minY };
  }

  // ============================================================================
  // NODE PROCESSING WITH ROBUST ERROR HANDLING
  // ============================================================================

  /**
   * Collect all interactive elements from the tree
   */
  private collectInteractiveElements(
    node: any,
    interactiveElements: any[] = [],
  ): void {
    if (!node) return;

    // Check if this node is interactive
    if (node.isInteractive) {
      interactiveElements.push(node);
    }

    // Recursively check children
    if (node.children && Array.isArray(node.children)) {
      for (const child of node.children) {
        this.collectInteractiveElements(child, interactiveElements);
      }
    }
  }

  /**
   * Create a second frame with all interactive elements for prototyping
   */
  private async createInteractivePrototypeFrame(
    mainFrame: FrameNode,
  ): Promise<FrameNode | null> {
    if (!this.data.root) return null;

    // Collect all interactive elements
    const interactiveElements: any[] = [];
    this.collectInteractiveElements(this.data.root, interactiveElements);

    if (interactiveElements.length === 0) {
      console.log("ℹ️ No interactive elements found, skipping prototype frame");
      return null;
    }

    console.log(
      `🎯 Found ${interactiveElements.length} interactive elements for prototype frame`,
    );

    // Create the interactive frame
    const interactiveFrame = figma.createFrame();
    interactiveFrame.name = "🎨 Interactive Elements (Prototype)";
    interactiveFrame.layoutMode = "VERTICAL";
    interactiveFrame.primaryAxisSizingMode = "AUTO";
    interactiveFrame.counterAxisSizingMode = "AUTO";
    interactiveFrame.itemSpacing = 20;
    interactiveFrame.paddingTop = 40;
    interactiveFrame.paddingBottom = 40;
    interactiveFrame.paddingLeft = 40;
    interactiveFrame.paddingRight = 40;
    interactiveFrame.fills = [
      { type: "SOLID", color: { r: 0.98, g: 0.98, b: 0.98 } },
    ];

    // Position frame next to main frame
    interactiveFrame.x = mainFrame.x + mainFrame.width + 100;
    interactiveFrame.y = mainFrame.y;

    // Group interactive elements by type for better organization
    const elementsByType = new Map<string, any[]>();
    for (const element of interactiveElements) {
      const type = element.interactionType || "interactive";
      if (!elementsByType.has(type)) {
        elementsByType.set(type, []);
      }
      elementsByType.get(type)!.push(element);
    }

    // Create sections for each interaction type
    for (const [type, elements] of elementsByType.entries()) {
      const sectionFrame = figma.createFrame();
      sectionFrame.name = `${type.charAt(0).toUpperCase() + type.slice(1)}s (${
        elements.length
      })`;
      sectionFrame.layoutMode = "VERTICAL";
      sectionFrame.primaryAxisSizingMode = "AUTO";
      sectionFrame.counterAxisSizingMode = "AUTO";
      sectionFrame.itemSpacing = 16;
      sectionFrame.paddingTop = 20;
      sectionFrame.paddingBottom = 20;
      sectionFrame.paddingLeft = 20;
      sectionFrame.paddingRight = 20;
      sectionFrame.fills = [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }];
      sectionFrame.strokes = [
        { type: "SOLID", color: { r: 0.9, g: 0.9, b: 0.9 } },
      ];
      sectionFrame.strokeWeight = 1;
      sectionFrame.cornerRadius = 8;

      // Create nodes for each interactive element
      // CRITICAL: Create isolated interactive elements WITHOUT children
      // This ensures only the clickable element itself is shown, not all nested content
      for (const elementData of elements) {
        try {
          // Create isolated version: copy element data but remove children
          // This ensures we only show the interactive element itself, not everything inside it
          const isolatedElementData = {
            ...elementData,
            children: [], // Remove children - we only want the interactive element itself
            // Keep essential properties for rendering the element
            layout: elementData.layout,
            fills: elementData.fills,
            strokes: elementData.strokes,
            effects: elementData.effects,
            textStyle: elementData.textStyle,
            characters: elementData.characters,
            imageHash: elementData.imageHash,
            // Keep interaction metadata
            isInteractive: true,
            interactionType: elementData.interactionType,
            interactionMetadata: elementData.interactionMetadata,
          };

          const elementNode = await this.createSingleNodeRobust(
            isolatedElementData,
            sectionFrame,
            { x: 0, y: 0 },
          );
          if (elementNode) {
            // Store original element ID for prototype connections
            this.safeSetPluginData(
              elementNode,
              "originalElementId",
              elementData.id,
            );
            this.safeSetPluginData(
              elementNode,
              "interactionType",
              elementData.interactionType || "interactive",
            );

            // Add label showing what type of interaction this is
            if (
              elementData.interactionType &&
              elementData.interactionType !== "interactive"
            ) {
              elementNode.name = `${elementData.name || "Element"} (${
                elementData.interactionType
              })`;
            }

            sectionFrame.appendChild(elementNode);
          }
        } catch (error) {
          console.warn(
            `⚠️ Failed to create interactive element ${elementData.id}:`,
            error,
          );
        }
      }

      if (sectionFrame.children.length > 0) {
        interactiveFrame.appendChild(sectionFrame);
      } else {
        sectionFrame.remove();
      }
    }

    if (interactiveFrame.children.length > 0) {
      // Add to the same page as main frame
      mainFrame.parent?.appendChild(interactiveFrame);
      console.log(
        `✅ Created interactive prototype frame with ${interactiveElements.length} elements`,
      );
      return interactiveFrame;
    } else {
      interactiveFrame.remove();
      return null;
    }
  }

  /**
   * Set up prototype connections between main frame and interactive frame
   */
  private async setupPrototypeConnections(
    mainFrame: FrameNode,
    interactiveFrame: FrameNode,
  ): Promise<void> {
    if (!mainFrame || !interactiveFrame) return;

    // Create a connection from main frame to interactive frame
    // This allows users to click on interactive elements in the main frame
    // and navigate to the interactive prototype frame

    // Find all interactive elements in the main frame
    const findInteractiveNodes = (node: SceneNode): SceneNode[] => {
      const interactive: SceneNode[] = [];

      // Check if node has interaction metadata
      const pluginData =
        (node as any).getPluginData?.("originalElementId") ||
        (node as any).getPluginData?.("interactionType");

      // Also check by name/type patterns
      const isLikelyInteractive =
        node.type === "COMPONENT" ||
        node.type === "INSTANCE" ||
        (node.name &&
          /button|link|dropdown|input|select|tab|menu/i.test(node.name));

      if (pluginData || isLikelyInteractive) {
        interactive.push(node);
      }

      // Recursively check children
      if ("children" in node) {
        for (const child of node.children) {
          interactive.push(...findInteractiveNodes(child));
        }
      }

      return interactive;
    };

    const mainInteractiveNodes = findInteractiveNodes(mainFrame);
    const interactiveFrameNodes = findInteractiveNodes(interactiveFrame);

    console.log(
      `🔗 Setting up prototype connections: ${mainInteractiveNodes.length} nodes in main frame, ${interactiveFrameNodes.length} in interactive frame`,
    );

    // Create prototype connections
    // For each interactive element in main frame, connect to corresponding element in interactive frame
    for (const mainNode of mainInteractiveNodes) {
      if (!("setPrototypeData" in mainNode)) continue;

      try {
        // Find corresponding node in interactive frame by name or ID
        const mainNodeId =
          (mainNode as any).getPluginData?.("sourceNodeId") ||
          (mainNode as any).getPluginData?.("originalElementId");

        let targetNode: SceneNode | null = null;
        if (mainNodeId) {
          // Try to find by original element ID
          for (const interactiveNode of interactiveFrameNodes) {
            const interactiveId = (interactiveNode as any).getPluginData?.(
              "originalElementId",
            );
            if (interactiveId === mainNodeId) {
              targetNode = interactiveNode;
              break;
            }
          }
        }

        // If not found by ID, try to find by name
        if (!targetNode) {
          for (const interactiveNode of interactiveFrameNodes) {
            if (interactiveNode.name === mainNode.name) {
              targetNode = interactiveNode;
              break;
            }
          }
        }

        // If still not found, connect to the interactive frame itself
        if (!targetNode) {
          targetNode = interactiveFrame;
        }

        // Set prototype connection using Figma's prototype API
        // Store connection metadata in plugin data for reference
        this.safeSetPluginData(
          mainNode as SceneNode,
          "prototypeTarget",
          targetNode.id,
        );
        this.safeSetPluginData(
          mainNode as SceneNode,
          "prototypeTransition",
          JSON.stringify({
            type: "INSTANT",
            duration: 0,
            easing: { type: "EASE_IN_OUT" },
          }),
        );

        // Set actual prototype connection using Figma API
        // Note: Figma requires nodes to be components or frames for prototype connections
        try {
          // Convert to component if needed for prototype connections
          let prototypeNode = mainNode;
          if (
            mainNode.type !== "COMPONENT" &&
            mainNode.type !== "FRAME" &&
            "children" in mainNode
          ) {
            // For non-frame nodes, we'll store the connection info in plugin data
            // Users can manually set up connections in Figma's prototype mode
            console.log(
              `ℹ️ Node ${mainNode.name} is not a frame/component, storing prototype info in plugin data`,
            );
          } else {
            // Set prototype connection for frames/components
            if ("setPrototypeData" in prototypeNode) {
              (prototypeNode as any).setPrototypeData({
                connections: [
                  {
                    destination: targetNode,
                    transition: {
                      type: "INSTANT",
                      duration: 0,
                      easing: { type: "EASE_IN_OUT" },
                    },
                  },
                ],
              });
              console.log(
                `✅ Set prototype connection from ${mainNode.name} to ${targetNode.name}`,
              );
            }
          }
        } catch (error) {
          // If setPrototypeData fails, the plugin data will still be available
          console.warn(
            `⚠️ Could not set prototype data directly, stored in plugin data instead:`,
            error,
          );
        }

        console.log(`✅ Connected ${mainNode.name} to ${targetNode.name}`);
      } catch (error) {
        console.warn(
          `⚠️ Failed to set prototype connection for ${mainNode.name}:`,
          error,
        );
      }
    }

    // Also create a connection from interactive frame back to main frame
    // This allows users to navigate back
    try {
      this.safeSetPluginData(interactiveFrame, "prototypeTarget", mainFrame.id);
      this.safeSetPluginData(
        interactiveFrame,
        "prototypeTransition",
        JSON.stringify({
          type: "INSTANT",
          duration: 0,
          easing: { type: "EASE_IN_OUT" },
        }),
      );

      // Set actual prototype connection from interactive frame back to main frame
      try {
        if ("setPrototypeData" in interactiveFrame) {
          (interactiveFrame as any).setPrototypeData({
            connections: [
              {
                destination: mainFrame,
                transition: {
                  type: "INSTANT",
                  duration: 0,
                  easing: { type: "EASE_IN_OUT" },
                },
              },
            ],
          });
          console.log("✅ Connected interactive frame back to main frame");
        }
      } catch (error) {
        console.warn(
          "⚠️ Could not set prototype connection from interactive frame:",
          error,
        );
      }
    } catch (error) {
      console.warn(
        "⚠️ Failed to set prototype connection from interactive frame:",
        error,
      );
    }
  }

  /**
   * Process large imports by splitting into chunks to prevent WASM OOM.
   * Creates separate frames for each chunk.
   */
  private async processChunkedImport(
    rootNode: ElementNode,
    parentFrame: FrameNode,
    analysis: any,
  ): Promise<void> {
    console.log("🪓 [CHUNKER] Starting chunked import process");

    // Split tree into chunks (max 1500 nodes per chunk)
    const chunks = chunkTree(rootNode, {
      maxNodesPerChunk: 1500,
      chunkingStrategy: "spatial-vertical",
    });

    console.log(
      `🪓 [CHUNKER] Created ${chunks.length} chunks from ${analysis.totalNodes} total nodes`,
    );

    // Create a parent frame to hold all chunk frames
    const containerFrame = figma.createFrame();
    containerFrame.name = `${rootNode.name || "Web Import"} (Chunked)`;
    containerFrame.x = parentFrame.x;
    containerFrame.y = parentFrame.y;
    containerFrame.resize(parentFrame.width, parentFrame.height);
    containerFrame.fills = parentFrame.fills;
    containerFrame.clipsContent = false;

    // Move the parent frame inside the container
    figma.currentPage.appendChild(containerFrame);

    let cumulativeY = 0;

    // Process each chunk sequentially
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      console.log(
        `🪓 [CHUNKER] Processing chunk ${i + 1}/${chunks.length} (${
          chunk.nodeCount
        } nodes)`,
      );

      this.postProgress(
        `Processing chunk ${i + 1}/${chunks.length} (${
          chunk.nodeCount
        } nodes)...`,
        15 + (i / chunks.length) * 70,
      );

      // Create a frame for this chunk
      const chunkFrame = figma.createFrame();
      chunkFrame.name = `Chunk ${i + 1} of ${chunks.length}`;
      chunkFrame.x = 0;
      chunkFrame.y = cumulativeY;
      chunkFrame.fills = [];
      chunkFrame.clipsContent = false;

      // Set frame size based on chunk content
      let maxWidth = parentFrame.width;
      let maxHeight = 0;

      for (const node of chunk.nodes) {
        const nodeWidth = node.layout?.width || node.absoluteLayout?.width || 0;
        const nodeHeight =
          node.layout?.height || node.absoluteLayout?.height || 0;
        maxWidth = Math.max(maxWidth, nodeWidth);
        maxHeight += nodeHeight;
      }

      chunkFrame.resize(maxWidth, Math.max(maxHeight, 100));
      containerFrame.appendChild(chunkFrame);

      // Create a temporary root node for this chunk
      const chunkRoot: ElementNode = {
        ...rootNode,
        children: chunk.nodes,
        id: `chunk-${i}`,
        name: `Chunk ${i + 1}`,
      };

      // Process this chunk's nodes
      try {
        await this.processChunkNodes(chunkRoot, chunkFrame);
        console.log(`✅ [CHUNKER] Chunk ${i + 1} complete`);
      } catch (error) {
        console.error(`❌ [CHUNKER] Chunk ${i + 1} failed:`, error);
        // Continue to next chunk even if this one fails
      }

      cumulativeY += chunkFrame.height + 50; // Add 50px gap between chunks

      // Yield to main thread between chunks to prevent UI freeze
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    // Select the container frame
    figma.currentPage.selection = [containerFrame];
    figma.viewport.scrollAndZoomIntoView([containerFrame]);

    this.mainFrame = containerFrame;

    console.log("✅ [CHUNKER] Chunked import complete");
  }

  /**
   * COORDINATE FIX: Find minimum x/y bounds across entire tree
   * Captured coordinates are PAGE_ABSOLUTE_CSS_PX, we need to normalize to (0,0)
   */
  private findMinimumBounds(node: any): { x: number; y: number } {
    let minX = Infinity;
    let minY = Infinity;

    const traverse = (n: any) => {
      if (!n) return;

      const pageX = n?.layout?.pageX;
      const pageY = n?.layout?.pageY;

      if (
        ValidationUtils.isValidNumber(pageX) &&
        ValidationUtils.isValidNumber(pageY)
      ) {
        minX = Math.min(minX, pageX);
        minY = Math.min(minY, pageY);
      } else if (n?.absoluteLayout) {
        const x = ValidationUtils.safeParseFloat(n.absoluteLayout.left, NaN);
        const y = ValidationUtils.safeParseFloat(n.absoluteLayout.top, NaN);
        if (Number.isFinite(x) && Number.isFinite(y)) {
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
        }
      }

      if (Array.isArray(n.children)) {
        for (const child of n.children) traverse(child);
      }
    };

    traverse(node);

    if (!Number.isFinite(minX)) minX = 0;
    if (!Number.isFinite(minY)) minY = 0;

    return { x: minX, y: minY };
  }

  /**
   * Process nodes for a single chunk.
   * This is a simplified version of processNodesWithBatchingRobust.
   */
  /**
   * Process nodes for a single chunk.
   * REFACTORED: Now uses iterative stack and yielding to prevent freeze/crash.
   */
  private async processChunkNodes(
    chunkRoot: ElementNode,
    chunkFrame: FrameNode,
  ): Promise<void> {
    // Stack for iterative traversal: [NodeData, ParentFigmaNode, AbsoluteOffset]
    const stack: {
      data: any;
      parent: FrameNode | SceneNode;
      absoluteOffset: { x: number; y: number };
    }[] = [];

    // Initial population
    if (chunkRoot.children && Array.isArray(chunkRoot.children)) {
      // COORDINATE FIX: Use the already-calculated coordinateOffset from processNodesWithBatchingRobust
      // This offset normalizes PAGE_ABSOLUTE_CSS_PX coordinates to start at (0,0)
      console.log(
        `🔧 [CHUNKER] Using global coordinate offset: x=${this.coordinateOffset.x}, y=${this.coordinateOffset.y}`,
      );

      // Chunk frame position (usually 0,0 for first chunk)
      const chunkAbsX = chunkFrame.x || 0;
      const chunkAbsY = chunkFrame.y || 0;

      // Apply the global coordinate offset to the chunk frame position
      const normalizedOffsetX = chunkAbsX + this.coordinateOffset.x;
      const normalizedOffsetY = chunkAbsY + this.coordinateOffset.y;

      console.log(
        `🔧 [CHUNKER] Chunk absoluteOffset: x=${normalizedOffsetX}, y=${normalizedOffsetY}`,
      );

      // Push in reverse order so first child is processed first
      for (let i = chunkRoot.children.length - 1; i >= 0; i--) {
        stack.push({
          data: chunkRoot.children[i],
          parent: chunkFrame,
          absoluteOffset: { x: normalizedOffsetX, y: normalizedOffsetY },
        });
      }
    }

    let nodesProcessed = 0;
    // MEMORY SAFETY: Extremely aggressive throttling for large schemas (14MB+)
    // Yield every 5 nodes to prevent WASM sandbox OOM on 10k+ node imports
    const TOTAL_NODES_PER_YIELD = 5;

    while (stack.length > 0) {
      const { data, parent, absoluteOffset } = stack.pop()!;

      try {
        // Create the node
        // ROOT CAUSE FIX: Use manual coordinate propagation instead of
        // unreliable parent.absoluteRenderBounds (which is async and often null).
        const createdNode = await this.nodeBuilder.createNode(
          data,
          absoluteOffset,
        );

        if (createdNode) {
          // Append to parent
          if (parent && "appendChild" in parent) {
            try {
              // CRITICAL FIX: Use insertChildByZIndex to respect CSS stacking order
              if ("children" in parent) {
                this.nodeBuilder.insertChildByZIndex(
                  parent as BaseNode & ChildrenMixin,
                  createdNode,
                );
              } else {
                (parent as any).appendChild(createdNode);
              }
            } catch (appendError) {
              console.warn(
                `⚠️ [CHUNKER] Child append failed for ${data.type} -> ${parent.type}:`,
                appendError,
              );
            }
          }

          // Push children to stack (reverse order)
          // CRITICAL FIX: Only try to add children if the created node can actually accept them (is a container)
          // AND if the data actually has children.
          if (
            createdNode &&
            "appendChild" in createdNode &&
            data.children &&
            Array.isArray(data.children)
          ) {
            // Calculate absolute position for children
            // Need to handle both regular and Auto Layout cases
            const currentAbsX = absoluteOffset.x + (createdNode.x || 0);
            const currentAbsY = absoluteOffset.y + (createdNode.y || 0);

            for (let i = data.children.length - 1; i >= 0; i--) {
              stack.push({
                data: data.children[i],
                parent: createdNode as FrameNode,
                absoluteOffset: { x: currentAbsX, y: currentAbsY },
              });
            }
          }
        }
      } catch (error) {
        console.error(`❌ [CHUNKER] Error building node ${data.id}:`, error);
        // Continue processing other nodes
      }

      nodesProcessed++;
      if (nodesProcessed % TOTAL_NODES_PER_YIELD === 0) {
        // MEMORY SAFETY: Extended yield to allow Figma's GC to run
        // For large imports, this prevents the WASM memory from spiking
        await new Promise((resolve) => setTimeout(resolve, 1));
        await yieldToMain();
      }
    }
  }

  private async processNodesWithBatchingRobust(
    parentFrame: FrameNode,
  ): Promise<void> {
    // 🚨 EMERGENCY DIAGNOSTIC LOGGING - Capture complete schema structure
    console.log("\n" + "=".repeat(80));
    console.log("🚨 [EMERGENCY DIAGNOSTIC] SCHEMA STRUCTURE ANALYSIS");
    console.log("=".repeat(80));

    // Log all top-level keys in schema
    const schemaKeys = this.data ? Object.keys(this.data) : [];
    console.log("📋 Top-level schema keys:", schemaKeys);

    // Check root field
    console.log("\n🔍 Checking this.data.root:");
    if (this.data.root === undefined) {
      console.log("  ❌ this.data.root is UNDEFINED");
    } else if (this.data.root === null) {
      console.log("  ❌ this.data.root is NULL");
    } else {
      console.log("  ✅ this.data.root EXISTS");
      console.log("  Type:", typeof this.data.root);
      console.log("  Constructor:", this.data.root.constructor?.name);
      console.log("  Keys:", Object.keys(this.data.root).slice(0, 20));
      console.log("  .type:", this.data.root.type);
      console.log("  .htmlTag:", this.data.root.htmlTag);
      console.log(
        "  .children type:",
        Array.isArray(this.data.root.children)
          ? "Array"
          : typeof this.data.root.children,
      );
      console.log("  .children length:", this.data.root.children?.length);
      if (this.data.root.children?.length > 0) {
        console.log("  First child:", {
          type: this.data.root.children[0]?.type,
          htmlTag: this.data.root.children[0]?.htmlTag,
          id: this.data.root.children[0]?.id,
        });
      }
    }

    // Check tree field
    console.log("\n🔍 Checking this.data.tree:");
    if (this.data.tree === undefined) {
      console.log("  ℹ️ this.data.tree is UNDEFINED (expected for schema v2)");
    } else if (this.data.tree === null) {
      console.log("  ❌ this.data.tree is NULL");
    } else {
      console.log("  ✅ this.data.tree EXISTS (schema v1 compatibility)");
      console.log("  Type:", typeof this.data.tree);
      console.log("  .children length:", this.data.tree.children?.length);
    }

    // Check other critical fields
    console.log("\n📊 Other schema fields:");
    console.log("  .version:", this.data.version);
    console.log("  .schemaVersion:", (this.data as any).schemaVersion);
    console.log("  .metadata exists:", !!this.data.metadata);
    console.log("  .assets exists:", !!this.data.assets);
    console.log("  .styles exists:", !!this.data.styles);

    console.log("=".repeat(80) + "\n");
    // 🚨 END EMERGENCY DIAGNOSTIC LOGGING

    // BACKWARDS COMPATIBILITY: Support both schema v2 (root) and v1 (tree)
    if (!this.data.root && !this.data.tree) {
      throw new Error(
        "No root data available (expected 'root' or 'tree' field in schema)",
      );
    }

    // BACKWARDS COMPATIBILITY: Support both schema v2 (root) and v1 (tree)
    const rootNode = this.data.root || this.data.tree;

    if (!rootNode) {
      throw new Error(
        `CRITICAL: No root node found in schema. ` +
          `Expected 'root' (schema v2) or 'tree' (schema v1), but got: ${Object.keys(
            this.data || {},
          )}`,
      );
    }

    console.log("🔍 [SCHEMA] Root node structure:", {
      field: this.data.root ? "root" : "tree",
      type: rootNode.type,
      htmlTag: rootNode.htmlTag,
      hasChildren: !!rootNode.children,
      childCount: rootNode.children?.length || 0,
      hasLayout: !!rootNode.layout,
      schemaKeys: Object.keys(this.data || {}),
    });

    // PHASE 1 OPTIMIZATION: Pre-analyze schema for better planning
    perfTracker.startPhase(PerfPhase.SCHEMA_ANALYSIS);
    const analysis = this.analyzeSchema(rootNode);
    perfTracker.endPhase(PerfPhase.SCHEMA_ANALYSIS);
    perfTracker.updateStats({ totalNodes: analysis.totalNodes });
    console.log(
      `🌳 Schema Analysis: ${analysis.totalNodes} nodes, ${analysis.requiredFonts.size} fonts, ${analysis.imageHashes.size} images, depth: ${analysis.depth}`,
    );

    // CRITICAL CHECK: If analysis found 0 nodes, something is wrong
    if (analysis.totalNodes === 0) {
      console.error("❌ [CRITICAL] Schema analysis found 0 nodes!");
      console.error("Root node details:", {
        type: rootNode?.type,
        htmlTag: rootNode?.htmlTag,
        hasChildren: !!rootNode?.children,
        childrenType: Array.isArray(rootNode?.children)
          ? "array"
          : typeof rootNode?.children,
        childCount: rootNode?.children?.length,
        rootKeys: Object.keys(rootNode || {}),
      });

      console.warn(
        "⚠️ Proceeding with 0 nodes - this will likely result in blank frame",
      );
    }

    this.postProgress(`Pre-analyzing schema...`, 5);

    // PHASE 2: Pre-process schema (normalize values upfront)
    perfTracker.startPhase(PerfPhase.SCHEMA_PREPROCESSING);
    this.preprocessSchema(rootNode);

    // Coordinate normalization: if major containers start at negative coords,
    // shift the whole import so content lands on-canvas.
    this.coordinateOffset = this.computeCoordinateOffsetFromSchema(rootNode);
    if (this.coordinateOffset.x !== 0 || this.coordinateOffset.y !== 0) {
      console.log("🧭 [COORDINATES] Applying global coordinate offset", {
        offsetX: this.coordinateOffset.x,
        offsetY: this.coordinateOffset.y,
      });
    }

    // PROFESSIONAL: Prepare layout schema (Auto Layout only)
    // Important: this mutates node layout metadata and can reset child offsets.
    // Only run when Auto Layout is enabled; pixel-perfect mode must preserve original geometry.
    if (this.options.applyAutoLayout !== false) {
      console.log(
        "🏗️ [PROFESSIONAL LAYOUT] Preparing layout schema with professional intelligence...",
      );
      prepareLayoutSchema(this.data);
      console.log(
        "✅ [PROFESSIONAL LAYOUT] Layout schema prepared with professional-grade analysis",
      );
    } else {
      console.log(
        "🧷 [PROFESSIONAL LAYOUT] Skipping prepareLayoutSchema() (Auto Layout disabled)",
      );
    }
    perfTracker.endPhase(PerfPhase.SCHEMA_PREPROCESSING);

    // HIERARCHY VALIDATION: Build schema parent map for later validation
    hierarchyValidator.reset();
    hierarchyValidator.buildSchemaParentMap(rootNode);

    // PHASE 1 OPTIMIZATION: Pre-load all fonts upfront (parallel)
    this.postProgress(`Pre-loading ${analysis.requiredFonts.size} fonts...`, 6);
    perfTracker.startPhase(PerfPhase.FONT_PRELOAD);
    const fontMap = await this.preloadFontsWithSmartFallback(
      analysis.requiredFonts,
    );
    perfTracker.endPhase(PerfPhase.FONT_PRELOAD);
    perfTracker.updateStats({ fontsLoaded: fontMap.size });
    console.log(`✅ Pre-loaded ${fontMap.size} fonts`);

    // PHASE 1 OPTIMIZATION: Pre-resolve all images upfront (parallel)
    if (analysis.imageHashes.size > 0) {
      this.postProgress(
        `Pre-resolving ${analysis.imageHashes.size} images...`,
        8,
      );
      perfTracker.startPhase(PerfPhase.IMAGE_PRELOAD);
      const imageMap = await this.preResolveImages(
        analysis.imageHashes,
        analysis.totalNodes,
      );
      perfTracker.endPhase(PerfPhase.IMAGE_PRELOAD);
      perfTracker.updateStats({ imagesLoaded: imageMap.size });
      console.log(`✅ Pre-resolved ${imageMap.size} images`);
      // Store image map for use during node creation
      (this.nodeBuilder as any).preResolvedImages = imageMap;
    }

    this.postProgress(`Processing ${analysis.totalNodes} elements...`, 10);

    // CHUNKING LOGIC: For large imports (>5000 nodes), split into chunks to prevent WASM OOM
    const CHUNKING_THRESHOLD = 5000;
    const needsChunking = analysis.totalNodes > CHUNKING_THRESHOLD;

    // Log analysis stats
    console.log(
      `📊 [ANALYSIS] Total nodes: ${analysis.totalNodes}, Chunking threshold: ${CHUNKING_THRESHOLD}`,
    );

    if (needsChunking) {
      console.log(
        `🪓 [CHUNKER] Large import detected (${analysis.totalNodes} nodes > ${CHUNKING_THRESHOLD} threshold)`,
      );
      console.log(
        "🪓 [CHUNKER] Enabling chunked import to prevent WASM memory exhaustion",
      );

      try {
        await this.processChunkedImport(rootNode, parentFrame, analysis);
        return; // Early return - chunked import handles everything
      } catch (chunkError) {
        console.error("❌ [CHUNKER] Chunked import failed:", chunkError);
        // Fallback to normal processing
        console.log("⚠️ [CHUNKER] Falling back to standard processing...");
      }
    }

    // HIERARCHY INFERENCE: Improve tree structure before building
    // BACKWARDS COMPATIBILITY: Use rootNode (which is already root || tree)
    let treeToBuild = rootNode;
    let inferredTreeMetrics: any = null;

    if (this.options.useHierarchyInference !== false) {
      try {
        console.log("🌳 [HIERARCHY] Running hierarchy inference...");
        this.postProgress("Inferring hierarchy structure...", 9);

        // For very large pages (like YouTube), add timeout protection
        perfTracker.startPhase(PerfPhase.HIERARCHY_INFERENCE);
        const inferenceStartTime = Date.now();
        const INFERENCE_TIMEOUT = 30000; // 30 seconds max for inference

        const inferredTree = inferHierarchy(this.data.root);
        const inferenceTime = Date.now() - inferenceStartTime;
        perfTracker.endPhase(PerfPhase.HIERARCHY_INFERENCE);

        if (inferenceTime > INFERENCE_TIMEOUT) {
          console.warn(
            `⚠️ [HIERARCHY] Inference took ${inferenceTime}ms (exceeded ${INFERENCE_TIMEOUT}ms threshold), using original tree for performance`,
          );
          treeToBuild = this.data.root;
        } else {
          inferredTreeMetrics = inferredTree.metrics;

          // Convert inferred tree back to ElementNode format
          treeToBuild = convertInferredTreeToElementNode(inferredTree);

          // Generate and print quality report
          const report = generateTreeQualityReport(
            inferredTree,
            analysis.totalNodes,
          );
          printTreeQualityReport(report);

          // Export debug artifact if in debug mode
          if (this.options.enableDebugMode) {
            const debugArtifact = exportDebugArtifact(inferredTree, report);
            console.log(
              "📊 [HIERARCHY] Debug artifact (first 1000 chars):",
              debugArtifact.substring(0, 1000),
            );
            // Store in plugin data for potential download
            figma.root.setPluginData(
              "hierarchy-inference-debug",
              debugArtifact,
            );
          }

          console.log(
            `✅ [HIERARCHY] Hierarchy inference complete (${inferenceTime}ms)`,
          );
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        console.error(
          `❌ [HIERARCHY] Hierarchy inference failed, falling back to original tree: ${errorMsg}`,
        );
        if (error instanceof Error && error.stack) {
          console.error("Stack trace:", error.stack);
        }
        // Fall back to original tree on error
        treeToBuild = this.data.root;
      }
    } else {
      console.log(
        "⏭️ [HIERARCHY] Hierarchy inference disabled (useHierarchyInference=false)",
      );
    }

    // Build node hierarchy with error tracking and PARALLEL processing
    this.processedNodeCount = 0;

    // Handle body node properly - support both html and body root tags
    // CRITICAL FIX: The schema may have either "html" or "body" as root
    // Simplified logic: Just process the tree directly. The recursive builder handles all children.
    console.log(
      `[DEBUG] Building tree from root: ${
        treeToBuild.htmlTag || treeToBuild.type
      }`,
    );

    const result = await this.buildHierarchyRobust(
      treeToBuild,
      parentFrame,
      { x: 0, y: 0 },
      analysis.totalNodes,
      { isRoot: true },
    );

    if (!result) {
      console.error(`❌ [CRITICAL] Failed to build root node:`, {
        id: treeToBuild.id,
        tagName: treeToBuild.tagName || treeToBuild.htmlTag,
        hasLayout: !!treeToBuild.layout,
        hasChildren: !!treeToBuild.children,
        childCount: treeToBuild.children?.length,
      });
      console.error(`❌ [CRITICAL] PARENT FRAME details:`, {
        id: parentFrame.id,
        name: parentFrame.name,
        removed: parentFrame.removed,
      });
      // GRACEFUL FAILURE: Don't throw - allow partial imports to persist for validation
      console.warn(
        `⚠️ [GRACEFUL] Continuing import despite root tree node failure`,
      );
    }

    console.log(
      `✅ Node processing complete: ${this.processedNodeCount} created, ${this.failedNodes.length} failed`,
    );

    // DIAGNOSTIC: Print detailed node creation statistics
    console.log("\n" + "=".repeat(80));
    console.log("📊 [DIAGNOSTIC] NODE CREATION STATISTICS");
    console.log("=".repeat(80));
    console.log(`  Total Attempted:     ${this.nodeCreationStats.attempted}`);
    console.log(`  Successfully Created: ${this.nodeCreationStats.created}`);
    console.log(`  Failed:              ${this.nodeCreationStats.failed}`);
    console.log(
      `  Null Validation:     ${this.nodeCreationStats.nullValidation}`,
    );
    const successRate =
      this.nodeCreationStats.attempted > 0
        ? (
            (this.nodeCreationStats.created /
              this.nodeCreationStats.attempted) *
            100
          ).toFixed(1)
        : 0;
    console.log(`  Success Rate:        ${successRate}%`);

    if (this.nodeCreationStats.byType.size > 0) {
      console.log("\n  Breakdown by Type:");
      const sortedTypes = Array.from(
        this.nodeCreationStats.byType.entries(),
      ).sort((a, b) => b[1].attempted - a[1].attempted);
      for (const [type, stats] of sortedTypes) {
        const typeSuccessRate =
          stats.attempted > 0
            ? ((stats.created / stats.attempted) * 100).toFixed(0)
            : 0;
        console.log(
          `    ${type}: ${stats.created}/${stats.attempted} created (${typeSuccessRate}%), ${stats.failed} failed`,
        );
      }
    }

    if (
      this.nodeCreationStats.created === 0 &&
      this.nodeCreationStats.attempted > 0
    ) {
      console.error(
        "🚨 [CRITICAL] ALL NODES FAILED TO CREATE! Check createSingleNodeRobust and NodeBuilder.createNode for errors.",
      );
    } else if (
      this.nodeCreationStats.created <
      this.nodeCreationStats.attempted * 0.5
    ) {
      console.warn(
        `⚠️ [WARNING] Less than 50% of nodes were created successfully. This may explain missing content.`,
      );
    }
    console.log("=".repeat(80) + "\n");

    /*
    // OLD COMPLEX LOGIC REMOVED FOR STABILITY
    // If root is "html", find the body child and process that
    let bodyNode = treeToBuild;
    if (treeToBuild.htmlTag === "html") { ... }
    if ((bodyNode.htmlTag === "body" || bodyNode.htmlTag === "html") && bodyNode.children) { ... }
    */
  }

  // RULE 6.1: Sort by stacking context (not just z-index)
  private sortChildrenByStackingContext(children: any[]): any[] {
    return this.sortChildrenByZIndex(children); // Uses enhanced logic below
  }

  private sortChildrenByZIndex(children: any[]): any[] {
    // Preserve original DOM order as a deterministic tie-breaker.
    // (Some runtimes have had unstable sorts; even with stable sorts, being explicit
    // prevents accidental reordering that can place overlay rectangles above images.)
    return children
      .map((child, index) => ({ child, index }))
      .sort((aWrap, bWrap) => {
        const a = aWrap.child;
        const b = bWrap.child;
        const zIndexA = ValidationUtils.safeParseFloat(
          a.zIndex || a.layoutContext?.zIndex,
          0,
        );
        const zIndexB = ValidationUtils.safeParseFloat(
          b.zIndex || b.layoutContext?.zIndex,
          0,
        );

        // RULE 6.1: Consider stacking context markers
        const stackingA =
          a._stackingContext || a.layoutContext?._stackingContext || false;
        const stackingB =
          b._stackingContext || b.layoutContext?._stackingContext || false;
        const isPositionedA =
          (a.position || a.layoutContext?.position) &&
          (a.position || a.layoutContext?.position) !== "static";
        const isPositionedB =
          (b.position || b.layoutContext?.position) &&
          (b.position || b.layoutContext?.position) !== "static";

        const getWeight = (
          zIndex: number,
          isPositioned: boolean,
          hasStacking: boolean,
        ) => {
          if (zIndex < 0) return zIndex;
          if (zIndex > 0) return zIndex;
          // RULE 6.1: Stacking context elements sort above non-stacking
          if (hasStacking && !isPositioned) return 0.05;
          return isPositioned ? 0.1 : 0;
        };

        const diff =
          getWeight(zIndexA, isPositionedA, stackingA) -
          getWeight(zIndexB, isPositionedB, stackingB);
        if (diff !== 0) return diff;
        return aWrap.index - bWrap.index;
      })
      .map((w) => w.child);
  }

  // ============================================================================
  // ROBUST NODE CREATION
  // ============================================================================

  /**
   * RECURSIVE HIERARCHY BUILDER
   * Refactored out of processNodesWithBatchingRobust to resolve QuickJS InternalError.
   * This class method avoids nested async closures which cause "unconsistent stack size" errors.
   */
  /**
   * ITERATIVE HIERARCHY BUILDER (Robust Queue-Based)
   * Refactored to use an iterative queue instead of recursion to prevent "QuickJS InternalError"
   * and stack overflows on deep DOM trees (e.g. YouTube).
   */
  private async buildHierarchyRobust(
    rootNodeData: any,
    rootParent: FrameNode | SceneNode,
    rootAbsoluteOffset: { x: number; y: number },
    totalNodes: number,
    options: { batchSize?: number; isRoot?: boolean } = {},
  ): Promise<SceneNode | null> {
    const batchSize = options.batchSize || 100;

    // Queue for BFS/Iterative processing
    // We use a queue to manage the nodes to create
    interface QueueItem {
      nodeData: any;
      parent: FrameNode | SceneNode;
      absoluteOffset: { x: number; y: number };
      isRoot: boolean;
    }

    const queue: QueueItem[] = [
      {
        nodeData: rootNodeData,
        parent: rootParent,
        absoluteOffset: rootAbsoluteOffset,
        isRoot: options.isRoot || false,
      },
    ];

    let rootCreatedNode: SceneNode | null = null;
    let isFirstItem = true;

    // Process queue
    while (queue.length > 0) {
      const item = queue.shift(); // BFS (FIFO) - better for incremental visuals than DFS
      if (!item) continue;

      const { nodeData, parent, absoluteOffset, isRoot } = item;

      // DIAGNOSTIC: Track attempted node creation
      const nodeType = nodeData?.type || nodeData?.htmlTag || "UNKNOWN";
      this.nodeCreationStats.attempted++;
      if (!this.nodeCreationStats.byType.has(nodeType)) {
        this.nodeCreationStats.byType.set(nodeType, {
          attempted: 0,
          created: 0,
          failed: 0,
        });
      }
      this.nodeCreationStats.byType.get(nodeType)!.attempted++;

      // Validate node data
      const validated = ValidationUtils.validateNodeData(nodeData);

      if (!validated) {
        this.nodeCreationStats.nullValidation++;
        this.nodeCreationStats.failed++;
        this.nodeCreationStats.byType.get(nodeType)!.failed++;
        this.recordFailedNode(
          nodeData,
          "Validation failed (ValidationUtils)",
          null,
          NodeFailureReason.FAIL_VALIDATION,
        );
        continue;
      }

      // FIX 1: Display Contents Handling [REFINED]
      // Elements with display: contents do not generate boxes, they should be flattened
      // CRITICAL: NEVER flatten the root node
      const display =
        nodeData.layout?.display || nodeData.layoutContext?.display;
      if (display === "contents" && !isRoot) {
        // Check for visual properties that would be lost if flattened
        const hasVisuals =
          (nodeData.fills && nodeData.fills.length > 0) ||
          (nodeData.strokes && nodeData.strokes.length > 0) ||
          (nodeData.effects && nodeData.effects.length > 0) ||
          (nodeData.opacity !== undefined && nodeData.opacity < 1);

        if (hasVisuals) {
          console.log(
            `⚠️ [DISPLAY_CONTENTS] Skipping flatten for ${nodeData.name} due to visual properties`,
          );
          // Proceed to create node
        } else {
          console.log(
            `✨ [DISPLAY_CONTENTS] Flattening ${nodeData.name} (passing children to ${parent.name})`,
          );

          // Add children to queue with CURRENT parent
          if (nodeData.children && Array.isArray(nodeData.children)) {
            // Preserve order
            for (const child of nodeData.children) {
              queue.push({
                nodeData: child,
                parent: parent,
                absoluteOffset: absoluteOffset, // contents doesn't offset
                isRoot: false,
              });
            }
          }
          continue; // Done with this node (flattened)
        }
      }

      // FIX 2: Zero-Height Container Filtering [REFINED]
      const width = nodeData.layout?.width ?? 0;
      const height = nodeData.layout?.height ?? 0;
      const isVisible = nodeData.visible !== false && nodeData.opacity !== 0;

      if (
        !isRoot &&
        width <= 0 &&
        height <= 0 &&
        isVisible &&
        (nodeData.type === "FRAME" ||
          nodeData.type === "RECTANGLE" ||
          !nodeData.type) &&
        nodeData.htmlTag !== "body"
      ) {
        const hasPaint =
          (nodeData.fills && nodeData.fills.length > 0) ||
          (nodeData.strokes && nodeData.strokes.length > 0) ||
          (nodeData.effects && nodeData.effects.length > 0);

        const clipsContent =
          nodeData.layoutContext?.overflow === "hidden" ||
          nodeData.layoutContext?.overflow === "scroll";

        if (!hasPaint && !clipsContent) {
          // Log less frequently or only on debug
          // console.log(`🗑️ [ZERO_DIM] Skipping...`);
          this.recordFailedNode(
            nodeData,
            "Zero dimensions and no paint",
            null,
            NodeFailureReason.SKIP_HIDDEN,
          );
          continue;
        }
      }

      try {
        // Log sparingly for performance
        // console.log(`🔨 [BUILD] Creating node ${validated.id}...`);

        const figmaNode = await this.createSingleNodeRobust(
          validated,
          parent as FrameNode,
          absoluteOffset,
        );

        if (!figmaNode) {
          this.nodeCreationStats.failed++;
          this.nodeCreationStats.byType.get(nodeType)!.failed++;
          this.recordFailedNode(
            validated,
            "Node creation returned null",
            null,
            NodeFailureReason.FAIL_NODE_CREATION_NULL,
          );
          continue;
        }

        // Store root return value
        if (isFirstItem) {
          rootCreatedNode = figmaNode;
          isFirstItem = false;
        }

        // Track successful creation
        this.nodeCreationStats.created++;
        this.nodeCreationStats.byType.get(nodeType)!.created++;

        this.createdNodes.set(validated.id, figmaNode);
        hierarchyValidator.registerFigmaNode(validated.id, figmaNode);
        this.verificationData.push({
          elementId: validated.id,
          originalData: validated,
          figmaNode,
        });

        this.processedNodeCount++;
        perfTracker.incrementStat("nodesCreated");

        const progress = 10 + (this.processedNodeCount / totalNodes) * 70;

        // Yield and update progress occasionally
        if (this.processedNodeCount % 10 === 0) {
          const currentNodeDesc = `${validated.name || "Element"} (${validated.type})`;
          this.postProgress(
            `Building: ${currentNodeDesc} (${this.processedNodeCount}/${totalNodes})`,
            progress,
          );
          await yieldToMain();
        }

        // Calculate new offset for children
        const newOffset = {
          x: absoluteOffset.x + (figmaNode.x || 0),
          y: absoluteOffset.y + (figmaNode.y || 0),
        };

        // QUEUE CHILDREN (Processing Order)

        // 1. Pseudo-elements BEFORE
        if (validated.pseudoElements?.before) {
          queue.push({
            nodeData: validated.pseudoElements.before,
            parent: figmaNode,
            absoluteOffset: newOffset,
            isRoot: false,
          });
        }

        // 2. Children
        if (validated.children && Array.isArray(validated.children)) {
          // Add to queue in standard order
          for (const child of validated.children) {
            queue.push({
              nodeData: child,
              parent: figmaNode,
              absoluteOffset: newOffset,
              isRoot: false,
            });
          }
        }

        // 3. Pseudo-elements AFTER
        if (validated.pseudoElements?.after) {
          queue.push({
            nodeData: validated.pseudoElements.after,
            parent: figmaNode,
            absoluteOffset: newOffset,
            isRoot: false,
          });
        }
      } catch (error) {
        this.recordFailedNode(
          validated,
          error instanceof Error ? error.message : "Unknown error",
          error instanceof Error ? error.stack : undefined,
          NodeFailureReason.FAIL_UNKNOWN_EXCEPTION,
        );
      }
    }

    return rootCreatedNode;
  }

  private async createSingleNodeRobust(
    nodeData: ValidatedNodeData,
    parent: FrameNode,
    absoluteOffset: { x: number; y: number },
  ): Promise<SceneNode | null> {
    // FIX: Skip hidden SVG sprite sheets that obscure content
    // CRITICAL FIX: Only skip if explicitly zero-sized. Do NOT skip based on fills alone,
    // as SVGs may have strokes or internal paths that are visible even without top-level fills.
    if (
      (nodeData.type === "VECTOR" || nodeData.htmlTag === "svg") &&
      nodeData.attributes?.["aria-hidden"] === "true"
    ) {
      const hasZeroDims =
        (nodeData.attributes &&
          nodeData.attributes.style &&
          nodeData.attributes.style.includes("height: 0")) ||
        (nodeData.attributes &&
          nodeData.attributes.style &&
          nodeData.attributes.style.includes("width: 0")) ||
        (nodeData.layout &&
          (nodeData.layout.width <= 1 || nodeData.layout.height <= 1));

      if (hasZeroDims) {
        console.log(
          `🚫 [SKIP] Ignoring hidden SVG sprite sheet (zero size): ${nodeData.name}`,
        );
        return null;
      }
    }

    // Create node via NodeBuilder
    console.log(
      `➡️ [NODE_BUILDER] calling createNode for ${nodeData.id} (${nodeData.type})`,
    );
    // CRITICAL FIX: Pass parent absolute bounds to ensure correct relative positioning
    const parentBounds = parent.absoluteRenderBounds
      ? { x: parent.absoluteRenderBounds.x, y: parent.absoluteRenderBounds.y }
      : undefined;

    const figmaNode = await this.nodeBuilder.createNode(nodeData, parentBounds);

    if (!figmaNode) {
      console.error(
        `❌ [NODE_CREATION] NodeBuilder returned null for ${nodeData.id}`,
        {
          id: nodeData.id,
          type: nodeData.type,
          tagName: nodeData.tagName,
          hasLayout: !!nodeData.layout,
          hasRect: !!nodeData.rect,
          hasStyles: !!nodeData.styles,
          nodeKeys: Object.keys(nodeData),
        },
      );
      return null;
    }
    console.log(
      `✅ [NODE_CREATION] Created figma node: ${figmaNode.id} (${figmaNode.type})`,
    );

    // Clear body/html backgrounds (including images)
    // Body/html elements should not have backgrounds applied as they would override the main frame
    if (
      (nodeData.htmlTag === "body" || nodeData.htmlTag === "html") &&
      "fills" in figmaNode
    ) {
      const bodyFills = (figmaNode as any).fills;
      if (Array.isArray(bodyFills) && bodyFills.length > 0) {
        const hasNonWhiteFill = bodyFills.some((fill: any) => {
          // Check for IMAGE fills - these should always be cleared for body/html
          if (fill.type === "IMAGE") {
            return true;
          }
          // Check for non-white SOLID fills
          if (fill.type === "SOLID" && fill.color) {
            const isWhite =
              fill.color.r > 0.95 && fill.color.g > 0.95 && fill.color.b > 0.95;
            const isTransparent = fill.opacity === 0;
            return !isWhite && !isTransparent;
          }
          // Clear any other fill types (gradients, etc.) for body/html
          return fill.type !== "SOLID";
        });

        if (hasNonWhiteFill) {
          // ENHANCED: PRESERVE DARK MODE
          // Do NOT strip backgrounds from body/html. If they are dark, we want them!
          console.log(
            `  ✅ [THEME] Preserving ${bodyFills.length} fill(s) on ${nodeData.htmlTag} element (Dark Mode support)`,
          );
          // (figmaNode as any).fills = []; // DISABLED
        }
      }
    }

    // Apply metadata
    this.applyNodeMetadata(figmaNode, nodeData);

    // Calculate and apply position
    // CRITICAL VALIDATION: IMAGE nodes should have proper parent relationships
    if (nodeData.type === "IMAGE" && !nodeData.parentId) {
      console.warn(
        `⚠️ IMAGE node "${
          nodeData.name || nodeData.id
        }" has no parentId - placement may be inaccurate`,
      );
      // Don't throw - attempt to proceed
    }

    // CRITICAL FIX: Ensure parent absolute coordinates are stored before calculating child position
    // This must happen BEFORE position calculation so child can reference parent's position
    if (
      !parent.getPluginData("absoluteX") ||
      !parent.getPluginData("absoluteY")
    ) {
      // Try to get parent's absolute coordinates from its stored data
      const parentNode = nodeData.parentId
        ? this.createdNodes.get(nodeData.parentId)
        : null;
      const parentAbsX = parentNode
        ? parentNode.getPluginData("absoluteX") || "0"
        : "0";
      const parentAbsY = parentNode
        ? parentNode.getPluginData("absoluteY") || "0"
        : "0";

      // If parent doesn't have stored coordinates, check if it's the root frame
      if (parentAbsX === "0" && parentAbsY === "0") {
        // Check if this is the main frame (root of import)
        const isMainFrame =
          parent.name === this.data.root?.name ||
          parent.id === this.mainFrame?.id ||
          !parent.parent ||
          parent.parent.type === "PAGE";

        if (isMainFrame) {
          // Root frame starts at (0, 0) in document coordinates
          this.safeSetPluginData(parent, "absoluteX", "0");
          this.safeSetPluginData(parent, "absoluteY", "0");
        } else if ("x" in parent && "y" in parent) {
          // For non-root frames, use their position as absolute (if not in Auto Layout)
          const hasAutoLayout =
            "layoutMode" in parent && parent.layoutMode !== "NONE";
          if (!hasAutoLayout) {
            // Calculate absolute position from parent's position in its parent
            const parentParent = parent.parent;
            if (parentParent && "x" in parentParent && "y" in parentParent) {
              const parentParentAbsX = ValidationUtils.safeParseFloat(
                parentParent.getPluginData("absoluteX") || "0",
                0,
              );
              const parentParentAbsY = ValidationUtils.safeParseFloat(
                parentParent.getPluginData("absoluteY") || "0",
                0,
              );
              const absX = parentParentAbsX + parent.x;
              const absY = parentParentAbsY + parent.y;
              this.safeSetPluginData(parent, "absoluteX", String(absX));
              this.safeSetPluginData(parent, "absoluteY", String(absY));
            } else {
              // No parent parent, use position directly
              this.safeSetPluginData(parent, "absoluteX", String(parent.x));
              this.safeSetPluginData(parent, "absoluteY", String(parent.y));
            }
          }
        }
      } else {
        // Parent has stored coordinates, use them
        this.safeSetPluginData(parent, "absoluteX", parentAbsX);
        this.safeSetPluginData(parent, "absoluteY", parentAbsY);
      }
    }

    // Calculate position BEFORE appending (needs parent context)
    const position = this.calculateNodePosition(nodeData, parent);
    const parentHasAutoLayout =
      "layoutMode" in parent && parent.layoutMode !== "NONE";

    // Store absolute coordinates in plugin data for future reference
    this.safeSetPluginData(figmaNode, "absoluteX", String(position.absoluteX));
    this.safeSetPluginData(figmaNode, "absoluteY", String(position.absoluteY));

    // Apply Auto Layout (optional) - must happen BEFORE appending
    if (this.options.applyAutoLayout !== false) {
      await this.applyAutoLayoutRobust(figmaNode, nodeData);
      this.applyFlexChildProperties(figmaNode, nodeData);
    }

    // CRITICAL FIX: Append to parent FIRST, then set position
    // Figma requires nodes to be in the parent's coordinate system before positioning
    if ((parent as SceneNode).type !== "TEXT") {
      // removed agent log block
      // CRITICAL FIX: Use insertChildByZIndex to respect CSS stacking order
      if ("children" in parent) {
        this.nodeBuilder.insertChildByZIndex(
          parent as BaseNode & ChildrenMixin,
          figmaNode,
        );
      } else {
        (parent as any).appendChild(figmaNode);
      }
      // removed agent log block
    }

    // CRITICAL FIX: Set position AFTER appending to parent AND validate coordinates
    // This ensures the position is set in the correct coordinate system
    const childIsAbsoluteInAutoLayout =
      parentHasAutoLayout &&
      ((nodeData as any).layoutPositioning === "ABSOLUTE" ||
        (figmaNode as any).layoutPositioning === "ABSOLUTE");

    if (!parentHasAutoLayout || childIsAbsoluteInAutoLayout) {
      // Validate and sanitize coordinates before applying
      const validX = this.validateCoordinate(position.x, "x", nodeData.id);
      const validY = this.validateCoordinate(position.y, "y", nodeData.id);

      figmaNode.x = validX;
      figmaNode.y = validY;

      // PIXEL-PERFECT SNAP (PHASE 2)
      // Guarantee 100% absolute coordinate fidelity by counter-acting any tree drift.
      // Only apply if not in Auto Layout (which manages its own positions).
      if (
        this.options.usePixelPerfectPositioning !== false &&
        this.mainFrame &&
        !parentHasAutoLayout
      ) {
        const actualAbs = this.getAbsolutePosition(figmaNode);
        const mainFrameAbs = this.getAbsolutePosition(this.mainFrame);

        // Target absolute coordinate in Figma page space
        // position.absoluteX already includes any global coordinateOffset applied
        const targetAbsX = position.absoluteX + mainFrameAbs.x;
        const targetAbsY = position.absoluteY + mainFrameAbs.y;

        const dx = targetAbsX - actualAbs.x;
        const dy = targetAbsY - actualAbs.y;

        // Apply corrective delta if drift detected (> 0.01px to avoid floating point noise)
        if (Math.abs(dx) > 0.01 || Math.abs(dy) > 0.01) {
          figmaNode.x += dx;
          figmaNode.y += dy;

          if (this.options.enableDebugMode) {
            console.log(
              `🎯 [PIXEL-SNAP] Adjusted "${nodeData.name}" by (${dx.toFixed(
                2,
              )}, ${dy.toFixed(2)}) to match absoluteLayout`,
            );
          }
        }
      }

      // DIAGNOSTIC: Log first 10 node positions to debug placement issues
      if (this.processedNodeCount < 10) {
        console.log(
          `📍 [POSITION-DEBUG] Node #${this.processedNodeCount} "${nodeData.name}" (${nodeData.type}):`,
        );
        console.log(
          `   Schema coords: layout=(${nodeData.layout?.x}, ${nodeData.layout?.y}), boundingBox=(${nodeData.boundingBox?.x}, ${nodeData.boundingBox?.y})`,
        );
        console.log(
          `   Calculated: position=(${position.x}, ${position.y}), absolute=(${position.absoluteX}, ${position.absoluteY})`,
        );
        console.log(`   Applied: figmaNode.x=${validX}, figmaNode.y=${validY}`);
        console.log(
          `   Parent: "${parent.name}" absoluteX=${parent.getPluginData(
            "absoluteX",
          )}, absoluteY=${parent.getPluginData("absoluteY")}`,
        );
        console.log(
          `   CoordinateOffset: x=${this.coordinateOffset.x}, y=${this.coordinateOffset.y}`,
        );
      }
      console.log(
        `📍 [POSITION] Node "${nodeData.name}" positioned at (${validX}, ${validY})`,
      );

      // Store absolute coordinates for verification
      this.safeSetPluginData(figmaNode, "appliedX", String(validX));
      this.safeSetPluginData(figmaNode, "appliedY", String(validY));
    } else {
      // For Auto Layout parents, store original position but don't set x/y
      // (Auto Layout will position the child)
      this.safeSetPluginData(
        figmaNode,
        "originalX",
        String(position.absoluteX),
      );
      this.safeSetPluginData(
        figmaNode,
        "originalY",
        String(position.absoluteY),
      );
    }

    // Size is applied by NodeBuilder using absoluteLayout/layout (getBoundingClientRect),
    // which already reflects CSS border-box sizing; avoid double-resizing here.

    // POST-BUILD GEOMETRY DELTA VALIDATION
    // Verify that resulting node geometry matches captured coordinates
    if (nodeData.layout && !parentHasAutoLayout) {
      this.validateNodeGeometry(figmaNode, nodeData, position);
    }

    return figmaNode;
  }

  /**
   * Preserve the captured page coordinate origin during import.
   * Positive page coordinates are meaningful and must not be normalized away.
   * Only genuinely negative content is translated onto the Figma canvas.
   */
  private computeCoordinateOffsetFromSchema(rootNode: any): {
    x: number;
    y: number;
  } {
    const minBounds = this.findMinimumBounds(rootNode);
    const offsetX = minBounds.x < 0 ? -minBounds.x : 0;
    const offsetY = minBounds.y < 0 ? -minBounds.y : 0;

    console.log(
      `🔧 [COORD-FIX] Minimum bounds: x=${minBounds.x}, y=${minBounds.y}; translation: x=${offsetX}, y=${offsetY}`,
    );

    return {
      x: ValidationUtils.safeParseFloat(offsetX, 0),
      y: ValidationUtils.safeParseFloat(offsetY, 0),
    };
  }

  private calculateNodePosition(
    nodeData: ValidatedNodeData,
    parent: FrameNode,
  ): { x: number; y: number; absoluteX: number; absoluteY: number } {
    // PIXEL-PERFECT POSITION CALCULATION v2.0
    // Fixes coordinate system mismatches and Auto Layout positioning issues

    // 1. Extract the canonical page coordinate first.
    // The extractor stores PAGE_ABSOLUTE_CSS_PX in layout.pageX/pageY.
    // layout.x/y and relativeX/relativeY are parent-relative compatibility fields
    // and must not override the canonical page coordinate.
    let absX = 0;
    let absY = 0;

    const hasPageCoordinates =
      nodeData.layout &&
      ValidationUtils.isValidNumber(nodeData.layout.pageX) &&
      ValidationUtils.isValidNumber(nodeData.layout.pageY);

    if (hasPageCoordinates) {
      absX = nodeData.layout!.pageX!;
      absY = nodeData.layout!.pageY!;
    } else if (nodeData.absoluteLayout) {
      // Legacy schema: absoluteLayout is page/document-relative geometry.
      absX = ValidationUtils.safeParseFloat(nodeData.absoluteLayout.left, 0);
      absY = ValidationUtils.safeParseFloat(nodeData.absoluteLayout.top, 0);
    } else if (nodeData.boundingBox) {
      // Legacy schema fallback. boundingBox.x/y are only used when no
      // canonical page coordinates were captured.
      absX = ValidationUtils.safeParseFloat(nodeData.boundingBox.x, 0);
      absY = ValidationUtils.safeParseFloat(nodeData.boundingBox.y, 0);
    } else if (nodeData.layout) {
      // Last-resort legacy fallback.
      absX = ValidationUtils.safeParseFloat(nodeData.layout.x, 0);
      absY = ValidationUtils.safeParseFloat(nodeData.layout.y, 0);
    }

    // PIXEL-PERFECT TEXT BASELINE ADJUSTMENT (PHASE 3)
    // Apply baseline offset captured from DOM to align text vertically
    // This compensates for CSS line-height leading vs Figma text box alignment
    if (
      nodeData.type === "TEXT" &&
      (nodeData as any).renderedMetrics?.baselineOffset
    ) {
      const baselineOffset = ValidationUtils.safeParseFloat(
        (nodeData as any).renderedMetrics.baselineOffset,
        0,
      );
      // Only apply if significant (> 0.5px) to avoid subpixel noise
      if (Math.abs(baselineOffset) > 0.5) {
        absY += baselineOffset;
        if (this.options?.enableDebugMode) {
          console.log(
            `📏 [BASELINE] Adjusted "${
              nodeData.name
            }" y by ${baselineOffset.toFixed(2)}px`,
          );
        }
      }
    }

    // Coordinate normalization: shift negative global page coords onto the canvas.
    // This prevents the main content from being positioned off-frame and then clipped.
    if (this.coordinateOffset.x !== 0 || this.coordinateOffset.y !== 0) {
      absX += this.coordinateOffset.x;
      absY += this.coordinateOffset.y;
    }

    // 2. Determine positioning context
    const cssPosition =
      nodeData.computedPosition?.position ||
      (nodeData as any)?.layoutContext?.position ||
      (nodeData as any)?.position ||
      "";
    const isFixed = cssPosition === "fixed";
    const isAbsolute = cssPosition === "absolute";
    const isSpeciallyPositioned = isFixed || isAbsolute;

    // 3. Check parent Auto Layout status
    const parentHasAutoLayout =
      "layoutMode" in parent && parent.layoutMode !== "NONE";

    // 4. Get parent coordinate information
    const parentAbsXStr = parent.getPluginData("absoluteX");
    const parentAbsYStr = parent.getPluginData("absoluteY");
    const parentAbsX = ValidationUtils.safeParseFloat(parentAbsXStr || "0", 0);
    const parentAbsY = ValidationUtils.safeParseFloat(parentAbsYStr || "0", 0);

    // 5. Calculate relative position based on context
    let relativeX: number;
    let relativeY: number;

    if (isSpeciallyPositioned) {
      // CRITICAL BUG FIX: Fixed/Absolute elements still need to be relative to their parent
      // The old code: relativeX = absX * this.scaleFactor was causing 2845px deviations
      relativeX = absX - parentAbsX;
      relativeY = absY - parentAbsY;

      console.log(
        `🔧 [FIXED BUG] ${cssPosition} element "${nodeData.name}": abs(${absX}, ${absY}) - parent(${parentAbsX}, ${parentAbsY}) = rel(${relativeX}, ${relativeY})`,
      );
    } else if (parentHasAutoLayout) {
      // CRITICAL FIX: Don't override positions for manually positioned elements within Auto Layout containers
      // Check if element is actually supposed to be auto-laid-out or manually positioned
      const isManuallyPositioned =
        isAbsolute ||
        isFixed ||
        nodeData.layoutContext?.position === "absolute" ||
        nodeData.layoutContext?.position === "fixed" ||
        nodeData.layout?.position === "absolute" ||
        nodeData.layout?.position === "fixed";

      if (isManuallyPositioned) {
        // Element is manually positioned within Auto Layout parent - preserve its position
        relativeX = absX - parentAbsX;
        relativeY = absY - parentAbsY;

        console.log(
          `📍 [MANUAL IN AUTO] "${nodeData.name}" manually positioned in Auto Layout parent: (${relativeX}, ${relativeY})`,
        );
      } else {
        // True Auto Layout child: let layout handle positioning
        relativeX = 0;
        relativeY = 0;

        console.log(
          `🔄 [AUTO LAYOUT] Child "${nodeData.name}" in Auto Layout parent - position managed by layout`,
        );
      }
    } else {
      // Derive the Figma parent-relative position directly from the canonical
      // page coordinate. Never substitute the extractor's deprecated relativeX/Y
      // because those values are already parent-relative and can belong to a
      // different coordinate context after normalization.
      relativeX = absX - parentAbsX;
      relativeY = absY - parentAbsY;

      console.log(
        `🧮 [CANONICAL] Position for "${nodeData.name}": page(${absX}, ${absY}) - parent(${parentAbsX}, ${parentAbsY}) = rel(${relativeX}, ${relativeY})`,
      );
    }
    // 6. Validate and sanitize final positions
    relativeX = ValidationUtils.safeParseFloat(relativeX, 0);
    relativeY = ValidationUtils.safeParseFloat(relativeY, 0);

    // 7. Handle special cases for hero/banner elements
    const isHeroElement =
      nodeData.name?.toLowerCase().includes("hero") ||
      nodeData.cssClasses?.some((cls: string) =>
        /hero|banner|navbar|header/i.test(cls),
      ) ||
      (absY < 100 && (nodeData.layout?.height || 0) > 200);

    if (isHeroElement && relativeY < 0 && !isSpeciallyPositioned) {
      console.log(
        `🦸 [HERO FIX] Hero element "${nodeData.name}" had negative Y (${relativeY}), correcting using absolute Y: ${absY}`,
      );
      relativeY = Math.max(0, absY);
    }

    // 8. Log final positioning for debugging
    if (this.options?.enableDebugMode) {
      console.log(
        `✅ [FINAL POSITION] "${nodeData.name}": (${relativeX.toFixed(
          1,
        )}, ${relativeY.toFixed(1)}) | absolute: (${absX}, ${absY})`,
      );
    }

    return {
      x: relativeX,
      y: relativeY,
      absoluteX: absX,
      absoluteY: absY,
    };
  }

  /**
   * POST-BUILD GEOMETRY DELTA VALIDATION
   * Validates that created node geometry matches captured coordinates
   * Reports nodes with deviations > 0.5px for debugging placement issues
   */
  private validateNodeGeometry(
    node: SceneNode,
    nodeData: ValidatedNodeData,
    position: { x: number; y: number; absoluteX: number; absoluteY: number },
  ): void {
    if (
      !("x" in node) ||
      !("y" in node) ||
      !("width" in node) ||
      !("height" in node)
    ) {
      return; // Can't validate nodes without geometry
    }

    const layout = nodeData.layout;
    if (!layout) return;

    // Read actual geometry from created node
    const actualX = node.x;
    const actualY = node.y;
    const actualWidth = (node as any).width;
    const actualHeight = (node as any).height;

    // Expected geometry from capture
    const expectedWidth = layout.width || 0;
    const expectedHeight = layout.height || 0;

    // Calculate deltas
    const dx = Math.abs(actualX - position.x);
    const dy = Math.abs(actualY - position.y);
    const dw = Math.abs(actualWidth - expectedWidth);
    const dh = Math.abs(actualHeight - expectedHeight);

    // Flag if deviation > 0.5px
    const TOLERANCE = 0.5;
    if (dx > TOLERANCE || dy > TOLERANCE || dw > TOLERANCE || dh > TOLERANCE) {
      const report = {
        nodeId: nodeData.id || "unknown",
        nodeName: nodeData.name || "unnamed",
        expected: {
          x: position.x,
          y: position.y,
          width: expectedWidth,
          height: expectedHeight,
        },
        actual: {
          x: actualX,
          y: actualY,
          width: actualWidth,
          height: actualHeight,
        },
        delta: { dx, dy, dw, dh },
      };

      console.warn(
        `⚠️ [GEOMETRY DELTA] "${report.nodeName}" deviation: dx=${dx.toFixed(
          2,
        )}px dy=${dy.toFixed(2)}px dw=${dw.toFixed(2)}px dh=${dh.toFixed(2)}px`,
        report,
      );
    }
  }

  private applyNodeMetadata(
    node: SceneNode,
    nodeData: ValidatedNodeData,
  ): void {
    // Store the canonical captured page coordinates. These are the same
    // coordinates used by calculateNodePosition(), including normalization.
    const rawX =
      nodeData.layout?.pageX ??
      nodeData.absoluteLayout?.left ??
      nodeData.boundingBox?.x ??
      nodeData.layout?.x ??
      0;
    const rawY =
      nodeData.layout?.pageY ??
      nodeData.absoluteLayout?.top ??
      nodeData.boundingBox?.y ??
      nodeData.layout?.y ??
      0;

    const absX = ValidationUtils.safeParseFloat(rawX, 0) + this.coordinateOffset.x;
    const absY = ValidationUtils.safeParseFloat(rawY, 0) + this.coordinateOffset.y;

    this.safeSetPluginData(node, "absoluteX", String(absX));
    this.safeSetPluginData(node, "absoluteY", String(absY));

    // Store schemaId for gap analysis linking (CRITICAL for scene graph export)
    // Store schemaId for gap analysis linking (CRITICAL for scene graph export)
    // TEMPORARY DISABLE to debug WASM crash
    /*
    if (nodeData.id) {
      this.safeSetPluginData(node, "schemaId", String(nodeData.id));
    }
    */

    // Shadow host
    if (nodeData.isShadowHost) {
      node.name = `${node.name} (Shadow Host)`;
      this.safeSetPluginData(node, "isShadowHost", "true");
    }

    // ML classification
    if (
      nodeData.mlUIType &&
      nodeData.mlConfidence &&
      nodeData.mlConfidence > 0.7
    ) {
      this.safeSetPluginData(node, "mlClassification", nodeData.mlUIType);
      this.safeSetPluginData(
        node,
        "mlConfidence",
        String(nodeData.mlConfidence),
      );

      if (
        node.name === "Frame" ||
        node.name === "Rectangle" ||
        node.name === nodeData.htmlTag
      ) {
        node.name = `${nodeData.mlUIType} - ${node.name}`;
      }

      if (
        (nodeData.mlUIType === "BUTTON" || nodeData.mlUIType === "INPUT") &&
        nodeData.mlConfidence > 0.9
      ) {
        this.safeSetPluginData(
          node,
          "suggestedComponentType",
          nodeData.mlUIType,
        );
      }
    }
  }

  private async applyAutoLayoutRobust(
    node: SceneNode,
    nodeData: ValidatedNodeData,
  ): Promise<void> {
    if (!("layoutMode" in node)) return;

    const hasAutoLayout =
      nodeData.autoLayout ||
      (nodeData.layoutMode &&
        nodeData.layoutMode !== "NONE" &&
        nodeData.layoutMode !== "GRID") ||
      (nodeData.suggestedAutoLayout && nodeData.suggestedLayoutMode);

    if (!hasAutoLayout) return;

    const frame = node as FrameNode;
    // Preserve visual size before switching layout modes. Auto Layout can default
    // to "hug contents" and collapse large containers into skinny columns.
    const originalWidth = frame.width;
    const originalHeight = frame.height;

    // PIXEL-SAFE: Only apply Auto Layout when schema validation says it is safe.
    const validation = (nodeData.autoLayout as any)?.validation;
    if (validation && validation.safe === false) {
      console.log(
        `❌ [AUTO_LAYOUT] Skipping Auto Layout for ${frame.name}: validation.safe=false`,
        {
          maxChildDeltaPx: validation.maxChildDeltaPx,
          tolerancePx: validation.tolerancePx,
          reasons: validation.reasons,
        },
      );
      return;
    }

    // Get raw layoutMode value (can be HORIZONTAL, VERTICAL, NONE, GRID, or undefined)
    const rawLayoutMode =
      nodeData.autoLayout?.layoutMode ||
      nodeData.layoutMode ||
      nodeData.suggestedLayoutMode;

    // Filter out invalid values before type assertion
    if (!rawLayoutMode || rawLayoutMode === "NONE" || rawLayoutMode === "GRID")
      return;

    // Now safely cast to valid Auto Layout mode
    const layoutMode = rawLayoutMode as "HORIZONTAL" | "VERTICAL";

    try {
      frame.layoutMode = layoutMode;

      // Sizing modes
      frame.primaryAxisSizingMode = (nodeData.autoLayout
        ?.primaryAxisSizingMode ||
        nodeData.primaryAxisSizingMode ||
        // Production default: preserve captured size unless explicitly set.
        "FIXED") as "FIXED" | "AUTO";

      frame.counterAxisSizingMode = (nodeData.autoLayout
        ?.counterAxisSizingMode ||
        nodeData.counterAxisSizingMode ||
        "FIXED") as "FIXED" | "AUTO";

      // Alignment
      frame.primaryAxisAlignItems = (nodeData.autoLayout
        ?.primaryAxisAlignItems ||
        nodeData.primaryAxisAlignItems ||
        "MIN") as "MIN" | "MAX" | "CENTER" | "SPACE_BETWEEN";

      frame.counterAxisAlignItems = (nodeData.autoLayout
        ?.counterAxisAlignItems ||
        nodeData.counterAxisAlignItems ||
        "MIN") as "MIN" | "MAX" | "CENTER" | "BASELINE";

      // Spacing
      const itemSpacing = ValidationUtils.safeParseFloat(
        nodeData.autoLayout?.itemSpacing ?? nodeData.itemSpacing,
        0,
      );
      frame.itemSpacing = Math.max(0, itemSpacing);

      // Padding
      frame.paddingLeft = this.clampPadding(
        nodeData.autoLayout?.paddingLeft ?? nodeData.paddingLeft,
      );
      frame.paddingRight = this.clampPadding(
        nodeData.autoLayout?.paddingRight ?? nodeData.paddingRight,
      );
      frame.paddingTop = this.clampPadding(
        nodeData.autoLayout?.paddingTop ?? nodeData.paddingTop,
      );
      frame.paddingBottom = this.clampPadding(
        nodeData.autoLayout?.paddingBottom ?? nodeData.paddingBottom,
      );

      // Wrap mode
      const layoutWrap = nodeData.autoLayout?.layoutWrap || nodeData.layoutWrap;
      if (layoutWrap === "WRAP") {
        frame.layoutWrap = "WRAP";
        const counterAxisSpacing = ValidationUtils.safeParseFloat(
          nodeData.autoLayout?.counterAxisSpacing ??
            nodeData.counterAxisSpacing,
          0,
        );
        frame.counterAxisSpacing = Math.max(0, counterAxisSpacing);
      }

      // Re-apply the captured size after enabling Auto Layout to prevent shrink/hug regressions.
      try {
        if (
          Number.isFinite(originalWidth) &&
          Number.isFinite(originalHeight) &&
          originalWidth > 0 &&
          originalHeight > 0
        ) {
          frame.resize(originalWidth, originalHeight);
        }
      } catch (resizeErr) {
        console.warn(
          "⚠️ Failed to preserve frame size after Auto Layout:",
          resizeErr,
        );
      }

      console.log(`✅ Auto Layout applied: ${layoutMode}`);
    } catch (error) {
      console.warn(`⚠️ Failed to apply Auto Layout:`, error);
    }
  }

  private applyFlexChildProperties(
    node: SceneNode,
    nodeData: ValidatedNodeData,
  ): void {
    // Support absolute-positioned children inside Auto Layout frames.
    // This preserves pixel-perfect x/y even when parent uses Auto Layout.
    if ("layoutPositioning" in node && (nodeData as any).layoutPositioning) {
      const lp = String((nodeData as any).layoutPositioning).toUpperCase();
      if (lp === "ABSOLUTE" || lp === "AUTO") {
        try {
          (node as any).layoutPositioning = lp;
        } catch (e) {
          console.warn("Failed to set layoutPositioning on child:", e);
        }
      }
    }

    if ("layoutGrow" in node && nodeData.layoutGrow !== undefined) {
      const layoutGrow = ValidationUtils.safeParseFloat(nodeData.layoutGrow, 0);
      if (layoutGrow > 0) {
        (node as FrameNode).layoutGrow = layoutGrow;
      }
    }

    if (
      "layoutAlign" in node &&
      nodeData.layoutAlign &&
      nodeData.layoutAlign !== "INHERIT"
    ) {
      (node as FrameNode).layoutAlign = nodeData.layoutAlign as
        | "MIN"
        | "CENTER"
        | "MAX"
        | "STRETCH";
    }
  }

  private clampPadding(value: number | undefined | null): number {
    if (value === undefined || value === null) return 0;
    const parsed = ValidationUtils.safeParseFloat(value, 0);
    return Math.max(0, parsed);
  }

  private safeSetPluginData(node: SceneNode, key: string, value: string): void {
    try {
      // CRITICAL: Aggressive limit to prevent WASM memory crashes
      if (!value || typeof value !== "string") return;

      const MAX_SIZE = 100; // Drastically reduced from 1024 to 100
      let safeValue = value;

      if (value.length > MAX_SIZE) {
        // Simple hash
        let hash = 0;
        for (let i = 0; i < value.length; i++) {
          hash = (hash << 5) - hash + value.charCodeAt(i);
          hash |= 0;
        }
        // Keep meaningful prefix if possible, replace dangerous chars
        const prefix = value.substring(0, 20).replace(/[^\w-]/g, "_");
        safeValue = `${prefix}_${Math.abs(hash).toString(16)}`;
      }

      node.setPluginData(key, safeValue);
    } catch (error) {
      // Silent fail or minimal log to avoid console crash
    }
  }

  private recordFailedNode(
    nodeData: any,
    errorMessage: string,
    stack: string | undefined | null,
    reasonCode: NodeFailureReason = NodeFailureReason.FAIL_UNKNOWN_EXCEPTION,
  ): void {
    this.failedNodes.push({
      id: nodeData.id || "unknown",
      type: nodeData.type || nodeData.tagName || "unknown",
      error: errorMessage,
      reasonCode,
      stack: stack || undefined,
      nodeData: nodeData,
      parentId: nodeData.parentId,
      hasLayout: !!nodeData.layout,
      hasRect: !!nodeData.rect,
      geometry: {
        width: nodeData.layout?.width ?? nodeData.rect?.width,
        height: nodeData.layout?.height ?? nodeData.rect?.height,
        x: nodeData.layout?.x ?? nodeData.rect?.x,
        y: nodeData.layout?.y ?? nodeData.rect?.y,
      },
      timestamp: Date.now(),
    });
  }

  /**
   * Helper to yield control back to the main thread, preventing [Violation] warnings.
   */
  private yieldToMainThread(): Promise<void> {
    return new Promise((r) => setTimeout(r, 0));
  }

  // ============================================================================
  // IMAGE PROCESSING WITH VALIDATION
  // ============================================================================

  /**
   * PHASE 1 OPTIMIZATION: Pre-resolve all images upfront in parallel
   */
  private async preResolveImages(
    imageHashes: Set<string>,
    nodeCount?: number,
  ): Promise<Map<string, Paint>> {
    const imageMap = new Map<string, Paint>();
    const hashArray = Array.from(imageHashes);

    if (hashArray.length === 0) {
      return imageMap;
    }

    console.log(`📸 Pre-resolving ${hashArray.length} images in parallel...`);

    // Statistics tracking
    const stats = { resolved: 0, timedOut: 0, failed: 0 };
    const timedOutHashes: string[] = [];
    const failedHashes: string[] = [];

    // CRITICAL DIAGNOSTIC: Log assets.images content vs requested hashes
    const assetKeys = Object.keys(this.nodeBuilder.assets?.images || {});
    console.log(
      `📊 [IMAGE DEBUG] Assets.images has ${assetKeys.length} entries`,
    );
    console.log(`📊 [IMAGE DEBUG] Image hashes requested: ${hashArray.length}`);
    if (assetKeys.length > 0) {
      console.log(
        `📊 [IMAGE DEBUG] First 5 asset keys: ${assetKeys
          .slice(0, 5)
          .join(", ")}`,
      );
    }
    if (hashArray.length > 0) {
      console.log(
        `📊 [IMAGE DEBUG] First 5 requested hashes: ${hashArray
          .slice(0, 5)
          .join(", ")}`,
      );
    }
    // Check for mismatches
    const missingInAssets = hashArray.filter((h) => !assetKeys.includes(h));
    if (missingInAssets.length > 0) {
      console.warn(
        `⚠️ [IMAGE DEBUG] ${missingInAssets.length} hashes NOT in assets.images!`,
      );
      console.warn(
        `⚠️ [IMAGE DEBUG] Missing hashes: ${missingInAssets
          .slice(0, 5)
          .join(", ")}`,
      );
    }

    // Helper to get asset source type for logging
    const getSourceType = (hash: string): string => {
      const asset = this.nodeBuilder.assets?.images?.[hash];
      if (!asset) return "MISSING";
      if (asset.data || asset.base64) return "BASE64";
      if (asset.url) return "URL";
      return "UNKNOWN";
    };

    // Process images in parallel batches with concurrency limit
    const concurrency = 12;

    for (let i = 0; i < hashArray.length; i += concurrency) {
      // Yield before each batch to allow rAF to breathe
      await this.yieldToMainThread();

      const batch = hashArray.slice(i, i + concurrency);
      console.log(
        `Processing batch ${Math.floor(i / concurrency) + 1}/${Math.ceil(hashArray.length / concurrency)} (${batch.length} images)...`,
      );

      const batchPromises = batch.map(async (hash) => {
        const sourceType = getSourceType(hash);
        console.log(`  ▶️ Resolving ${hash} [source: ${sourceType}]...`);
        const startTime = Date.now();
        try {
          // MANDATORY FIX: Direct resolution without timeout to prevent "ignore-late" data loss
          const paint = await this.nodeBuilder.resolveImagePaint({
            imageHash: hash,
            type: "IMAGE",
          });
          const duration = Date.now() - startTime;

          console.log(`  ✅ Resolved ${hash} [${sourceType}] in ${duration}ms`);
          stats.resolved++;
          return { hash, paint };
        } catch (error) {
          const duration = Date.now() - startTime;
          console.warn(
            `  ❌ FAILED ${hash} [${sourceType}] after ${duration}ms:`,
            error,
          );
          stats.failed++;
          failedHashes.push(hash);
          // Return transparent fallback (not visible placeholder)
          return {
            hash,
            paint: {
              type: "SOLID",
              color: { r: 0, g: 0, b: 0 },
              opacity: 0,
            } as SolidPaint,
          };
        }
      });

      const results = await Promise.allSettled(batchPromises);
      results.forEach((result, idx) => {
        if (result.status === "fulfilled") {
          imageMap.set(batch[idx], result.value.paint);
        } else {
          // Fallback to transparent on critical error
          imageMap.set(batch[idx], {
            type: "SOLID",
            color: { r: 0, g: 0, b: 0 },
            opacity: 0,
          } as SolidPaint);
        }
      });

      // Small delay between batches to avoid overwhelming Figma API
      if (i + concurrency < hashArray.length) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }

    // Summary log
    console.log(`\n📊 [IMAGE RESOLUTION SUMMARY]`);
    console.log(`   ✅ Resolved: ${stats.resolved}/${hashArray.length}`);
    console.log(`   ⏰ Timed Out: ${stats.timedOut}`);
    console.log(`   ❌ Failed: ${stats.failed}`);
    if (timedOutHashes.length > 0) {
      console.log(
        `   ⏰ Timed out hashes: ${timedOutHashes.slice(0, 5).join(", ")}${timedOutHashes.length > 5 ? ` (+${timedOutHashes.length - 5} more)` : ""}`,
      );
    }
    if (failedHashes.length > 0) {
      console.log(
        `   ❌ Failed hashes: ${failedHashes.slice(0, 5).join(", ")}${failedHashes.length > 5 ? ` (+${failedHashes.length - 5} more)` : ""}`,
      );
    }

    console.log(`✅ Pre-resolved ${imageMap.size}/${hashArray.length} images`);
    return imageMap;
  }

  private async batchProcessImagesRobust(imageNodes: any[]): Promise<void> {
    // Also collect all image hashes from assets registry that might not be in tree
    const assetImageHashes = new Set<string>();
    if (this.data.assets?.images) {
      Object.keys(this.data.assets.images).forEach((hash) => {
        assetImageHashes.add(hash);
        // Also add as a node for preloading
        if (!imageNodes.find((n) => n.imageHash === hash)) {
          imageNodes.push({ imageHash: hash, source: "asset-registry" });
        }
      });
    }

    console.log(
      `📸 Preloading ${imageNodes.length} images (${assetImageHashes.size} from asset registry)`,
    );

    const batches = this.chunkArray(imageNodes, this.options.maxBatchSize);

    for (let i = 0; i < batches.length; i++) {
      this.postProgress(
        `Processing image batch ${i + 1}/${batches.length}...`,
        15 + (i / batches.length) * 15,
      );

      const batchPromises = batches[i].map((node) =>
        this.preloadImageRobust(node),
      );
      const results = await Promise.allSettled(batchPromises);

      // Log failures
      const failures = results.filter((r) => r.status === "rejected");
      if (failures.length > 0) {
        console.warn(
          `⚠️ ${failures.length} images failed to preload in batch ${i + 1}`,
        );
      }

      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  private async preloadImageRobust(
    nodeData: any,
    attempt: number = 0,
  ): Promise<ImageCreationResult> {
    const startTime = Date.now();
    const result: ImageCreationResult = {
      success: false,
      retryAttempts: attempt,
      processingTime: 0,
      originalHash: nodeData.imageHash || "unknown",
    };

    try {
      const imageHash = nodeData.imageHash;

      if (!imageHash || typeof imageHash !== "string") {
        throw new Error("Invalid or missing imageHash");
      }

      if (this.imageCreationCache.has(imageHash)) {
        result.success = true;
        result.imageHash = this.imageCreationCache.get(imageHash);
        return result;
      }

      // P0-1 FIX: Normalize hash by stripping any data URI prefixes
      // Capture side may send full data URLs as hashes in some edge cases
      const normalizedHash = this.normalizeImageHash(imageHash);

      let imageAsset = this.data.assets?.images?.[imageHash];

      // P0-1 FIX: Also try normalized hash if exact match fails
      if (!imageAsset && normalizedHash !== imageHash) {
        imageAsset = this.data.assets?.images?.[normalizedHash];
        if (imageAsset) {
          console.log(
            `[IMAGE HASH] Matched via normalized hash: ${imageHash.substring(0, 30)}... -> ${normalizedHash.substring(0, 20)}...`,
          );
        }
      }

      // If exact match not found, try fuzzy matching
      if (!imageAsset && this.data.assets?.images) {
        const allKeys = Object.keys(this.data.assets.images);

        // P0-1 FIX: Log diagnostic info for debugging hash mismatches
        if (allKeys.length > 0 && allKeys.length <= 20) {
          console.log(
            `[IMAGE HASH DEBUG] Looking for: ${imageHash.substring(0, 40)}...`,
          );
          console.log(
            `[IMAGE HASH DEBUG] Available keys (${allKeys.length}):`,
            allKeys.map((k) => k.substring(0, 30) + "..."),
          );
        }

        // P0-1 FIX: Try matching by normalized forms of both sides
        const normalizedLookupHash = normalizedHash.toLowerCase();
        for (const key of allKeys) {
          const normalizedKey = this.normalizeImageHash(key).toLowerCase();
          if (normalizedKey === normalizedLookupHash) {
            console.log(
              `[IMAGE HASH] Matched via double-normalized hash: ${key.substring(0, 30)}...`,
            );
            imageAsset = this.data.assets.images[key];
            break;
          }
        }

        // Fallback: Deterministic fuzzy matching via suffix
        if (!imageAsset) {
          const hashSuffix = normalizedHash.slice(-8); // Last 8 chars
          const candidates = allKeys.filter((key) => {
            const normalizedKey = this.normalizeImageHash(key);
            return (
              normalizedKey.endsWith(hashSuffix) ||
              normalizedHash.endsWith(normalizedKey.slice(-8))
            );
          });
          if (candidates.length === 1) {
            const key = candidates[0];
            console.log(
              `[IMAGE HASH] Fuzzy matching (unique suffix candidate): ${key.substring(0, 30)}... for ${imageHash.substring(0, 30)}...`,
            );
            imageAsset = this.data.assets.images[key];
          } else if (candidates.length > 1) {
            console.warn(
              `[IMAGE HASH] Ambiguous fuzzy match for ${imageHash.substring(0, 30)}... (${candidates.length} candidates) - skipping to avoid wrong image`,
            );
          }
        }

        // Try case-insensitive matching on original hash
        if (!imageAsset) {
          const lowerHash = imageHash.toLowerCase();
          for (const key of allKeys) {
            if (key.toLowerCase() === lowerHash) {
              console.log(
                `[IMAGE HASH] Case-insensitive match: ${key.substring(0, 30)}... for ${imageHash.substring(0, 30)}...`,
              );
              imageAsset = this.data.assets.images[key];
              if (imageAsset) {
                break;
              }
            }
          }
        }
      }

      if (!imageAsset) {
        const availableKeys = Object.keys(this.data.assets?.images || {});
        console.error(
          `[IMAGE HASH] FAILED: Asset not found for hash: ${imageHash.substring(0, 50)}...`,
        );
        console.error(
          `[IMAGE HASH] Available keys (${availableKeys.length}):`,
          availableKeys.slice(0, 10).map((k) => k.substring(0, 30) + "..."),
        );
        throw new Error(
          `Image asset not found: ${imageHash.substring(0, 50)}...`,
        );
      }

      const base64Data =
        imageAsset.base64 || imageAsset.data || imageAsset.screenshot;

      const urlCandidate =
        (typeof imageAsset.url === "string" && imageAsset.url) ||
        (typeof imageAsset.absoluteUrl === "string" &&
          imageAsset.absoluteUrl) ||
        (typeof imageAsset.originalUrl === "string" &&
          imageAsset.originalUrl) ||
        null;

      const mimeHint =
        (typeof imageAsset.mimeType === "string" && imageAsset.mimeType) ||
        (typeof (imageAsset as any).contentType === "string" &&
          (imageAsset as any).contentType) ||
        "";
      const isAvifAsset =
        mimeHint.toLowerCase().includes("avif") ||
        (typeof urlCandidate === "string" &&
          /\.avif(\?|#|$)/i.test(urlCandidate));

      let imageBytes: Uint8Array | null = null;
      const strictCloneMode = this.options.strictCloneMode ?? true; // FIDELITY FIX: Default to true

      if (base64Data && typeof base64Data === "string") {
        const normalized = ValidationUtils.normalizeBase64Payload(base64Data);
        if (!ValidationUtils.validateBase64(normalized)) {
          console.warn(
            `⚠️ Invalid base64 for image ${imageHash}, will try URL fallback if available`,
          );
        } else {
          try {
            // AVIF is common on modern sites (incl. Etsy), but Figma createImage doesn't support it.
            // Prefer transcoding up-front when we have a strong AVIF hint.
            imageBytes = isAvifAsset
              ? await requestImageTranscode(normalized, "image/avif")
              : await this.base64ToUint8ArrayRobust(normalized);
          } catch (decodeError) {
            console.warn(
              `⚠️ base64Decode failed for ${imageHash}, will try URL fallback if available`,
              decodeError,
            );
          }
        }
      }

      // ROOT CAUSE FIX: Even in strictCloneMode, we MUST allow fetching if the extension
      // skipped embedding OR if base64 decode failed. Otherwise, we get magenta rectangles.
      if (!imageBytes && urlCandidate) {
        const isSvg =
          /\.svg(\?|#|$)/i.test(urlCandidate) ||
          (typeof imageAsset.mimeType === "string" &&
            imageAsset.mimeType.includes("svg"));

        // Let NodeBuilder handle SVG rasterization/vector conversion; don't preload.
        if (!isSvg) {
          const fetched = await this.fetchImageBytesRobust(urlCandidate);
          const isWebp =
            (fetched.contentType || "").includes("image/webp") ||
            /\.webp(\?|#|$)/i.test(urlCandidate) ||
            this.isWebpBytes(fetched.bytes);
          const isAvif =
            (fetched.contentType || "").includes("image/avif") ||
            /\.avif(\?|#|$)/i.test(urlCandidate) ||
            this.isAvifBytes(fetched.bytes);
          imageBytes = isWebp
            ? await this.transcodeWebpWithRetry(
                await this.uint8ToBase64(fetched.bytes),
                2,
              )
            : isAvif
              ? await requestImageTranscode(
                  await this.uint8ToBase64(fetched.bytes),
                  "image/avif",
                )
              : fetched.bytes;
        }
      }

      if (!imageBytes) {
        throw new Error(
          urlCandidate
            ? strictCloneMode
              ? `No usable image bytes for ${imageHash} (strict clone: missing/invalid embedded bytes; URL fetch disabled)`
              : `No usable image bytes for ${imageHash} (base64 invalid and URL fetch skipped/failed)`
            : `No usable image bytes for ${imageHash} (missing/invalid base64 and no URL)`,
        );
      }
      const figmaImage = figma.createImage(imageBytes);

      this.imageCreationCache.set(imageHash, figmaImage.hash);
      this.nodeBuilder.preloadImageHash(imageHash, figmaImage.hash);

      result.success = true;
      result.imageHash = figmaImage.hash;

      console.log(`✅ Preloaded image: ${imageHash}`);
    } catch (error) {
      result.error = error instanceof Error ? error.message : "Unknown error";

      // Retry logic
      const nextAttempt = attempt + 1;
      if (this.options.retryFailedImages && nextAttempt <= 2) {
        await new Promise((resolve) => setTimeout(resolve, 100 * nextAttempt));
        return this.preloadImageRobust(nodeData, nextAttempt);
      }

      console.warn(
        `❌ Failed to preload image after ${attempt + 1} attempts:`,
        result.error,
      );
    } finally {
      result.processingTime = Date.now() - startTime;
    }

    return result;
  }

  private async base64ToUint8ArrayRobust(base64: string): Promise<Uint8Array> {
    const clean = ValidationUtils.normalizeBase64Payload(base64);

    // WebP detection and transcoding
    if (ValidationUtils.isWebP(clean)) {
      try {
        const pngBytes = await this.transcodeWebpWithRetry(clean, 2);
        if (pngBytes?.length > 0) {
          return pngBytes;
        }
      } catch (error) {
        console.warn("WebP transcode failed, using direct decode:", error);
      }
    }

    const decoded = figma.base64Decode(clean);
    // If the payload is AVIF (even if mislabeled), transcode before createImage.
    if (this.isAvifBytes(decoded)) {
      return requestImageTranscode(clean, "image/avif");
    }
    return decoded;
  }

  private async fetchImageBytesRobust(
    url: string,
    timeoutMs = 20000,
  ): Promise<{ bytes: Uint8Array; contentType?: string }> {
    try {
      // Use proxy fetch for external URLs
      const result = await fetchWithProxy(url);
      return { bytes: result.bytes, contentType: result.contentType };
    } catch (proxyError) {
      console.warn(
        `  ⚠️ Proxy fetch failed for ${url}, trying direct:`,
        proxyError,
      );

      let signal: AbortSignal | undefined;
      let timeout: any;

      if (typeof AbortController !== "undefined") {
        const controller = new AbortController();
        timeout = setTimeout(() => controller.abort(), timeoutMs);
        signal = controller.signal;
      }

      try {
        const fetchOptions: any = {
          headers: {
            Accept:
              "image/webp,image/png,image/jpeg,image/apng,image/svg+xml,*/*;q=0.8",
          },
        };
        if (signal) {
          fetchOptions.signal = signal;
        }

        const response = await fetch(url, fetchOptions);
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const contentType = response.headers.get("content-type") || undefined;
        const buffer = await response.arrayBuffer();
        return { bytes: new Uint8Array(buffer), contentType };
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    }
  }

  private isWebpBytes(bytes: Uint8Array): boolean {
    if (!bytes || bytes.length < 12) return false;
    return (
      bytes[0] === 0x52 &&
      bytes[1] === 0x49 &&
      bytes[2] === 0x46 &&
      bytes[3] === 0x46 &&
      bytes[8] === 0x57 &&
      bytes[9] === 0x45 &&
      bytes[10] === 0x42 &&
      bytes[11] === 0x50
    );
  }

  private isAvifBytes(bytes: Uint8Array): boolean {
    if (!bytes || bytes.length < 16) return false;
    const isFtyp =
      bytes[4] === 0x66 &&
      bytes[5] === 0x74 &&
      bytes[6] === 0x79 &&
      bytes[7] === 0x70;
    if (!isFtyp) return false;
    const brand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
    return brand === "avif" || brand === "avis";
  }

  private async uint8ToBase64(bytes: Uint8Array): Promise<string> {
    const BASE64_CHARS =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let result = "";
    const len = bytes.length;

    for (let i = 0; i < len; i += 3) {
      // Yield to main thread every 100kb to prevent blocking rAF
      if (i > 0 && i % 102400 === 0) {
        await this.yieldToMainThread();
      }
      const byte1 = bytes[i];
      const byte2 = i + 1 < len ? bytes[i + 1] : 0;
      const byte3 = i + 2 < len ? bytes[i + 2] : 0;

      const triplet = (byte1 << 16) | (byte2 << 8) | byte3;

      result += BASE64_CHARS[(triplet >> 18) & 0x3f];
      result += BASE64_CHARS[(triplet >> 12) & 0x3f];
      result += i + 1 < len ? BASE64_CHARS[(triplet >> 6) & 0x3f] : "=";
      result += i + 2 < len ? BASE64_CHARS[triplet & 0x3f] : "=";
    }

    return result;
  }

  private async transcodeWebpWithRetry(
    base64: string,
    retries: number,
  ): Promise<Uint8Array> {
    let lastError: any;
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const png = await requestWebpTranscode(base64);
        if (png?.length > 0) {
          return png;
        }
        lastError = new Error("Empty transcode result");
      } catch (error) {
        lastError = error;
        await new Promise((resolve) =>
          setTimeout(resolve, 200 * (attempt + 1)),
        );
      }
    }
    throw lastError || new Error("WebP transcode failed");
  }

  // ============================================================================
  // TEXT NODE VALIDATION
  // ============================================================================

  private async validateAllTextNodes(): Promise<void> {
    this.postProgress("Validating text nodes...", 88);

    const textNodes = Array.from(this.createdNodes.values()).filter(
      (node) => node.type === "TEXT",
    ) as TextNode[];

    console.log(`📝 Validating ${textNodes.length} text nodes`);

    for (const textNode of textNodes) {
      const validation = await this.validateTextNode(textNode);
      this.textValidationResults.push(validation);
    }

    const failures = this.textValidationResults.filter(
      (v) => !v.success,
    ).length;
    console.log(`✅ Text validation complete: ${failures} failures`);
  }

  private async validateTextNode(
    textNode: TextNode,
  ): Promise<TextValidationResult> {
    const result: TextValidationResult = {
      elementId: textNode.id,
      success: true,
      fontLoaded: false,
      contentMatches: true,
      boundsReasonable: true,
      errors: [],
    };

    try {
      // Validate font is loaded
      const fontName = textNode.fontName as FontName;
      const fontKey = `${fontName.family}-${fontName.style}`;
      result.fontLoaded = this.loadedFonts.has(fontKey);

      if (!result.fontLoaded) {
        result.errors.push(`Font not loaded: ${fontKey}`);
        result.success = false;
      }

      // Validate text content
      const text = ValidationUtils.sanitizeText(textNode.characters);
      if (text.length === 0 && textNode.characters.length > 0) {
        result.errors.push("Text contains only invalid characters");
        result.contentMatches = false;
        result.success = false;
      }

      // Validate bounds
      if (textNode.width < 0 || textNode.height < 0) {
        result.errors.push("Negative dimensions");
        result.boundsReasonable = false;
        result.success = false;
      }

      if (textNode.width > 10000 || textNode.height > 10000) {
        result.errors.push("Unreasonably large dimensions");
        result.boundsReasonable = false;
        result.success = false;
      }
    } catch (error) {
      result.success = false;
      result.errors.push(
        error instanceof Error ? error.message : "Unknown error",
      );
    }

    return result;
  }

  // ============================================================================
  // VERIFICATION & REPORTING
  // ============================================================================

  private getAbsolutePosition(node: SceneNode): { x: number; y: number } {
    let x = node.x;
    let y = node.y;
    let parent = node.parent;
    while (parent && parent.type !== "PAGE" && parent.type !== "DOCUMENT") {
      x += parent.x;
      y += parent.y;
      parent = parent.parent;
    }
    return { x, y };
  }

  private async verifyImportAccuracyRobust(): Promise<ImportVerificationReport> {
    this.postProgress("Verifying positions (sampling)...", 90);

    // OPTIMIZED SAMPLING APPROACH v2.0
    // Instead of checking ALL elements (which causes 98% stall), use intelligent sampling
    // to get representative feedback without performance impact

    const allElements = Array.from(this.verificationData);
    const totalElements = allElements.length;

    // Determine sample size based on total elements (max 100 elements for performance)
    const maxSampleSize = Math.min(
      100,
      Math.max(10, Math.floor(totalElements * 0.05)),
    ); // 5% sample, capped at 100

    console.log(
      `📊 [VERIFICATION] Sampling ${maxSampleSize} elements from ${totalElements} total for position verification`,
    );

    let samplesToCheck: typeof allElements = [];

    if (totalElements <= maxSampleSize) {
      // Check all if small dataset
      samplesToCheck = allElements;
    } else {
      // INTELLIGENT SAMPLING: Mix of different element types for representative results
      const stratifiedSample = this.createStratifiedSample(
        allElements,
        maxSampleSize,
      );
      samplesToCheck = stratifiedSample;
    }

    const results: PositionVerificationResult[] = [];
    const deviations: number[] = [];

    // Calculate Main Frame absolute position to use as anchor
    const mainFrameAbs = this.mainFrame
      ? this.getAbsolutePosition(this.mainFrame)
      : { x: 0, y: 0 };

    for (const { elementId, originalData, figmaNode } of samplesToCheck) {
      if (!("x" in figmaNode) || !("y" in figmaNode)) continue;
      if (!originalData.layout && !originalData.absoluteLayout) continue;

      const expectedX = ValidationUtils.safeParseFloat(
        originalData.absoluteLayout?.left ?? originalData.layout?.x,
        0,
      );
      const expectedY = ValidationUtils.safeParseFloat(
        originalData.absoluteLayout?.top ?? originalData.layout?.y,
        0,
      );

      // Get absolute position of the node in Figma (traversing up to Page)
      const nodeAbs = this.getAbsolutePosition(figmaNode);

      // Calculate position relative to Main Frame (which should match Schema global coordinates)
      const actual = {
        x: nodeAbs.x - mainFrameAbs.x,
        y: nodeAbs.y - mainFrameAbs.y,
      };

      // Expected coordinates must match the coordinate normalization applied during import.
      const expected = {
        x: expectedX + (this.coordinateOffset.x || 0),
        y: expectedY + (this.coordinateOffset.y || 0),
      };

      const xDiff = Math.abs(actual.x - expected.x);
      const yDiff = Math.abs(actual.y - expected.y);
      const deviation = Math.sqrt(xDiff * xDiff + yDiff * yDiff);
      const withinTolerance = deviation <= this.options.coordinateTolerance;

      deviations.push(deviation);
      results.push({
        elementId,
        expected,
        actual,
        deviation,
        withinTolerance,
      });

      // Log problematic elements immediately for debugging
      if (!withinTolerance) {
        console.warn(
          `⚠️ [POSITION] Element "${elementId}" position deviation: ${deviation.toFixed(
            1,
          )}px (expected: ${expected.x.toFixed(1)}, ${expected.y.toFixed(
            1,
          )} | actual: ${actual.x.toFixed(1)}, ${actual.y.toFixed(1)})`,
        );

        // UNIFIED DIAGNOSTICS: Record position mismatch
        this.diagnosticCollector.recordMismatch(
          elementId,
          "POSITION",
          expected,
          actual,
          `Position deviation: ${deviation.toFixed(1)}px`,
          deviation > 10 ? "ERROR" : "WARN",
        );
      }

      // 🔍 ASSET VERIFICATION: Check if image nodes actually have images
      if (originalData.type === "IMAGE" || originalData.imageHash) {
        const actualFills =
          "fills" in figmaNode ? (figmaNode.fills as Paint[]) : [];
        const hasImage = actualFills.some((f) => f.type === "IMAGE");

        if (!hasImage) {
          console.error(
            `❌ [ASSET] Image element "${elementId}" is missing its image fill in Figma!`,
          );

          // UNIFIED DIAGNOSTICS: Record asset mismatch
          this.diagnosticCollector.recordMismatch(
            elementId,
            "ASSET",
            "IMAGE_PAINT",
            "SOLID/NONE",
            "Image asset failed to render - node has no image fill",
            "ERROR",
          );
        }
      }
    }

    results.sort((a, b) => b.deviation - a.deviation);

    const withinTolerance = results.filter((r) => r.withinTolerance).length;
    const outsideTolerance = results.length - withinTolerance;

    // Calculate confidence interval for the sample
    const sampleAccuracy = withinTolerance / results.length;
    const estimatedTotalAccurate = Math.round(sampleAccuracy * totalElements);

    console.log(
      `📊 [VERIFICATION] Sample accuracy: ${(sampleAccuracy * 100).toFixed(
        1,
      )}% (${withinTolerance}/${
        results.length
      }) | Estimated total accurate: ${estimatedTotalAccurate}/${totalElements}`,
    );

    return {
      totalElements: this.createdNodes.size,
      successfulElements: this.createdNodes.size - this.failedNodes.length,
      failedElements: this.failedNodes.length,
      positionsVerified: results.length, // Sample size, not total
      positionsWithinTolerance: withinTolerance,
      positionsOutsideTolerance: outsideTolerance,
      maxDeviation: deviations.length > 0 ? Math.max(...deviations) : 0,
      averageDeviation:
        deviations.length > 0
          ? deviations.reduce((sum, d) => sum + d, 0) / deviations.length
          : 0,
      problematicElements: results
        .filter((r) => !r.withinTolerance)
        .slice(0, 10),
      imagesProcessed: this.imageCreationCache.size,
      imagesSuccessful: Array.from(this.imageCreationCache.values()).filter(
        (h) => h,
      ).length,
      imagesFailed: 0,
      totalProcessingTime: 0,
      textNodesValidated: this.textValidationResults.length,
      textValidationFailures: this.textValidationResults.filter(
        (v) => !v.success,
      ).length,
      failedNodes: this.failedNodes,
      // Add sampling metadata
      samplingUsed: true,
      sampleSize: results.length,
      estimatedAccuracy: sampleAccuracy,
    };
  }

  /**
   * Creates a stratified sample that represents different types of elements
   * for more accurate position verification without checking every element
   */
  private createStratifiedSample(elements: any[], sampleSize: number): any[] {
    // Categorize elements by type for stratified sampling
    const textElements = elements.filter((e) => e.originalData.type === "TEXT");
    const imageElements = elements.filter(
      (e) => e.originalData.type === "IMAGE",
    );
    const frameElements = elements.filter(
      (e) => e.originalData.type === "FRAME",
    );
    const otherElements = elements.filter(
      (e) => !["TEXT", "IMAGE", "FRAME"].includes(e.originalData.type),
    );

    const strata = [
      { name: "TEXT", elements: textElements },
      { name: "IMAGE", elements: imageElements },
      { name: "FRAME", elements: frameElements },
      { name: "OTHER", elements: otherElements },
    ];

    let sample: any[] = [];
    const remainingSize = sampleSize;

    // Proportional allocation with minimum representation for each type
    for (const stratum of strata) {
      if (stratum.elements.length === 0) continue;

      // Calculate stratum sample size (proportional + minimum 1 if exists)
      const proportion = stratum.elements.length / elements.length;
      let stratumSample = Math.max(1, Math.floor(proportion * remainingSize));
      stratumSample = Math.min(stratumSample, stratum.elements.length);

      // Random sample within stratum
      const shuffled = stratum.elements.sort(() => 0.5 - Math.random());
      sample = sample.concat(shuffled.slice(0, stratumSample));
    }

    // If we're under the target, fill with random elements
    if (sample.length < sampleSize) {
      const remaining = elements.filter((e) => !sample.includes(e));
      const additional = remaining
        .sort(() => 0.5 - Math.random())
        .slice(0, sampleSize - sample.length);
      sample = sample.concat(additional);
    }

    console.log(
      `📊 [SAMPLING] Created stratified sample: ${
        sample.length
      } elements (Text: ${
        sample.filter((e) => e.originalData.type === "TEXT").length
      }, Images: ${
        sample.filter((e) => e.originalData.type === "IMAGE").length
      }, Frames: ${
        sample.filter((e) => e.originalData.type === "FRAME").length
      }, Other: ${
        sample.filter(
          (e) => !["TEXT", "IMAGE", "FRAME"].includes(e.originalData.type),
        ).length
      })`,
    );

    return sample.slice(0, sampleSize);
  }

  private generateFinalReport(
    totalTime: number,
    verification: ImportVerificationReport | null,
  ): ImportVerificationReport {
    const report: ImportVerificationReport = verification || {
      totalElements: this.createdNodes.size,
      successfulElements: this.createdNodes.size - this.failedNodes.length,
      failedElements: this.failedNodes.length,
      positionsVerified: 0,
      positionsWithinTolerance: 0,
      positionsOutsideTolerance: 0,
      maxDeviation: 0,
      averageDeviation: 0,
      problematicElements: [],
      imagesProcessed: this.imageCreationCache.size,
      imagesSuccessful: this.imageCreationCache.size,
      imagesFailed: 0,
      totalProcessingTime: totalTime,
      textNodesValidated: this.textValidationResults.length,
      textValidationFailures: this.textValidationResults.filter(
        (v) => !v.success,
      ).length,
      failedNodes: this.failedNodes,
    };

    report.totalProcessingTime = totalTime;
    report.memoryUsage = {
      imageCache: this.imageCreationCache.size,
      nodeCache: this.createdNodes.size,
      verificationData: this.verificationData.length,
    };

    return report;
  }

  /**
   * PHASE 2: Pre-process schema to normalize values upfront
   * REFACTORED: Iterative traversal to prevent Maximum Call Stack Exceeded
   */
  private preprocessSchema(rootNode: any): void {
    if (!rootNode) return;

    // Iterative traversal with cycle detection
    const stack = [rootNode];
    const visited = new Set<any>();

    while (stack.length > 0) {
      const node = stack.pop();
      if (!node) continue;

      // Cycle detection
      if (visited.has(node)) {
        continue;
      }
      visited.add(node);

      // ROBUSTNESS: BACKFILL LAYOUT FROM RECT
      // Some capture engines produce 'rect' instead of 'layout'. NodeBuilder strictly requires 'layout'.
      if (!node.layout && node.rect && typeof node.rect === "object") {
        node.layout = {
          x: node.rect.x,
          y: node.rect.y,
          width: node.rect.width,
          height: node.rect.height,
        };
      }

      // Normalize numeric values
      if (node.layout) {
        node.layout.x = ValidationUtils.safeParseFloat(node.layout.x, 0);
        node.layout.y = ValidationUtils.safeParseFloat(node.layout.y, 0);
        node.layout.width = ValidationUtils.safeParseFloat(
          node.layout.width,
          0,
        );
        node.layout.height = ValidationUtils.safeParseFloat(
          node.layout.height,
          0,
        );
      }

      // Normalize opacity
      if (node.opacity !== undefined) {
        node.opacity = Math.max(
          0,
          Math.min(1, ValidationUtils.safeParseFloat(node.opacity, 1)),
        );
      }

      // Normalize zIndex
      if (node.zIndex !== undefined) {
        node.zIndex = ValidationUtils.safeParseFloat(node.zIndex, 0);
      }

      // Push children to stack
      if (Array.isArray(node.children)) {
        // Reverse order to process first child first (though order doesn't strictly matter for preprocessing)
        for (let i = node.children.length - 1; i >= 0; i--) {
          stack.push(node.children[i]);
        }
      }
    }
  }

  // ============================================================================
  // MEMORY CLEANUP
  // ============================================================================

  private performMemoryCleanup(): void {
    console.log("🧹 Performing memory cleanup");

    this.imageCreationCache.clear();
    this.verificationData = [];

    // Keep createdNodes and failedNodes for reporting

    console.log("✅ Memory cleanup complete");
  }

  // ============================================================================
  // UI COMMUNICATION
  // ============================================================================

  private postProgress(message: string, percent: number): void {
    figma.ui.postMessage({
      type: "progress",
      message,
      percent: Math.min(100, Math.max(0, percent)),
    });
  }

  private postComplete(report: ImportVerificationReport): void {
    figma.ui.postMessage({
      type: "complete",
      stats: {
        elements: report.successfulElements,
        failed: report.failedElements,
        images: report.imagesSuccessful,
        textNodes: report.textNodesValidated,
      },
      verification: report,
    });

    // Get style operation statistics for user warning
    const styleStats = this.nodeBuilder.getStyleOperationStats();
    const styleFailureRate = styleStats.failureRate;
    const hasHighStyleFailureRate = styleFailureRate > 0.1; // >10% failure rate

    // User notification with style operation warnings
    if (report.failedElements > 0 || hasHighStyleFailureRate) {
      let message = `⚠️ Import complete: ${report.successfulElements} successful`;

      if (report.failedElements > 0) {
        message += `, ${report.failedElements} failed`;
      }

      if (hasHighStyleFailureRate) {
        const percentFailed = Math.round(styleFailureRate * 100);
        message += `. ${percentFailed}% of style operations failed`;
        console.warn(
          `⚠️ [STYLE_OPERATIONS] High failure rate detected:`,
          styleStats,
        );
        console.warn(
          `⚠️ [STYLE_OPERATIONS] This may indicate schema issues or incompatible CSS properties. Check console for details.`,
        );
      }

      figma.notify(message + ". See console for details.", { timeout: 6000 });
    } else {
      figma.notify(
        `✅ Import complete: ${report.successfulElements} elements created!`,
      );
    }
  }

  // ============================================================================
  // SCREENSHOT & UTILITIES
  // ============================================================================

  private normalizeScreenshotToDataUrl(screenshot: unknown): string | null {
    if (typeof screenshot !== "string") return null;
    const trimmed = screenshot.trim();
    if (!trimmed) return null;
    if (trimmed.includes(",")) return trimmed;

    const cleanBase64 = trimmed.replace(/\s/g, "");
    if (!ValidationUtils.validateBase64(cleanBase64)) return null;

    // Assume PNG when only base64 is provided.
    return `data:image/png;base64,${cleanBase64}`;
  }

  /**
   * PHASE 1 OPTIMIZATION: Comprehensive schema analysis in single pass
   */
  private analyzeSchema(root: any): {
    totalNodes: number;
    imageNodes: any[];
    imageHashes: Set<string>;
    requiredFonts: Set<string>;
    nodeTypes: Map<string, number>;
    depth: number;
  } {
    // 🚨 EMERGENCY: Log what analyzeSchema receives
    console.log("🔬 [analyzeSchema] Called with root:", {
      exists: !!root,
      type: typeof root,
      isNull: root === null,
      isUndefined: root === undefined,
      constructor: root?.constructor?.name,
      keys: root ? Object.keys(root).slice(0, 20) : [],
    });

    let totalNodes = 0;
    const imageNodes: any[] = [];
    const imageHashes = new Set<string>();
    const requiredFonts = new Set<string>();
    const nodeTypes = new Map<string, number>();
    let maxDepth = 0;

    // CRITICAL: Iterative traversal to prevent stack overflow
    const stack: { node: any; depth: number }[] = [{ node: root, depth: 0 }];
    // Cycle detection to prevent infinite loops
    const visited = new Set<any>();

    while (stack.length > 0) {
      const { node, depth } = stack.pop()!;

      if (!node) continue;

      // Cycle detection
      if (visited.has(node)) continue;
      visited.add(node);

      totalNodes++;
      maxDepth = Math.max(maxDepth, depth);

      // Track node types
      const type = node.type || "UNKNOWN";
      nodeTypes.set(type, (nodeTypes.get(type) || 0) + 1);

      // Collect image hashes
      if (node.type === "IMAGE" && node.imageHash) {
        imageNodes.push(node);
        imageHashes.add(node.imageHash);
      } else if (node.imageHash) {
        // Fallback for any node with an image hash
        imageHashes.add(node.imageHash);
      }

      // Check for images in fills array
      if (Array.isArray(node.fills)) {
        node.fills.forEach((fill: any) => {
          if (fill?.type === "IMAGE" && fill?.imageHash) {
            imageHashes.add(fill.imageHash);
            if (!imageNodes.some((n: any) => n.imageHash === fill.imageHash)) {
              imageNodes.push({ imageHash: fill.imageHash, source: "fill" });
            }
          }
        });
      }

      // Check for images in backgrounds array
      if (Array.isArray(node.backgrounds)) {
        node.backgrounds.forEach((bg: any) => {
          const bgHash = bg?.imageHash || bg?.fill?.imageHash;
          if (bgHash) {
            imageHashes.add(bgHash);
            if (!imageNodes.some((n: any) => n.imageHash === bgHash)) {
              imageNodes.push({ imageHash: bgHash, source: "background" });
            }
          }
        });
      }

      // Collect required fonts from text nodes
      if (node.type === "TEXT") {
        if (node.textStyle?.fontFamily) {
          const family = node.textStyle.fontFamily;
          const weight = node.textStyle.fontWeight || 400;
          const style = this.weightToStyle(weight);
          requiredFonts.add(`${family}|${style}`);
        } else if (node.fontFamily) {
          const family = node.fontFamily;
          const weight = (node.fontWeight || 400) as number;
          const style = this.weightToStyle(weight);
          requiredFonts.add(`${family}|${style}`);
        }
      }

      // Push children to stack (in reverse order to process first child first)
      if (Array.isArray(node.children)) {
        for (let i = node.children.length - 1; i >= 0; i--) {
          stack.push({ node: node.children[i], depth: depth + 1 });
        }
      }
    }

    console.log("🔬 [analyzeSchema] Traversal complete. Final results:", {
      totalNodes,
      maxDepth,
      uniqueImages: imageHashes.size,
      uniqueFonts: requiredFonts.size,
    });

    return {
      totalNodes,
      imageNodes,
      imageHashes,
      requiredFonts,
      nodeTypes,
      depth: maxDepth,
    };
  }

  /**
   * Legacy method - kept for backward compatibility
   */
  private traverseAndCollect(root: any): {
    totalNodes: number;
    imageNodes: any[];
  } {
    const analysis = this.analyzeSchema(root);
    return { totalNodes: analysis.totalNodes, imageNodes: analysis.imageNodes };
  }

  private chunkArray<T>(array: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size));
    }
    return chunks;
  }

  /**
   * P0-1 FIX: Normalize an image hash by stripping data URI prefixes.
   * The capture side sometimes uses full data URLs as keys, while the lookup
   * side may use just the base64 portion or a hash of the content.
   *
   * This normalizes by:
   * 1. Stripping data:image/...;base64, prefixes
   * 2. Removing any whitespace
   * 3. Returning just the raw base64/hash portion
   */
  private normalizeImageHash(hash: string): string {
    if (!hash || typeof hash !== "string") return "";

    // Strip data URI prefix if present (common format: data:image/png;base64,...)
    let normalized = hash;
    const dataUriMatch = hash.match(/^data:[^;]+;base64,(.+)$/i);
    if (dataUriMatch) {
      normalized = dataUriMatch[1];
    }

    // Also handle cases where only "base64," prefix exists
    if (normalized.startsWith("base64,")) {
      normalized = normalized.substring(7);
    }

    // Remove any whitespace that might have crept in
    normalized = normalized.replace(/\s/g, "");

    return normalized;
  }

  /**
   * CRITICAL: Validate and sanitize coordinates to prevent positioning failures
   */
  private validateCoordinate(
    value: any,
    axis: "x" | "y",
    nodeId: string,
  ): number {
    if (typeof value !== "number" || !isFinite(value)) {
      console.warn(
        `⚠️ Invalid ${axis} coordinate for node ${nodeId}: ${value}, using 0`,
      );
      return 0;
    }

    // Clamp to reasonable bounds to prevent Figma crashes
    const MIN_COORD = -100000;
    const MAX_COORD = 100000;

    if (value < MIN_COORD || value > MAX_COORD) {
      console.warn(
        `⚠️ ${axis} coordinate ${value} outside safe bounds for node ${nodeId}, clamping`,
      );
      return Math.max(MIN_COORD, Math.min(MAX_COORD, value));
    }

    return value;
  }

  // ============================================================================
  // AI INTEGRATION
  // ============================================================================

  private async integrateColorPalette(colorPalette: any): Promise<void> {
    if (
      !colorPalette.palette ||
      Object.keys(colorPalette.palette).length === 0
    ) {
      return;
    }

    try {
      for (const [name, colorData] of Object.entries(colorPalette.palette)) {
        const color = colorData as any;
        if (!color?.figma) continue;

        try {
          const style = figma.createPaintStyle();
          style.name = `AI Colors/${name}`;
          style.paints = [{ type: "SOLID", color: color.figma, opacity: 1 }];
          console.log(`✅ Color style created: ${name}`);
        } catch (error) {
          console.warn(`⚠️ Failed to create color style ${name}:`, error);
        }
      }
    } catch (error) {
      console.warn("⚠️ Color palette integration failed:", error);
    }
  }

  private async integrateTypographyAnalysis(typography: any): Promise<void> {
    if (!typography.tokens || Object.keys(typography.tokens).length === 0) {
      return;
    }

    try {
      for (const [name, tokenData] of Object.entries(typography.tokens)) {
        const token = tokenData as any;
        if (!token) continue;

        try {
          const fontFamily = token.fontFamily || "Inter";
          const fontWeight = ValidationUtils.safeParseFloat(
            token.fontWeight,
            400,
          );
          const fontSize = ValidationUtils.safeParseFloat(token.fontSize, 16);
          const fontStyle = this.weightToStyle(fontWeight);

          await this.loadFontWithValidation({
            family: fontFamily,
            style: fontStyle,
          });

          const style = figma.createTextStyle();
          style.name = `AI Typography/${name}`;
          style.fontName = { family: fontFamily, style: fontStyle };
          style.fontSize = fontSize;

          if (token.lineHeight) {
            const lineHeight = ValidationUtils.safeParseFloat(
              token.lineHeight,
              0,
            );
            if (lineHeight > 0) {
              style.lineHeight = { unit: "PIXELS", value: lineHeight };
            }
          }

          if (token.letterSpacing) {
            const letterSpacing = ValidationUtils.safeParseFloat(
              token.letterSpacing,
              0,
            );
            style.letterSpacing = { unit: "PIXELS", value: letterSpacing };
          }

          console.log(`✅ Typography style created: ${name}`);
        } catch (error) {
          console.warn(`⚠️ Failed to create typography style ${name}:`, error);
        }
      }
    } catch (error) {
      console.warn("⚠️ Typography integration failed:", error);
    }
  }

  /**
   * Log comprehensive import completion report with schema statistics
   */
  private logImportCompletionReport(report: any): void {
    const stats = this.calculateImportStatistics();
    const totalTime = Date.now() - (this as any).importStartTime;

    console.log(
      "\n🎯 ═══════════════════════════════════════════════════════════",
    );
    console.log("🚀 FIGMA IMPORT COMPLETION REPORT");
    console.log("═══════════════════════════════════════════════════════════");

    console.log(`📄 SOURCE: ${this.data?.metadata?.url || "Unknown"}`);
    console.log(
      `⏱️  IMPORT TIME: ${totalTime || report.processingTime || "Unknown"}ms`,
    );
    console.log(
      `📊 SUCCESS RATE: ${report.successfulNodes || 0}/${
        report.totalNodes || 0
      } nodes (${(
        ((report.successfulNodes || 0) / Math.max(1, report.totalNodes || 1)) *
        100
      ).toFixed(1)}%)`,
    );

    if (stats) {
      console.log("\n🎯 PIXEL-PERFECT RESULTS:");
      console.log(
        `   Nodes with Transforms Applied: ${stats.transformsApplied}`,
      );
      console.log(`   Matrix Transforms: ${stats.matrixTransforms}`);
      console.log(`   Auto Layout Frames: ${stats.autoLayoutFrames}`);
      console.log(`   Component Instances: ${stats.componentInstances || 0}`);

      console.log("\n📐 FIGMA STRUCTURE:");
      console.log(`   Total Figma Nodes: ${report.successfulNodes || 0}`);
      console.log(`   Frames Created: ${stats.framesCreated || 0}`);
      console.log(`   Text Nodes: ${stats.textNodes || 0}`);
      console.log(`   Vector Graphics: ${stats.vectorNodes || 0}`);
    }

    if (report.errors && report.errors.length > 0) {
      console.log("\n⚠️  ISSUES:");
      console.log(`   Failed Nodes: ${report.errors.length}`);
      report.errors.slice(0, 3).forEach((error: any, i: number) => {
        console.log(
          `   ${i + 1}. ${error.type || "Error"}: ${
            error.message || "Unknown error"
          }`,
        );
      });
    }

    if (report.warnings && report.warnings.length > 0) {
      console.log("\n💡 OPTIMIZATION OPPORTUNITIES:");
      report.warnings.slice(0, 3).forEach((warning: any) => {
        console.log(`   - ${warning}`);
      });
    }

    console.log("═══════════════════════════════════════════════════════════");
    console.log(`🎉 FIGMA IMPORT COMPLETE: Ready for design iteration!`);
    console.log(
      "═══════════════════════════════════════════════════════════\n",
    );

    // MISSING NODES REPORT - Track what failed and why
    this.logMissingNodesReport();
  }

  private logMissingNodesReport(): void {
    console.log("\n" + "=".repeat(80));
    console.log("🔍 MISSING NODES REPORT");
    console.log("=".repeat(80));

    // Count total schema nodes from the original data
    const totalSchemaNodes = this.countSchemaNodes(
      this.data.root || this.data.tree,
    );
    const successfulNodes = this.createdNodes.size;
    const failedNodes = this.failedNodes.length;
    const skippedNodes = Math.max(
      0,
      totalSchemaNodes - successfulNodes - failedNodes,
    );

    console.log(`📊 Total schema nodes received: ${totalSchemaNodes}`);
    console.log(`✅ Successfully created: ${successfulNodes}`);
    console.log(`⏭️  Skipped (no error): ${skippedNodes}`);
    console.log(`❌ Failed (with error): ${failedNodes}`);
    console.log(
      `📈 Success rate: ${((successfulNodes / totalSchemaNodes) * 100).toFixed(
        1,
      )}%`,
    );

    // Group failures by reason code
    const failuresByReason = new Map<NodeFailureReason, FailedNodeReport[]>();
    this.failedNodes.forEach((failure) => {
      const existing = failuresByReason.get(failure.reasonCode) || [];
      existing.push(failure);
      failuresByReason.set(failure.reasonCode, existing);
    });

    if (failuresByReason.size > 0) {
      console.log("\n📋 Top Failure Reasons:");
      const sortedReasons = Array.from(failuresByReason.entries()).sort(
        (a, b) => b[1].length - a[1].length,
      );

      sortedReasons.forEach(([reason, failures]) => {
        console.log(`  ${reason}: ${failures.length} nodes`);
        // Log first occurrence with details
        const first = failures[0];
        console.log(
          `    Example: id=${first.id}, type=${first.type}, name=${
            first.nodeData?.name || "N/A"
          }`,
        );
        console.log(
          `    hasLayout=${first.hasLayout}, hasRect=${first.hasRect}`,
        );
        if (first.geometry) {
          console.log(
            `    geometry: w=${first.geometry.width}, h=${first.geometry.height}`,
          );
        }
        if (first.stack) {
          const stackLines = first.stack.split("\n").slice(0, 3);
          console.log(`    stack: ${stackLines.join(" | ")}`);
        }
      });
    }

    console.log("=".repeat(80) + "\n");
  }

  private countSchemaNodes(node: any): number {
    if (!node) return 0;
    let count = 1; // Count this node
    if (Array.isArray(node.children)) {
      node.children.forEach((child: any) => {
        count += this.countSchemaNodes(child);
      });
    }
    return count;
  }

  /**
   * Calculate import-specific statistics
   */
  private calculateImportStatistics(): any {
    let stats = {
      transformsApplied: 0,
      matrixTransforms: 0,
      autoLayoutFrames: 0,
      componentInstances: 0,
      framesCreated: 0,
      textNodes: 0,
      vectorNodes: 0,
    };

    // Walk through created Figma nodes to gather statistics
    try {
      const mainFrame = this.mainFrame;
      if (mainFrame) {
        stats = this.analyzeNodeStats(mainFrame, stats);
      }
    } catch (error) {
      console.warn("Could not calculate import statistics:", error);
    }

    return stats;
  }

  /**
   * Recursively analyze Figma node statistics
   */
  private analyzeNodeStats(node: SceneNode, stats: any): any {
    // Count node types
    switch (node.type) {
      case "FRAME":
      case "GROUP":
        stats.framesCreated++;
        if ("layoutMode" in node && node.layoutMode !== "NONE") {
          stats.autoLayoutFrames++;
        }
        break;
      case "TEXT":
        stats.textNodes++;
        break;
      case "VECTOR":
      case "STAR":
      case "POLYGON":
      case "ELLIPSE":
      case "RECTANGLE":
        stats.vectorNodes++;
        break;
      case "INSTANCE":
        stats.componentInstances++;
        break;
    }

    // Count transforms
    if (node.getPluginData("absoluteTransformApplied")) {
      stats.transformsApplied++;
    }
    if (node.getPluginData("transformMatrix")) {
      stats.matrixTransforms++;
    }

    // Recurse to children
    if ("children" in node && node.children) {
      node.children.forEach((child: any) => {
        stats = this.analyzeNodeStats(child, stats);
      });
    }

    return stats;
  }

  /**
   * Export diagnostic report for pixel-perfect fidelity debugging
   * Generates comprehensive JSON report with all import tracking data
   */
  private exportDiagnosticReport(): void {
    try {
      const diagnosticExport = this.diagnosticCollector.export();

      // FALLBACK: If diagnostic shows 0 nodes but we have a main frame, count actual nodes
      if (diagnosticExport.summary.totalNodes === 0 && this.mainFrame) {
        const actualNodeCount = this.mainFrame.children.length + 1; // +1 for main frame itself
        console.warn(
          `⚠️ [DIAGNOSTIC] Tracking shows 0 nodes but main frame has ${this.mainFrame.children.length} children. Updating count.`,
        );
        diagnosticExport.summary.totalNodes = actualNodeCount;
        diagnosticExport.summary.successfulNodes = actualNodeCount;

        // Add placeholder entries for untracked nodes
        if (this.mainFrame.children.length > 0) {
          this.mainFrame.children.forEach((child, idx) => {
            diagnosticExport.nodeDetails.push({
              nodeId: `untracked-${idx}`,
              pipelineStatus: {
                schemaNodeId: `untracked-${idx}`,
                figmaNodeId: child.id,
                completedPhases: ["COMPLETE"],
                earlyReturnDetected: false,
                completionTimestamp: Date.now(),
                errorMessages: [],
              },
              warnings: [
                "Node created but not tracked in diagnostic collector",
              ],
              errors: [],
            });
          });
        }
      }

      // Log summary to console
      console.log(
        "\n📊 ═══════════════════════════════════════════════════════════",
      );
      console.log("🔬 DIAGNOSTIC EXPORT SUMMARY");
      console.log(
        "═══════════════════════════════════════════════════════════",
      );
      console.log(`Import ID: ${diagnosticExport.importId}`);
      console.log(`Timestamp: ${diagnosticExport.timestamp}`);
      console.log(`Source URL: ${diagnosticExport.sourceUrl}`);
      console.log("\n📈 NODE STATISTICS:");
      console.log(`   Total Nodes: ${diagnosticExport.summary.totalNodes}`);
      console.log(
        `   Successful Nodes: ${diagnosticExport.summary.successfulNodes}`,
      );
      console.log(
        `   Failed Nodes: ${diagnosticExport.summary.failedNodes.length}`,
      );
      console.log(
        `   White Blank Frames: ${diagnosticExport.summary.whiteBlankFrames.length}`,
      );
      console.log(
        `   Rasterized Nodes: ${diagnosticExport.summary.rasterizedNodes}`,
      );
      console.log(
        `   Auto Layout Nodes: ${diagnosticExport.summary.autoLayoutNodes}`,
      );
      console.log(
        `   Transformed Nodes: ${diagnosticExport.summary.transformedNodes}`,
      );
      console.log(
        `   Early Returns Detected: ${diagnosticExport.summary.earlyReturns.length}`,
      );
      console.log(
        `   Critical Failures: ${diagnosticExport.summary.criticalFailures}`,
      );

      if (diagnosticExport.performanceMetrics) {
        console.log("\n⏱️  PERFORMANCE:");
        console.log(
          `   Total Import Duration: ${diagnosticExport.performanceMetrics.totalImportDurationMs}ms`,
        );
        console.log(
          `   Average Node Build Time: ${diagnosticExport.performanceMetrics.averageNodeBuildTimeMs.toFixed(
            2,
          )}ms`,
        );
        console.log(
          `   Rasterization Time: ${diagnosticExport.performanceMetrics.rasterizationTimeMs}ms`,
        );
      }

      console.log("\n💾 EXPORT:");
      console.log(
        `   Diagnostic data collected for ${diagnosticExport.nodeDetails.length} nodes`,
      );
      console.log(`   Use figma.ui.postMessage to export full JSON`);
      console.log(
        "═══════════════════════════════════════════════════════════\n",
      );

      // Post diagnostic data to UI for download
      figma.ui.postMessage({
        type: "diagnostic-export",
        data: diagnosticExport,
      });

      // Also log the full JSON to console (can be large, but useful for debugging)
      console.log("📋 Full diagnostic data (copy from console):");
      console.log(JSON.stringify(diagnosticExport, null, 2));
    } catch (error) {
      console.error("❌ Failed to export diagnostic report:", error);
    }
  }
}
