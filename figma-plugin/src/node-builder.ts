// Node Builder - Constructs Figma nodes from schema data
import { FontManager } from "./font-manager";
import { StyleManager } from "./style-manager";
import { ComponentManager } from "./component-manager";
import { ImportOptions } from "./import-options";
import { DesignTokensManager } from "./design-tokens-manager";
import { requestImageTranscode, requestWebpTranscode } from "./ui-bridge";
import {
  parseTransform,
  parseTransformOrigin,
  decomposeMatrix,
  ParsedTransform,
} from "./transform-parser";
import { fetchWithProxy } from "./utils/asset-proxy";
import { ProfessionalLayoutSolver } from "./layout-solver";
import {
  parseCssFilter,
  filterRequiresRasterization,
} from "./utils/css-filter-parser";
import {
  NodeValidation,
  ValidationIssue,
  ValidationIssueCode,
  FigmaNodeType,
} from "../../shared/schema";
import {
  parseColorToRGBA,
  type RGBA,
  type RGB,
} from "../../shared/color-utils";

/**
 * Custom error for schema validation failures
 * Allows type-safe error handling instead of fragile string matching
 */
export class SchemaValidationError extends Error {
  constructor(
    message: string,
    public readonly nodeId?: string,
    public readonly fieldName?: string,
  ) {
    super(message);
    this.name = "SchemaValidationError";
  }
}

type SceneNodeWithGeometry = SceneNode & GeometryMixin;

// Type guards for safe property access on SceneNode variants
function hasGeometryMixin(node: SceneNode): node is SceneNode & GeometryMixin {
  return "fills" in node && "strokes" in node;
}

function hasBlendMixin(node: SceneNode): node is SceneNode & BlendMixin {
  return "effects" in node && "opacity" in node;
}

function getNodeFills(node: SceneNode): readonly Paint[] | null {
  if (!hasGeometryMixin(node)) return null;
  const fills = node.fills;
  return fills === figma.mixed ? null : fills;
}

function getNodeStrokes(node: SceneNode): readonly Paint[] | null {
  if (!hasGeometryMixin(node)) return null;
  return node.strokes;
}

function getNodeEffects(node: SceneNode): readonly Effect[] | null {
  if (!hasBlendMixin(node)) return null;
  return node.effects;
}

interface DiagnosticReport {
  nodeId: string;
  nodeName: string;
  nodeType: string;
  issues: string[];
  suggestedFix: string;
  expectedProps: Record<string, any>;
  actualProps: Record<string, any>;
  severity: "warning" | "error" | "critical";
}

// Suggested fixes for common import issues
const IMPORT_ISSUE_FIXES: Record<string, string> = {
  fill: "Fill extraction failed. Check if the element has a valid background-color or background-image in CSS. Transparent elements may not have fills.",
  stroke:
    "Stroke extraction failed. Check if the element has a border style in CSS. The border-style must be solid, dashed, or dotted (not none).",
  text: "Text extraction failed. The text content may be empty or the element may not be a true text node. Check if text is rendered via pseudo-elements.",
  image:
    "Image import failed. The image URL may be invalid, blocked by CORS, or the image bytes were not embedded. Enable strictCloneMode to ensure images are embedded.",
  font: "Font loading failed. Figma cannot load this font. Options: 1) Install the font locally, 2) Enable strictCloneMode to rasterize text, 3) Use a fallback font.",
  layout:
    "Layout values are invalid. Check for NaN/Infinity in position or dimensions. This usually indicates a hidden or collapsed element.",
  transform:
    "CSS transform could not be applied. Complex transforms (3D, perspective) are simplified in Figma.",
  gradient:
    "Gradient parsing failed. Complex gradient syntax may not be fully supported. Falls back to solid color.",
  shadow:
    "Box-shadow could not be converted. Check for valid shadow values with proper units.",
  opacity: "Opacity value is invalid. Must be between 0 and 1.",
  default:
    "An unexpected issue occurred during import. Check the console for more details.",
};

class FigmaImportDiagnostics {
  private reports: DiagnosticReport[] = [];
  private missingFills = 0;
  private missingStrokes = 0;
  private missingText = 0;
  private missingImages = 0;
  private failedFontLoads = 0;
  private importStartTime = 0;
  private importUrl = "";

  startImport(url: string = "unknown"): void {
    this.reports = [];
    this.missingFills = 0;
    this.missingStrokes = 0;
    this.missingText = 0;
    this.missingImages = 0;
    this.failedFontLoads = 0;
    this.importStartTime = Date.now();
    this.importUrl = url;
    console.log(`📊 [IMPORT DIAGNOSTICS] Started for: ${url}`);
  }

  private getSuggestedFix(issue: string): string {
    const lowerIssue = issue.toLowerCase();
    for (const [key, fix] of Object.entries(IMPORT_ISSUE_FIXES)) {
      if (lowerIssue.includes(key)) {
        return fix;
      }
    }
    return IMPORT_ISSUE_FIXES.default;
  }

  private inferSeverity(issue: string): DiagnosticReport["severity"] {
    const lowerIssue = issue.toLowerCase();
    if (
      lowerIssue.includes("critical") ||
      lowerIssue.includes("fatal") ||
      lowerIssue.includes("failed to create")
    ) {
      return "critical";
    }
    if (
      lowerIssue.includes("failed") ||
      lowerIssue.includes("error") ||
      lowerIssue.includes("missing")
    ) {
      return "error";
    }
    return "warning";
  }

  logIssue(
    nodeId: string,
    nodeName: string,
    nodeType: string,
    issue: string,
    expected?: any,
    actual?: any,
  ) {
    const suggestedFix = this.getSuggestedFix(issue);
    const severity = this.inferSeverity(issue);

    const emoji =
      severity === "critical" ? "💀" : severity === "error" ? "❌" : "⚠️";
    // NOTE: console.group/groupEnd are NOT available in Figma's plugin sandbox
    // Using console.log instead to avoid "console.group is not a function" errors
    console.log(
      `${emoji} [FIGMA IMPORT] ${nodeType} "${nodeName}" | Issue: ${issue} | 🔧 Fix: ${suggestedFix}`,
    );
    if (expected) console.log("  Expected:", expected);
    if (actual) console.log("  Actual:", actual);

    const report: DiagnosticReport = {
      nodeId,
      nodeName,
      nodeType,
      issues: [issue],
      suggestedFix,
      severity,
      expectedProps: expected || {},
      actualProps: actual || {},
    };

    this.reports.push(report);

    if (issue.includes("fill")) this.missingFills++;
    if (issue.includes("stroke")) this.missingStrokes++;
    if (issue.includes("text")) this.missingText++;
    if (issue.includes("image")) this.missingImages++;
    if (issue.includes("font")) this.failedFontLoads++;
  }

  getSummary() {
    return {
      totalIssues: this.reports.length,
      missingFills: this.missingFills,
      missingStrokes: this.missingStrokes,
      missingText: this.missingText,
      missingImages: this.missingImages,
      failedFontLoads: this.failedFontLoads,
      reports: this.reports,
    };
  }

  /**
   * Generate a human-readable import report
   */
  generateReport(): string {
    const duration = ((Date.now() - this.importStartTime) / 1000).toFixed(2);
    const summary = this.getSummary();

    const lines: string[] = [];
    lines.push("");
    lines.push(
      "╔══════════════════════════════════════════════════════════════════════════════╗",
    );
    lines.push(
      "║                        FIGMA IMPORT DIAGNOSTIC REPORT                        ║",
    );
    lines.push(
      "╠══════════════════════════════════════════════════════════════════════════════╣",
    );
    lines.push(`║ URL: ${this.importUrl.substring(0, 70).padEnd(70)} ║`);
    lines.push(`║ Duration: ${duration}s`.padEnd(79) + "║");
    lines.push(`║ Total Issues: ${summary.totalIssues}`.padEnd(79) + "║");
    lines.push(
      "╠══════════════════════════════════════════════════════════════════════════════╣",
    );
    lines.push(
      "║ ISSUE BREAKDOWN                                                              ║",
    );
    lines.push(
      "╠══════════════════════════════════════════════════════════════════════════════╣",
    );
    lines.push(
      `║   🎨 Missing Fills:   ${summary.missingFills}`.padEnd(79) + "║",
    );
    lines.push(
      `║   ✏️  Missing Strokes: ${summary.missingStrokes}`.padEnd(79) + "║",
    );
    lines.push(
      `║   📝 Text Issues:     ${summary.missingText}`.padEnd(79) + "║",
    );
    lines.push(
      `║   🖼️  Image Issues:    ${summary.missingImages}`.padEnd(79) + "║",
    );
    lines.push(
      `║   🔤 Font Failures:   ${summary.failedFontLoads}`.padEnd(79) + "║",
    );

    // Group by severity
    const criticalIssues = this.reports.filter(
      (r) => r.severity === "critical",
    );
    const errorIssues = this.reports.filter((r) => r.severity === "error");
    const warningIssues = this.reports.filter((r) => r.severity === "warning");

    if (criticalIssues.length > 0 || errorIssues.length > 0) {
      lines.push(
        "╠══════════════════════════════════════════════════════════════════════════════╣",
      );
      lines.push(
        "║ TOP ISSUES TO FIX                                                            ║",
      );
      lines.push(
        "╠══════════════════════════════════════════════════════════════════════════════╣",
      );

      const topIssues = [...criticalIssues, ...errorIssues].slice(0, 5);
      for (const issue of topIssues) {
        const emoji = issue.severity === "critical" ? "💀" : "❌";
        lines.push(
          `║ ${emoji} ${issue.nodeType} "${issue.nodeName.substring(
            0,
            30,
          )}"`.padEnd(78) + "║",
        );
        lines.push(
          `║    Issue: ${issue.issues[0].substring(0, 60)}`.padEnd(78) + "║",
        );
        lines.push(
          `║    🔧 ${issue.suggestedFix.substring(0, 65)}`.padEnd(78) + "║",
        );
        lines.push("║".padEnd(79) + "║");
      }
    }

    lines.push(
      "╠══════════════════════════════════════════════════════════════════════════════╣",
    );
    if (criticalIssues.length > 0) {
      lines.push(
        "║ 🚨 CRITICAL issues found - some elements may not render correctly.           ║",
      );
    } else if (errorIssues.length > 0) {
      lines.push(
        "║ ⚡ Some errors occurred but import completed. Review issues above.           ║",
      );
    } else if (warningIssues.length > 0) {
      lines.push(
        "║ ✨ Import completed with minor warnings. Quality should be good.             ║",
      );
    } else {
      lines.push(
        "║ ✅ Import completed with no issues! Pixel-perfect result expected.           ║",
      );
    }
    lines.push(
      "╚══════════════════════════════════════════════════════════════════════════════╝",
    );

    return lines.join("\n");
  }

  /**
   * Print the report to console
   */
  printReport(): void {
    console.log(this.generateReport());
  }

  /**
   * Get report as JSON
   */
  getReportJSON(): string {
    return JSON.stringify(
      {
        url: this.importUrl,
        duration: Date.now() - this.importStartTime,
        ...this.getSummary(),
      },
      null,
      2,
    );
  }
}

export const diagnostics = new FigmaImportDiagnostics();

interface ValidatedPaint {
  type:
    | "SOLID"
    | "GRADIENT_LINEAR"
    | "GRADIENT_RADIAL"
    | "GRADIENT_ANGULAR"
    | "GRADIENT_DIAMOND"
    | "IMAGE"
    | "EMOJI";
  visible?: boolean;
  opacity?: number;
  blendMode?: BlendMode;
  color?: RGB;
  gradientTransform?: Transform;
  gradientStops?: ColorStop[];
  imageHash?: string;
  imageTransform?: Transform;
  scaleMode?: "FILL" | "FIT" | "CROP" | "TILE";
  scalingMode?: "FILL" | "FIT" | "CROP" | "TILE";
  rotation?: number;
  gifRef?: any;
  filters?: ImageFilters;
}

interface ValidatedNodeData {
  id: string;
  name: string;
  type: string;
  layout: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  fills?: ValidatedPaint[];
  strokes?: ValidatedPaint[];
  effects?: any[];
  [key: string]: any;
}

export class NodeBuilder {
  private imageFetchCache = new Map<string, Uint8Array>();
  private imagePaintCache = new Map<string, string>(); // Maps asset hash -> Figma image hash
  private imageObjectCache = new Map<string, Image>(); // Maps asset hash -> Figma Image object
  public assets: any;
  private fontCache = new Map<string, { family: string; style: string }>();
  // PHASE 2: Enhanced caching
  private colorParseCache = new Map<string, RGBA | null>();
  private fillConversionCache = new Map<string, Paint[]>();
  private styleBatchCache = new Map<string, any>();
  // ENHANCED: Scale factor for retina/DPI correction
  private scaleFactor: number = 1;

  // TELEMETRY: Track style operation failures for user warning
  private styleOperationStats = {
    totalOperations: 0,
    failedOperations: 0,
    failedValidations: 0,
    failures: [] as { nodeId: string; operation: string; error: string }[],
  };

  private diagnostics: any;

  // MEMORY SAFETY: When true, skip expensive layout intelligence analysis
  // This is set for imports with 1000+ nodes to prevent WASM OOM crashes
  public memorySafetyMode: boolean = false;

  constructor(
    private styleManager: StyleManager,
    private componentManager: ComponentManager,
    private options: ImportOptions,
    assets?: any,
    private designTokensManager?: DesignTokensManager,
    private schema?: any,
    private diagnosticCollector?: any, // Use shared DiagnosticCollector
    private fontManager?: FontManager,
  ) {
    this.assets = assets;
    // PIXEL-PERFECT: All geometry is captured in CSS pixels - no scaling needed
    // The new absolute transform system eliminates coordinate system ambiguity
    this.scaleFactor = 1;

    // Use shared collector if provided, otherwise fallback to local stub for safety
    this.diagnostics = diagnosticCollector || new FigmaImportDiagnostics();

    console.log(
      `[NODE_BUILDER] Initialized with pixel-perfect transform system (scaleFactor: ${this.scaleFactor})`,
    );

    // Initialize standard layout solver fallback
    this.professionalLayoutSolver = new ProfessionalLayoutSolver();
  }

  setAssets(assets: any): void {
    this.assets = assets;
  }

  /**
   * Get style operation statistics for telemetry and user warnings
   */
  getStyleOperationStats() {
    return {
      ...this.styleOperationStats,
      failureRate:
        this.styleOperationStats.totalOperations > 0
          ? this.styleOperationStats.failedOperations /
            this.styleOperationStats.totalOperations
          : 0,
    };
  }

  /**
   * Helper to retrieve the normalized Z-index from plugin data.
   * Defaults to 0 if not found.
   */
  public getZIndex(node: SceneNode): number {
    try {
      const dataStr = node.getPluginData("cssZIndex");
      if (dataStr) {
        const data = JSON.parse(dataStr);
        if (data && typeof data.normalized === "number") {
          return data.normalized;
        }
      }
    } catch (e) {
      // Ignore parse errors
    }
    return 0;
  }

  // Optimization: Shadow Tree to track child order without expensive bridge calls
  private shadowChildren: Map<
    string,
    Array<{ node: SceneNode; zIndex: number }>
  > = new Map();

  /**
   * Inserts a child node into a parent node at the correct index based on Z-index.
   * Uses Shadow Tree optimization to avoid O(N^2) Figma bridge calls.
   */
  public insertChildByZIndex(
    parent: BaseNode & ChildrenMixin,
    child: SceneNode,
  ): void {
    const parentId = parent.id;
    let list = this.shadowChildren.get(parentId);

    if (!list) {
      list = [];
      this.shadowChildren.set(parentId, list);
    }

    const childZ = this.getZIndex(child);
    let insertIndex = list.length; // Default to top

    // Preserve captured DOM order for equal z-index values. Do not infer visual
    // background status from geometry: CSS permits full-size positioned elements
    // above or below content, and geometry alone cannot determine stacking context.
    //
    // Update Shadow Tree
    list.splice(insertIndex, 0, { node: child, zIndex: childZ });

    // Perform Actual Insertion
    if (insertIndex >= parent.children.length) {
      parent.appendChild(child);
    } else {
      parent.insertChild(insertIndex, child);
    }
  }


  /**
   * CRITICAL: Validate and sanitize node data to ensure Figma API compliance
   * This prevents silent failures from invalid properties and paint objects
   */
  /**
   * PROFESSIONAL: Enhanced node validation with layout intelligence and correction
   */
  private validateNodeData(data: any): ValidatedNodeData {
    const nodeId = data.id || "unknown";

    // FAIL-FAST: Warn if critical layout data is missing but attempt to recover
    // This allows partial imports even if some nodes are malformed
    if (!data.layout || typeof data.layout !== "object") {
      console.warn(
        "⚠️ [VALIDATION] Critical layout data missing, using default:",
        {
          nodeId,
          nodeName: data.name,
          nodeType: data.type,
        },
      );
      // Provide recovery layout
      data.layout = { width: 100, height: 100, x: 0, y: 0 };
    }

    const rawWidth = this.validateNumber(data.layout.width, 1);
    const rawHeight = this.validateNumber(data.layout.height, 1);
    const dimensions = this.validateDimensions(rawWidth, rawHeight, nodeId);

    // PROFESSIONAL: Apply layout validation and correction
    // MEMORY SAFETY: Skip expensive layout validation for large imports
    const correctedData = this.memorySafetyMode
      ? data
      : this.applyProfessionalLayoutValidation(data);

    const validated: ValidatedNodeData = {
      id: nodeId,
      name: correctedData.name || "Unnamed",
      type: correctedData.type || "FRAME",
      layout: {
        x: this.validateNumber(correctedData.layout?.x, 0),
        y: this.validateNumber(correctedData.layout?.y, 0),
        width: dimensions.width,
        height: dimensions.height,
      },
    };

    // Copy all other properties as-is, but sanitize critical paint arrays
    // CRITICAL FIX: Merge property-by-property to avoid overwriting validated layout object
    const validatedLayout = { ...validated.layout };
    Object.assign(validated, correctedData);
    validated.layout = validatedLayout;

    // CRITICAL: Sanitize fills to remove schema-specific metadata
    if (data.fills && Array.isArray(data.fills)) {
      validated.fills = this.sanitizePaintArray(data.fills, "fills", data.id);
    }

    // CRITICAL: Sanitize strokes to remove schema-specific metadata
    if (data.strokes && Array.isArray(data.strokes)) {
      validated.strokes = this.sanitizePaintArray(
        data.strokes,
        "strokes",
        data.id,
      );
    }

    return validated;
  }

  /**
   * PHASE 6: Post-Build Validation Checkpoint
   * Verifies the created Figma node matches the schema intent
   */
  private validateNodePostBuild(node: SceneNode, schemaData: any): void {
    if (!schemaData.validation) return;

    const validation = schemaData.validation as NodeValidation;
    const validationIssues: ValidationIssue[] = validation.issues || [];

    // 1. Capture Actual Geometry
    const actualBounds =
      "absoluteRenderBounds" in node
        ? node.absoluteRenderBounds
        : { x: node.x, y: node.y, width: node.width, height: node.height }; // fallback for groups/etc

    // Update validation record
    validation.figmaActual = {
      created: true,
      createdNodeId: node.id,
      createdNodeType: node.type as FigmaNodeType,
      absoluteRenderBounds: actualBounds
        ? {
            x: actualBounds.x,
            y: actualBounds.y,
            width: actualBounds.width,
            height: actualBounds.height,
          }
        : null,
      absoluteTransform2x3:
        "absoluteTransform" in node
          ? (node as SceneNode & { absoluteTransform: Transform })
              .absoluteTransform
          : null,
      fillsActual: getNodeFills(node)?.length ?? 0,
      strokesActual: getNodeStrokes(node)?.length ?? 0,
      effectsActual: getNodeEffects(node)?.length ?? 0,
      childIndexActual: node.parent ? node.parent.children.indexOf(node) : -1,
    };

    // 2. Compute Deltas
    if (validation.dom.layout && actualBounds) {
      const expectedHeight = validation.dom.layout.height;

      // Calculate deltas
      validation.deltas = {
        positionDx: actualBounds.x - validation.dom.layout.x,
        positionDy: actualBounds.y - validation.dom.layout.y,
        widthDw: actualBounds.width - validation.dom.layout.width,
        heightDh: actualBounds.height - validation.dom.layout.height,
        rotationDdeg: 0, // TODO: Extract rotation from transform
      };

      // 3. Evaluate Thresholds (Strict Mode)
      // Geometry Mismatch
      const GEOMETRY_THRESHOLD = 0.5;
      if (
        Math.abs(validation.deltas.positionDx!) > GEOMETRY_THRESHOLD ||
        Math.abs(validation.deltas.positionDy!) > GEOMETRY_THRESHOLD
      ) {
        validationIssues.push({
          code: "POSTBUILD_GEOMETRY_MISMATCH",
          severity: "WARN", // Escalates to ERROR in strict mode
          message: `Position mismatch: dx=${validation.deltas.positionDx?.toFixed(
            2,
          )}, dy=${validation.deltas.positionDy?.toFixed(2)}`,
          evidence: {
            expected: validation.dom.layout,
            actual: actualBounds,
            deltas: validation.deltas,
          },
        });

        // Debug log high discrepancies
        if (
          Math.abs(validation.deltas.positionDx!) > 10 ||
          Math.abs(validation.deltas.positionDy!) > 10
        ) {
          console.warn(
            `❌ [GEOMETRY] Major displacement for ${
              node.name
            }: dx=${validation.deltas.positionDx?.toFixed(
              1,
            )}, dy=${validation.deltas.positionDy?.toFixed(1)}`,
          );

          // UNIFIED DIAGNOSTICS: Record major position failure
          if (this.diagnostics.recordMismatch) {
            this.diagnostics.recordMismatch(
              schemaData.id,
              "POSITION",
              validation.dom.layout,
              actualBounds,
              `Major displacement: dx=${validation.deltas.positionDx?.toFixed(
                1,
              )}, dy=${validation.deltas.positionDy?.toFixed(1)}`,
              "ERROR",
            );
          }
        }
      }
    }

    // Paint Mismatch
    if ("fills" in node) {
      const fillsActual = (node as any).fills.length;
      if (validation.figmaPlan.fillsExpected > 0 && fillsActual === 0) {
        validationIssues.push({
          code: "POSTBUILD_PAINT_MISMATCH",
          severity: "ERROR",
          message: "Node expects fills but has none",
          evidence: { expected: validation.figmaPlan.fillsExpected, actual: 0 },
        });

        // UNIFIED DIAGNOSTICS: Record major paint failure
        if (this.diagnostics.recordMismatch) {
          this.diagnostics.recordMismatch(
            schemaData.id,
            "ASSET",
            validation.figmaPlan.fillsExpected,
            0,
            "Node expects fills but has none (White Blank Frame)",
            "ERROR",
          );
        }
      }

      // 🔍 ASSET CHECK: Detect if image was replaced by solid color
      const expectsImage = schemaData.type === "IMAGE" || schemaData.imageHash;
      const actualFills = (node as any).fills as Paint[];
      const hasImageFill = actualFills.some((f) => f.type === "IMAGE");

      if (expectsImage && !hasImageFill && actualFills.length > 0) {
        if (this.diagnostics.recordMismatch) {
          this.diagnostics.recordMismatch(
            schemaData.id,
            "ASSET",
            "IMAGE_FILL",
            "SOLID_FILL",
            "Image asset missing - replaced with placeholder solid color",
            "ERROR",
          );
        }
      }
    }

    // Attach updated issues list back to schema object for reporting
    schemaData.validation.issues = validationIssues;
  }

  /**
   * ENHANCED: Comprehensive paint validation pipeline
   * Fixes 68% paint object validation failures found in analysis
   */
  private sanitizePaintArray(
    paints: any[],
    type: "fills" | "strokes",
    nodeId: string,
  ): ValidatedPaint[] {
    if (!Array.isArray(paints)) return [];

    return paints
      .map((paint, index) => {
        // COMPREHENSIVE VALIDATION: Use enhanced paint validation
        const validation = this.validatePaintObject(paint, {
          nodeId,
          index,
          type,
        });

        if (!validation.isValid) {
          console.warn(
            `⚠️ [PAINT VALIDATION] ${nodeId} ${type}[${index}]: ${validation.errors.join(
              ", ",
            )}`,
          );
          diagnostics.logIssue(
            nodeId,
            "Unknown",
            "PAINT_VALIDATION",
            `Invalid ${type}[${index}]: ${validation.errors.join(", ")}`,
            paint,
            validation.fallback,
          );

          // Use validated fallback or return null to filter out
          return validation.fallback;
        }

        return validation.sanitized;
      })
      .filter((paint): paint is ValidatedPaint => paint !== null);
  }

  /**
   * COMPREHENSIVE PAINT VALIDATOR: Validates paint objects before Figma API calls
   * Prevents the 68% paint validation failures identified in analysis
   */
  private validatePaintObject(
    paint: any,
    context: { nodeId: string; index: number; type: string },
  ): {
    isValid: boolean;
    errors: string[];
    sanitized: ValidatedPaint | null;
    fallback: ValidatedPaint | null;
  } {
    const errors: string[] = [];

    // Validate paint object exists
    if (!paint || typeof paint !== "object") {
      return {
        isValid: false,
        errors: ["Paint object is null or not an object"],
        sanitized: null,
        fallback: this.createDefaultSolidPaint(),
      };
    }

    // Validate paint type
    const paintType = this.validatePaintType(paint.type);
    if (!paintType || paintType !== paint.type) {
      errors.push(`Invalid paint type: ${paint.type}`);
    }

    // Type-specific validation
    switch (paintType) {
      case "SOLID":
        if (!this.isValidColorObject(paint.color)) {
          errors.push("SOLID paint missing valid color object");
        }
        break;

      case "IMAGE":
        if (!paint.imageHash && !paint.src) {
          errors.push("IMAGE paint missing imageHash or src reference");
        }
        if (paint.imageHash && !this.isValidImageHash(paint.imageHash)) {
          errors.push("IMAGE paint has invalid imageHash");
        }
        break;

      case "GRADIENT_LINEAR":
      case "GRADIENT_RADIAL":
      case "GRADIENT_ANGULAR":
      case "GRADIENT_DIAMOND":
        if (
          !Array.isArray(paint.gradientStops) ||
          paint.gradientStops.length < 2
        ) {
          errors.push("Gradient paint requires at least 2 gradient stops");
        }
        break;
    }

    // If validation failed, provide fallback
    if (errors.length > 0) {
      return {
        isValid: false,
        errors,
        sanitized: null,
        fallback: this.createFallbackPaint(paintType, paint),
      };
    }

    // Create sanitized paint object
    try {
      const sanitized = this.createSanitizedPaint(paint, paintType);
      return {
        isValid: true,
        errors: [],
        sanitized,
        fallback: null,
      };
    } catch (error) {
      return {
        isValid: false,
        errors: [`Sanitization failed: ${error.message}`],
        sanitized: null,
        fallback: this.createDefaultSolidPaint(),
      };
    }
  }

  /**
   * Creates a properly sanitized paint object for Figma API compliance
   */
  private createSanitizedPaint(
    paint: any,
    type: ValidatedPaint["type"],
  ): ValidatedPaint {
    const sanitized: ValidatedPaint = { type };

    // Copy valid properties only
    const validProps = [
      "visible",
      "opacity",
      "blendMode",
      "color",
      "gradientTransform",
      "gradientStops",
      "imageHash",
      "imageTransform",
      "scaleMode",
      "rotation",
      "gifRef",
      "filters",
    ];

    for (const prop of validProps) {
      if (paint[prop] !== undefined) {
        (sanitized as any)[prop] = paint[prop];
      }
    }

    // Validate and normalize common properties
    if (sanitized.opacity !== undefined) {
      sanitized.opacity = Math.max(
        0,
        Math.min(1, Number(sanitized.opacity) || 0),
      );
    }

    if (sanitized.visible === undefined) {
      sanitized.visible = true;
    }

    // Type-specific normalization
    if (type === "SOLID" && paint.color) {
      const colorData = this.validateColor(paint.color);
      sanitized.color = { r: colorData.r, g: colorData.g, b: colorData.b };

      // If the color had an alpha channel, and opacity isn't already explicitly set, use it
      if (
        colorData.a !== undefined &&
        colorData.a !== 1 &&
        sanitized.opacity === undefined
      ) {
        sanitized.opacity = colorData.a;
      } else if (
        colorData.a !== undefined &&
        colorData.a !== 1 &&
        sanitized.opacity !== undefined
      ) {
        // Multiply if both exist for maximum fidelity
        sanitized.opacity *= colorData.a;
      }
    }

    return sanitized;
  }

  /**
   * Creates fallback paint objects based on original type
   */
  private createFallbackPaint(
    type: string,
    originalPaint: any,
  ): ValidatedPaint {
    switch (type) {
      case "IMAGE":
        // Try to preserve image reference if possible
        if (
          originalPaint.imageHash &&
          this.isValidImageHash(originalPaint.imageHash)
        ) {
          return {
            type: "IMAGE",
            visible: true,
            imageHash: originalPaint.imageHash,
            scaleMode: originalPaint.scaleMode || "FILL",
          };
        }
        // Fall back to transparent placeholder
        return {
          type: "SOLID",
          visible: true,
          color: { r: 0.9, g: 0.9, b: 0.9 },
          opacity: 0.5,
        };

      default:
        return this.createDefaultSolidPaint();
    }
  }

  /**
   * Creates a safe default solid paint
   */
  private createDefaultSolidPaint(): ValidatedPaint {
    return {
      type: "SOLID",
      visible: true,
      opacity: 1,
      color: { r: 0.8, g: 0.8, b: 0.8 },
    };
  }

  /**
   * Validates color object structure
   */
  private isValidColorObject(color: any): boolean {
    return (
      color &&
      typeof color === "object" &&
      Number.isFinite(color.r) &&
      Number.isFinite(color.g) &&
      Number.isFinite(color.b) &&
      color.r >= 0 &&
      color.r <= 1 &&
      color.g >= 0 &&
      color.g <= 1 &&
      color.b >= 0 &&
      color.b <= 1
    );
  }

  /**
   * Validates image hash exists in assets
   */
  private isValidImageHash(hash: string): boolean {
    return (
      typeof hash === "string" &&
      hash.length > 0 &&
      this.assets?.images?.[hash] !== undefined
    );
  }

  private validatePaintType(type: any): ValidatedPaint["type"] {
    const validTypes: ValidatedPaint["type"][] = [
      "SOLID",
      "GRADIENT_LINEAR",
      "GRADIENT_RADIAL",
      "GRADIENT_ANGULAR",
      "GRADIENT_DIAMOND",
      "IMAGE",
      "EMOJI",
    ];
    return validTypes.includes(type) ? type : "SOLID";
  }

  private validateColor(color: any): RGBA {
    return {
      r: this.validateNumber(color.r, 0, 0, 1),
      g: this.validateNumber(color.g, 0, 0, 1),
      b: this.validateNumber(color.b, 0, 0, 1),
      a: this.validateNumber(color.a, 1, 0, 1),
    };
  }

  private validateNumber(
    value: any,
    defaultValue: number,
    min?: number,
    max?: number,
  ): number {
    if (typeof value !== "number" || !isFinite(value)) {
      return defaultValue;
    }

    let result = value;
    if (min !== undefined) result = Math.max(min, result);
    if (max !== undefined) result = Math.min(max, result);
    return result;
  }

  /**
   * CRITICAL: Validate dimensions and handle zero-width/height elements
   */
  private validateDimensions(
    width: number,
    height: number,
    nodeId: string,
  ): { width: number; height: number } {
    // Handle zero or negative dimensions
    const minDimension = 0.01; // Minimum visible size in Figma

    let validWidth = width;
    let validHeight = height;

    if (width <= 0) {
      console.log(
        `📏 Node ${nodeId} has zero/negative width (${width}), setting to ${minDimension}`,
      );
      validWidth = minDimension;
    }

    if (height <= 0) {
      console.log(
        `📏 Node ${nodeId} has zero/negative height (${height}), setting to ${minDimension}`,
      );
      validHeight = minDimension;
    }

    return { width: validWidth, height: validHeight };
  }

  /**
   * CRITICAL: Get coordinate scale factor for DPI/Retina normalization.
   * Ensures translate values are scaled correctly across different device pixel ratios.
   */
  private getCoordinateScaleFactor(): number {
    try {
      if (!this.schema?.metadata?.viewport) {
        return 1; // Fallback to no scaling
      }

      const viewport = this.schema.metadata.viewport;

      // Use devicePixelRatio as primary scale factor
      const devicePixelRatio = viewport.devicePixelRatio || 1;

      // If screenshotScale is different from devicePixelRatio, use that instead
      const screenshotScale = viewport.screenshotScale || devicePixelRatio;

      // Capture coordinate system can override scaling behavior
      const captureSystem = this.schema.metadata.captureCoordinateSystem;

      if (captureSystem === "device-pixels") {
        // Device pixels: need to scale down by devicePixelRatio
        return devicePixelRatio;
      } else {
        // CSS pixels: use screenshot scale if available, otherwise devicePixelRatio
        return screenshotScale;
      }
    } catch (error) {
      console.warn("Error getting coordinate scale factor:", error);
      return 1; // Safe fallback
    }
  }

  preloadImageHash(hash: string, figmaImageHash: string): void {
    this.imagePaintCache.set(hash, figmaImageHash);
  }

  /**
   * Find a matching design token for a color value
   */
  private findColorToken(color: {
    r: number;
    g: number;
    b: number;
    a?: number;
  }): string | undefined {
    if (!this.designTokensManager) return undefined;

    const tolerance = 0.01;

    for (const [tokenId, token] of Object.entries(
      (this.designTokensManager as any).tokensRegistry.variables,
    )) {
      const typedToken = token as any;
      if (typedToken.type === "COLOR" && typedToken.resolvedValue) {
        const tokenColor = typedToken.resolvedValue;
        if (
          Math.abs(tokenColor.r - color.r) < tolerance &&
          Math.abs(tokenColor.g - color.g) < tolerance &&
          Math.abs(tokenColor.b - color.b) < tolerance
        ) {
          return tokenId;
        }
      }
    }

    return undefined;
  }

  async loadFontWithFallbacks(
    requestedFamily: string,
    requestedStyle: string,
  ): Promise<{ family: string; style: string } | null> {
    const cacheKey = `${requestedFamily}:${requestedStyle}`;
    if (this.fontCache.has(cacheKey)) {
      return this.fontCache.get(cacheKey)!;
    }

    const cleanFamily = requestedFamily.replace(/['"]/g, "").trim();

    const fontFallbacks = new Map<string, string[]>([
      ["Times", ["Times New Roman", "Times", "serif"]],
      ["Times New Roman", ["Times New Roman", "Times", "serif"]],
      ["Georgia", ["Georgia", "Times New Roman", "serif"]],

      ["Arial", ["Arial", "Helvetica", "sans-serif"]],
      ["Helvetica", ["Helvetica", "Arial", "sans-serif"]],
      [
        "Helvetica Neue",
        ["Helvetica Neue", "Helvetica", "Arial", "sans-serif"],
      ],
      // Enhanced web font mappings for better accuracy
      ["Roboto", ["Roboto", "Inter", "Arial", "sans-serif"]],
      ["YouTube Sans", ["Roboto", "Inter", "Arial", "sans-serif"]],
      ["YouTube", ["Roboto", "Inter", "Arial", "sans-serif"]],
      ["Open Sans", ["Open Sans", "Inter", "Arial", "sans-serif"]],
      ["Lato", ["Lato", "Inter", "Arial", "sans-serif"]],
      ["Montserrat", ["Montserrat", "Inter", "Arial", "sans-serif"]],
      ["Source Sans Pro", ["Source Sans Pro", "Inter", "Arial", "sans-serif"]],
      // Common Etsy fonts
      ["Graphik", ["Inter", "Arial", "sans-serif"]],
      ["Graphik Web", ["Inter", "Arial", "sans-serif"]],
      [
        "Neue Helvetica",
        ["Helvetica Neue", "Helvetica", "Arial", "sans-serif"],
      ],
      // Common Facebook fonts
      ["Segoe UI", ["Inter", "Arial", "sans-serif"]],
      ["SF Pro Display", ["Inter", "Arial", "sans-serif"]],
      ["SF Pro Text", ["Inter", "Arial", "sans-serif"]],

      ["Monaco", ["Monaco", "Menlo", "monospace"]],
      ["Menlo", ["Menlo", "Monaco", "monospace"]],
      ["Courier", ["Courier", "Courier New", "monospace"]],
      ["Courier New", ["Courier New", "Courier", "monospace"]],
      ["SF Mono", ["SF Mono", "Monaco", "Menlo", "monospace"]],

      ["-apple-system", ["Inter", "Arial", "sans-serif"]],
      ["system-ui", ["Inter", "Arial", "sans-serif"]],
      ["BlinkMacSystemFont", ["Inter", "Arial", "sans-serif"]],

      ["sohne-var", ["Inter", "Helvetica Neue", "Arial", "sans-serif"]],
      ["Sohne", ["Inter", "Helvetica Neue", "Arial", "sans-serif"]],
      ["Stripe Sans", ["Inter", "Helvetica Neue", "Arial", "sans-serif"]],
      [
        "ui-sans-serif",
        ["Inter", "-apple-system", "system-ui", "Arial", "sans-serif"],
      ],
    ]);

    // ENHANCED: Try the exact family first, then fallbacks
    // Inter is closer to most web fonts than Arial, so prioritize it
    const fallbackChain = fontFallbacks.get(cleanFamily) || [
      cleanFamily, // Try exact match first
      "Inter", // Inter is closer to most web fonts than Arial
      "Arial",
    ];

    for (const fontFamily of fallbackChain) {
      const baseStyle = (requestedStyle || "Regular").trim();
      const wantsItalic = /\bitalic\b/i.test(baseStyle);

      const normalizeStyleVariants = (style: string): string[] => {
        const s = style.trim();
        if (!s) return [];

        const variants = new Set<string>();
        variants.add(s);
        variants.add(s.replace(/\s+/g, "")); // "Semi Bold" -> "SemiBold"

        // Common casing variants.
        variants.add(s.replace(/\bSemi\s*Bold\b/i, "Semibold"));
        variants.add(s.replace(/\bExtra\s*Bold\b/i, "Extrabold"));
        variants.add(s.replace(/\bExtra\s*Light\b/i, "Extralight"));

        // Space-separated variants.
        variants.add(s.replace(/\bSemi\s*Bold\b/i, "Semi Bold"));
        variants.add(s.replace(/\bExtra\s*Bold\b/i, "Extra Bold"));
        variants.add(s.replace(/\bExtra\s*Light\b/i, "Extra Light"));
        variants.add(s.replace(/\bDemi\s*Bold\b/i, "Demi Bold"));
        variants.add(s.replace(/\bDemi\s*Bold\b/i, "DemiBold"));

        return Array.from(variants).filter(Boolean);
      };

      const italicize = (style: string): string[] => {
        const s = style.trim();
        if (!s) return [];
        if (/\bitalic\b/i.test(s)) return normalizeStyleVariants(s);
        const variants = new Set<string>();
        for (const v of normalizeStyleVariants(s)) {
          variants.add(`${v} Italic`);
          variants.add(`${v}Italic`);
        }
        variants.add("Italic");
        variants.add("Oblique");
        return Array.from(variants).filter(Boolean);
      };

      const weightStyles = [
        "Regular",
        "Book",
        "Normal",
        "Thin",
        "Extra Light",
        "ExtraLight",
        "Ultra Light",
        "UltraLight",
        "Light",
        "Medium",
        "Demi Bold",
        "DemiBold",
        "Semi Bold",
        "SemiBold",
        "Semibold",
        "Bold",
        "Extra Bold",
        "ExtraBold",
        "Extrabold",
        "Black",
        "Heavy",
      ];

      const nonItalicBase = baseStyle.replace(/\bitalic\b/gi, "").trim();
      const requestedCandidates = wantsItalic
        ? [...italicize(baseStyle), ...normalizeStyleVariants(nonItalicBase)]
        : normalizeStyleVariants(baseStyle);

      const baselineCandidates = wantsItalic
        ? italicize("Regular")
        : normalizeStyleVariants("Regular");

      // NOTE: Avoid Array.prototype.flatMap() - it's not available in some Figma plugin runtimes.
      const weightStyleVariants: string[] = [];
      for (const s of weightStyles) {
        const variantsForWeight = wantsItalic
          ? italicize(s)
          : normalizeStyleVariants(s);
        for (const v of variantsForWeight) weightStyleVariants.push(v);
      }

      // If italic isn't available for this family, fall back to non-italic weights.
      const nonItalicWeightVariants: string[] = [];
      if (wantsItalic) {
        for (const s of weightStyles) {
          const variantsForWeight = normalizeStyleVariants(s);
          for (const v of variantsForWeight) nonItalicWeightVariants.push(v);
        }
      }

      const stylesToTry = Array.from(
        new Set<string>([
          ...requestedCandidates,
          ...baselineCandidates,
          ...weightStyleVariants,
          ...nonItalicWeightVariants,
        ]),
      );

      for (const style of stylesToTry) {
        try {
          await figma.loadFontAsync({ family: fontFamily, style });
          const result = { family: fontFamily, style };
          this.fontCache.set(cacheKey, result);
          console.log(
            `✅ Loaded font: ${fontFamily} ${style} (requested: ${cleanFamily} ${requestedStyle})`,
          );
          return result;
        } catch {
          console.log(`⚠️ Failed to load: ${fontFamily} ${style}`);
        }
      }
    }

    try {
      await figma.loadFontAsync({ family: "Inter", style: "Regular" });
      const result = { family: "Inter", style: "Regular" };
      this.fontCache.set(cacheKey, result);
      console.warn(
        `❌ Using last resort font Inter Regular for: ${cleanFamily} ${requestedStyle}`,
      );
      return result;
    } catch (error) {
      console.error(
        `❌ Critical: Cannot load Inter Regular. Trying system fallback.`,
        error,
      );
      const systemFonts = [
        { family: "Arial", style: "Regular" },
        { family: "Helvetica", style: "Regular" },
        { family: "San Francisco", style: "Regular" },
        { family: "Roboto", style: "Regular" },
      ];

      for (const font of systemFonts) {
        try {
          await figma.loadFontAsync(font);
          console.warn(`✅ Using system fallback font: ${font.family}`);
          return font;
        } catch {
          continue;
        }
      }

      console.error(
        `❌ Critical: No fonts available - will create rectangle placeholders`,
      );
      return null;
    }
  }

  async createNode(
    nodeData: any,
    parentAbsoluteBounds?: { x: number; y: number },
  ): Promise<SceneNode | null> {
    if (!nodeData) return null;

    // SVG DEBUG LOGGER
    if (nodeData.type === "VECTOR" || nodeData.tagName === "svg") {
      const childCount = nodeData.children ? nodeData.children.length : 0;
      console.log(
        `🔍 [SVG-DEBUG] Processing SVG/VECTOR node: ${
          nodeData.name || nodeData.id
        }`,
      );
      console.log(`   - ID: ${nodeData.id}`);
      console.log(`   - Children: ${childCount}`);
      console.log(
        `   - svgContent length: ${
          nodeData.svgContent ? nodeData.svgContent.length : 0
        }`,
      );
      console.log(`   - vectorData: ${!!nodeData.vectorData}`);
      console.log(`   - imageHash: ${nodeData.imageHash}`);
    }

    try {
      if (nodeData.embed?.type) {
        const embedNode = await this.createEmbedPlaceholder(nodeData);
        await this.afterCreate(embedNode, nodeData, { reuseComponent: false });
        return embedNode;
      }

      if (nodeData.componentSignature) {
        const registered = this.componentManager.getComponentBySignature(
          nodeData.componentSignature,
        );
        if (registered && nodeData.type !== "COMPONENT") {
          const instance = registered.createInstance();
          await this.afterCreate(instance, nodeData, { reuseComponent: true });
          return instance;
        }
      }

      let node: SceneNode | null = null;

      switch (nodeData.type) {
        case "TEXT":
          node = await this.createText(nodeData);
          break;
        case "IMAGE":
          node = await this.createImage(nodeData);
          break;
        case "VECTOR":
          node = await this.createVector(nodeData);
          break;
        case "RECTANGLE":
          node = await this.createRectangle(nodeData);
          break;
        case "COMPONENT":
          node = await this.createComponent(nodeData);
          break;
        case "INSTANCE":
          node = await this.createInstance(nodeData);
          break;
        case "FRAME":
        default:
          node = await this.createFrame(nodeData);
          break;
      }

      if (!node) {
        return null;
      }

      await this.afterCreate(node, nodeData, {
        reuseComponent: false,
        parentAbsoluteBounds,
      });

      if (nodeData.type === "COMPONENT") {
        const component = node as ComponentNode;
        const componentId = nodeData.componentId || nodeData.id || component.id;
        this.componentManager.registerComponent(componentId, component);
        if (nodeData.componentSignature) {
          this.componentManager.registerSignature(
            nodeData.componentSignature,
            component,
          );
        }
      } else if (nodeData.componentSignature) {
        this.safeSetPluginData(
          node,
          "componentSignature",
          nodeData.componentSignature,
        );
      }

      // PHASE 6: Post-Build Validation
      if (node) {
        this.validateNodePostBuild(node, nodeData);
      }

      return node;
    } catch (e) {
      console.error(
        `❌ [NODE_BUILDER] createNode failed for ${nodeData.type} ${nodeData.id}:`,
        e instanceof Error ? e.message : JSON.stringify(e, null, 2),
      );
      // FAILURE RECOVERY: Return a red fallback frame so the user sees *something*
      console.warn(`⚠️ [RECOVERY] Creating fallback node for ${nodeData.id}`);
      return this.createFallbackNode(
        nodeData,
        e instanceof Error ? e.message : String(e),
      );
    }
  }

  /**
   * EMERGENCY FALLBACK: Creates a visible red box when node creation fails.
   * Ensures the import process never silently drops a node.
   */
  private async createFallbackNode(
    data: any,
    errorMsg: string,
  ): Promise<FrameNode> {
    const frame = figma.createFrame();
    frame.name = `⚠️ ERROR: ${data.name || "Unknown"} (${data.type})`;

    // Ensure we have valid dimensions
    const width = Math.max(data.layout?.width || 100, 100);
    const height = Math.max(data.layout?.height || 100, 100);
    frame.resize(width, height);

    // Bright red stroke to indicate error
    frame.strokes = [{ type: "SOLID", color: { r: 1, g: 0, b: 0 } }];
    frame.strokeWeight = 2;
    frame.fills = [{ type: "SOLID", color: { r: 1, g: 0.9, b: 0.9 } }]; // Light red background

    // Try to add text label
    try {
      await figma.loadFontAsync({ family: "Inter", style: "Regular" });
      const text = figma.createText();
      text.characters = `Failed: ${data.name}\n${errorMsg.substring(0, 50)}`;
      text.fontSize = 10;
      text.fills = [{ type: "SOLID", color: { r: 1, g: 0, b: 0 } }];
      frame.appendChild(text);
    } catch (e) {
      // Ignore text failure
    }

    return frame;
  }

  private async createFrame(data: any): Promise<FrameNode> {
    // removed agent log block
    const frame = figma.createFrame();
    frame.name = data.name || "Frame";
    const frameWidth = Math.max(
      this.roundForPixelPerfection(data.layout?.width || 1),
      0.01,
    );
    const frameHeight = Math.max(
      this.roundForPixelPerfection(data.layout?.height || 1),
      0.01,
    );
    frame.resize(frameWidth, frameHeight);
    frame.fills = []; // Start transparent
    // removed agent log block
    return frame;
  }

  private async createRectangle(data: any): Promise<RectangleNode> {
    const rect = figma.createRectangle();
    rect.name = data.name || "Rectangle";
    rect.resize(
      Math.max(this.roundForPixelPerfection(data.layout?.width || 1), 0.01),
      Math.max(this.roundForPixelPerfection(data.layout?.height || 1), 0.01),
    );
    rect.fills = []; // Start transparent
    rect.strokes = [];
    rect.effects = [];
    return rect;
  }

  private async createEmbedPlaceholder(data: any): Promise<FrameNode> {
    if (!data.autoLayout) {
      data.autoLayout = {
        layoutMode: "VERTICAL",
        primaryAxisAlignItems: "CENTER",
        counterAxisAlignItems: "CENTER",
        itemSpacing: 6,
        paddingTop: 12,
        paddingBottom: 12,
        paddingLeft: 12,
        paddingRight: 12,
      };
    }

    const frame = figma.createFrame();
    frame.name = `${data.name || "Embed"} (${data.embed?.type || "embed"})`;
    frame.resize(
      Math.max(data.layout?.width || 160, 40),
      Math.max(data.layout?.height || 90, 40),
    );
    frame.layoutMode = "VERTICAL";
    frame.primaryAxisAlignItems = "CENTER";
    frame.counterAxisAlignItems = "CENTER";
    frame.itemSpacing = 6;
    frame.paddingTop = 12;
    frame.paddingBottom = 12;
    frame.paddingLeft = 12;
    frame.paddingRight = 12;
    frame.strokes = [
      { type: "SOLID", color: { r: 0.36, g: 0.43, b: 0.64 }, opacity: 0.4 },
    ];
    frame.fills = [
      {
        type: "SOLID",
        color: { r: 0.93, g: 0.95, b: 0.99 },
        opacity: 1,
      },
    ];
    frame.cornerRadius = 10;

    try {
      await figma.loadFontAsync({ family: "Inter", style: "Semi Bold" });
      await figma.loadFontAsync({ family: "Inter", style: "Regular" });
    } catch (e) {
      console.warn("Font load failed for embed placeholder", e);
    }

    const title = figma.createText();
    title.characters = (data.embed?.type || "Embed").toUpperCase();
    title.fontSize = 12;
    title.fontName = { family: "Inter", style: "Semi Bold" };
    title.fills = [
      { type: "SOLID", color: { r: 0.24, g: 0.29, b: 0.46 }, opacity: 1 },
    ];

    const subtitle = figma.createText();
    const srcLabel = data.embed?.src
      ? data.embed.src.slice(0, 60)
      : "External content";
    subtitle.characters = srcLabel;
    subtitle.fontSize = 11;
    subtitle.fontName = { family: "Inter", style: "Regular" };
    subtitle.fills = [
      { type: "SOLID", color: { r: 0.35, g: 0.41, b: 0.55 }, opacity: 1 },
    ];

    frame.appendChild(title);
    frame.appendChild(subtitle);

    this.safeSetPluginData(
      frame,
      "embed",
      JSON.stringify({
        ...data.embed,
        htmlTag: data.htmlTag,
        id: data.id,
        sourceUrl: data.embed?.src,
      }),
    );

    return frame;
  }

  private async createText(data: any): Promise<SceneNode> {
    const text = figma.createText();
    text.name = data.name || "Text";

    // CRITICAL: Extract and normalize text content FIRST
    let characters = data.characters || data.textContent || "";

    // Normalize whitespace: preserve line breaks but normalize spaces
    // Replace multiple spaces with single space (except in pre-formatted text)
    if (
      data.textStyle?.whiteSpace !== "pre" &&
      data.textStyle?.whiteSpace !== "pre-wrap"
    ) {
      // Normalize spaces but preserve line breaks
      characters = characters
        .replace(/[ \t]+/g, " ")
        .replace(/\n\s+/g, "\n")
        .replace(/\s+\n/g, "\n");
    }

    // Remove leading/trailing whitespace unless it's pre-formatted
    if (
      data.textStyle?.whiteSpace !== "pre" &&
      data.textStyle?.whiteSpace !== "pre-wrap"
    ) {
      characters = characters.trim();
    }

    // CRITICAL: Set characters IMMEDIATELY after creation so Figma can calculate proper bounds
    // This must happen BEFORE any sizing operations
    if (characters) {
      text.characters = characters;
    } else {
      // Empty text node - use placeholder
      text.characters = " ";
    }

    if (data.textStyle) {
      const fontStyle = this.mapFontWeight(data.textStyle.fontWeight);
      const isItalic = (data.textStyle.fontStyle || "")
        .toLowerCase()
        .includes("italic");

      // Use fontFamilyStack if available for better font matching
      const fontFamilyStack = data.textStyle.fontFamilyStack || [
        data.textStyle.fontFamily,
      ];
      let fontFamily = fontFamilyStack[0] || data.textStyle.fontFamily;
      const baseStyle = fontStyle || "Regular";
      // Preserve intended weight for italic fonts when available ("Medium Italic", etc.).
      let finalFontStyle = isItalic
        ? baseStyle === "Regular"
          ? "Italic"
          : `${baseStyle} Italic`
        : baseStyle;

      const originalFontFamily = fontFamily;
      const strictCloneMode = this.options?.strictCloneMode ?? true; // FIDELITY FIX: Default to true

      let fontLoadResult: { family: string; style: string } | null = null;
      if (strictCloneMode) {
        // Strict clone: only accept the exact requested font (no family fallback).

        try {
          if (this.fontManager) {
            // [NEW] Use FontManager to find best match (fuzzy + weight mapping)
            const weightNumeric =
              typeof data.textStyle.fontWeight === "number"
                ? data.textStyle.fontWeight
                : 400;
            const bestFont = await this.fontManager.findBestFont(
              fontFamily,
              baseStyle,
              weightNumeric,
              isItalic,
            );

            if (bestFont) {
              await figma.loadFontAsync(bestFont);
              fontLoadResult = bestFont;
            } else {
              // Try legacy exact load if manager found nothing
              await figma.loadFontAsync({
                family: fontFamily,
                style: finalFontStyle,
              });
              fontLoadResult = { family: fontFamily, style: finalFontStyle };
            }
          } else {
            // Legacy path (no manager)
            await figma.loadFontAsync({
              family: fontFamily,
              style: finalFontStyle,
            });
            fontLoadResult = { family: fontFamily, style: finalFontStyle };
          }
        } catch {
          fontLoadResult = null;
        }

        if (!fontLoadResult) {
          diagnostics.logIssue(
            data.id || "unknown",
            data.name,
            "TEXT",
            `Strict clone: font unavailable (${originalFontFamily} ${finalFontStyle})`,
            { family: originalFontFamily, style: finalFontStyle },
            { screenshotAssetId: data.screenshotAssetId || null },
          );

          // [PRIORITY 1] Try Safe Fallback First (Inter/Arial) to keep text editable
          // We prefer slightly wrong font over a static image or missing text.
          const SAFE_FALLBACKS = [
            "Inter",
            "Arial",
            "Helvetica",
            "Roboto",
            "sans-serif",
          ];
          let loadedFallbackFont: FontName | null = null;

          for (const fallbackFamily of SAFE_FALLBACKS) {
            try {
              // Try standard weights
              const candidate = { family: fallbackFamily, style: "Regular" };
              await figma.loadFontAsync(candidate);
              loadedFallbackFont = candidate;
              break;
            } catch (e) {
              // Try next
            }
          }

          if (loadedFallbackFont) {
            console.warn(
              `⚠️ [STRICT CLONE] Missing font "${originalFontFamily}", falling back to safe font "${loadedFallbackFont.family}"`,
            );

            const textNode = figma.createText();
            textNode.fontName = loadedFallbackFont;
            textNode.characters = characters;

            // Apply other known properties best-effort
            const fallbackSize = data.textStyle?.fontSize || 12;
            if (data.layout?.width) {
              textNode.resize(
                data.layout.width,
                data.layout.height || fallbackSize * 1.5,
              );
            }
            textNode.fontSize = Math.max(1, fallbackSize);

            // Tint safely (red-ish to indicate it's not exact, or just black?)
            // Let's keep it normal color so it looks "good enough", but add a plugin data flag.
            // MEMORY SAFETY FIX: Sanitize fills to remove schema-specific properties that Figma's API rejects
            if (data.fills && Array.isArray(data.fills)) {
              try {
                const sanitizedFills = this.sanitizePaintArray(
                  data.fills,
                  "fills",
                  data.id || "text",
                );
                textNode.fills =
                  sanitizedFills.length > 0
                    ? (sanitizedFills as Paint[])
                    : [{ type: "SOLID", color: { r: 0, g: 0, b: 0 } }];
              } catch (e) {
                console.warn(
                  "  ⚠️ [TEXT] Failed to apply sanitized fills, falling back to black",
                  e,
                );
                try {
                  textNode.fills = [
                    { type: "SOLID", color: { r: 0, g: 0, b: 0 } },
                  ];
                } catch (fallbackError) {
                  console.error(
                    "  ❌ [TEXT] Even fallback fill failed",
                    fallbackError,
                  );
                }
              }
            } else {
              textNode.fills = [{ type: "SOLID", color: { r: 0, g: 0, b: 0 } }];
            }

            this.safeSetPluginData(
              textNode,
              "strictCloneMissingFont",
              `Original: ${originalFontFamily} ${finalFontStyle}`,
            );

            return textNode as any;
          }

          // [PRIORITY 2] Prefer capture-time pixel fallback (element screenshot) if provided.
          const screenshotId = data.screenshotAssetId;
          const screenshotAsset =
            screenshotId && this.assets?.images
              ? this.assets.images[screenshotId]
              : null;
          const base64Candidate =
            (screenshotAsset as any)?.base64 ||
            (screenshotAsset as any)?.data ||
            (screenshotAsset as any)?.screenshot;

          if (
            typeof base64Candidate === "string" &&
            base64Candidate.length > 0
          ) {
            try {
              const targetWidth = Math.max(
                this.roundForPixelPerfection(
                  data.layout?.width || data.absoluteLayout?.width || 100,
                ),
                0.01,
              );
              const targetHeight = Math.max(
                this.roundForPixelPerfection(
                  data.layout?.height || data.absoluteLayout?.height || 20,
                ),
                0.01,
              );

              const image = await this.createFigmaImageFromAsset(
                screenshotAsset,
                screenshotId!,
                targetWidth * 2,
                targetHeight * 2,
              );
              if (!image) throw new Error("Failed to create fallback image");

              const imageFrame = figma.createFrame();
              imageFrame.name = `${data.name || "Text"} (strict clone raster)`;
              imageFrame.resize(targetWidth, targetHeight);
              imageFrame.fills = [
                { type: "IMAGE", imageHash: image.hash, scaleMode: "FILL" },
              ];

              this.safeSetPluginData(imageFrame, "rasterizedText", "true");
              this.safeSetPluginData(
                imageFrame,
                "rasterizeReason",
                "FONT_UNAVAILABLE",
              );
              this.safeSetPluginData(
                imageFrame,
                "originalFontFamily",
                originalFontFamily,
              );
              this.safeSetPluginData(
                imageFrame,
                "originalFontStyle",
                finalFontStyle,
              );
              this.safeSetPluginData(imageFrame, "originalText", characters);

              return imageFrame as any;
            } catch (rasterErr) {
              console.error(
                "❌ [STRICT CLONE] Failed to build raster fallback from screenshotAssetId",
                rasterErr,
              );
            }
          }

          // If even safe fonts fail (unlikely), ONLY THEN do we revert to the rectangle.
          console.error(
            `❌ [STRICT CLONE] Critical: Missing original font AND all safe fallbacks for ${originalFontFamily}`,
          );
          return null;
        }
      } else {
        // Non-strict mode: Try fonts from the stack first, then fall back to default chain.
        for (const stackFont of fontFamilyStack) {
          fontLoadResult = await this.loadFontWithFallbacks(
            stackFont,
            finalFontStyle,
          );
          if (fontLoadResult) {
            fontFamily = fontLoadResult.family;
            break;
          }
        }

        // If stack fonts failed, try the original font with fallback chain
        if (!fontLoadResult) {
          fontLoadResult = await this.loadFontWithFallbacks(
            fontFamily,
            finalFontStyle,
          );
        }

        if (!fontLoadResult) {
          diagnostics.logIssue(
            data.id || "unknown",
            data.name,
            "TEXT",
            `Font loading failed completely for ${originalFontFamily}`,
            { family: originalFontFamily, style: finalFontStyle },
            { error: "All fallbacks failed" },
          );
          console.error(
            `❌ Font loading failed completely for ${originalFontFamily}. Dropping text node.`,
          );
          return null;
        }
      }

      fontFamily = fontLoadResult.family;
      finalFontStyle = fontLoadResult.style;

      // ENHANCED: Improved font metrics compensation using Canvas TextMetrics
      let fontMetricsRatio = 1.0;
      if (fontFamily !== originalFontFamily) {
        // Use Canvas TextMetrics if available for more accurate compensation
        if (
          data.renderedMetrics?.actualBoundingBoxAscent &&
          data.renderedMetrics?.actualBoundingBoxDescent
        ) {
          // Calculate ratio based on actual text metrics
          const originalHeight =
            data.renderedMetrics.actualBoundingBoxAscent +
            data.renderedMetrics.actualBoundingBoxDescent;
          const expectedHeight = data.textStyle.fontSize * 1.2; // Approximate line height
          fontMetricsRatio = originalHeight / expectedHeight;

          // Clamp ratio to reasonable bounds (0.8 to 1.2) to prevent extreme adjustments
          fontMetricsRatio = Math.max(0.8, Math.min(1.2, fontMetricsRatio));

          console.log(
            `📝 Font fallback with metrics: ${originalFontFamily} → ${fontFamily} (ratio: ${fontMetricsRatio.toFixed(
              3,
            )}, originalHeight: ${originalHeight.toFixed(2)}px)`,
          );
        } else {
          // Fallback to static ratio map
          fontMetricsRatio = this.getFontMetricsRatio(
            fontFamily,
            originalFontFamily,
          );
          console.log(
            `📝 Font fallback: ${originalFontFamily} → ${fontFamily} (ratio: ${fontMetricsRatio.toFixed(
              3,
            )})`,
          );
        }
      }

      text.fontName = { family: fontFamily, style: finalFontStyle };

      // CRITICAL FIX: Validate fontSize to prevent NaN/Infinity/zero errors
      const rawFontSize = data.textStyle.fontSize * fontMetricsRatio;
      const adjustedFontSize =
        Number.isFinite(rawFontSize) && rawFontSize > 0 ? rawFontSize : 12;
      text.fontSize = Math.max(1, adjustedFontSize);
      // ENHANCED: Improved text alignment handling
      // Map CSS text-align to Figma textAlignHorizontal
      const textAlign = data.textStyle.textAlignHorizontal || "LEFT";
      text.textAlignHorizontal =
        textAlign === "CENTER"
          ? "CENTER"
          : textAlign === "RIGHT"
            ? "RIGHT"
            : textAlign === "JUSTIFY"
              ? "JUSTIFIED"
              : "LEFT";

      // ENHANCED: Better vertical alignment based on CSS vertical-align and line-height
      // Default to TOP for most cases, but can be adjusted based on CSS
      const verticalAlign = data.textStyle.textAlignVertical || "TOP";
      text.textAlignVertical =
        verticalAlign === "CENTER"
          ? "CENTER"
          : verticalAlign === "BOTTOM"
            ? "BOTTOM"
            : "TOP";

      const spacingScale =
        fontFamily !== originalFontFamily ? fontMetricsRatio : 1.0;

      // ENHANCED: Improved line height calculation using Canvas TextMetrics
      if (data.renderedMetrics?.lineHeightPx) {
        // Use measured line height from browser
        text.lineHeight = {
          unit: "PIXELS",
          value: data.renderedMetrics.lineHeightPx * spacingScale,
        };
      } else if (
        data.renderedMetrics?.actualBoundingBoxAscent &&
        data.renderedMetrics?.actualBoundingBoxDescent
      ) {
        // Calculate line height from Canvas TextMetrics if available
        const measuredLineHeight =
          data.renderedMetrics.actualBoundingBoxAscent +
          data.renderedMetrics.actualBoundingBoxDescent;
        text.lineHeight = {
          unit: "PIXELS",
          value: measuredLineHeight * spacingScale,
        };
      } else if (data.textStyle.lineHeight?.unit === "PIXELS") {
        text.lineHeight = {
          unit: "PIXELS",
          value: data.textStyle.lineHeight.value * spacingScale,
        };
      } else if (data.textStyle.lineHeight?.unit === "PERCENT") {
        text.lineHeight = {
          unit: "PERCENT",
          value: data.textStyle.lineHeight.value,
        };
      } else {
        // ENHANCED: Use font size * 1.2 as default line height (standard typography)
        const defaultLineHeight = adjustedFontSize * 1.2;
        text.lineHeight = {
          unit: "PIXELS",
          value: defaultLineHeight,
        };
      }

      if (data.textStyle.letterSpacing?.unit === "PIXELS") {
        text.letterSpacing = {
          unit: "PIXELS",
          value: data.textStyle.letterSpacing.value * spacingScale,
        };
      } else {
        text.letterSpacing = {
          unit: data.textStyle.letterSpacing?.unit || "PIXELS",
          value: data.textStyle.letterSpacing?.value || 0,
        };
      }

      // CRITICAL FIX: Apply text fills from textStyle.fills (primary) or data.fills (fallback)
      // Text color is extracted into textStyle.fills in dom-extractor.ts:extractTypography
      if (data.textStyle?.fills?.length) {
        text.fills = await this.convertFillsAsync(
          data.textStyle.fills,
          data.layout,
        );
        // removed agent log block
      } else if (data.fills && data.fills.length > 0) {
        // Fallback: use node.fills if textStyle.fills is not available
        text.fills = await this.convertFillsAsync(data.fills, data.layout);
        // removed agent log block
      } else {
        // removed agent log block
      }

      if (data.textStyle.textDecoration) {
        const deco = (data.textStyle.textDecoration || "").toLowerCase();
        if (deco.includes("line-through")) {
          text.textDecoration = "STRIKETHROUGH";
        } else if (deco.includes("underline")) {
          text.textDecoration = "UNDERLINE";
        } else {
          text.textDecoration = "NONE";
        }
      }

      if (data.textStyle.textTransform) {
        const tf = (data.textStyle.textTransform || "").toLowerCase();
        if (tf === "uppercase") text.textCase = "UPPER";
        else if (tf === "lowercase") text.textCase = "LOWER";
        else if (tf === "capitalize") text.textCase = "TITLE";
        else text.textCase = "ORIGINAL";
      } else if (data.textStyle.textCase) {
        text.textCase = data.textStyle.textCase;
      }

      if (data.textStyle.fontStyle) {
        this.safeSetPluginData(text, "fontStyle", data.textStyle.fontStyle);
      }
      if (data.textStyle.paragraphSpacing !== undefined) {
        this.safeSetPluginData(
          text,
          "paragraphSpacing",
          String(data.textStyle.paragraphSpacing),
        );
      }
      if (data.textStyle.paragraphIndent !== undefined) {
        this.safeSetPluginData(
          text,
          "paragraphIndent",
          String(data.textStyle.paragraphIndent),
        );
      }
      if (data.textStyle.whiteSpace) {
        this.safeSetPluginData(text, "whiteSpace", data.textStyle.whiteSpace);
        // Prefer explicit extractor hint when present.
        if (data.textAutoResize) {
          text.textAutoResize = data.textAutoResize;
        } else if (data.textStyle.whiteSpace === "nowrap") {
          text.textAutoResize = "WIDTH_AND_HEIGHT";
        } else if (
          data.textStyle.whiteSpace === "pre" ||
          data.textStyle.whiteSpace === "pre-wrap"
        ) {
          text.textAutoResize = "HEIGHT";
        }
      }

      // CRITICAL FIX: Ensure textAutoResize is never NONE unless explicitly needed
      // NONE can cause text to collapse and appear hidden, especially for small text
      // Only use NONE if text has explicit truncation (ellipsis) AND fixed width
      if (!text.textAutoResize || text.textAutoResize === "NONE") {
        const hasTruncation =
          data.textStyle?.textOverflow === "ellipsis" ||
          data.textStyle?.textOverflow === "ending";
        const hasFixedWidth = data.layout?.width && data.layout.width > 0;

        // Only use NONE if we have both truncation AND fixed width
        if (hasTruncation && hasFixedWidth) {
          text.textAutoResize = "NONE";
        } else {
          // Default to HEIGHT for most text to prevent collapse
          text.textAutoResize = "HEIGHT";
          console.log(
            `📝 [TEXT] ${data.name}: Changed textAutoResize from NONE to HEIGHT to prevent collapse`,
          );
        }
      }
      if (data.textStyle.wordWrap) {
        this.safeSetPluginData(text, "wordWrap", data.textStyle.wordWrap);
      }
      if (data.textStyle.textOverflow) {
        this.safeSetPluginData(
          text,
          "textOverflow",
          data.textStyle.textOverflow,
        );
        if (data.textStyle.textOverflow === "ellipsis") {
          text.textTruncation = "ENDING";
          // Truncation requires a fixed-width text box in Figma.
          text.textAutoResize = "NONE";
        }
      }
      if (data.textStyle.listStyleType) {
        this.safeSetPluginData(
          text,
          "listStyleType",
          data.textStyle.listStyleType,
        );
      }

      const textEffectsSource =
        (data.textStyle.effects && data.textStyle.effects.length > 0
          ? data.textStyle.effects
          : data.textStyle.textShadows) || [];
      if (textEffectsSource.length > 0) {
        const existingEffects = text.effects || [];
        const textShadowEffects = this.convertEffects(textEffectsSource);
        text.effects = [...existingEffects, ...textShadowEffects];
      }
    }

    // CRITICAL FIX: Don't set position here - let applyPositioning() handle it
    // Text nodes should use relative positioning like all other nodes
    // Setting absolute coordinates here bypasses the relative positioning logic
    // and causes text to appear in wrong positions

    // Store layout info for applyPositioning() to use
    if (data.absoluteLayout) {
      this.safeSetPluginData(text, "usedAbsoluteLayout", "true");
    }

    // Respect explicit extractor hint for text resizing behavior (affects wrapping + truncation).
    if (data.textAutoResize && !text.textAutoResize) {
      text.textAutoResize = data.textAutoResize;
    }

    // CRITICAL: Characters are already set above - this section handles OCR override only
    // AI Enhancement: Use OCR alternative if available and confidence is high
    if (
      data.ocrAlternative &&
      data.ocrConfidence > 0.8 &&
      (!characters || characters.trim().length === 0)
    ) {
      console.log(
        `✅ [AI] Using OCR alternative text for ${
          data.name
        }: "${data.ocrAlternative.substring(0, 50)}"`,
      );
      text.characters = data.ocrAlternative;
      this.safeSetPluginData(text, "usedOCRAlternative", "true");
      this.safeSetPluginData(text, "ocrConfidence", String(data.ocrConfidence));
    }

    // CRITICAL FIX: Prevent text from appearing vertical/hidden
    // Check for writing mode and transforms that might rotate text
    const writingMode =
      data.textStyle?.writingMode || data.layoutContext?.writingMode || "";
    const hasVerticalWritingMode =
      writingMode === "vertical-rl" || writingMode === "vertical-lr";
    const transform = data.layoutContext?.transform || "";
    const hasRotation = transform && /rotate\([^)]+\)/.test(transform);

    // ENHANCED: Set text size AFTER characters and font are set
    // CRITICAL: Use Figma's actual text bounds after setting characters and font
    // This ensures we get accurate measurements from Figma's text engine

    // First, let Figma calculate the natural text size
    // We'll use this as a baseline and adjust if needed

    let targetWidth = 1;
    let targetHeight = 1;

    // Priority 1: Use renderedMetrics (Canvas TextMetrics) - most accurate for single-line text
    if (data.renderedMetrics?.width && data.renderedMetrics.width > 0) {
      targetWidth = data.renderedMetrics.width;
    } else if (data.absoluteLayout?.width && data.absoluteLayout.width > 0) {
      targetWidth = data.absoluteLayout.width;
    } else if (data.layout?.width && data.layout.width > 0) {
      targetWidth = data.layout.width;
    } else {
      // Fallback: Use Figma's calculated width after setting characters
      // This happens automatically when we set textAutoResize
      targetWidth = Math.max(text.width || 1, 1);
    }

    // Priority 1: Use Canvas TextMetrics height (most accurate)
    if (
      data.renderedMetrics?.actualBoundingBoxAscent &&
      data.renderedMetrics?.actualBoundingBoxDescent
    ) {
      // Calculate height from Canvas TextMetrics (most accurate)
      targetHeight =
        data.renderedMetrics.actualBoundingBoxAscent +
        data.renderedMetrics.actualBoundingBoxDescent;
    } else if (
      data.renderedMetrics?.height &&
      data.renderedMetrics.height > 0
    ) {
      targetHeight = data.renderedMetrics.height;
    } else if (data.absoluteLayout?.height && data.absoluteLayout.height > 0) {
      targetHeight = data.absoluteLayout.height;
    } else if (data.layout?.height && data.layout.height > 0) {
      targetHeight = data.layout.height;
    } else if (
      text.lineHeight &&
      typeof text.lineHeight === "object" &&
      "value" in text.lineHeight
    ) {
      // Use line height as fallback
      targetHeight = text.lineHeight.value;
    } else {
      // Final fallback: Use Figma's calculated height
      const fontSize = typeof text.fontSize === "number" ? text.fontSize : 12;
      targetHeight = Math.max(text.height || fontSize * 1.2, 1);
    }

    // CRITICAL FIX: Ensure minimum dimensions to prevent hidden text
    // If text has zero or near-zero dimensions, use font size as minimum
    if (targetWidth < 1 || targetHeight < 1) {
      const minSize = Math.max(data.textStyle?.fontSize || 12, 12);
      if (targetWidth < 1) targetWidth = minSize;
      if (targetHeight < 1) targetHeight = minSize;
      console.warn(
        `⚠️ [TEXT] ${data.name} had invalid dimensions, using minimum size: ${targetWidth}x${targetHeight}`,
      );
    }

    // CRITICAL FIX: For vertical writing mode or rotated text, swap dimensions if needed
    // But only if the dimensions suggest it's actually vertical (height > width significantly)
    if (
      hasVerticalWritingMode ||
      (hasRotation && targetHeight > targetWidth * 1.5)
    ) {
      // Store original dimensions in plugin data for reference
      this.safeSetPluginData(text, "originalWidth", String(targetWidth));
      this.safeSetPluginData(text, "originalHeight", String(targetHeight));
      this.safeSetPluginData(
        text,
        "writingMode",
        writingMode || "horizontal-tb",
      );
      // Don't swap - let Figma handle vertical text natively if supported
      // But ensure text is visible
      console.log(
        `📝 [TEXT] ${data.name} has vertical writing mode or rotation, preserving dimensions`,
      );
    }
    // removed agent log block

    // ENHANCED: Improved text sizing with better bounds handling
    // CRITICAL: Only resize if textAutoResize is NONE (fixed size)
    // For HEIGHT or WIDTH_AND_HEIGHT, let Figma auto-size based on content

    const finalWidth = Math.max(targetWidth, 1);
    const finalHeight = Math.max(targetHeight, 1);

    // CRITICAL FIX: Prevent vertical text wrapping for suspiciously narrow widths
    // If the width is very small (< font size) but text is long, it's likely a capture error.
    // Force WIDTH_AND_HEIGHT to let Figma calculate the natural width.
    // Also handling cases where width is effectively 0 or 1 from capture defaults
    if (
      text.textAutoResize === "HEIGHT" &&
      (finalWidth < (text.fontSize as number) || finalWidth < 5) &&
      characters.length > 1
    ) {
      console.warn(
        `⚠️ [TEXT] Detected potential vertical wrapping for "${characters.substring(
          0,
          10,
        )}..." (width: ${finalWidth}, fontSize: ${text.fontSize}). Forcing WIDTH_AND_HEIGHT.`,
      );
      text.textAutoResize = "WIDTH_AND_HEIGHT";
    }

    // CRITICAL: Apply sizing based on textAutoResize mode
    if (text.textAutoResize === "NONE") {
      // Fixed size - use exact dimensions
      text.resize(finalWidth, finalHeight);
    } else if (text.textAutoResize === "WIDTH_AND_HEIGHT") {
      // Auto-size both - Figma handles this, but ensure minimum dimensions
      // Don't resize, let Figma calculate, but set a minimum if needed
      if (text.width < 1 || text.height < 1) {
        text.resize(
          Math.max(text.width || finalWidth, 1),
          Math.max(text.height || finalHeight, 1),
        );
      }
    } else {
      // HEIGHT mode - set width, let height auto-size
      // For nowrap text, use actual text width if available
      if (
        data.textStyle?.whiteSpace === "nowrap" &&
        data.renderedMetrics?.width &&
        data.renderedMetrics.width < finalWidth
      ) {
        text.resize(Math.max(data.renderedMetrics.width, 1), finalHeight);
      } else {
        text.resize(finalWidth, finalHeight);
      }
    }

    // removed agent log block

    // AI Enhancement: Log typography normalization
    if (data.normalizedToTypeScale && data.originalFontSize) {
      console.log(
        `✅ [AI] Using normalized font size: ${data.textStyle.fontSize}px (original: ${data.originalFontSize}px) for ${data.name}`,
      );
      this.safeSetPluginData(
        text,
        "originalFontSize",
        String(data.originalFontSize),
      );
      this.safeSetPluginData(text, "normalizedToTypeScale", "true");
    }

    try {
      text.textAutoResize = text.textAutoResize || "NONE";
    } catch {
      // ignore
    }

    if (data.inlineTextSegments && data.inlineTextSegments.length > 0) {
      await this.applyInlineTextSegments(text, data.inlineTextSegments);
    }

    if (!characters && !data.textContent) {
      diagnostics.logIssue(
        data.id || "unknown",
        data.name,
        "TEXT",
        "Text node created with empty characters",
        { characters: "non-empty string" },
        { characters: characters },
      );
    }

    // HIGH-FIDELITY: Hyperlink support
    // Apply href from anchor tags to text nodes for prototype interactivity
    if (data.hyperlink || data.href) {
      try {
        const href = data.hyperlink || data.href;
        // Validate URL
        if (
          typeof href === "string" &&
          href.length > 0 &&
          !href.startsWith("javascript:")
        ) {
          // Apply hyperlink to entire text range
          const hyperlink: HyperlinkTarget = {
            type: "URL",
            value: href,
          };
          text.setRangeHyperlink(0, text.characters.length, hyperlink);
          console.log(
            `🔗 [HYPERLINK] Applied link to "${data.name}": ${href.substring(0, 50)}...`,
          );
          this.safeSetPluginData(text, "hyperlink", href);
        }
      } catch (hyperlinkErr) {
        console.warn(
          `⚠️ [HYPERLINK] Failed to apply hyperlink to ${data.name}:`,
          hyperlinkErr,
        );
      }
    }

    // HIGH-FIDELITY: Per-segment hyperlinks for inline links
    // If text has inline segments with individual hrefs, apply them
    if (data.hyperlinkSegments && Array.isArray(data.hyperlinkSegments)) {
      for (const segment of data.hyperlinkSegments) {
        try {
          if (
            segment.href &&
            segment.start !== undefined &&
            segment.end !== undefined
          ) {
            const hyperlink: HyperlinkTarget = {
              type: "URL",
              value: segment.href,
            };
            const start = Math.max(
              0,
              Math.min(segment.start, text.characters.length),
            );
            const end = Math.max(
              start,
              Math.min(segment.end, text.characters.length),
            );
            if (start < end) {
              text.setRangeHyperlink(start, end, hyperlink);
              console.log(
                `🔗 [HYPERLINK] Applied inline link [${start}-${end}]: ${segment.href.substring(0, 30)}...`,
              );
            }
          }
        } catch (segmentErr) {
          console.warn(
            `⚠️ [HYPERLINK] Failed to apply segment hyperlink:`,
            segmentErr,
          );
        }
      }
    }

    console.log(
      `📝 Created text node: "${characters.substring(0, 50)}${
        characters.length > 50 ? "..." : ""
      }"`,
    );
    return text;
  }

  private async applyInlineTextSegments(
    textNode: TextNode,
    segments: any[],
  ): Promise<void> {
    let currentIndex = 0;

    for (const segment of segments) {
      const segmentText = segment.text || "";
      if (!segmentText) continue;

      const start = currentIndex;
      const end = currentIndex + segmentText.length;

      if (end > textNode.characters.length) break;

      if (segment.style) {
        const fontWeight = segment.style.fontWeight || 400;
        const isItalic = segment.style.fontStyle === "italic";
        const currentFont = textNode.fontName;
        const fontFamily =
          segment.style.fontFamily ||
          (currentFont !== figma.mixed ? currentFont.family : "Inter");

        // FIDELITY FIX: Use proper font-weight mapping (100-900 range)
        let style = this.mapFontWeight(fontWeight);

        if (isItalic) {
          style = style === "Regular" ? "Italic" : `${style} Italic`;
        }

        try {
          const fontName = { family: fontFamily, style };
          await figma.loadFontAsync(fontName);
          textNode.setRangeFontName(start, end, fontName);
        } catch (e) {
          console.warn(
            `Failed to apply inline font style: ${fontFamily} ${style}`,
            e,
          );
        }

        if (segment.style.color) {
          const { r, g, b, a } = segment.style.color;
          textNode.setRangeFills(start, end, [
            {
              type: "SOLID",
              color: { r, g, b },
              opacity: a !== undefined ? a : 1,
            },
          ]);
        }

        if (segment.style.textDecoration) {
          textNode.setRangeTextDecoration(
            start,
            end,
            segment.style.textDecoration,
          );
        }

        if (
          segment.style.fontSize &&
          Number.isFinite(segment.style.fontSize) &&
          segment.style.fontSize > 0 &&
          segment.style.fontSize !== textNode.fontSize
        ) {
          textNode.setRangeFontSize(
            start,
            end,
            Math.max(1, segment.style.fontSize),
          );
        }
      }

      currentIndex = end;
    }
  }

  private async createImage(data: any): Promise<SceneNode> {
    // VIDEO placeholder handling stays the same
    if (data.pluginData?.originalType === "VIDEO") {
      const frame = figma.createFrame();
      frame.name = data.name || "Video";
      frame.resize(
        Math.max(this.roundForPixelPerfection(data.layout?.width || 1), 0.01),
        Math.max(this.roundForPixelPerfection(data.layout?.height || 1), 0.01),
      );
      frame.fills = [];

      const playIcon = figma.createVector();
      playIcon.vectorPaths = [
        {
          windingRule: "NONZERO",
          data: "M 0 0 L 0 24 L 18 12 L 0 0 Z",
        },
      ];
      playIcon.name = "Play Icon";
      playIcon.fills = [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }];
      playIcon.strokes = [
        { type: "SOLID", color: { r: 0, g: 0, b: 0 }, opacity: 0.5 },
      ];
      playIcon.strokeWeight = 1;

      const iconSize =
        Math.min(data.layout?.width || 100, data.layout?.height || 100) * 0.2;
      const scale = iconSize / 24;
      playIcon.resize(24 * scale, 24 * scale);
      playIcon.x = ((data.layout?.width || 100) - playIcon.width) / 2;
      playIcon.y = ((data.layout?.height || 100) - playIcon.height) / 2;

      // AI Enhancement: Add OCR text overlay if available
      if (data.ocrText && data.hasOCRText && data.ocrConfidence > 0.7) {
        try {
          await figma.loadFontAsync({ family: "Inter", style: "Regular" });
          const ocrTextNode = figma.createText();
          ocrTextNode.characters = data.ocrText.substring(0, 200); // Limit length
          // CRITICAL FIX: Validate fontSize with minimum of 8px
          const ocrRawSize =
            Math.min(data.layout?.width || 100, data.layout?.height || 100) *
            0.05;
          ocrTextNode.fontSize = Math.max(
            8,
            Number.isFinite(ocrRawSize) ? ocrRawSize : 12,
          );
          ocrTextNode.fills = [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }];
          ocrTextNode.x = 10;
          ocrTextNode.y = 10;
          ocrTextNode.name = "OCR Text Overlay";
          frame.appendChild(ocrTextNode);
          this.safeSetPluginData(ocrTextNode, "ocrText", data.ocrText);
          this.safeSetPluginData(
            ocrTextNode,
            "ocrConfidence",
            String(data.ocrConfidence),
          );
          console.log(
            `✅ [AI] Added OCR text overlay to image: "${data.ocrText.substring(
              0,
              50,
            )}"`,
          );
        } catch (ocrError) {
          console.warn("⚠️ [AI] Failed to create OCR text overlay:", ocrError);
        }
      }

      const circle = figma.createEllipse();
      circle.resize(iconSize * 2, iconSize * 2);
      circle.x = ((data.layout?.width || 100) - circle.width) / 2;
      circle.y = ((data.layout?.height || 100) - circle.height) / 2;
      circle.fills = [
        { type: "SOLID", color: { r: 0, g: 0, b: 0 }, opacity: 0.5 },
      ];
      circle.name = "Play Button Background";

      frame.appendChild(circle);
      frame.appendChild(playIcon);

      return frame;
    }

    const rect = figma.createRectangle();
    rect.name = data.name || "Image";
    rect.resize(
      Math.max(this.roundForPixelPerfection(data.layout?.width || 1), 0.01),
      Math.max(this.roundForPixelPerfection(data.layout?.height || 1), 0.01),
    );

    // 🔥 CRITICAL: schema uses imageHash – prefer that, but still support imageAssetId.
    // Some extractors only set image hashes on fills/backgrounds; fall back to those when needed.
    let hash: string | undefined = data.imageAssetId || data.imageHash;
    const asset =
      hash && this.assets?.images && this.assets.images[hash]
        ? this.assets.images[hash]
        : undefined;

    // Inline SVGs should be turned into vectors instead of rasterized images
    if (asset) {
      const svgMarkup = await this.extractSvgMarkup(asset);
      if (svgMarkup) {
        try {
          const baseUrl = asset?.url || (this.assets as any)?.baseUrl;
          const needsInlining =
            typeof svgMarkup === "string" && /<use\b/i.test(svgMarkup);
          const inlined = needsInlining
            ? await this.inlineSvgUsesInPlugin(svgMarkup, baseUrl)
            : svgMarkup;
          const vectorNode = this.createVectorFromSvgMarkup(inlined, data);
          if (vectorNode) {
            return vectorNode;
          }
        } catch (error) {
          console.warn("Failed to inline SVG <use> references", error);
        }
      }
    }

    if (!hash && Array.isArray(data.fills)) {
      const imageFill = data.fills.find(
        (f: any) => f && f.type === "IMAGE" && typeof f.imageHash === "string",
      );
      if (imageFill) {
        hash = imageFill.imageHash;
      }
    }

    if (hash) {
      // CRITICAL FIX: Use scaleMode from fills if available, otherwise derive from objectFit
      let scaleMode: "FILL" | "FIT" | "CROP" | "TILE" = "FILL";
      if (data.fills && data.fills.length > 0) {
        const imageFill = data.fills.find((f: any) => f && f.type === "IMAGE");
        if (imageFill && imageFill.scaleMode) {
          scaleMode = imageFill.scaleMode;
        }
      }
      if (scaleMode === "FILL" && data.objectFit) {
        scaleMode = this.mapObjectFitToScaleMode(data.objectFit);
      }

      // PIXEL-PERFECT PHASE 2: Use intrinsicSize and imageFit from enhanced capture
      if (data.intrinsicSize && data.imageFit) {
        const { width: intrinsicW, height: intrinsicH } = data.intrinsicSize;
        const { width: displayW, height: displayH } = data.layout || {};

        // Map CSS object-fit to Figma scaleMode
        // IMPORTANT: cover → FILL (not CROP) because CROP requires explicit imageTransform
        const imageFitMapping: Record<string, "FILL" | "FIT" | "CROP"> = {
          fill: "FILL", // Stretch to fill container (may distort aspect ratio)
          contain: "FIT", // Scale to fit, preserve aspect, may show empty space
          cover: "FILL", // Scale to cover, preserve aspect (FILL is correct for cover without imageTransform)
          none: "CROP", // Display at intrinsic size, will resize below
          "scale-down": "FIT", // Like contain but never upscale
        };
        scaleMode = imageFitMapping[data.imageFit] || "FILL";

        // For object-fit: none, resize rectangle to intrinsic dimensions to prevent scaling
        if (data.imageFit === "none" && intrinsicW > 0 && intrinsicH > 0) {
          rect.resize(
            Math.max(this.roundForPixelPerfection(intrinsicW), 0.01),
            Math.max(this.roundForPixelPerfection(intrinsicH), 0.01),
          );
          console.log(
            `✅ [PIXEL-PERFECT] Resized ${
              data.name || "Image"
            } to intrinsic size ${intrinsicW}x${intrinsicH} (object-fit: none)`,
          );
        }

        console.log(
          `✅ [PIXEL-PERFECT] Applied imageFit '${
            data.imageFit
          }' → scaleMode '${scaleMode}' for ${
            data.name || "Image"
          } (intrinsic: ${intrinsicW}x${intrinsicH}, display: ${displayW}x${displayH})`,
        );
      }

      // CRITICAL FIX: Get imageTransform from the fill if available
      // Also pass the URL for fallback fetching (critical for Etsy lazy-loaded images)
      const imageFill = data.fills?.find((f: any) => f && f.type === "IMAGE");
      // CRITICAL: Ensure URL is in the fill object for resolveImagePaint to use
      const fillWithUrl = imageFill
        ? {
            ...imageFill,
            url:
              imageFill.url ||
              data.component?.options?.image ||
              (hash.startsWith("http") ? hash : undefined),
          }
        : {
            type: "IMAGE",
            imageHash: hash,
            scaleMode: scaleMode,
            visible: true,
            url:
              data.component?.options?.image ||
              (hash.startsWith("http") ? hash : undefined),
          };

      const imagePaint = await this.resolveImagePaint({
        ...fillWithUrl,
        imageHash: hash,
        scaleMode,
        imageTransform: imageFill?.imageTransform,
        objectFit: data.objectFit || imageFill?.objectFit,
        objectPosition: imageFill?.objectPosition,
      });

      // CRITICAL: Validate that we got an IMAGE paint, not a fallback SOLID paint
      if (imagePaint.type === "IMAGE") {
        rect.fills = [imagePaint];
        console.log(
          `✅ Image paint applied to ${data.name || "Image"} with hash ${hash}`,
        );
      } else {
        console.error(
          `❌ Failed to resolve image for hash ${hash} - got ${imagePaint.type} fallback instead of IMAGE paint`,
        );
        console.error(
          `  Available asset keys: ${Object.keys(this.assets?.images || {})
            .slice(0, 5)
            .join(", ")}`,
        );

        // CRITICAL FIX: Try to fetch from URL if available (for Etsy lazy-loaded images)
        // Check for URL in fills, imageHash (if it's a URL), or component options
        let imageUrl: string | undefined = undefined;
        if (data.fills && data.fills.length > 0) {
          const imageFill = data.fills.find(
            (f: any) => f && f.type === "IMAGE",
          );
          if (imageFill && imageFill.url) {
            imageUrl = imageFill.url;
          }
        }
        if (
          !imageUrl &&
          hash &&
          (hash.startsWith("http") || hash.startsWith("data:"))
        ) {
          imageUrl = hash;
        }
        if (!imageUrl && data.component?.options?.image) {
          imageUrl = data.component.options.image;
        }

        // Try one more time to fetch from URL before using solid fill fallback
        if (imageUrl && imageUrl !== hash) {
          try {
            console.log(
              `🔄 [LAST RESORT] Attempting to fetch image from URL: ${imageUrl}`,
            );
            // Use fetchImage which automatically routes external URLs to proxy
            const { bytes, contentType: fetchedContentType } =
              await this.fetchImage(imageUrl);
            const transcodedBytes = await this.transcodeIfUnsupportedRaster(
              bytes,
              fetchedContentType || "image/png",
              data.layout?.width
                ? Math.max(data.layout.width * 2, 1)
                : undefined,
              data.layout?.height
                ? Math.max(data.layout.height * 2, 1)
                : undefined,
            );
            const figmaImage = figma.createImage(transcodedBytes);
            const finalImagePaint: ImagePaint = {
              type: "IMAGE",
              imageHash: figmaImage.hash,
              scaleMode: scaleMode,
              visible: true,
            };
            rect.fills = [finalImagePaint];
            console.log(
              `✅ [LAST RESORT] Successfully fetched and applied image from URL`,
            );
          } catch (urlError) {
            console.warn(`  ❌ URL fetch failed:`, urlError);
            // Still set the fallback so the node is visible
            rect.fills = [imagePaint];
          }
        } else {
          // No URL available, use the fallback

          // Image resolution failed. Keep the fallback rectangle.
          console.warn(
            `⚠️ Image missing for ${hash}, keeping fallback rectangle`,
          );
          return rect;
        }

        diagnostics.logIssue(
          data.id || "unknown",
          data.name || "Image",
          "IMAGE",
          `Image resolution failed for hash ${hash}`,
          {
            hash,
            availableKeys: Object.keys(this.assets?.images || {}).length,
            paintType: imagePaint.type,
            triedUrl: !!imageUrl,
          },
          {
            result:
              (imagePaint as any).type === "IMAGE"
                ? "url fetch succeeded"
                : "placeholder created",
          },
        );
      }
    }

    // AI Enhancement: Add OCR text overlay for images with text
    if (data.ocrText && data.hasOCRText && data.ocrConfidence > 0.7) {
      try {
        // Convert rectangle to frame to hold text overlay
        const frame = figma.createFrame();
        frame.name = data.name || "Image";
        frame.resize(
          this.roundForPixelPerfection(rect.width),
          this.roundForPixelPerfection(rect.height),
        );
        frame.fills = rect.fills;
        frame.x = rect.x;
        frame.y = rect.y;

        await figma.loadFontAsync({ family: "Inter", style: "Regular" });
        const ocrTextNode = figma.createText();
        ocrTextNode.characters = data.ocrText.substring(0, 200);
        const fontSize =
          Math.min(data.layout.width || 100, data.layout.height || 100) * 0.05;
        ocrTextNode.fontSize = Math.max(fontSize, 12);
        ocrTextNode.fills = [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }];
        ocrTextNode.x = 10;
        ocrTextNode.y = 10;
        ocrTextNode.name = "OCR Text Overlay";
        frame.appendChild(ocrTextNode);
        this.safeSetPluginData(ocrTextNode, "ocrText", data.ocrText);
        this.safeSetPluginData(
          ocrTextNode,
          "ocrConfidence",
          String(data.ocrConfidence),
        );
        console.log(
          `✅ [AI] Added OCR text overlay to image: "${data.ocrText.substring(
            0,
            50,
          )}"`,
        );
        return frame;
      } catch (ocrError) {
        console.warn("⚠️ [AI] Failed to create OCR text overlay:", ocrError);
        // Return original rect if overlay fails
      }
    }

    return rect;
  }

  private async createVector(data: any): Promise<SceneNode | null> {
    const baseUrl =
      (this.assets as any)?.baseUrl ||
      data?.svgBaseUrl ||
      data?.pluginData?.pageUrl ||
      data?.metadata?.url;

    if (data.svgContent) {
      try {
        const raw = String(data.svgContent).trim();
        // IMPORTANT: Do not split on "," for inline SVG strings (commas are valid inside SVG, e.g. rgb(0, 0, 0)).
        // Only treat it as a data URL when it actually starts with "data:".
        let svgString = raw;
        if (raw.startsWith("data:")) {
          const { payload, isBase64 } = this.extractDataUrlParts(raw);
          const decoded = isBase64
            ? await this.base64ToString(payload, { allowSvg: true })
            : this.safeDecodeUriComponent(payload);
          svgString = decoded.trim().startsWith("<") ? decoded : raw;
        } else if (!raw.startsWith("<")) {
          svgString = await this.base64ToString(raw, { allowSvg: true });
        }

        const needsInlining = /<use\b/i.test(svgString);
        const inlined = needsInlining
          ? await this.inlineSvgUsesInPlugin(svgString, baseUrl)
          : svgString;
        const vectorNode = this.createVectorFromSvgMarkup(inlined, data);
        if (vectorNode) return vectorNode;
      } catch (error) {
        console.warn("Failed to create node from SVG content", error);
      }
    }

    if (data.vectorData?.svgCode) {
      try {
        const raw = data.vectorData.svgCode;
        const needsInlining = typeof raw === "string" && /<use\b/i.test(raw);
        const inlined = needsInlining
          ? await this.inlineSvgUsesInPlugin(raw, baseUrl)
          : raw;
        const vectorNode = this.createVectorFromSvgMarkup(inlined, data);
        if (vectorNode) return vectorNode as SceneNode;
      } catch (error) {
        console.warn(
          "Failed to create vector from SVG, falling back to rectangle.",
          error,
        );
      }
    }

    // Try converting SVG image assets directly to vectors.
    if (data.imageHash && this.assets?.images?.[data.imageHash]?.svgCode) {
      try {
        const svgMarkup = this.assets.images[data.imageHash].svgCode;
        const assetUrl =
          this.assets.images[data.imageHash]?.url ||
          (this.assets as any)?.baseUrl;
        const needsInlining =
          typeof svgMarkup === "string" && /<use\b/i.test(svgMarkup);
        const inlined = needsInlining
          ? await this.inlineSvgUsesInPlugin(svgMarkup, assetUrl)
          : svgMarkup;
        const vectorNode = this.createVectorFromSvgMarkup(inlined, data);
        if (vectorNode) return vectorNode as SceneNode;
      } catch (error) {
        console.warn(
          "Failed to create vector from svgCode on asset, continuing as raster",
          error,
        );
      }
    }

    const imageNode = await this.createRectangle(data);

    // AI Enhancement: Add OCR text overlay for images with text
    if (
      data.ocrText &&
      data.hasOCRText &&
      data.ocrConfidence > 0.7 &&
      imageNode
    ) {
      // OCR overlay requires a container node (FRAME). `createRectangle` returns a RectangleNode,
      // so skip the overlay in this fallback path to avoid invalid node operations.
    }

    return imageNode;
  }

  private async createComponent(data: any): Promise<ComponentNode> {
    const component = figma.createComponent();
    component.name = data.name || "Component";
    component.resize(
      Math.max(this.roundForPixelPerfection(data.layout?.width || 1), 0.01),
      Math.max(this.roundForPixelPerfection(data.layout?.height || 1), 0.01),
    );
    component.fills = []; // Start transparent
    return component;
  }

  private async createInstance(data: any): Promise<SceneNode | null> {
    const componentId = data.componentId || data.componentKey || data.id;
    if (componentId) {
      const existing = this.componentManager.getComponent(componentId);
      if (existing) {
        return existing.createInstance();
      }
    }

    const signature = data.componentSignature;
    if (signature) {
      const registered =
        this.componentManager.getComponentBySignature(signature);
      if (registered) {
        return registered.createInstance();
      }
    }

    return this.createFrame(data);
  }

  private async afterCreate(
    node: SceneNode,
    data: any,
    meta: {
      reuseComponent: boolean;
      parentAbsoluteBounds?: { x: number; y: number };
    },
  ): Promise<void> {
    // Helper to safely execute operations with isolated error handling
    const safeExec = async (opName: string, op: () => void | Promise<void>) => {
      this.styleOperationStats.totalOperations++;
      try {
        await op();
      } catch (e) {
        this.styleOperationStats.failedOperations++;
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(`⚠️ [${opName}] failed for ${node.name}: ${msg}`);

        // Track detailed failure info (limit to 100 to prevent memory issues)
        if (this.styleOperationStats.failures.length < 100) {
          this.styleOperationStats.failures.push({
            nodeId: data.id || "unknown",
            operation: opName,
            error: msg,
          });
        }
      }
    };

    try {
      node.name = data.name || node.name;

      // CRITICAL FIX: Validate and sanitize all data before applying
      // FAIL-FAST: Schema validation errors are re-thrown (missing layout, etc.)
      // This ensures broken nodes fail early instead of producing downstream issues
      let validatedData: any;
      try {
        validatedData = this.validateNodeData(data);
      } catch (validationErr) {
        this.styleOperationStats.failedValidations++;

        // Re-throw schema validation errors (missing required fields)
        // These indicate upstream extraction/serialization failure
        if (validationErr instanceof SchemaValidationError) {
          console.error(
            `❌ [SCHEMA] Node "${data.name}" missing field: ${validationErr.fieldName}`,
          );
          throw validationErr; // Re-throw to fail node creation
        }

        // For other validation issues, log and attempt to continue with raw data
        // (This allows minor paint/style issues to not block entire node)
        console.warn(
          `⚠️ [VALIDATION] Non-critical validation issue for ${data.name}, using raw data:`,
          validationErr,
        );
        validatedData = data;
      }

      // SAFETY: Each operation wrapped for isolation - if one fails, others still run
      await safeExec("applyPositioning", () => {
        if (typeof this.applyPositioning === "function") {
          this.applyPositioning(node, validatedData, meta.parentAbsoluteBounds);
        }
      });

      // CRITICAL: applyCommonStyles applies fills - must be isolated
      await safeExec("applyCommonStyles", async () => {
        if (typeof this.applyCommonStyles === "function") {
          await this.applyCommonStyles(node, validatedData);
        }
      });

      // CRITICAL FIX: Apply box sizing correction to handle transformed elements and strict dimensions
      // This must run after basic styling but before Auto Layout to ensure correct base dimensions
      await safeExec("applyBoxSizingCorrection", () => {
        this.applyBoxSizingCorrection(node, validatedData);
      });

      // Only try to convert CSS Grid → Auto Layout if auto-layout mode is enabled
      if (this.options?.applyAutoLayout) {
        await safeExec("applyAutoLayout", () => {
          if (
            data.autoLayout &&
            node.type === "FRAME" &&
            typeof this.applyAutoLayout === "function"
          ) {
            this.applyAutoLayout(node as FrameNode, data.autoLayout);
          }
        });
        await safeExec("applyGridLayoutMetadata", () => {
          if (typeof this.applyGridLayoutMetadata === "function") {
            this.applyGridLayoutMetadata(node, data);
          }
        });
      }

      await safeExec("applyOverflow", () => {
        if (typeof this.applyOverflow === "function") {
          this.applyOverflow(node, data);
        }
      });
      await safeExec("applyOpacity", () => {
        if (typeof this.applyOpacity === "function") {
          this.applyOpacity(node, data);
        }
      });
      await safeExec("applyVisibility", () => {
        if (typeof this.applyVisibility === "function") {
          this.applyVisibility(node, data);
        }
      });
      await safeExec("applyFilters", () => {
        if (typeof this.applyFilters === "function") {
          this.applyFilters(node, data);
        }
      });
      await safeExec("applyMetadata", () => {
        if (typeof this.applyMetadata === "function") {
          this.applyMetadata(node, data, meta);
        }
      });

      if (
        data.designTokens &&
        this.designTokensManager &&
        typeof this.applyDesignTokens === "function"
      ) {
        await safeExec("applyDesignTokens", () =>
          this.applyDesignTokens(node, data.designTokens),
        );
      }
    } catch (e) {
      // FAIL-FAST: Re-throw SchemaValidationError so createNode can remove the invalid node
      if (e instanceof SchemaValidationError) {
        throw e;
      }

      // ENHANCED ERROR LOGGING: Capture full details including stack trace
      const errorMessage = e instanceof Error ? e.message : String(e);
      const errorStack = e instanceof Error ? e.stack : undefined;
      console.error(
        `❌ [NODE_BUILDER] afterCreate failed for ${node.name}: ${errorMessage}`,
        {
          error: e,
          stack: errorStack,
          nodeType: node.type,
          dataType: data?.type,
        },
      );
      // GRACEFUL FAILURE: Don't throw for other errors - log error and continue
      console.warn(
        `⚠️ [GRACEFUL] Continuing import despite afterCreate failure for ${node.name}`,
      );
    }
  }

  private applyBorderSidesIfPresent(node: SceneNode, data: any): void {
    const sides = data?.borderSides;
    if (!sides || typeof sides !== "object") return;
    if (!("strokes" in node) || !("strokeAlign" in node)) return;

    const normSide = (s: any) => {
      const width =
        typeof s?.width === "number" && Number.isFinite(s.width) ? s.width : 0;
      const style =
        typeof s?.style === "string" ? s.style.toLowerCase() : "none";
      const color = s?.color;
      const hasColor =
        color &&
        typeof color.r === "number" &&
        typeof color.g === "number" &&
        typeof color.b === "number";
      const active =
        width > 0.001 && style !== "none" && style !== "hidden" && hasColor;
      return {
        width: active ? width : 0,
        style,
        color: hasColor ? color : null,
      };
    };

    const top = normSide(sides.top);
    const right = normSide(sides.right);
    const bottom = normSide(sides.bottom);
    const left = normSide(sides.left);

    const maxWidth = Math.max(top.width, right.width, bottom.width, left.width);
    if (maxWidth <= 0) return;

    const activeSides = [top, right, bottom, left].filter(
      (s) => s.width > 0.001,
    );
    const pickColor =
      activeSides.find((s) => s.color)?.color ||
      ({ r: 0, g: 0, b: 0, a: 1 } as any);

    const nearlyEqual = (a: number, b: number) => Math.abs(a - b) < 1e-3;
    const colorsMatch =
      activeSides.length === 0
        ? true
        : activeSides.every((s) => {
            const c = s.color || pickColor;
            return (
              nearlyEqual(c.r, pickColor.r) &&
              nearlyEqual(c.g, pickColor.g) &&
              nearlyEqual(c.b, pickColor.b) &&
              nearlyEqual(c.a ?? 1, pickColor.a ?? 1)
            );
          });

    if (!colorsMatch) {
      this.safeSetPluginData(
        node,
        "cssBorderSides",
        JSON.stringify({ top, right, bottom, left }),
      );
      this.safeSetPluginData(node, "cssBorderColorMismatch", "true");
    }

    const paint: SolidPaint = {
      type: "SOLID",
      color: { r: pickColor.r, g: pickColor.g, b: pickColor.b },
      opacity: typeof pickColor.a === "number" ? pickColor.a : 1,
      visible: true,
    };

    (node as any).strokes = [paint];
    (node as any).strokeAlign = "INSIDE";

    // Per-side stroke weights (when supported) fix the biggest visual mismatch:
    // border-bottom-only, asymmetric widths, etc.
    if (
      "strokeTopWeight" in (node as any) &&
      "strokeRightWeight" in (node as any) &&
      "strokeBottomWeight" in (node as any) &&
      "strokeLeftWeight" in (node as any)
    ) {
      (node as any).strokeTopWeight = top.width;
      (node as any).strokeRightWeight = right.width;
      (node as any).strokeBottomWeight = bottom.width;
      (node as any).strokeLeftWeight = left.width;
      (node as any).strokeWeight = maxWidth;
    } else {
      // Fallback: uniform stroke weight (best-effort).
      (node as any).strokeWeight = maxWidth;
      this.safeSetPluginData(node, "cssBorderAsymmetric", "true");
    }

    // Dash patterns: only apply when all active sides share a single style.
    if ("dashPattern" in (node as any)) {
      const styles = new Set(activeSides.map((s) => s.style));
      if (styles.size === 1) {
        const style = Array.from(styles)[0];
        const dashPatterns: Record<string, number[]> = {
          dashed: [10, 5],
          dotted: [2, 3],
          solid: [],
        };
        const pattern = dashPatterns[style] || [];
        if (pattern.length > 0) {
          (node as any).dashPattern = pattern;
        }
      }
    }
  }

  private async applyDesignTokens(node: SceneNode, tokens: any): Promise<void> {
    if (!this.designTokensManager) return;

    const getVar = (tokenId: string) =>
      this.designTokensManager!.getVariableByTokenId(tokenId);

    if (tokens.fill && "fills" in node) {
      const variable = getVar(tokens.fill);
      if (variable) {
        const fills = (node as GeometryMixin).fills as Paint[];
        if (fills && fills.length > 0) {
          const newFills = JSON.parse(JSON.stringify(fills));
          const boundFill = figma.variables.setBoundVariableForPaint(
            newFills[0],
            "color",
            variable,
          );
          newFills[0] = boundFill;
          (node as GeometryMixin).fills = newFills;
        }
      }
    }

    if (tokens.stroke && "strokes" in node) {
      const variable = getVar(tokens.stroke);
      if (variable) {
        const strokes = (node as GeometryMixin).strokes as Paint[];
        if (strokes && strokes.length > 0) {
          const newStrokes = JSON.parse(JSON.stringify(strokes));
          const boundStroke = figma.variables.setBoundVariableForPaint(
            newStrokes[0],
            "color",
            variable,
          );
          newStrokes[0] = boundStroke;
          (node as GeometryMixin).strokes = newStrokes;
        }
      }
    }

    if (tokens.borderRadius && "cornerRadius" in node) {
      const variable = getVar(tokens.borderRadius);
      if (variable) {
        try {
          node.setBoundVariable("topLeftRadius", variable.id);
          node.setBoundVariable("topRightRadius", variable.id);
          node.setBoundVariable("bottomLeftRadius", variable.id);
          node.setBoundVariable("bottomRightRadius", variable.id);
        } catch {}
      }
    }

    if (tokens.width && "resize" in node) {
      const variable = getVar(tokens.width);
      if (variable) {
        try {
          node.setBoundVariable("width", variable.id);
        } catch {}
      }
    }
    if (tokens.height && "resize" in node) {
      const variable = getVar(tokens.height);
      if (variable) {
        try {
          node.setBoundVariable("height", variable.id);
        } catch {}
      }
    }

    if ("layoutMode" in node && (node as FrameNode).layoutMode !== "NONE") {
      if (tokens.gap) {
        const variable = getVar(tokens.gap);
        if (variable) node.setBoundVariable("itemSpacing", variable.id);
      }
      if (tokens.padding) {
        const variable = getVar(tokens.padding);
        if (variable) {
          node.setBoundVariable("paddingTop", variable.id);
          node.setBoundVariable("paddingBottom", variable.id);
          node.setBoundVariable("paddingLeft", variable.id);
          node.setBoundVariable("paddingRight", variable.id);
        }
      }
    }
  }

  /**
   * PIXEL-PERFECT: Apply transforms using absolute transformation matrix
   * Single source of truth for all transform applications - eliminates coordinate ambiguity
   */
  private applyCssTransforms(
    node: SceneNode,
    data: any,
    elementWidth: number,
    elementHeight: number,
  ): void {
    // Check if professional transform was already applied to avoid double application
    if (node.getPluginData("professionalTransformApplied") === "true") {
      return;
    }

    // Check if node has absoluteTransform data from new schema
    const absoluteTransform = data.absoluteTransform;
    if (!absoluteTransform) {
      // No transform data - skip
      return;
    }

    console.log(
      `🎯 [PIXEL-PERFECT TRANSFORMS] Applying matrix transform for ${data.tagName}`,
    );

    const { matrix, origin } = absoluteTransform;
    const [a, b, c, d, tx, ty] = matrix;

    // CRITICAL SAFETY: Validate matrix values to prevent engine crashes
    if (
      ![a, b, c, d, tx, ty].every(
        (v) => typeof v === "number" && Number.isFinite(v),
      )
    ) {
      console.warn(
        `⚠️ [TRANSFORM] Skipping invalid matrix for ${data.tagName}:`,
        matrix,
      );
      return;
    }

    // Apply the transform matrix directly to the Figma node
    try {
      // P0 FIDELITY FIX: Calculate correct translation accounting for transform-origin and static position
      // CSS transforms pivot around transform-origin (default center), while Figma pivots around top-left (0,0).
      // We must compensate for this pivot difference AND add the static layout position.

      const staticX = data.layout?.x ?? 0;
      const staticY = data.layout?.y ?? 0;

      const ox = (origin?.x ?? 0.5) * elementWidth;
      const oy = (origin?.y ?? 0.5) * elementHeight;

      // Calculate adjusted translation
      // tx_final = staticX + tx + originX * (1 - a) - originY * c
      // ty_final = staticY + ty + originY * (1 - d) - originX * b
      const tx_final = staticX + tx + ox * (1 - a) - oy * c;
      const ty_final = staticY + ty + oy * (1 - d) - ox * b;

      // Convert to Figma's relativeTransform format: [[a, c, tx], [b, d, ty]]
      const relativeTransform: Transform = [
        [a, c, tx_final],
        [b, d, ty_final],
      ];

      // Apply the transform
      if ("relativeTransform" in node) {
        (node as any).relativeTransform = relativeTransform;
        console.log(
          `  ✅ Applied matrix transform with origin compensation:`,
          relativeTransform,
        );
      }

      // Store original local size for validation
      if (data.localSize) {
        this.safeSetPluginData(
          node,
          "originalLocalSize",
          JSON.stringify(data.localSize),
        );
      }

      // Store transform metadata for debugging
      this.safeSetPluginData(node, "absoluteTransformApplied", "true");
      this.safeSetPluginData(node, "transformMatrix", JSON.stringify(matrix));
      this.safeSetPluginData(node, "transformOrigin", JSON.stringify(origin));

      console.log(
        `  📊 Transform details: matrix=${matrix}, origin=${JSON.stringify(
          origin,
        )}, localSize=${JSON.stringify(data.localSize)}`,
      );
    } catch (error) {
      console.warn(`  ⚠️ Failed to apply transform matrix:`, error);
      // Fallback: apply as individual transformations
      this.applyTransformFallback(node, matrix, data.localSize);
    }

    console.log(
      `✅ [PIXEL-PERFECT TRANSFORMS] Matrix transform applied to ${data.tagName} (${node.type})`,
    );
  }

  /**
   * Fallback transform application when direct matrix fails
   */
  private applyTransformFallback(
    node: SceneNode,
    matrix: number[],
    localSize?: { width: number; height: number },
  ): void {
    const safeMatrix = matrix.map((v) => (Number.isFinite(v) ? v : 0));
    const a = safeMatrix[0] ?? 1;
    const b = safeMatrix[1] ?? 0;
    const c = safeMatrix[2] ?? 0;
    const d = safeMatrix[3] ?? 1;
    const tx = safeMatrix[4] ?? 0;
    const ty = safeMatrix[5] ?? 0;

    // Extract rotation from matrix
    const rotationRadians = Math.atan2(b, a);
    if (rotationRadians !== 0 && "rotation" in node) {
      const rotationDegrees = (rotationRadians * 180) / Math.PI;
      // Figma rotation is in degrees clockwise.
      // Math.atan2 returns radians, which we convert to degrees.
      node.rotation = rotationDegrees;
      console.log(
        `  🔄 Fallback: Applied rotation: ${rotationDegrees.toFixed(2)}°`,
      );
    }

    // Extract scale from matrix
    const scaleX = Math.sqrt(a * a + b * b);
    const scaleY = Math.sqrt(c * c + d * d);
    if ((scaleX !== 1 || scaleY !== 1) && "resize" in node && localSize) {
      const scaledWidth = localSize.width * scaleX;
      const scaledHeight = localSize.height * scaleY;
      (node as LayoutMixin).resize(
        Math.max(scaledWidth, 1),
        Math.max(scaledHeight, 1),
      );
      console.log(`  📏 Fallback: Applied scale: ${scaleX}x${scaleY}`);
    }

    // Apply translation
    if (tx !== 0 || ty !== 0) {
      const currentX = Number.isFinite(node.x) ? node.x : 0;
      const currentY = Number.isFinite(node.y) ? node.y : 0;
      node.x = currentX + tx;
      node.y = currentY + ty;
      console.log(`  📍 Fallback: Applied translation: (${tx}, ${ty})`);
    }
  }

  /**
   * ENHANCED STACKING CONTEXT: Handles z-index and layer ordering
   * Fixes stacking context translation issues identified in validation analysis
   */

  private applyStackingContext(node: SceneNode, data: any): void {
    // Extract z-index from multiple possible sources
    const zIndex =
      data.absoluteLayout?.zIndex ||
      data.layoutContext?.zIndex ||
      data.style?.zIndex ||
      data.zIndex;

    if (zIndex !== undefined && zIndex !== null && zIndex !== "auto") {
      // Normalize z-index to safe range for Figma layer ordering
      const normalizedZIndex = this.normalizeZIndex(zIndex);

      // Store z-index for layer sorting during parent processing
      this.safeSetPluginData(
        node,
        "cssZIndex",
        JSON.stringify({
          original: zIndex,
          normalized: normalizedZIndex,
          stackingContext: data.absoluteLayout?._stackingContext || false,
        }),
      );

      // Log for debugging stacking issues
      console.log(
        `🔄 [STACKING] Applied z-index ${zIndex} (normalized: ${normalizedZIndex}) to ${data.name}`,
      );
    }

    // Handle fixed/absolute positioning for stacking context
    const position = data.layoutContext?.position || data.style?.position;
    if (position === "fixed" || position === "absolute") {
      this.safeSetPluginData(
        node,
        "cssPosition",
        JSON.stringify({
          position,
          zIndex: zIndex || 0,
          stackingContext: true,
        }),
      );
    }
  }

  /**
   * Normalize z-index values to prevent overflow in Figma's layer system
   */
  private normalizeZIndex(zIndex: any): number {
    if (typeof zIndex !== "number") {
      const parsed = parseInt(String(zIndex), 10);
      if (!isFinite(parsed)) return 0;
      zIndex = parsed;
    }

    // Clamp z-index to reasonable range (-1000 to 1000)
    // Figma handles layer ordering differently than CSS z-index
    return Math.max(-1000, Math.min(1000, zIndex));
  }

  private tryApplyCssMatrixTransform(
    node: SceneNode,
    data: any,
    bounds: { left: number; top: number },
    elementWidth: number,
    elementHeight: number,
  ): boolean {
    const transformData =
      data.transform ||
      data.layoutContext?.transform ||
      data.style?.transform ||
      null;

    if (!transformData || transformData === "none") return false;

    let matrix: [number, number, number, number, number, number] | undefined;

    // Handle array format (from new extractor: [a, b, c, d, tx, ty])
    if (Array.isArray(transformData) && transformData.length >= 6) {
      matrix = [
        transformData[0],
        transformData[1],
        transformData[2],
        transformData[3],
        transformData[4],
        transformData[5],
      ];
    }
    // Handle legacy object format { matrix: [...] }
    else if (
      typeof transformData === "object" &&
      Array.isArray(transformData.matrix)
    ) {
      const m = transformData.matrix;
      if (m.length >= 6) {
        matrix = [m[0], m[1], m[2], m[3], m[4], m[5]];
      }
    }
    // Handle string format (CSS string)
    else if (typeof transformData === "string") {
      const parsed = parseTransform(transformData);
      if (parsed?.matrix) {
        matrix = parsed.matrix;
      }
    }

    if (!matrix) return false;

    const originString =
      data.transformOrigin ||
      data.layoutContext?.transformOrigin ||
      data.style?.transformOrigin ||
      "50% 50%";

    const origin = parseTransformOrigin(
      originString,
      elementWidth,
      elementHeight,
    );
    const ox = origin.x * elementWidth;
    const oy = origin.y * elementHeight;

    const [a, b, c, d, tx, ty] = matrix;

    const applyToPoint = (x: number, y: number) => {
      const dx = x - ox;
      const dy = y - oy;
      return {
        x: a * dx + c * dy + tx + ox,
        y: b * dx + d * dy + ty + oy,
      };
    };

    const corners = [
      applyToPoint(0, 0),
      applyToPoint(elementWidth, 0),
      applyToPoint(0, elementHeight),
      applyToPoint(elementWidth, elementHeight),
    ];
    const minX = Math.min(...corners.map((p) => p.x));
    const minY = Math.min(...corners.map((p) => p.y));

    // The schema's absoluteLayout.left/top is the transformed bounding box origin.
    // Solve for the untransformed origin so that after applying the CSS matrix the
    // node's transformed bounds match the captured bounds.
    const baseX = bounds.left - minX;
    const baseY = bounds.top - minY;

    // Convert "transform about origin" into a single affine matrix in Figma space.
    // p' = M*(p - o) + o + base
    const e = baseX + tx + ox - (a * ox + c * oy);
    const f = baseY + ty + oy - (b * ox + d * oy);

    try {
      // Use relativeTransform so skew + rotation are applied pixel-perfectly.
      // Not all nodes expose this in typings, so set via `any`.
      (node as any).relativeTransform = [
        [a, c, e],
        [b, d, f],
      ];
      this.safeSetPluginData(
        node,
        "cssTransformMatrix",
        JSON.stringify(matrix),
      );
      this.safeSetPluginData(
        node,
        "cssTransformOrigin",
        JSON.stringify(origin),
      );
      return true;
    } catch (error) {
      console.warn("Failed to apply relativeTransform; falling back", error);
      return false;
    }
  }

  /**
   * PROFESSIONAL: Enhanced positioning with layout intelligence and hybrid strategies
   */

  private applyPositioning(
    node: SceneNode,
    data: any,
    parentAbsoluteBounds?: { x: number; y: number },
  ) {
    try {
      // CRITICAL FIX: Apply stacking context (z-index)
      // This ensures the node has 'cssZIndex' data for sorting in the parent
      this.applyStackingContext(node, data);

      if (data.layout) {
        // ROOT CAUSE FIX: Do NOT modify data.layout in-place.
        // Use local variables to calculate relative offsets.
        let relX = data.layout.x ?? 0;
        let relY = data.layout.y ?? 0;

        if (
          parentAbsoluteBounds &&
          typeof parentAbsoluteBounds.x === "number" &&
          typeof parentAbsoluteBounds.y === "number"
        ) {
          relX = relX - parentAbsoluteBounds.x;
          relY = relY - parentAbsoluteBounds.y;
        }

        // PROFESSIONAL: Analyze layout intelligence for optimal positioning strategy
        // PROFESSIONAL: Analyze layout intelligence for optimal positioning strategy
        // MEMORY SAFETY: Skip this expensive analysis for large imports to prevent OOM
        let layoutIntelligence;
        if (this.memorySafetyMode) {
          // Minimal fallback - no expensive layout analysis
          layoutIntelligence = {
            inferredLayout: { layoutMode: "NONE" },
            confidenceScore: 0,
            hybridStrategy: { mode: "ABSOLUTE" },
            fallbackStrategy: {
              mode: "ABSOLUTE",
              reasoning: "Memory safety mode",
            },
          };
        } else {
          try {
            layoutIntelligence =
              this.professionalLayoutSolver.analyzeLayoutIntelligence(data);
          } catch (intellErr) {
            const errMsg =
              intellErr instanceof Error
                ? intellErr.message
                : String(intellErr);
            // Only log errors
            console.error(
              `❌ [applyPositioning] analyzeLayoutIntelligence failed for ${data.name}: ${errMsg}`,
            );
            // Create minimal fallback
            layoutIntelligence = {
              inferredLayout: { layoutMode: "NONE" },
              confidenceScore: 0,
              hybridStrategy: { mode: "ABSOLUTE" },
              fallbackStrategy: {
                mode: "ABSOLUTE",
                reasoning: "Error fallback",
              },
            };
          }
        }

        // Apply professional hybrid positioning strategy
        try {
          this.applyProfessionalPositioning(node, data, layoutIntelligence);
        } catch (profErr) {
          const errMsg =
            profErr instanceof Error ? profErr.message : String(profErr);
          console.error(
            `❌ [applyPositioning] applyProfessionalPositioning failed for ${data.name}: ${errMsg}`,
          );
        }

        // Use normalized coordinates from helper
        let coordResult;
        try {
          // Pass the RELATIVE coordinates for normalization
          coordResult = this.validateAndNormalizeCoordinates({
            ...data.layout,
            x: relX,
            y: relY,
          });
        } catch (err) {
          coordResult = {
            x: relX,
            y: relY,
            width: data.layout.width || 100,
            height: data.layout.height || 100,
            isValid: true,
            errors: [],
          };
        }

        if (coordResult && !coordResult.isValid) {
          // Log validation errors only when they happen
          try {
            if (
              typeof diagnostics !== "undefined" &&
              typeof diagnostics.logIssue === "function" &&
              Array.isArray(coordResult.errors)
            ) {
              coordResult.errors.forEach((error) => {
                diagnostics.logIssue(
                  data.id || "unknown",
                  data.name || "unnamed",
                  "COORDINATE_VALIDATION",
                  error,
                  data.layout,
                  {
                    x: coordResult.x,
                    y: coordResult.y,
                    width: coordResult.width,
                    height: coordResult.height,
                  },
                );
              });
            }
          } catch (diagErr) {
            // Ignore diagnostic logging errors
          }
        }

        let { x, y, width, height } = coordResult;

        // Store original fractional values for debugging (only if needed)
        if (
          this.options?.enableDebugMode &&
          (data.layout.x !== x || data.layout.y !== y)
        ) {
          this.safeSetPluginData(
            node,
            "originalPosition",
            JSON.stringify({
              x: data.layout.x,
              y: data.layout.y,
              roundedX: x,
              roundedY: y,
            }),
          );
        }

        const untransformedWidth =
          (typeof data.layout.untransformedWidth === "number" &&
          Number.isFinite(data.layout.untransformedWidth) &&
          data.layout.untransformedWidth > 0
            ? data.layout.untransformedWidth
            : undefined) ?? width;
        const untransformedHeight =
          (typeof data.layout.untransformedHeight === "number" &&
          Number.isFinite(data.layout.untransformedHeight) &&
          data.layout.untransformedHeight > 0
            ? data.layout.untransformedHeight
            : undefined) ?? height;

        // If we have a CSS matrix transform, apply it via relativeTransform so skew/rotation are accurate.
        // We must size the node to its untransformed box before applying the matrix.
        if ("resize" in node) {
          (node as LayoutMixin).resize(
            Math.max(untransformedWidth, 1),
            Math.max(untransformedHeight, 1),
          );
        }

        // Canonical geometry path: captured local coordinates are applied once.
        // CSS matrices are handled by tryApplyCssMatrixTransform above.
        this.applyProfessionalTransform(node, data, x, y);

        const professionalTransformApplied =
          node.getPluginData("professionalTransformApplied") === "true";

        if (
          !professionalTransformApplied &&
          typeof x === "number" &&
          typeof y === "number" &&
          Number.isFinite(x) &&
          Number.isFinite(y)
        ) {
          node.x = x;
          node.y = y;
        }

        if (
          typeof width === "number" &&
          typeof height === "number" &&
          "resize" in node &&
          !data.transform &&
          !data.layoutContext?.transform &&
          !data.style?.transform
        ) {
          (node as LayoutMixin).resize(Math.max(width, 1), Math.max(height, 1));
        }
      }

      // PHASE 4: Apply CSS filters and blend modes after geometry is finalized
      this.applyCssFiltersAndBlend(node, data);

      // PHASE 5: Apply rasterization fallback for unmappable visual features
      this.applyRasterization(node, data);

      if (data.position) {
        this.safeSetPluginData(node, "cssPosition", data.position);
      }

      // PIXEL-PERFECT LAYOUT DETECTION: Use intelligent layout mode selection
      if ("layoutMode" in node) {
        const shouldUseAutoLayout = this.shouldUseAutoLayoutForNode(data);

        if (
          shouldUseAutoLayout &&
          data.autoLayout &&
          this.options?.applyAutoLayout
        ) {
          this.applyAutoLayout(node as FrameNode, data.autoLayout);
        } else if (shouldUseAutoLayout && !this.options?.applyAutoLayout) {
          // Use absolute positioning but preserve layout metadata for debugging
          (node as FrameNode).layoutMode = "NONE";
          this.safeSetPluginData(node, "layoutMode", "ABSOLUTE");
          this.safeSetPluginData(
            node,
            "potentialAutoLayout",
            JSON.stringify(data.autoLayout || {}),
          );
        } else {
          // Use absolute positioning for precise pixel placement
          (node as FrameNode).layoutMode = "NONE";
          this.safeSetPluginData(node, "layoutMode", "ABSOLUTE");
        }
      }

      if (data.layoutContext) {
        this.safeSetPluginData(
          node,
          "cssLayoutContext",
          JSON.stringify(data.layoutContext),
        );

        if (
          data.layoutContext.transform &&
          data.layoutContext.transform !== "none"
        ) {
          this.safeSetPluginData(
            node,
            "cssTransform",
            data.layoutContext.transform,
          );
        }

        if (data.layoutContext.position) {
          this.safeSetPluginData(
            node,
            "cssPosition",
            data.layoutContext.position,
          );
        }

        if (data.autoLayout && (data.autoLayout as any).flexAnalysis) {
          this.safeSetPluginData(
            node,
            "flexAnalysis",
            JSON.stringify((data.autoLayout as any).flexAnalysis),
          );
        }
      }

      if (
        "layoutGrow" in node &&
        typeof data.autoLayout?.layoutGrow === "number"
      ) {
        try {
          (node as any).layoutGrow = data.autoLayout.layoutGrow;
        } catch (e) {
          // Silent fail
        }
        this.safeSetPluginData(
          node,
          "cssLayoutGrow",
          data.autoLayout.layoutGrow.toString(),
        );
      }
      if ("layoutAlign" in node && data.autoLayout?.layoutAlign) {
        try {
          (node as any).layoutAlign = data.autoLayout.layoutAlign;
        } catch (e) {
          // Silent fail
        }
        this.safeSetPluginData(
          node,
          "cssLayoutAlign",
          data.autoLayout.layoutAlign,
        );
      }

      if (data.layout) {
        try {
          this.applyResponsiveConstraints(node, data.layout);
        } catch (respErr) {
          console.error(
            `❌ [applyPositioning] applyResponsiveConstraints failed for ${data.name}`,
            respErr,
          );
        }
      }
    } catch (outerErr) {
      // ENHANCED: Log full error context to identify "not a function" source
      const errMsg =
        outerErr instanceof Error ? outerErr.message : String(outerErr);
      console.error(
        `❌ [applyPositioning] OUTER CATCH for ${
          data?.name || "unknown"
        }: ${errMsg}`,
        outerErr,
      );
      // Don't rethrow - let safeExec handle the error logging
      throw outerErr;
    }
  }

  private applyResponsiveConstraints(node: SceneNode, layout: any) {
    if (!("minWidth" in node)) return;

    const frameNode = node as FrameNode;
    const supportsMinMaxConstraints =
      this.nodeSupportsMinMaxConstraints(frameNode);

    if (typeof layout.minWidth === "number" && layout.minWidth > 0) {
      this.safeSetPluginData(node, "cssMinWidth", layout.minWidth.toString());

      if (supportsMinMaxConstraints) {
        try {
          frameNode.minWidth = layout.minWidth;
        } catch (error) {
          console.warn(
            `Cannot set minWidth on node "${frameNode.name}":`,
            error,
          );
        }
      }
    }

    if (typeof layout.maxWidth === "number" && layout.maxWidth > 0) {
      this.safeSetPluginData(node, "cssMaxWidth", layout.maxWidth.toString());

      if (supportsMinMaxConstraints) {
        try {
          frameNode.maxWidth = layout.maxWidth;
        } catch (error) {
          console.warn(
            `Cannot set maxWidth on node "${frameNode.name}":`,
            error,
          );
        }
      }
    }

    if (typeof layout.minHeight === "number" && layout.minHeight > 0) {
      this.safeSetPluginData(node, "cssMinHeight", layout.minHeight.toString());

      if (supportsMinMaxConstraints) {
        try {
          frameNode.minHeight = layout.minHeight;
        } catch (error) {
          console.warn(
            `Cannot set minHeight on node "${frameNode.name}":`,
            error,
          );
        }
      }
    }

    if (typeof layout.maxHeight === "number" && layout.maxHeight > 0) {
      this.safeSetPluginData(node, "cssMaxHeight", layout.maxHeight.toString());

      if (supportsMinMaxConstraints) {
        try {
          frameNode.maxHeight = layout.maxHeight;
        } catch (error) {
          console.warn(
            `Cannot set maxHeight on node "${frameNode.name}":`,
            error,
          );
        }
      }
    }
  }

  private nodeSupportsMinMaxConstraints(node: FrameNode): boolean {
    if ("layoutMode" in node && node.layoutMode !== "NONE") {
      return true;
    }

    if (node.parent && "layoutMode" in node.parent) {
      const parentFrame = node.parent as FrameNode;
      return parentFrame.layoutMode !== "NONE";
    }

    return false;
  }

  private applyAutoLayout(node: FrameNode, layout: any) {
    try {
      // PIXEL-PERFECT VALIDATION: Only apply if validation.safe === true
      if (layout.validation && layout.validation.safe === false) {
        console.log(
          `❌ [AUTO_LAYOUT] Skipping Auto Layout for ${
            node.name
          }: Failed validation (${layout.validation.maxChildDeltaPx.toFixed(
            2,
          )}px > ${layout.validation.tolerancePx}px tolerance)`,
        );
        console.log(
          `   Rejection reasons: ${layout.validation.reasons.join(", ")}`,
        );

        // Keep absolute positioning
        node.layoutMode = "NONE";
        this.safeSetPluginData(
          node,
          "autoLayoutRejected",
          JSON.stringify({
            reasons: layout.validation.reasons,
            maxChildDeltaPx: layout.validation.maxChildDeltaPx,
            tolerancePx: layout.validation.tolerancePx,
          }),
        );
        return;
      }

      // Validate required fields for new schema format
      if (
        !layout.mode ||
        !layout.padding ||
        typeof layout.itemSpacing !== "number"
      ) {
        console.warn(
          `⚠️ [AUTO_LAYOUT] Invalid layout schema for ${node.name}, falling back to absolute`,
        );
        node.layoutMode = "NONE";
        return;
      }

      // Apply validated Auto Layout configuration
      node.layoutMode = layout.mode; // 'HORIZONTAL' | 'VERTICAL'

      // Map schema alignItems/justifyContent to Figma properties
      node.primaryAxisAlignItems = this.mapSchemaAlignmentToPrimary(
        layout.justifyContent,
      );
      node.counterAxisAlignItems = this.mapSchemaAlignmentToCounter(
        layout.alignItems,
      );
      node.itemSpacing = layout.itemSpacing;

      // Apply padding from schema format
      node.paddingTop = layout.padding.top;
      node.paddingRight = layout.padding.right;
      node.paddingBottom = layout.padding.bottom;
      node.paddingLeft = layout.padding.left;

      // Apply sizing modes
      if (layout.primaryAxisSizingMode) {
        node.primaryAxisSizingMode = layout.primaryAxisSizingMode;
      } else {
        node.primaryAxisSizingMode = "AUTO"; // Default
      }

      if (layout.counterAxisSizingMode) {
        node.counterAxisSizingMode = layout.counterAxisSizingMode;
      } else {
        node.counterAxisSizingMode = "AUTO"; // Default
      }

      // Apply wrap setting
      node.layoutWrap = layout.wrap ? "WRAP" : "NO_WRAP";

      // PROFESSIONAL: Apply strokesIncludedInLayout for professional border-box behavior
      if (layout.strokesIncludedInLayout !== undefined) {
        node.strokesIncludedInLayout = layout.strokesIncludedInLayout;
        console.log(
          `📍 [PROFESSIONAL LAYOUT] Applied strokesIncludedInLayout: ${layout.strokesIncludedInLayout}`,
        );
      } else if (
        typeof node.strokeWeight === "number" &&
        node.strokeWeight > 0
      ) {
        // Auto-detect: include strokes if element has visible borders
        node.strokesIncludedInLayout = true;
        console.log(
          `📍 [PROFESSIONAL LAYOUT] Auto-detected strokesIncludedInLayout: true (stroke weight: ${node.strokeWeight})`,
        );
      } else {
        node.strokesIncludedInLayout = false;
      }

      // Store validation metrics for debugging
      this.safeSetPluginData(
        node,
        "autoLayoutValidation",
        JSON.stringify({
          safe: layout.validation?.safe || false,
          maxChildDeltaPx: layout.validation?.maxChildDeltaPx || 0,
          avgChildDeltaPx: layout.validation?.avgChildDeltaPx || 0,
          tolerancePx: layout.validation?.tolerancePx || 1.0,
          evidence: layout.evidence,
        }),
      );

      console.log(
        `✅ [AUTO_LAYOUT] Applied validated Auto Layout to ${node.name}: ${
          layout.mode
        } (delta: ${(layout.validation?.maxChildDeltaPx || 0).toFixed(2)}px)`,
      );
    } catch (error) {
      console.warn(
        `❌ [AUTO_LAYOUT] Failed to apply Auto Layout to ${node.name}:`,
        error,
      );
      node.layoutMode = "NONE";
    }
  }

  /**
   * Map schema alignment format to Figma primary axis alignment values
   */
  private mapSchemaAlignmentToPrimary(
    alignment: "MIN" | "CENTER" | "MAX" | "BASELINE" | "SPACE_BETWEEN",
  ): "MIN" | "CENTER" | "MAX" | "SPACE_BETWEEN" {
    switch (alignment) {
      case "MIN":
        return "MIN";
      case "CENTER":
        return "CENTER";
      case "MAX":
        return "MAX";
      case "SPACE_BETWEEN":
        return "SPACE_BETWEEN";
      case "BASELINE":
        // Primary axis doesn't support baseline, fallback to MIN
        console.warn(
          "[AUTO_LAYOUT] Baseline alignment not supported on primary axis, using MIN",
        );
        return "MIN";
      default:
        return "MIN";
    }
  }

  /**
   * Map schema alignment format to Figma counter axis alignment values
   */
  private mapSchemaAlignmentToCounter(
    alignment: "MIN" | "CENTER" | "MAX" | "BASELINE" | "SPACE_BETWEEN",
  ): "MIN" | "CENTER" | "MAX" | "BASELINE" {
    switch (alignment) {
      case "MIN":
        return "MIN";
      case "CENTER":
        return "CENTER";
      case "MAX":
        return "MAX";
      case "BASELINE":
        return "BASELINE";
      case "SPACE_BETWEEN":
        // Counter axis doesn't support space-between, fallback to MIN
        console.warn(
          "[AUTO_LAYOUT] Space-between alignment not supported on counter axis, using MIN",
        );
        return "MIN";
      default:
        return "MIN";
    }
  }

  private async applyCommonStyles(node: SceneNode, data: any): Promise<void> {
    // CRITICAL DEBUG: Log all color-related data for diagnosis
    const backgroundColorSources = {
      style: data.style?.backgroundColor,
      direct: data.backgroundColor,
      fillColor: data.fillColor,
      cssVariables: data.cssVariables
        ? Object.keys(data.cssVariables).length
        : 0,
    };

    console.log(`🎨 Applying common styles to ${data.name}:`, {
      hasBackgrounds: !!data.backgrounds?.length,
      backgroundsCount: data.backgrounds?.length || 0,
      hasFills: !!data.fills?.length,
      fillsCount: data.fills?.length || 0,
      fillsPreview: data.fills
        ?.slice(0, 2)
        .map((f: any) => ({ type: f.type, color: f.color })),
      hasImageHash: !!data.imageHash,
      nodeType: node.type,
      canHaveFills: "fills" in node,
      backgroundColorSources,
    });

    if ("fills" in node) {
      // If this node was created from inline SVG markup, preserve whatever paints came from the SVG.
      // The SVG content is the source of truth for logo/icon colors; applying schema-derived fills here
      // can incorrectly paint over the vector (e.g. turning a logo into a solid block).
      const preserveSvgFills =
        data?.type === "VECTOR" &&
        typeof data?.svgContent === "string" &&
        data.svgContent.trim().length > 0;
      if (preserveSvgFills) {
        console.log(
          `  🧩 [SVG] Preserving fills from svgContent for ${data.name}, skipping fill/background processing`,
        );
      } else {
        const paints: Paint[] = [];

        // CRITICAL FIX: Check if this is body/html - only skip if schema EXPLICITLY says no fills
        // The schema is the source of truth - if it has fills, apply them even for body/html
        // ENHANCED: Also check for header/nav elements - they should NOT be skipped for fills
        const isBodyOrHtml = data.htmlTag === "body" || data.htmlTag === "html";
        const isHeaderOrNav =
          data.htmlTag === "header" ||
          data.htmlTag === "nav" ||
          (data.name && /header|nav/i.test(data.name)) ||
          (data.cssClasses &&
            data.cssClasses.some((cls: string) => /header|nav/i.test(cls)));
        const schemaExplicitlyNoFills =
          Array.isArray(data.fills) && data.fills.length === 0;
        const hasFillsInSchema = data.fills && data.fills.length > 0;
        const hasBackgroundsInSchema =
          data.backgrounds && data.backgrounds.length > 0;
        const hasImageHash = !!data.imageHash;
        // CRITICAL FIX: Include computed background colors as valid fill source
        const hasComputedBackgroundColor = !!(
          data.computedStyle?.backgroundColor &&
          data.computedStyle.backgroundColor !== "transparent" &&
          data.computedStyle.backgroundColor !== "rgba(0, 0, 0, 0)" &&
          data.computedStyle.backgroundColor !== "rgba(0,0,0,0)"
        );
        const hasStyleBackgroundColor = !!(
          data.style?.backgroundColor ||
          data.backgroundColor ||
          data.fillColor
        );
        const hasAnyFillData =
          hasFillsInSchema ||
          hasBackgroundsInSchema ||
          hasImageHash ||
          hasComputedBackgroundColor ||
          hasStyleBackgroundColor;

        // CRITICAL FIX: Headers/nav should NEVER skip fill processing
        // Only skip fill processing if BOTH conditions are true:
        // 1. Element is actually body/html (NOT header/nav) AND not a TEXT node
        // 2. Schema explicitly has empty fills array (not just missing/undefined)
        // AND no other fill sources exist (backgrounds, imageHash, computedStyle, etc.)
        // IMPORTANT: TEXT nodes should NEVER be skipped regardless of htmlTag
        if (
          !isHeaderOrNav &&
          isBodyOrHtml &&
          data.type !== "TEXT" &&
          schemaExplicitlyNoFills &&
          !hasAnyFillData
        ) {
          console.log(
            `  ⚪ [BODY/HTML] Schema explicitly says no fills for ${data.name}, skipping fill processing`,
            {
              isBodyOrHtml,
              schemaExplicitlyNoFills,
              hasFillsInSchema,
              hasBackgroundsInSchema,
              hasImageHash,
              hasComputedBackgroundColor,
              hasStyleBackgroundColor,
              computedBg: data.computedStyle?.backgroundColor,
              styleBg: data.style?.backgroundColor,
            },
          );
          (node as SceneNodeWithGeometry).fills = [];
          // Skip to the rest of the function (strokes, effects, etc.) - don't process fills
        } else {
          // ENHANCED: Log why we're processing fills (especially important for body/html elements)
          if (isHeaderOrNav) {
            console.log(
              `  🎨 [HEADER/NAV] Processing fills for ${data.name} (tag: ${data.htmlTag})`,
            );
          } else if (isBodyOrHtml) {
            console.log(
              `  🎨 [BODY/HTML] Processing fills for ${data.name} - has fill data:`,
              {
                hasFillsInSchema,
                hasBackgroundsInSchema,
                hasImageHash,
                hasComputedBackgroundColor,
                hasStyleBackgroundColor,
                computedBg: data.computedStyle?.backgroundColor,
                styleBg: data.style?.backgroundColor,
                reason: !schemaExplicitlyNoFills
                  ? "schema has fills"
                  : "has other fill sources",
              },
            );
          }
          // Process fills normally - even for body/html if schema has fills
          // ENHANCED: Check computed styles FIRST as they're most reliable (early fallback)
          let earlyFallbackColor: RGBA | null = null;
          if (data.computedStyle?.backgroundColor) {
            earlyFallbackColor = this.parseColorString(
              data.computedStyle.backgroundColor,
            );
            if (earlyFallbackColor && earlyFallbackColor.a > 0) {
              console.log(
                `  🎨 [EARLY FALLBACK] Found computed backgroundColor for ${data.name}:`,
                earlyFallbackColor,
              );
            } else if (earlyFallbackColor && earlyFallbackColor.a === 0) {
              console.log(
                `  🎨 [EARLY FALLBACK] Computed backgroundColor is transparent for ${data.name}, will try other sources`,
              );
              earlyFallbackColor = null; // Reset to try other sources
            }
          }

          const hasDetailedBackgrounds = (data.backgrounds?.length || 0) > 0;

          // CRITICAL FIX: Check if computed background is transparent but fills are inherited
          // If so, skip inherited fills to prevent opaque overlays covering content
          const computedBgStr = data.computedStyle?.backgroundColor || "";
          // More robust transparent detection - check for rgba(0,0,0,0) variations and transparent
          const computedBgIsTransparent =
            computedBgStr === "rgba(0, 0, 0, 0)" ||
            computedBgStr === "rgba(0,0,0,0)" ||
            computedBgStr === "transparent" ||
            computedBgStr.trim() === "rgba(0, 0, 0, 0)" ||
            computedBgStr.trim() === "rgba(0,0,0,0)" ||
            computedBgStr.toLowerCase().includes("rgba(0,0,0,0)") ||
            computedBgStr.toLowerCase() === "transparent";
          // Check if fills are inherited - also check if fills exist but computed bg is transparent
          const fillsAreInherited =
            data.colorInheritance?.backgroundColorSource === "inherited" ||
            (computedBgIsTransparent &&
              data.fills?.length > 0 &&
              data.colorInheritance?.backgroundColorSource !== "explicit");

          // Enhanced logging for debugging
          console.log(`🔍 [FILL DEBUG] ${data.name} (${data.id}):`, {
            computedBg: computedBgStr,
            computedBgIsTransparent,
            inheritanceSource: data.colorInheritance?.backgroundColorSource,
            fillsAreInherited,
            fillCount: data.fills?.length || 0,
            hasBackgrounds: hasDetailedBackgrounds,
          });

          // removed agent log block

          // 1. Process regular fills (solid colors, gradients, images)
          // PIXEL-PERFECT FIX: Process ALL fills from schema, don't skip inherited
          // If fills array is empty, synthesize from computedStyle
          if (data.fills?.length) {
            // Process fills even if inherited - visual fidelity requires all paints
            console.log(
              `  ✅ Processing ${data.fills.length} fills for ${data.name} ` +
                `(inherited: ${fillsAreInherited}, computedBg: ${computedBgStr})`,
            );
            console.log(
              `  ✅ Processing ${data.fills.length} fills for ${data.name}`,
            );
            const fillPaints = await this.convertFillsAsync(
              data.fills,
              data.layout,
            );

            // removed agent log block

            // DEBUG: Log conversion results
            console.log(
              `  🎨 [FILL DEBUG] convertFillsAsync for ${data.name}:`,
              {
                schemaFillsCount: data.fills.length,
                convertedPaintsCount: fillPaints.length,
                schemaFills: data.fills.map((f) => ({
                  type: f.type,
                  opacity: f.opacity,
                  colorA: f.color?.a,
                })),
                convertedPaints: fillPaints.map((p) => ({
                  type: p.type,
                  opacity: p.opacity,
                  visible: p.visible,
                })),
              },
            );

            // BUGFIX: Only filter IMAGE fills if we actually have background layers AND they contain images.
            // If backgrounds array exists but is empty or has no images, keep IMAGE fills from fills array.
            const hasImageBackgrounds =
              hasDetailedBackgrounds &&
              data.backgrounds.some(
                (bg: any) =>
                  bg?.type === "IMAGE" ||
                  bg?.fill?.type === "IMAGE" ||
                  bg?.imageHash,
              );

            // If we have detailed image backgrounds, prefer those over generic IMAGE fills in `fills`.
            // Otherwise, keep all fills (including IMAGE fills).
            const filteredFills = fillPaints.filter(
              (p) => !hasImageBackgrounds || p.type !== "IMAGE",
            );
            paints.push(...filteredFills);

            // CRITICAL FIX: If fills were in schema but convertFillsAsync returned nothing,
            // try fallback immediately (don't wait for all other checks to fail)
            if (fillPaints.length === 0 && data.fills.length > 0) {
              console.warn(
                `  ⚠️ [FILL] ${data.fills.length} fills in schema but convertFillsAsync returned 0 paints for ${data.name}`,
              );

              // CRITICAL FIX: Try to manually convert fills if async conversion failed
              // This handles cases where convertFillsAsync silently fails
              for (const fill of data.fills) {
                try {
                  if (fill.type === "SOLID" && fill.color) {
                    // BUGFIX: fill.color is already an object {r,g,b}, not a string to parse
                    let color = null;

                    if (
                      typeof fill.color === "object" &&
                      fill.color.r !== undefined
                    ) {
                      // Color is already in {r,g,b} format
                      color = {
                        r: Math.max(0, Math.min(1, fill.color.r)),
                        g: Math.max(0, Math.min(1, fill.color.g)),
                        b: Math.max(0, Math.min(1, fill.color.b)),
                      };
                    } else if (typeof fill.color === "string") {
                      // Color is a string, parse it
                      color = this.parseColorString(fill.color);
                    }

                    if (color) {
                      const opacity =
                        fill.opacity !== undefined
                          ? fill.opacity
                          : color.a !== undefined
                            ? color.a
                            : 1;
                      paints.push(
                        figma.util.solidPaint(
                          { r: color.r, g: color.g, b: color.b },
                          {
                            opacity: opacity,
                            visible: fill.visible !== false,
                          },
                        ),
                      );
                      console.log(
                        `  ✅ [FILL FIX] Manually converted SOLID fill for ${data.name}`,
                      );
                      continue;
                    }
                  }

                  // Try fallback color extraction from multiple sources
                  let fallbackColor: RGBA | undefined =
                    this.parseColorString(data.style?.backgroundColor) ||
                    this.parseColorString(data.backgroundColor) ||
                    this.parseColorString(data.fillColor);

                  if (
                    (!fallbackColor || fallbackColor.a === 0) &&
                    data.computedStyle?.backgroundColor
                  ) {
                    fallbackColor = this.parseColorString(
                      data.computedStyle.backgroundColor,
                    );
                  }

                  // If still no color (transparent), try getPlaceholderColor
                  if (!fallbackColor || fallbackColor.a === 0) {
                    const placeholderColor = this.getPlaceholderColor(data);
                    // Only use placeholder if it's not the default grey (meaning it found an actual color)
                    const isDefaultGrey =
                      Math.abs(placeholderColor.r - 0.92) < 0.01 &&
                      Math.abs(placeholderColor.g - 0.92) < 0.01 &&
                      Math.abs(placeholderColor.b - 0.92) < 0.01 &&
                      Math.abs((placeholderColor.a || 1) - 1) < 0.01;
                    if (!isDefaultGrey) {
                      fallbackColor = placeholderColor;
                    }
                  }

                  if (
                    fallbackColor &&
                    (fallbackColor.a === undefined || fallbackColor.a > 0)
                  ) {
                    paints.push(
                      figma.util.solidPaint(
                        {
                          r: fallbackColor.r,
                          g: fallbackColor.g,
                          b: fallbackColor.b,
                        },
                        {
                          opacity:
                            fallbackColor.a !== undefined ? fallbackColor.a : 1,
                          visible: true,
                        },
                      ),
                    );
                    console.log(
                      `  🎨 [FILL FIX] Using backgroundColor fallback for ${data.name}:`,
                      { color: fallbackColor },
                    );
                    continue;
                  }
                } catch (fillErr) {
                  console.warn(
                    `  ⚠️ [FILL] Error processing fill ${fill.type}:`,
                    fillErr,
                  );
                }
              }

              if (paints.length === 0) {
                console.warn(
                  `  ⚠️ [FILL] No fallback color found for ${data.name} after convertFillsAsync failed`,
                );
              }
            } // End if fillPaints.length === 0 fallback check
          } else if (data.fills?.length === 0) {
            // PIXEL-PERFECT FIX: Synthesize fills from computedStyle when schema has empty array
            console.log(
              `  🔧 [SYNTHESIS] Empty fills array for ${data.name}, attempting synthesis`,
            );

            // Try computedStyle.backgroundColor first (most reliable)
            if (data.computedStyle?.backgroundColor) {
              const color = this.parseColorString(
                data.computedStyle.backgroundColor,
              );
              if (color && color.a > 0.01) {
                console.log(
                  `  ✓ [SYNTHESIS] Created fill from computedStyle for ${data.name}:`,
                  color,
                );
                paints.push({
                  type: "SOLID",
                  color: { r: color.r, g: color.g, b: color.b },
                  opacity: color.a,
                  visible: true,
                });
              }
            }

            // Fallback to style.backgroundColor
            if (paints.length === 0 && data.style?.backgroundColor) {
              const color = this.parseColorString(data.style.backgroundColor);
              if (color && color.a > 0.01) {
                console.log(
                  `  ✓ [SYNTHESIS] Created fill from style.backgroundColor for ${data.name}:`,
                  color,
                );
                paints.push({
                  type: "SOLID",
                  color: { r: color.r, g: color.g, b: color.b },
                  opacity: color.a,
                  visible: true,
                });
              }
            }
          }

          // 2. Process detailed background layers (usually images with specific positioning)
          // CRITICAL FIX: Do NOT skip inherited backgrounds
          // If the extractor captured backgrounds (images, gradients), they should be rendered.
          const shouldSkipBackgrounds = false;

          if (hasDetailedBackgrounds && !shouldSkipBackgrounds) {
            console.log(
              `  ✅ Processing ${data.backgrounds.length} detailed background layers`,
            );
            const bgPaints = await this.convertBackgroundLayersAsync(
              data.backgrounds,
              data.layout,
            );
            paints.push(...bgPaints);
          } else if (
            hasDetailedBackgrounds &&
            computedBgIsTransparent &&
            fillsAreInherited
          ) {
            console.log(
              `  ⚪ [FILL] Skipping ${data.backgrounds.length} inherited background layers for ${data.name} (computed background is transparent)`,
            );
          }

          // 3. Handle primary image content (e.g. <img> src), effectively a top-layer "fill"
          if (data.imageHash) {
            console.log(`  🖼️ Processing primary image hash for ${data.name}`);
            const imageFill = {
              type: "IMAGE" as const,
              imageHash: data.imageHash,
              scaleMode: (data.objectFit
                ? this.mapObjectFitToScaleMode(data.objectFit)
                : "FILL") as "FILL" | "FIT" | "CROP" | "TILE",
              visible: true,
            };

            paints.push(await this.resolveImagePaint(imageFill, data.layout));
          }

          // 3.5. CRITICAL FIX: If we have an early fallback color but no paints yet, apply it immediately
          // This ensures computed background colors are never lost even when schema has no fills
          if (
            paints.length === 0 &&
            earlyFallbackColor &&
            earlyFallbackColor.a > 0
          ) {
            console.log(
              `  🎨 [EARLY FALLBACK DIRECT] Applying computed backgroundColor immediately for ${data.name}:`,
              earlyFallbackColor,
            );
            paints.push(
              figma.util.solidPaint(
                {
                  r: earlyFallbackColor.r,
                  g: earlyFallbackColor.g,
                  b: earlyFallbackColor.b,
                },
                {
                  opacity: earlyFallbackColor.a,
                  visible: true,
                },
              ),
            );
          }

          // 4. Fallback: If still no paints, try to derive a solid color fill
          // CRITICAL FIX: Do NOT promote descendant images to parent backgrounds
          // Images should only be used when explicitly set as background-image in CSS
          // Promoting descendant images causes incorrect backgrounds (e.g., <img> tags becoming page backgrounds)
          // CRITICAL FIX: Do NOT apply inherited colors if computed background is transparent
          if (paints.length === 0) {
            // CRITICAL FIX: ALWAYS try to derive a solid fill from CSS backgroundColor
            // This is the most important fallback - many nodes rely on this
            // ENHANCED: Use early fallback color if available (computed styles are most reliable)
            // Otherwise check all other sources in order of preference
            let parsedColor = earlyFallbackColor;

            // If early fallback didn't work, try all other sources in order of preference
            if (!parsedColor) {
              // NEW: Check for inherited color information first
              // CRITICAL FIX: Do NOT skip inherited colors even if computed background is transparent
              // The whole point of inheritance tracking is to paint the parent's color when the child is transparent
              // but visually needs to block what's behind it (or just appear colored).
              const shouldSkipInheritedFallback = false;
              if (
                data.colorInheritance?.backgroundColorSource === "inherited" &&
                !shouldSkipInheritedFallback
              ) {
                console.log(
                  `  🔗 [INHERITANCE] Node ${data.name} has inherited background color`,
                );
                // For inherited colors, the effective color should already be in fills array
                // But if not, check colorInheritance data
                if (data.colorInheritance.effectiveColor) {
                  parsedColor = this.parseColorString(
                    data.colorInheritance.effectiveColor,
                  );
                  console.log(
                    `  ✅ [INHERITANCE] Using effective inherited color: ${data.colorInheritance.effectiveColor}`,
                  );
                }
              } else if (shouldSkipInheritedFallback) {
                console.log(
                  `  ⚪ [FILL] Skipping inherited color fallback for ${data.name} (computed background is transparent)`,
                );
              }

              if (!parsedColor) {
                parsedColor =
                  (data.computedStyle?.backgroundColor
                    ? this.parseColorString(data.computedStyle.backgroundColor)
                    : null) ||
                  this.parseColorString(data.style?.backgroundColor) ||
                  this.parseColorString(data.backgroundColor) ||
                  this.parseColorString(data.fillColor);
              }
            }

            // If no explicit background color found, only fall back to heuristic placeholder colors
            // when the element is not border-only. Border-only nodes must remain transparent.
            if (!parsedColor) {
              const hasStroke =
                (Array.isArray(data.strokes) && data.strokes.length > 0) ||
                (typeof data.strokeWeight === "number" &&
                  data.strokeWeight > 0);

              if (hasStroke) {
                console.log(
                  `  🛑 [FILL] Skipping placeholder-derived fill for border-only node ${data.name}`,
                );
              } else {
                // NEW: Try schema-based parent color detection before using placeholder
                // Note: For now, we'll implement a basic parent check without full schema traversal
                // CRITICAL FIX: Skip inherited colors if computed background is transparent
                const shouldSkipParentColor =
                  computedBgIsTransparent &&
                  (fillsAreInherited ||
                    data.colorInheritance?.backgroundColorSource !==
                      "explicit");

                const inheritedColor = !shouldSkipParentColor
                  ? this.getBasicParentColor(data)
                  : undefined;
                if (inheritedColor) {
                  parsedColor = inheritedColor;
                  console.log(
                    `  🔗 [SCHEMA-INHERITANCE] Using parent color for ${data.name}:`,
                    inheritedColor,
                  );
                } else if (shouldSkipParentColor) {
                  console.log(
                    `  ⚪ [FILL] Skipping parent color fallback for ${data.name} (computed background is transparent)`,
                  );
                } else {
                  const placeholderColor = this.getPlaceholderColor(data);
                  const isDefaultGrey =
                    Math.abs(placeholderColor.r - 0.92) < 0.01 &&
                    Math.abs(placeholderColor.g - 0.92) < 0.01 &&
                    Math.abs(placeholderColor.b - 0.92) < 0.01;

                  // Only use placeholder if it's not the default grey (meaning it found an actual color)
                  if (!isDefaultGrey) {
                    parsedColor = placeholderColor;
                    console.log(
                      `  🎨 Using placeholder color for ${data.name} (extracted from CSS variables/data)`,
                    );
                  }
                }
              }
            }

            if (parsedColor) {
              console.log(
                `  🎨 Derived solid fill for ${data.name} from backgroundColor (fallback):`,
                {
                  source: data.style?.backgroundColor
                    ? "style.backgroundColor"
                    : data.backgroundColor
                      ? "backgroundColor"
                      : data.fillColor
                        ? "fillColor"
                        : "placeholder/getPlaceholderColor",
                  color: parsedColor,
                },
              );
              paints.push(
                figma.util.solidPaint(
                  { r: parsedColor.r, g: parsedColor.g, b: parsedColor.b },
                  {
                    opacity: parsedColor.a !== undefined ? parsedColor.a : 1,
                    visible: true,
                  },
                ),
              );
            } else {
              // PIXEL-PERFECT FIX: Add visible placeholder when fill is expected but missing
              // This makes fill failures obvious for debugging rather than silently transparent
              // Only add placeholder for elements that appear to need fills (non-tiny elements)
              const hasMinimumSize =
                (data.layout?.width || 0) > 5 && (data.layout?.height || 0) > 5;
              const isLikelyContainer =
                data.htmlTag === "div" ||
                data.htmlTag === "section" ||
                data.htmlTag === "article" ||
                data.htmlTag === "header" ||
                data.htmlTag === "nav" ||
                data.htmlTag === "footer" ||
                data.htmlTag === "main" ||
                data.htmlTag === "aside";
              const hasExplicitTransparent =
                data.computedStyle?.backgroundColor === "rgba(0, 0, 0, 0)" ||
                data.computedStyle?.backgroundColor === "transparent";

              if (
                hasMinimumSize &&
                isLikelyContainer &&
                !hasExplicitTransparent
              ) {
                // Production mode: log once but don't affect visuals
                console.log(
                  `  ⚪ [FILL] No fill found for ${data.name} - element stays transparent`,
                );
              } else {
                // For elements that don't need fills (small, explicitly transparent), just log
                console.log(
                  `  ⚪ [FILL] Skipping fill for ${data.name} (transparent/small/not container)`,
                  {
                    hasMinimumSize,
                    isLikelyContainer,
                    hasExplicitTransparent,
                    htmlTag: data.htmlTag,
                  },
                );
              }
            }
          }

          // Final assignment (only for non-body/html nodes)
          // CRITICAL FIX: Always apply fills if we have any paints, even if empty array
          if (paints.length > 0) {
            // CSS background-color paints underneath background-image/gradients.
            // Ensure SOLID fills don't accidentally cover IMAGE/GRADIENT paints.
            const hasSolid = paints.some((p) => p.type === "SOLID");
            const hasNonSolid = paints.some((p) => p.type !== "SOLID");
            const orderedPaints: Paint[] =
              hasSolid && hasNonSolid
                ? [
                    ...paints.filter((p) => p.type === "SOLID"),
                    ...paints.filter((p) => p.type !== "SOLID"),
                  ]
                : paints;

            // CRITICAL FIX: Validate paints before assignment
            let validPaints = orderedPaints.filter((p) => {
              if (!p || typeof p !== "object") return false;
              if (p.type === "SOLID") {
                const solid = p as SolidPaint;
                return (
                  solid.color &&
                  typeof solid.color.r === "number" &&
                  typeof solid.color.g === "number" &&
                  typeof solid.color.b === "number"
                );
              }
              return true; // Other paint types validated elsewhere
            });

            if (validPaints.length > 0) {
              // ENHANCED: Apply background blend mode to fills
              if (
                data.backgroundBlendMode &&
                data.backgroundBlendMode !== "NORMAL"
              ) {
                // Use map to create new objects to avoid read-only property error
                validPaints = validPaints.map((paint) => ({
                  ...paint,
                  blendMode: data.backgroundBlendMode,
                }));
                console.log(
                  `  🎨 Applied backgroundBlendMode ${data.backgroundBlendMode} to ${validPaints.length} fills`,
                );
              }

              // removed agent log block
              // PROACTIVE CRASH PREVENTION: Wrap assignment in try-catch
              try {
                (node as SceneNodeWithGeometry).fills = validPaints;
              } catch (e) {
                console.error(
                  `❌ [ACCESSIBILITY] SAFETY: Failed to set fills for ${data.name}. This is likely due to invalid paint data escaping validation.`,
                  e,
                );
                // Fallback to a safe known good fill (transparent or black) to prevent visual artifacts
                try {
                  (node as SceneNodeWithGeometry).fills = [
                    {
                      type: "SOLID",
                      color: { r: 0, g: 0, b: 0 },
                      opacity: 0,
                      visible: true,
                    },
                  ]; // Safe fallback
                } catch (fallbackError) {
                  console.error(
                    "  ❌ Even fallback fill failed - node might not support fills",
                    fallbackError,
                  );
                }
              }
              // removed agent log block
              console.log(
                `  ✅ Applied ${validPaints.length} fill(s) to ${data.name} (computedBgTransparent: ${computedBgIsTransparent}, fillsInherited: ${fillsAreInherited}):`,
                validPaints.map((p) => ({
                  type: p.type,
                  color:
                    p.type === "SOLID" ? (p as SolidPaint).color : undefined,
                  opacity: p.opacity,
                })),
              );

              // CRITICAL DEBUG: Verify fills were actually set
              const verifyFills = (node as SceneNodeWithGeometry).fills;
              if (
                verifyFills !== figma.mixed &&
                (!verifyFills ||
                  (Array.isArray(verifyFills) && verifyFills.length === 0))
              ) {
                console.error(
                  `  ❌ [CRITICAL] Fills were set but node.fills is now empty for ${data.name}! Attempting recovery...`,
                );
                // Recovery: Try setting again
                try {
                  (node as SceneNodeWithGeometry).fills = validPaints;
                  const recheck = (node as SceneNodeWithGeometry).fills;
                  if (Array.isArray(recheck) && recheck.length > 0) {
                    console.log(
                      `  ✅ [RECOVERY] Successfully recovered fills for ${data.name}`,
                    );
                  } else {
                    console.error(
                      `  ❌ [RECOVERY FAILED] Could not set fills for ${data.name}`,
                    );
                  }
                } catch (recoveryErr) {
                  console.error(`  ❌ [RECOVERY ERROR] ${recoveryErr}`);
                }
              }
            } else {
              console.warn(
                `  ⚠️ [FILL] All ${orderedPaints.length} paints were invalid for ${data.name}, no fills applied`,
              );
            }
          } else {
            // CRITICAL FIX: Check if we should have had fills but didn't get any
            const hadFillsInSchema = data.fills && data.fills.length > 0;
            const hadBackgrounds =
              data.backgrounds && data.backgrounds.length > 0;
            const hadImageHash = !!data.imageHash;

            if (hadFillsInSchema || hadBackgrounds || hadImageHash) {
              console.warn(
                `  ⚠️ [FILL WARNING] ${data.name} had fills/backgrounds in schema but none were applied:`,
                {
                  fillsCount: data.fills?.length || 0,
                  backgroundsCount: data.backgrounds?.length || 0,
                  hasImageHash: !!data.imageHash,
                  backgroundColor:
                    data.style?.backgroundColor || data.backgroundColor,
                },
              );
            } else {
              console.log(
                `  ⚪ No fills/backgrounds produced for ${data.name}, setting transparent`,
              );
            }
            // Don't wipe an already-resolved image fill if the schema didn't emit paints here.
            const existingFills =
              "fills" in node ? (node as SceneNodeWithGeometry).fills : [];
            const hasExistingImageFill =
              Array.isArray(existingFills) &&
              existingFills.some((f: any) => f?.type === "IMAGE");
            if (
              hasExistingImageFill &&
              (data?.type === "IMAGE" ||
                Boolean(data?.imageHash) ||
                (Array.isArray(data?.fills) &&
                  data.fills.some((f: any) => f?.type === "IMAGE")))
            ) {
              console.warn(
                `  ⚠️ [FILL] Preserving existing IMAGE fill(s) for ${data.name} despite empty paint result`,
              );
            } else {
              (node as SceneNodeWithGeometry).fills = [];
            }
          }
        }
      }
    }

    // ENHANCED: Apply mix-blend-mode (layer blend mode)
    if (data.mixBlendMode && "blendMode" in node) {
      if (data.mixBlendMode !== "NORMAL") {
        (node as any).blendMode = data.mixBlendMode;
        console.log(
          `  🎨 Applied mixBlendMode ${data.mixBlendMode} to ${data.name}`,
        );
      }
    }

    // ENHANCED: Handle clip-path (basic support/logging)
    if (data.clipPath) {
      console.log(
        `  ✂️ [CLIP-PATH] Node ${data.name} has clip-path: ${data.clipPath.type}('${data.clipPath.value}') - logging strictly`,
      );
      this.safeSetPluginData(node, "clipPath", JSON.stringify(data.clipPath));
    }

    // Apply placeholder for form controls if provided
    if (
      data.placeholder &&
      node.type === "TEXT" &&
      (data.htmlTag === "input" || data.name === "Input")
    ) {
      // For imports that create a TEXT node directly (rare), set characters + placeholder color
      (node as TextNode).characters = data.placeholder;
      const placeholderColor = this.getPlaceholderColor(data);
      (node as TextNode).fills = [
        figma.util.solidPaint(
          {
            r: placeholderColor.r,
            g: placeholderColor.g,
            b: placeholderColor.b,
          },
          {
            opacity:
              placeholderColor.a !== undefined ? placeholderColor.a : 0.6,
          },
        ),
      ];
    } else if (
      data.placeholder &&
      "placeholder" in node &&
      (data.htmlTag === "input" || data.name === "Input")
    ) {
      (node as any).placeholder = data.placeholder;
      const placeholderColor = this.getPlaceholderColor(data);
      this.safeSetPluginData(
        node,
        "placeholderColor",
        JSON.stringify(placeholderColor),
      );
    }

    if (data.strokes && "strokes" in node) {
      console.log(`  ✏️ Applying strokes to ${data.name}`);
      (node as SceneNodeWithGeometry).strokes = await this.convertStrokesAsync(
        data.strokes,
      );
    }

    if ("strokeWeight" in node && data.strokeWeight !== undefined) {
      // removed agent log block
      (node as any).strokeWeight = data.strokeWeight;
      // removed agent log block
    } else if ("strokeWeight" in node && data.strokes?.[0]?.thickness) {
      // removed agent log block
      (node as any).strokeWeight = data.strokes[0].thickness;
    }

    if ("strokeAlign" in node) {
      if (data.strokeAlign) {
        // removed agent log block
        (node as any).strokeAlign = data.strokeAlign;
      } else if (data.strokes?.[0]?.strokeAlign) {
        (node as any).strokeAlign = data.strokes[0].strokeAlign;
      }
    }

    if ("dashPattern" in node) {
      if (data.strokes?.[0]?.dashPattern) {
        (node as any).dashPattern = data.strokes[0].dashPattern;
      } else if (data.borderStyle) {
        const dashPatterns: Record<string, number[]> = {
          dashed: [10, 5],
          dotted: [2, 3],
          solid: [],
        };
        const pattern = dashPatterns[data.borderStyle] || [];
        if (pattern.length > 0) {
          (node as any).dashPattern = pattern;
        }
      }
    }

    // Prefer per-side CSS borders (more accurate than a single strokeWeight).
    this.applyBorderSidesIfPresent(node, data);

    if (this.designTokensManager && "fills" in node) {
      await this.bindVariablesToNode(node as any, data);
    }

    if (data.borderStyle) {
      this.safeSetPluginData(node, "borderStyle", data.borderStyle);
    }

    if (data.cornerRadius && "cornerRadius" in node) {
      console.log(
        `  🔲 Applying corner radius to ${data.name}:`,
        data.cornerRadius,
      );
      this.applyCornerRadius(node as any, data.cornerRadius);
    }

    // HIGH-FIDELITY: Corner Smoothing (iOS-style rounded corners)
    // Figma supports cornerSmoothing for premium rounded corner aesthetics
    if ("cornerSmoothing" in node) {
      if (data.cornerSmoothing !== undefined) {
        // Direct value from schema (0-1 range)
        (node as any).cornerSmoothing = Math.max(
          0,
          Math.min(1, data.cornerSmoothing),
        );
      } else if (
        data.cornerRadius &&
        typeof data.cornerRadius === "number" &&
        data.cornerRadius > 0
      ) {
        // Auto-detect: Apply subtle smoothing (0.6) for any rounded corners
        // This creates more natural-looking curves similar to iOS/macOS
        (node as any).cornerSmoothing = 0.6;
      }
    }

    const existingEffects =
      "effects" in node ? [...((node as BlendMixin).effects || [])] : [];
    if (data.effects?.length && "effects" in node) {
      console.log(
        `  ✨ Applying ${data.effects.length} effects to ${data.name}`,
      );
      const convertedEffects = this.convertEffects(data.effects);
      console.log(
        `  ✨ Converted effects:`,
        convertedEffects.map((e: any) => ({
          type: e.type,
          visible: e.visible,
        })),
      );
      existingEffects.push(...convertedEffects);
    }

    if (existingEffects.length && "effects" in node) {
      (node as BlendMixin).effects = existingEffects;
      console.log(
        `  ✅ Applied ${existingEffects.length} total effects to ${data.name}`,
      );
    }

    if (data.opacity !== undefined && "opacity" in node) {
      (node as any).opacity = data.opacity;
    }

    if (data.blendMode && "blendMode" in node) {
      (node as any).blendMode = data.blendMode;
    }
    if (data.mixBlendMode && "blendMode" in node) {
      (node as any).blendMode = data.mixBlendMode;
    }

    // HIGH-FIDELITY: Stroke Cap (stroke-linecap CSS equivalent)
    // Affects how line ends are drawn for strokes
    if ("strokeCap" in node && data.strokeCap) {
      const capMap: Record<string, StrokeCap> = {
        butt: "NONE",
        round: "ROUND",
        square: "SQUARE",
      };
      const mappedCap = capMap[data.strokeCap.toLowerCase()];
      if (mappedCap) {
        (node as any).strokeCap = mappedCap;
      }
    } else if ("strokeCap" in node && data.strokes?.[0]?.strokeCap) {
      (node as any).strokeCap = data.strokes[0].strokeCap;
    }

    // HIGH-FIDELITY: Stroke Join (stroke-linejoin CSS equivalent)
    // Affects how corners are drawn where strokes meet
    if ("strokeJoin" in node && data.strokeJoin) {
      const joinMap: Record<string, StrokeJoin> = {
        miter: "MITER",
        round: "ROUND",
        bevel: "BEVEL",
      };
      const mappedJoin = joinMap[data.strokeJoin.toLowerCase()];
      if (mappedJoin) {
        (node as any).strokeJoin = mappedJoin;
      }
    } else if ("strokeJoin" in node && data.strokes?.[0]?.strokeJoin) {
      (node as any).strokeJoin = data.strokes[0].strokeJoin;
    }

    // HIGH-FIDELITY: Stroke Miter Limit
    if ("strokeMiterLimit" in node && data.strokeMiterLimit !== undefined) {
      (node as any).strokeMiterLimit = Math.max(1, data.strokeMiterLimit);
    }

    // HIGH-FIDELITY: Mask support (clip-path / mask CSS equivalent)
    // If this node is marked as a mask, set isMask = true
    if ("isMask" in node && data.isMask === true) {
      (node as any).isMask = true;
      console.log(`🎭 [MASK] Applied mask to ${data.name}`);
    }

    // HIGH-FIDELITY: clipsContent for overflow: hidden
    // This is already partially handled but ensuring robustness
    if ("clipsContent" in node) {
      if (data.clipsContent !== undefined) {
        (node as FrameNode).clipsContent = data.clipsContent;
      } else if (
        data.layoutContext?.overflow === "hidden" ||
        data.layoutContext?.overflow === "scroll" ||
        data.layoutContext?.overflow === "auto"
      ) {
        (node as FrameNode).clipsContent = true;
      }
    }

    // HIGH-FIDELITY: Layout Grids (for design reference)
    // Capture CSS Grid properties and store as layout grids
    if (
      "layoutGrids" in node &&
      data.layoutGrids &&
      Array.isArray(data.layoutGrids)
    ) {
      try {
        (node as FrameNode).layoutGrids = data.layoutGrids;
        console.log(
          `📐 [GRID] Applied ${data.layoutGrids.length} layout grids to ${data.name}`,
        );
      } catch (e) {
        console.warn(`⚠️ Failed to apply layout grids:`, e);
      }
    }

    // HIGH-FIDELITY: Item Reverse Z-Index (for flex-direction: *-reverse)
    if ("itemReverseZIndex" in node && data.itemReverseZIndex === true) {
      (node as FrameNode).itemReverseZIndex = true;
      console.log(`🔄 [LAYOUT] Applied reverse Z-index for ${data.name}`);
    }
  }

  /**
   * CRITICAL FIX: Correct node dimensions based on precise box-sizing data
   * This handles the "double transformation" issue where getBoundingClientRect()
   * returns rotated bounds (enlarged) which are then rotated AGAIN by Figma.
   * By forcing the visualDimensions (offsetWidth/Height), we ensure the node
   * starts at its correct pre-transform size.
   */
  private applyBoxSizingCorrection(node: SceneNode, data: any): void {
    const boxSizing = data._boxSizingData;
    if (!boxSizing || !boxSizing.visualDimensions) return;

    // Only apply to resizable nodes (Frame, Rectangle, etc.)
    // Text nodes have their own sizing logic
    if (node.type === "TEXT" || !("resize" in node) || node.type === "GROUP")
      return;

    const { width: visualW, height: visualH } = boxSizing.visualDimensions;
    if (visualW <= 0 || visualH <= 0) return;

    // SCENARIO 1: Transformed elements (Rotation/Skew)
    // If the node has a transform, getBoundingClientRect (which feeds data.layout)
    // returns the bounding box of the ROTATED element, which is larger than the element itself.
    // Figma then rotates this ALREADY ENLARGED box, causing "double transformation" distortion.
    // FIX: Force the node to use its original (pre-transform) dimensions.
    const hasTransform =
      (data.layoutContext?.transform &&
        data.layoutContext.transform !== "none") ||
      ("relativeTransform" in node &&
        JSON.stringify((node as any).relativeTransform) !==
          JSON.stringify([
            [1, 0, 0],
            [0, 1, 0],
          ]));

    if (hasTransform) {
      // Check if current dimensions are significantly different from visual dimensions
      // If so, it likely means we have the "bounding box vs element size" mismatch
      const widthDiff = Math.abs(node.width - visualW);
      const heightDiff = Math.abs(node.height - visualH);

      // If difference is significant (>1px), force the correction
      if (widthDiff > 1 || heightDiff > 1) {
        console.log(
          `📏 [BOX-MODEL] Correcting transformed node dimensions for ${node.name}:`,
          {
            current: `${node.width.toFixed(1)}x${node.height.toFixed(1)}`,
            visual: `${visualW}x${visualH}`,
            transform: data.layoutContext?.transform,
          },
        );
        node.resize(visualW, visualH);

        // Add plugin data to flag this correction
        this.safeSetPluginData(
          node,
          "boxSizingCorrection",
          "transformed source",
        );
      }
    }
    // SCENARIO 2: Standard elements with box-sizing discrepancies
    // Even without transforms, slightly different rounding in getBoundingClientRect
    // vs offsetWidth can cause 1px gaps or blurs.
    else {
      const widthDiff = Math.abs(node.width - visualW);
      const heightDiff = Math.abs(node.height - visualH);

      // Apply closer fit if there's a small but noticeable discrepancy (1-5px)
      // Large discrepancies might indicate other layout issues, so we're conservative here
      if (
        (widthDiff > 0.5 && widthDiff < 5) ||
        (heightDiff > 0.5 && heightDiff < 5)
      ) {
        console.log(
          `📏 [BOX-MODEL] Fine-tuning node dimensions for ${node.name}:`,
          {
            current: `${node.width.toFixed(1)}x${node.height.toFixed(1)}`,
            target: `${visualW}x${visualH}`,
          },
        );
        node.resize(visualW, visualH);
      }
    }
  }

  private applyCornerRadius(node: any, radius: any, tokenId?: string) {
    if (typeof radius === "number") {
      if (this.designTokensManager && tokenId) {
        const variable = this.designTokensManager.getVariableByTokenId(tokenId);
        if (
          variable &&
          variable.resolvedType === "FLOAT" &&
          "boundVariables" in node
        ) {
          node.boundVariables = {
            ...(node.boundVariables || {}),
            cornerRadius: { type: "VARIABLE_ALIAS", id: variable.id },
          };
        }
      }
      node.cornerRadius = radius;
    } else {
      node.topLeftRadius = radius.topLeft || 0;
      node.topRightRadius = radius.topRight || 0;
      node.bottomRightRadius = radius.bottomRight || 0;
      node.bottomLeftRadius = radius.bottomLeft || 0;
    }
  }

  private applyGridLayoutMetadata(node: SceneNode, data: any) {
    if (!data.gridLayout) return;

    const grid = data.gridLayout;

    this.applyGridLayoutConversion(node as FrameNode, grid, data);

    this.safeSetPluginData(
      node,
      "enhancedGridLayout",
      JSON.stringify({
        ...grid,
        conversionApplied: true,
        timestamp: Date.now(),
      }),
    );

    this.safeSetPluginData(
      node,
      "cssGridLayout",
      JSON.stringify({
        templateColumns: grid.templateColumns,
        templateRows: grid.templateRows,
        columnGap: grid.columnGap,
        rowGap: grid.rowGap,
        autoFlow: grid.autoFlow,
        justifyItems: grid.justifyItems,
        alignItems: grid.alignItems,
        justifyContent: grid.justifyContent,
        alignContent: grid.alignContent,
      }),
    );

    if (data.gridChild) {
      this.safeSetPluginData(node, "gridChild", JSON.stringify(data.gridChild));
    }

    if ("name" in node && typeof node.name === "string") {
      const strategy = grid.conversionStrategy || "auto";
      if (!node.name.includes("[Grid")) {
        node.name = `${node.name} [Grid:${strategy}]`;
      }
    }

    if (grid.figmaAnnotations && grid.figmaAnnotations.length > 0) {
      this.safeSetPluginData(
        node,
        "gridAnnotations",
        JSON.stringify(grid.figmaAnnotations),
      );
    }
  }

  private applyGridLayoutConversion(
    node: FrameNode,
    gridData: any,
    elementData: any,
  ) {
    switch (gridData.conversionStrategy) {
      case "nested-auto-layout":
        this.applyNestedAutoLayoutConversion(node, gridData);
        break;
      case "absolute-positioning":
        this.applyAbsolutePositioningConversion(node, gridData);
        break;
      case "hybrid":
        this.applyHybridLayoutConversion(node, gridData);
        break;
      default:
        this.applyBasicGridAutoLayout(node, gridData);
    }
  }

  private applyNestedAutoLayoutConversion(node: FrameNode, gridData: any) {
    if (!("layoutMode" in node)) return;

    const isRowMajor =
      gridData.computedRowSizes.length <= gridData.computedColumnSizes.length;

    node.layoutMode = isRowMajor ? "VERTICAL" : "HORIZONTAL";

    const primaryProp = isRowMajor
      ? gridData.alignContent || "start"
      : gridData.justifyContent || "start";
    const counterProp = isRowMajor
      ? gridData.justifyContent || "start"
      : gridData.alignContent || "start";

    node.primaryAxisAlignItems = this.mapGridAlignment(primaryProp);

    const counterAlign = this.mapGridAlignment(counterProp);
    node.counterAxisAlignItems =
      counterAlign === "SPACE_BETWEEN" ? "CENTER" : (counterAlign as any);
    node.itemSpacing = isRowMajor ? gridData.rowGap : gridData.columnGap;

    this.safeSetPluginData(
      node,
      "gridConversionData",
      JSON.stringify({
        strategy: "nested-auto-layout",
        isRowMajor,
        rowCount: gridData.computedRowSizes.length,
        columnCount: gridData.computedColumnSizes.length,
        rowSizes: gridData.computedRowSizes,
        columnSizes: gridData.computedColumnSizes,
        rowGap: gridData.rowGap,
        columnGap: gridData.columnGap,
      }),
    );

    console.log(
      `✅ Applied nested Auto Layout to grid: ${gridData.computedColumnSizes.length}x${gridData.computedRowSizes.length}`,
    );
  }

  private applyAbsolutePositioningConversion(node: FrameNode, gridData: any) {
    if (!("layoutMode" in node)) return;

    node.layoutMode = "NONE";

    this.safeSetPluginData(
      node,
      "gridConversionData",
      JSON.stringify({
        strategy: "absolute-positioning",
        templateAreas: gridData.templateAreas,
        computedColumnSizes: gridData.computedColumnSizes,
        computedRowSizes: gridData.computedRowSizes,
        positioning: "manual",
      }),
    );

    console.log(`⚠️ Applied absolute positioning to complex grid`);
  }

  private applyHybridLayoutConversion(node: FrameNode, gridData: any) {
    this.applyNestedAutoLayoutConversion(node, gridData);

    this.safeSetPluginData(
      node,
      "gridHybridData",
      JSON.stringify({
        strategy: "hybrid",
        complexItems: gridData.templateAreas || [],
        fallbackToAbsolute: true,
      }),
    );

    console.log(`🔀 Applied hybrid layout conversion to grid`);
  }

  private applyBasicGridAutoLayout(node: FrameNode, gridData: any) {
    if (!("layoutMode" in node)) return;

    const hasMoreColumns =
      gridData.computedColumnSizes.length > gridData.computedRowSizes.length;

    node.layoutMode = hasMoreColumns ? "HORIZONTAL" : "VERTICAL";
    node.itemSpacing = hasMoreColumns ? gridData.columnGap : gridData.rowGap;
    node.primaryAxisAlignItems = "MIN";
    node.counterAxisAlignItems = "MIN";

    console.log(
      `📐 Applied basic Auto Layout to grid (${gridData.computedColumnSizes.length}x${gridData.computedRowSizes.length})`,
    );
  }

  private mapGridAlignment(
    value?: string,
  ): "MIN" | "CENTER" | "MAX" | "SPACE_BETWEEN" {
    switch (value) {
      case "start":
      case "flex-start":
        return "MIN";
      case "center":
        return "CENTER";
      case "end":
      case "flex-end":
        return "MAX";
      case "space-between":
        return "SPACE_BETWEEN";
      case "stretch":
      default:
        return "MIN";
    }
  }

  private applyOverflow(node: SceneNode, data: any) {
    // RULE 5.1: Create masks for overflow/clip-path
    if (
      !data.overflow &&
      data.clipsContent === undefined &&
      !data._hasOverflowMask
    )
      return;
    if ("clipsContent" in node) {
      // Handle direct clipsContent flag from extractor or overflow mask detection
      if (data.clipsContent === true || data._hasOverflowMask === true) {
        (node as FrameNode).clipsContent = true;
        return;
      }
      if (!data.overflow) return;
      // Handle both overflow.x/y (new) and overflow.horizontal/vertical (old) formats
      const horizontalHidden =
        data.overflow.horizontal === "hidden" ||
        data.overflow.horizontal === "clip" ||
        data.overflow.x === "hidden" ||
        data.overflow.x === "clip";
      const verticalHidden =
        data.overflow.vertical === "hidden" ||
        data.overflow.vertical === "clip" ||
        data.overflow.y === "hidden" ||
        data.overflow.y === "clip";
      (node as FrameNode).clipsContent = horizontalHidden || verticalHidden;
    }
  }

  private applyOpacity(node: SceneNode, data: any) {
    // RULE 2.2: Use cumulative opacity if available (flattened during extraction)
    const opacity =
      data._cumulativeOpacity !== undefined
        ? data._cumulativeOpacity
        : data.opacity !== undefined
          ? data.opacity
          : 1;

    if (opacity !== 1 && "opacity" in node) {
      (node as any).opacity = Math.max(0, Math.min(1, opacity));
    }
  }

  private applyVisibility(node: SceneNode, data: any) {
    // CRITICAL FIX: Don't hide text nodes unless explicitly hidden
    // Text nodes with opacity 0 or very low opacity should still be visible in Figma
    // to match browser rendering (browsers may still show text with low opacity)
    const isTextNode = node.type === "TEXT";
    const opacity = data.opacity !== undefined ? data.opacity : 1;
    const hasVeryLowOpacity = opacity > 0 && opacity < 0.01;

    if (
      data.display === "none" ||
      data.visibility === "hidden" ||
      data.visibility === "collapse"
    ) {
      node.visible = false;
    } else if (isTextNode && hasVeryLowOpacity) {
      // Text with very low opacity should still be visible (browser shows it)
      node.visible = true;
      if (opacity > 0 && opacity < 1 && "opacity" in node) {
        (node as any).opacity = opacity;
      }
    } else {
      // DROPDOWN FIX: Check for common dropdown/popup classes and hide them by default
      // This prevents "stacked" artifacts where absolute positioned menus all appear at once
      const hiddenClasses = [
        "dropdown-menu",
        "dropdown-content",
        "submenu",
        "sub-menu",
        "popup-content",
        "tooltip-content",
      ];
      
      const hasHiddenClass = data.cssClasses && data.cssClasses.some((cls: string) => 
        hiddenClasses.includes(cls.toLowerCase())
      );

      // Check if aria-expanded is explicitly true (if we captured attributes)
      const isExpanded = data.attributes && data.attributes["aria-expanded"] === "true";

      if (hasHiddenClass && !isExpanded) {
        node.visible = false;
        console.log(
          `🙈 [VISIBILITY] Hiding potential dropdown/popup "${node.name}" to prevent stacking artifacts`
        );
      } else {
        node.visible = true;
      }
    }
  }

  private applyFilters(node: SceneNode, data: any) {
    if (!("setPluginData" in node)) return;
    const existingEffects =
      "effects" in node ? [...((node as BlendMixin).effects || [])] : [];

    (data.filters || []).forEach((filter: any) => {
      if (filter.type === "blur" && "effects" in node) {
        existingEffects.push({
          type: "LAYER_BLUR",
          radius: filter.unit === "px" ? filter.value : filter.value || 0,
          visible: true,
        } as BlurEffect);
      }
      if (filter.type === "dropShadow" && "effects" in node) {
        existingEffects.push({
          type: "DROP_SHADOW",
          color: filter.color || { r: 0, g: 0, b: 0, a: 0.5 },
          offset: filter.offset || { x: 0, y: 0 },
          radius: filter.unit === "px" ? filter.value : filter.value || 0,
          spread: 0,
          visible: true,
          blendMode: "NORMAL",
        } as DropShadowEffect);
      }
    });

    (data.backdropFilters || []).forEach((filter: any) => {
      if (filter.type === "blur" && "effects" in node) {
        existingEffects.push({
          type: "BACKGROUND_BLUR",
          radius: filter.unit === "px" ? filter.value : filter.value || 0,
          visible: true,
        } as BlurEffect);
      }
    });

    if (existingEffects.length && "effects" in node) {
      (node as BlendMixin).effects = existingEffects;
    }

    if (data.filters?.length) {
      this.safeSetPluginData(node, "cssFilters", JSON.stringify(data.filters));
    }
    if (data.backdropFilters?.length) {
      this.safeSetPluginData(
        node,
        "cssBackdropFilters",
        JSON.stringify(data.backdropFilters),
      );
    }
  }

  private applyMetadata(
    node: SceneNode,
    data: any,
    meta: { reuseComponent: boolean },
  ) {
    this.applyConstraints(node, data);

    const isTextNode = node.type === "TEXT";
    const canHaveLayoutProperties = !isTextNode && "layoutGrow" in node;

    if (canHaveLayoutProperties && data.autoLayout?.layoutGrow !== undefined) {
      try {
        (node as any).layoutGrow = data.autoLayout.layoutGrow;
      } catch (error) {
        console.warn(
          `Cannot set layoutGrow on node "${node.name}" in metadata:`,
          error,
        );
        this.safeSetPluginData(
          node,
          "cssLayoutGrow",
          data.autoLayout.layoutGrow.toString(),
        );
      }
    }
    if (canHaveLayoutProperties && data.autoLayout?.layoutAlign) {
      try {
        (node as any).layoutAlign = data.autoLayout.layoutAlign;
      } catch (error) {
        console.warn(
          `Cannot set layoutAlign on node "${node.name}" in metadata:`,
          error,
        );
        this.safeSetPluginData(
          node,
          "cssLayoutAlign",
          data.autoLayout.layoutAlign,
        );
      }
    }

    this.safeSetPluginData(node, "sourceNodeId", data.id || "");
    this.safeSetPluginData(node, "htmlTag", data.htmlTag || "");

    if (data.cssClasses?.length) {
      this.safeSetPluginData(
        node,
        "cssClasses",
        JSON.stringify(data.cssClasses),
      );
    }

    if (data.dataAttributes && Object.keys(data.dataAttributes).length) {
      this.safeSetPluginData(
        node,
        "dataAttributes",
        JSON.stringify(data.dataAttributes),
      );
    }

    if (data.cssCustomProperties) {
      this.safeSetPluginData(
        node,
        "cssCustomProperties",
        JSON.stringify(data.cssCustomProperties),
      );
    }

    if (data.clipPath) {
      this.safeSetPluginData(
        node,
        "cssClipPath",
        JSON.stringify(data.clipPath),
      );
    }

    if (data.mask) {
      this.safeSetPluginData(node, "cssMask", JSON.stringify(data.mask));
    }

    if (data.pointerEvents) {
      this.safeSetPluginData(node, "pointerEvents", data.pointerEvents);
    }

    if (data.position) {
      this.safeSetPluginData(node, "positioning", data.position);
    }

    if (data.absoluteLayout) {
      this.safeSetPluginData(
        node,
        "absoluteLayout",
        JSON.stringify(data.absoluteLayout),
      );
    }

    if (data.scrollData) {
      this.safeSetPluginData(
        node,
        "scrollData",
        JSON.stringify(data.scrollData),
      );
    }

    if (data.contentHash) {
      this.safeSetPluginData(node, "contentHash", data.contentHash);
    }

    if (meta.reuseComponent) {
      this.safeSetPluginData(node, "componentInstance", "true");
    }

    if (data.computedStyles) {
      this.safeSetPluginData(
        node,
        "computedStyles",
        JSON.stringify(data.computedStyles),
      );
    }
  }

  private applyConstraints(node: SceneNode, data: any) {
    if (!data.constraints) return;
    if ("constraints" in node) {
      (node as ConstraintMixin).constraints = {
        horizontal: data.constraints.horizontal || "MIN",
        vertical: data.constraints.vertical || "MIN",
      };
    }
  }

  private async convertBackgroundLayersAsync(
    backgrounds: any[],
    nodeLayout?: { width: number; height: number },
  ): Promise<Paint[]> {
    const paints: Paint[] = [];

    // Diagnostic logging for background processing
    console.log(
      `🔍 convertBackgroundLayersAsync called with ${
        backgrounds?.length || 0
      } backgrounds`,
    );
    if (backgrounds) {
      backgrounds.forEach((layer, i) => {
        const fill = layer?.fill || layer;
        console.log(`  Background ${i}:`, {
          layerType: layer?.type,
          hasFill: !!layer?.fill,
          fillType: fill?.type,
          hasImageHash: !!fill?.imageHash,
          imageHash: fill?.imageHash,
        });
      });

      for (const layer of backgrounds) {
        if (!layer) continue;

        const fill = layer.fill || layer;

        if (fill.type === "SOLID" && fill.color) {
          const { r, g, b } = fill.color;
          const opacity =
            fill.opacity !== undefined ? fill.opacity : (fill.color.a ?? 1);
          if (opacity <= 0) {
            continue;
          }
          console.log(`  🎨 Converting SOLID background:`, {
            r,
            g,
            b,
            opacity,
          });
          paints.push(
            figma.util.solidPaint(
              { r, g, b },
              {
                opacity,
                visible: fill.visible !== false,
              },
            ),
          );
          continue;
        }

        if (
          (fill.type === "GRADIENT_LINEAR" ||
            fill.type === "GRADIENT_RADIAL") &&
          fill.gradientStops
        ) {
          console.log(
            `  🌈 Converting ${fill.type} gradient with ${fill.gradientStops.length} stops`,
          );
          paints.push({
            type: fill.type,
            gradientStops: fill.gradientStops.map((stop: any) => {
              const { r, g, b, a } = stop.color;
              return {
                position: stop.position,
                color: { r, g, b, a },
              };
            }),
            gradientTransform: fill.gradientTransform || [
              [1, 0, 0],
              [0, 1, 0],
            ],
            visible: fill.visible !== false,
          } as GradientPaint);
          continue;
        }

        if (fill.type === "IMAGE") {
          paints.push(
            await this.resolveImagePaintWithBackground(fill, layer, nodeLayout),
          );
          continue;
        }

        if (fill.type === "SVG") {
          const svgPaint = await this.resolveSVGPaint(fill);
          if (svgPaint) {
            paints.push(svgPaint);
          }
          continue;
        }
      }
    }

    console.log(`  ✅ Converted ${paints.length} background layers`);
    return paints;
  }

  private async convertFillsAsync(
    fills: any[],
    nodeLayout?: { width: number; height: number },
    context?: { tokenId?: string; property?: string },
  ): Promise<Paint[]> {
    const paints: Paint[] = [];

    for (const fill of fills) {
      if (!fill) continue;

      // Debug: Log exactly what each fill looks like (only in debug mode to reduce noise)
      if (this.options?.enableDebugMode) {
        console.log(
          `🎨 [FILL DEBUG] Processing fill:`,
          JSON.stringify(fill, null, 2),
        );
      }

      if (fill.type === "SOLID" && fill.color) {
        // Sanitize color values to prevent NaN/undefined/out-of-range issues
        const sanitizeColorComponent = (v: any): number => {
          if (v === undefined || v === null || !isFinite(v)) return 0;
          return Math.max(0, Math.min(1, v));
        };
        const sanitizeOpacity = (v: any): number => {
          if (v === undefined || v === null || !isFinite(v)) return 1;
          return Math.max(0, Math.min(1, v));
        };

        const r = sanitizeColorComponent(fill.color.r);
        const g = sanitizeColorComponent(fill.color.g);
        const b = sanitizeColorComponent(fill.color.b);
        const opacity = sanitizeOpacity(
          fill.opacity !== undefined ? fill.opacity : (fill.color.a ?? 1),
        );

        // CRITICAL: Check for NaN/invalid color components to prevent silent failures
        if (
          !isFinite(r) ||
          !isFinite(g) ||
          !isFinite(b) ||
          !isFinite(opacity)
        ) {
          console.warn(`⚠️ [FILL] Invalid color components detected:`, {
            r,
            g,
            b,
            opacity,
            fillType: fill.type,
            originalColor: fill.color,
          });
          continue; // Skip invalid fills instead of creating broken paints
        }

        // CRITICAL FIX: Only skip if opacity is exactly 0
        // Even very low opacity colors (like 0.01) should be applied - they're still visible
        // The previous threshold of 0.001 was too strict and caused many fills to be lost
        if (opacity <= 0) {
          if (this.options?.enableDebugMode) {
            console.log(
              `⚠️ [FILL DEBUG] Skipping fill with opacity=${opacity}:`,
              {
                color: { r, g, b },
                fillOpacity: fill.opacity,
                colorA: fill.color.a,
              },
            );
          }
          continue;
        }

        const paint: SolidPaint = {
          type: "SOLID",
          color: { r, g, b },
          opacity,
          visible: fill.visible !== false,
        };

        if (this.designTokensManager) {
          let tokenId = context?.tokenId;

          if (!tokenId) {
            tokenId = this.findColorToken({ r, g, b, a: fill.color.a });
          }

          if (tokenId) {
            const variable =
              this.designTokensManager.getVariableByTokenId(tokenId);
            if (variable && variable.resolvedType === "COLOR") {
              (paint as any).boundVariables = {
                color: { type: "VARIABLE_ALIAS", id: variable.id },
              };
            }
          }
        }

        paints.push(paint);
        continue;
      }

      if (
        (fill.type === "GRADIENT_LINEAR" || fill.type === "GRADIENT_RADIAL") &&
        fill.gradientStops
      ) {
        paints.push({
          type: fill.type,
          gradientStops: fill.gradientStops.map((stop: any) => {
            const { r, g, b, a } = stop.color;
            return {
              position: stop.position,
              color: { r, g, b, a },
            };
          }),
          gradientTransform: fill.gradientTransform || [
            [1, 0, 0],
            [0, 1, 0],
          ],
          visible: fill.visible !== false,
        } as GradientPaint);
        continue;
      }

      if (fill.type === "IMAGE") {
        const imagePaint = await this.resolveImagePaint(fill, nodeLayout);
        // CRITICAL: Validate that IMAGE fills result in IMAGE paints
        if (imagePaint.type === "IMAGE") {
          paints.push(imagePaint);
        } else {
          console.error(
            `❌ IMAGE fill failed to resolve - got ${imagePaint.type} fallback instead of IMAGE paint for hash ${fill.imageHash}`,
          );
          // Still add the fallback so the node has some fill, but log the error
          paints.push(imagePaint);
          diagnostics.logIssue(
            "unknown",
            "fill",
            "IMAGE",
            `IMAGE fill resolution failed for hash ${fill.imageHash}`,
            {
              hash: fill.imageHash,
              availableKeys: Object.keys(this.assets?.images || {}).length,
              paintType: imagePaint.type,
            },
            { result: "fallback applied" },
          );
        }
        continue;
      }

      if (fill.type === "SVG") {
        const svgPaint = await this.resolveSVGPaint(fill);
        if (svgPaint) {
          paints.push(svgPaint);
        } else {
          console.error(
            `❌ SVG fill failed to resolve for svgRef ${fill.svgRef}`,
          );
        }
        continue;
      }

      // Catch-all: Log unhandled fill types
      console.warn(`⚠️ [FILL DEBUG] Unhandled fill type: "${fill.type}"`, fill);
    }

    if (fills.length > 0 && paints.length === 0) {
      const validFills = fills.filter(
        (f) =>
          f &&
          f.visible !== false &&
          (f.opacity === undefined || f.opacity > 0),
      );
      if (validFills.length > 0) {
        console.warn(
          `⚠️ [FIGMA IMPORT] ${fills.length} fills processed but 0 resulted in paints.`,
        );
        diagnostics.logIssue(
          context?.tokenId || "unknown",
          "unknown",
          "FILLS",
          `${fills.length} fills processed but 0 resulted in paints`,
          { validFillsCount: validFills.length },
          { paintsCount: 0 },
        );
      }
    }

    // PHASE 2: Cache result
    const cacheKey = JSON.stringify({ fills, context });
    this.fillConversionCache.set(cacheKey, paints);
    return paints;
  }

  private async resolveImagePaintWithBackground(
    fill: any,
    layer: any,
    nodeLayout?: { width: number; height: number },
  ): Promise<Paint> {
    const hash = fill.imageHash;

    console.log(`🔍 resolveImagePaintWithBackground called:`, { hash });

    if (!hash) {
      return figma.util.solidPaint({ r: 0.9, g: 0.9, b: 0.9 });
    }

    let imageHash: string | undefined;
    let image: Image | null = null;

    if (this.imagePaintCache.has(hash)) {
      imageHash = this.imagePaintCache.get(hash)!;
    } else {
      if (this.assets?.images?.[hash]) {
        try {
          const asset = this.assets.images[hash];
          image = await this.createFigmaImageFromAsset(
            asset,
            hash,
            nodeLayout?.width ? nodeLayout.width * 2 : undefined,
            nodeLayout?.height ? nodeLayout.height * 2 : undefined,
          );

          if (!image) {
            const assetUrl =
              asset.url || asset.originalUrl || asset.absoluteUrl;
            if (assetUrl && !assetUrl.startsWith("data:")) {
              try {
                const { bytes, contentType } = await this.fetchImage(assetUrl);
                const transcoded = await this.transcodeIfUnsupportedRaster(
                  bytes,
                  contentType || "image/png",
                  nodeLayout?.width ? nodeLayout.width * 2 : undefined,
                  nodeLayout?.height ? nodeLayout.height * 2 : undefined,
                );
                image = figma.createImage(transcoded);
              } catch (e) {
                console.warn(`  ❌ [BG FALLBACK] Asset URL fetch failed:`, e);
              }
            }
          }
        } catch (e) {
          console.warn(`  ⚠️ Failed to create image from asset ${hash}`, e);
        }
      }

      if (!image) {
        if (hash.startsWith("http") || hash.startsWith("data:")) {
          try {
            const { bytes, contentType } = await this.fetchImage(hash);
            const transcoded = await this.transcodeIfUnsupportedRaster(
              bytes,
              contentType || "image/png",
              nodeLayout?.width ? nodeLayout.width * 2 : undefined,
              nodeLayout?.height ? nodeLayout.height * 2 : undefined,
            );
            image = figma.createImage(transcoded);
          } catch (e) {
            console.warn(`  ❌ [BG] direct URL fetch failed for ${hash}`, e);
          }
        }

        if (!image && fill.url) {
          try {
            const { bytes, contentType } = await this.fetchImage(fill.url);
            const transcoded = await this.transcodeIfUnsupportedRaster(
              bytes,
              contentType || "image/png",
              nodeLayout?.width ? nodeLayout.width * 2 : undefined,
              nodeLayout?.height ? nodeLayout.height * 2 : undefined,
            );
            image = figma.createImage(transcoded);
          } catch (e) {
            console.warn(`  ❌ [BG] fill.url fetch failed`, e);
          }
        }
      }

      if (image) {
        this.imagePaintCache.set(hash, image.hash);
        imageHash = image.hash;
      } else {
        return {
          type: "SOLID",
          color: { r: 0, g: 0, b: 0 },
          opacity: 0,
        } as SolidPaint;
      }
    }

    const scaleMode = this.getScaleModeFromRepeat(layer.repeat);
    const imageTransform = this.calculateImageTransform(
      layer.position,
      layer.size,
      nodeLayout,
      this.assets?.images?.[hash],
    );

    return {
      type: "IMAGE",
      imageHash,
      scaleMode,
      visible: fill.visible !== false,
      ...(imageTransform && { imageTransform }),
    } as ImagePaint;
  }

  async resolveImagePaint(
    fill: any,
    nodeLayout?: { width: number; height: number },
  ): Promise<Paint> {
    const hash = fill.imageHash;

    if (!hash) {
      return { type: "SOLID", opacity: 0.5 } as SolidPaint;
    }

    const buildImagePaint = (figmaImageHash: string): ImagePaint => {
      let scaleMode: "FILL" | "FIT" | "CROP" | "TILE" =
        fill.scaleMode || "FILL";
      if (fill.objectFit) {
        scaleMode = this.mapObjectFitToScaleMode(fill.objectFit);
      }

      let imageTransform: Transform | undefined = fill.imageTransform;

      // P1 FIX: Handle object-position for COVER/CONTAIN by switching to CROP + Transform
      // Figma's FILL/FIT always centers the image. If object-position is not center,
      // we must manually calculate the CROP transform to achieve the offset.
      if (
        !imageTransform &&
        fill.objectFit &&
        fill.objectPosition &&
        fill.objectPosition !== "center center"
      ) {
        const asset = this.assets?.images?.[hash];
        // We need natural dimensions to calculate correct crop
        if (asset && asset.width && asset.height && nodeLayout) {
          const posParts = fill.objectPosition.trim().split(/\s+/);
          // Handle 1-value syntax (e.g. "left" -> "left center")
          const positionObj = {
            x: posParts[0] || "50%",
            y: posParts[1] || (posParts.length === 1 ? "50%" : "50%"),
          };

          const calculated = this.calculateImageTransform(
            positionObj,
            { width: fill.objectFit, height: fill.objectFit }, // Pass fit as size keyword
            nodeLayout,
            { width: asset.width, height: asset.height },
          );

          if (calculated) {
            scaleMode = "CROP";
            imageTransform = calculated;
            // console.log(`🖼️ [IMAGE] Converted ${fill.objectFit} + ${fill.objectPosition} to CROP`);
          }
        }
      }

      if (
        !imageTransform &&
        fill.objectPosition &&
        fill.objectPosition !== "center center"
      ) {
        imageTransform = this.parseObjectPositionToTransform(
          fill.objectPosition,
        );
      }

      return {
        type: "IMAGE",
        imageHash: figmaImageHash,
        scaleMode,
        visible: fill.visible !== false,
        ...(imageTransform && { imageTransform }),
      };
    };

    if (this.imagePaintCache.has(hash)) {
      return buildImagePaint(this.imagePaintCache.get(hash)!);
    }

    let image: Image | null = null;

    if (this.assets?.images?.[hash]) {
      try {
        const asset = this.assets.images[hash];
        image = await this.createFigmaImageFromAsset(
          asset,
          hash,
          nodeLayout?.width ? nodeLayout.width * 2 : undefined,
          nodeLayout?.height ? nodeLayout.height * 2 : undefined,
        );

        if (!image) {
          const assetUrl = asset.url || asset.originalUrl || asset.absoluteUrl;
          if (assetUrl && !assetUrl.startsWith("data:")) {
            try {
              const { bytes, contentType } = await this.fetchImage(assetUrl);
              const transcoded = await this.transcodeIfUnsupportedRaster(
                bytes,
                contentType || "image/png",
                nodeLayout?.width
                  ? Math.max(nodeLayout.width * 2, 1)
                  : undefined,
                nodeLayout?.height
                  ? Math.max(nodeLayout.height * 2, 1)
                  : undefined,
              );
              image = figma.createImage(transcoded);
            } catch (e) {
              console.warn(`  ❌ [FILL FALLBACK] Asset URL fetch failed:`, e);
            }
          }
        }
      } catch (e) {
        console.warn(`  ⚠️ Failed to resolve image from asset ${hash}`, e);
      }
    } else {
      if (hash.startsWith("http") || hash.startsWith("data:")) {
        try {
          const { bytes, contentType } = await this.fetchImage(hash);
          const transcoded = await this.transcodeIfUnsupportedRaster(
            bytes,
            contentType || "image/png",
            nodeLayout?.width ? Math.max(nodeLayout.width * 2, 1) : undefined,
            nodeLayout?.height ? Math.max(nodeLayout.height * 2, 1) : undefined,
          );
          image = figma.createImage(transcoded);
        } catch (e) {
          console.warn(`  ❌ direct URL fetch failed for ${hash}`, e);
        }
      }

      if (!image && fill.url) {
        try {
          const { bytes, contentType } = await this.fetchImage(fill.url);
          const transcoded = await this.transcodeIfUnsupportedRaster(
            bytes,
            contentType || "image/png",
            nodeLayout?.width ? Math.max(nodeLayout.width * 2, 1) : undefined,
            nodeLayout?.height ? Math.max(nodeLayout.height * 2, 1) : undefined,
          );
          image = figma.createImage(transcoded);
        } catch (e) {
          console.warn(`  ❌ fill.url fetch failed`, e);
        }
      }
    }

    if (!image) {
      return {
        type: "SOLID",
        color: { r: 0, g: 0, b: 0 },
        opacity: 0,
      } as SolidPaint;
    }

    this.imagePaintCache.set(hash, image.hash);
    return buildImagePaint(image.hash);
  }

  async resolveSVGPaint(fill: any): Promise<Paint | null> {
    const svgRef = fill.svgRef;

    console.log(`🎨 [FIGMA IMPORT] Resolving SVG paint for svgRef: ${svgRef}`);

    if (!svgRef) {
      console.error("❌ resolveSVGPaint: No svgRef provided in fill:", fill);
      return null;
    }

    // Look up SVG asset by reference
    const svgAsset = this.assets?.svgs?.[svgRef];
    if (!svgAsset) {
      console.error(
        `❌ resolveSVGPaint: SVG asset not found for svgRef: ${svgRef}`,
      );
      console.error(
        `  📊 Available SVG keys (${
          Object.keys(this.assets?.svgs || {}).length
        } total):`,
        Object.keys(this.assets?.svgs || {}).slice(0, 10),
      );
      return null;
    }

    const cacheKey = `SVG:${svgRef}`;
    if (this.imageObjectCache.has(cacheKey)) {
      const image = this.imageObjectCache.get(cacheKey)!;
      return {
        type: "IMAGE",
        imageHash: image.hash,
        scaleMode: fill.scaleMode || "FILL",
        visible: fill.visible !== false,
      };
    }

    try {
      // Create vector node from SVG markup
      const vectorNode = figma.createNodeFromSvg(svgAsset.svgCode);

      if (!vectorNode) {
        console.error(
          `❌ resolveSVGPaint: Failed to create vector node from SVG: ${svgRef}`,
        );
        return null;
      }

      // Convert vector to image paint for use as fill
      // Note: Figma doesn't directly support vector fills, so we convert to image
      const imageBytes = await vectorNode.exportAsync({
        format: "PNG",
        constraint: { type: "SCALE", value: 2 }, // High DPI for crisp vectors
      });

      const image = figma.createImage(imageBytes);
      this.imageObjectCache.set(cacheKey, image);

      // Clean up the temporary vector node
      vectorNode.remove();

      console.log(`  ✅ Successfully converted SVG to image paint`);

      const imagePaint: ImagePaint = {
        type: "IMAGE",
        imageHash: image.hash,
        scaleMode: fill.scaleMode || "FILL",
        visible: fill.visible !== false,
      };

      return imagePaint;
    } catch (error) {
      console.error(
        `❌ resolveSVGPaint: Error creating vector from SVG:`,
        error,
      );
      return null;
    }
  }

  private mapObjectFitToScaleMode(
    objectFit: string,
  ): "FILL" | "FIT" | "CROP" | "TILE" {
    // IMPORTANT: cover → FILL (not CROP) because CROP requires explicit imageTransform
    // FILL with proper aspect ratio preservation is the correct Figma equivalent of CSS cover
    const mapping: Record<string, "FILL" | "FIT" | "CROP" | "TILE"> = {
      fill: "FILL", // Stretch to fill
      contain: "FIT", // Scale to fit, preserve aspect
      cover: "FILL", // Scale to cover, preserve aspect (FILL is correct without imageTransform)
      none: "CROP", // Display at intrinsic size
      "scale-down": "FIT", // Like contain but no upscale
    };
    return mapping[objectFit] || "FILL";
  }

  /**
   * PHASE 4: Apply CSS filters and blend modes with strict "map or rasterize" policy
   */
  private applyCssFiltersAndBlend(node: SceneNode, data: any): void {
    // Note: parseCssFilter and filterRequiresRasterization are now static imports at top of file

    // Blend mode
    if (data.mixBlendMode) {
      const mapped = this.mapCssBlendModeToFigma(data.mixBlendMode);
      if (mapped) {
        // SceneNode.blendMode exists in plugin API via BlendMode enum
        (node as any).blendMode = mapped;
      } else {
        data.rasterize = data.rasterize ?? { reason: "BLEND_MODE" };
      }
    }

    // CSS filter → effects / image filters
    if (data.cssFilter) {
      const parsed = parseCssFilter(data.cssFilter);

      // Strict clone: if anything unknown remains, rasterize instead of approximating
      if (filterRequiresRasterization(parsed)) {
        data.rasterize = data.rasterize ?? { reason: "FILTER" };
      }

      // Apply representable subset
      const effects: Effect[] = [];
      for (const f of parsed) {
        if (f.kind === "blur" && f.radiusPx > 0) {
          // BlurEffect with type 'LAYER_BLUR' and radius
          effects.push({
            type: "LAYER_BLUR",
            radius: f.radiusPx,
            visible: true,
          } as any);
        }

        if (f.kind === "drop-shadow") {
          // DropShadowEffect supports color/offset/radius/spread
          effects.push({
            type: "DROP_SHADOW",
            color: f.color,
            offset: { x: f.offsetX, y: f.offsetY },
            radius: f.blurRadius,
            spread: f.spread,
            visible: true,
            blendMode: "NORMAL",
          } as any);
        }
      }

      if (effects.length > 0) {
        // Merge without destroying existing effects
        const existing = (node as any).effects ?? [];
        (node as any).effects = [...existing, ...effects];
      }

      // ImagePaint.filters subset (approximate; only do this in "editable fidelity" mode)
      // ImagePaint supports `filters: ImageFilters`
      if (data.type === "IMAGE" && (node as any).fills) {
        const fills = (node as any).fills as ReadonlyArray<Paint>;
        const imgIndex = fills.findIndex((p: any) => p && p.type === "IMAGE");
        if (imgIndex !== -1) {
          const img = { ...(fills[imgIndex] as any) };

          const currentFilters = img.filters ? { ...img.filters } : {};
          for (const f of parsed) {
            if (f.kind === "contrast") currentFilters.contrast = f.amount;
            if (f.kind === "saturate") currentFilters.saturation = f.amount;

            // brightness has no perfect 1:1; exposure is the closest available knob in ImageFilters
            if (f.kind === "brightness") currentFilters.exposure = f.amount - 1;
          }

          img.filters = currentFilters;
          const next = fills.slice();
          (next as any)[imgIndex] = img;
          (node as any).fills = next;
        }
      }
    }
  }

  /**
   * Map CSS mix-blend-mode to Figma BlendMode enum
   */
  private mapCssBlendModeToFigma(css: string): string | null {
    const v = String(css).trim().toLowerCase();

    // Figma BlendMode enum values are defined in API docs
    const map: Record<string, string> = {
      normal: "NORMAL",
      multiply: "MULTIPLY",
      screen: "SCREEN",
      overlay: "OVERLAY",
      darken: "DARKEN",
      lighten: "LIGHTEN",
      "color-dodge": "COLOR_DODGE",
      "color-burn": "COLOR_BURN",
      "hard-light": "HARD_LIGHT",
      "soft-light": "SOFT_LIGHT",
      difference: "DIFFERENCE",
      exclusion: "EXCLUSION",
      hue: "HUE",
      saturation: "SATURATION",
      color: "COLOR",
      luminosity: "LUMINOSITY",
    };

    return map[v] ?? null;
  }

  /**
   * PHASE 5: Check if node should be rasterized (perfect clone fallback)
   * Returns true if node has rasterize metadata with valid dataUrl
   */
  private shouldRasterizeNode(data: any): boolean {
    return !!(
      data.rasterize &&
      data.rasterize.dataUrl &&
      typeof data.rasterize.dataUrl === "string" &&
      data.rasterize.dataUrl.startsWith("data:image/")
    );
  }

  /**
   * PHASE 5: Apply rasterization - convert dataUrl to ImagePaint
   * For containers with children: creates a background rectangle with the screenshot
   * For leaf nodes: replaces fills with the captured screenshot
   * This ensures pixel-perfect fidelity for unmappable CSS features without covering children
   */
  private applyRasterization(node: SceneNode, data: any): void {
    try {
      if (!this.shouldRasterizeNode(data)) return;

      const dataUrl = data.rasterize.dataUrl;
      const reason = data.rasterize.reason || "UNKNOWN";

      console.log(`[PHASE 5] Rasterizing node due to: ${reason}`, {
        tagName: data.tagName,
        cssFilter: data.cssFilter,
        mixBlendMode: data.mixBlendMode,
        hasChildren: data.children && data.children.length > 0,
      });

      // Check cache first
      let image: Image;
      if (this.imageObjectCache.has(dataUrl)) {
        image = this.imageObjectCache.get(dataUrl)!;
      } else {
        // Decode base64 data URL to Uint8Array
        const base64Data = dataUrl.split(",")[1];
        if (!base64Data) {
          console.warn(
            "[PHASE 5] Invalid dataUrl format - missing base64 data",
          );
          return;
        }

        // Convert base64 to Uint8Array
        const bytes = this.base64ToUint8Array(base64Data);

        // Create Figma image from bytes
        image = figma.createImage(bytes);
        this.imageObjectCache.set(dataUrl, image);
      }

      const imageHash = image.hash;

      // Create ImagePaint
      const imagePaint: ImagePaint = {
        type: "IMAGE",
        imageHash: imageHash,
        scaleMode: "FILL",
        visible: true,
      };

      // CRITICAL FIX: For containers with children, create a background rectangle instead of replacing fills
      // This prevents the rasterized image from covering child nodes
      if (
        node.type === "FRAME" &&
        "children" in node &&
        node.children.length > 0
      ) {
        const bgRect = figma.createRectangle();
        bgRect.name = `🎨 Rasterized Background (${reason})`;
        bgRect.resize(node.width, node.height);
        bgRect.fills = [imagePaint];
        bgRect.locked = true; // Prevent accidental editing

        // Insert as first child (background layer)
        (node as FrameNode).insertChild(0, bgRect);

        // Clear parent fills to avoid double-rendering
        if ("fills" in node) {
          (node as any).fills = [];
        }

        console.log(
          `[PHASE 5] ✅ Created rasterized background rectangle for container ${data.tagName}`,
          {
            reason,
            childCount: node.children.length,
            imageHash: imageHash.substring(0, 16) + "...",
          },
        );
      } else if ("fills" in node) {
        // For leaf nodes (no children), directly replace fills
        (node as any).fills = [imagePaint];

        console.log(
          `[PHASE 5] ✅ Applied rasterization screenshot to leaf node ${data.tagName}`,
          {
            reason,
            imageHash: imageHash.substring(0, 16) + "...",
          },
        );
      } else {
        console.warn(
          `[PHASE 5] Node type ${node.type} does not support fills - cannot apply rasterization`,
        );
      }
    } catch (err) {
      console.error("[PHASE 5] Failed to apply rasterization:", err);
    }
  }

  private getFontMetricsRatio(
    actualFont: string,
    originalFont: string,
  ): number {
    const fontMetricsMap = new Map<string, number>([
      ["Inter:Arial", 0.98],
      ["Inter:Helvetica", 0.97],
      ["Arial:Inter", 1.02],
      ["Helvetica:Inter", 1.03],
      ["Roboto:Inter", 0.99],
      ["Open Sans:Inter", 1.01],
      ["Lato:Inter", 0.99],
      ["Montserrat:Inter", 1.02],
      ["Source Sans Pro:Inter", 0.98],

      ["Times New Roman:Times", 1.0],
      ["Georgia:Times New Roman", 0.95],

      ["Monaco:Menlo", 1.01],
      ["SF Mono:Monaco", 0.99],
      ["Courier New:Courier", 1.0],
    ]);

    const key = `${originalFont}:${actualFont}`;
    return fontMetricsMap.get(key) || 1.0;
  }

  private parseObjectPositionToTransform(
    objectPosition: string,
  ): [[number, number, number], [number, number, number]] {
    const parts = objectPosition.trim().split(/\s+/);
    let xOffset = 0;
    let yOffset = 0;

    if (parts[0]) {
      if (parts[0] === "left") xOffset = -0.5;
      else if (parts[0] === "right") xOffset = 0.5;
      else if (parts[0] === "center") xOffset = 0;
      else if (parts[0].endsWith("%")) {
        const percent = parseFloat(parts[0]) / 100;
        xOffset = percent - 0.5;
      }
    }

    if (parts[1]) {
      if (parts[1] === "top") yOffset = -0.5;
      else if (parts[1] === "bottom") yOffset = 0.5;
      else if (parts[1] === "center") yOffset = 0;
      else if (parts[1].endsWith("%")) {
        const percent = parseFloat(parts[1]) / 100;
        yOffset = percent - 0.5;
      }
    }

    return [
      [1, 0, xOffset],
      [0, 1, yOffset],
    ];
  }

  private async convertStrokesAsync(strokes: any[]): Promise<Paint[]> {
    console.log(`  ✏️ Converting ${strokes.length} strokes`);
    return strokes.map((stroke) => {
      const color = stroke.color || { r: 0, g: 0, b: 0 };
      const { r, g, b } = color;
      return {
        type: "SOLID",
        color: { r, g, b },
        opacity: stroke.opacity !== undefined ? stroke.opacity : (color.a ?? 1),
        visible: stroke.visible !== false,
      };
    }) as SolidPaint[];
  }

  private convertEffects(effects: any[]): Effect[] {
    return effects.map((effect) => {
      if (effect.type === "DROP_SHADOW") {
        return {
          type: "DROP_SHADOW",
          color: effect.color,
          offset: effect.offset,
          radius: effect.radius,
          spread: effect.spread || 0,
          visible: effect.visible !== false,
          blendMode: effect.blendMode || "NORMAL",
        } as DropShadowEffect;
      }

      if (effect.type === "INNER_SHADOW") {
        return {
          type: "INNER_SHADOW",
          color: effect.color,
          offset: effect.offset,
          radius: effect.radius,
          spread: effect.spread || 0,
          visible: effect.visible !== false,
          blendMode: effect.blendMode || "NORMAL",
        } as InnerShadowEffect;
      }

      if (effect.type === "LAYER_BLUR") {
        return {
          type: "LAYER_BLUR",
          radius: effect.radius,
          visible: effect.visible !== false,
        } as BlurEffect;
      }

      if (effect.type === "BACKGROUND_BLUR") {
        return {
          type: "BACKGROUND_BLUR",
          radius: effect.radius,
          visible: effect.visible !== false,
        } as BlurEffect;
      }

      return effect;
    });
  }

  private getScaleModeFromRepeat(
    repeat?: string,
  ): "FILL" | "FIT" | "CROP" | "TILE" {
    if (!repeat) return "FILL";

    const repeatLower = repeat.toLowerCase().trim();

    if (repeatLower === "repeat" || repeatLower === "repeat repeat") {
      return "TILE";
    }

    if (repeatLower === "repeat-x" || repeatLower === "repeat-y") {
      return "TILE";
    }

    return "FILL";
  }

  private calculateImageTransform(
    position?: { x: string; y: string },
    size?: { width: string; height: string },
    nodeLayout?: { width: number; height: number },
    imageAsset?: { width: number; height: number },
  ): [[number, number, number], [number, number, number]] | undefined {
    if (!position && !size) return undefined;

    let scaleX = 1;
    let scaleY = 1;
    let translateX = 0;
    let translateY = 0;

    if (size && nodeLayout && imageAsset) {
      const { width: sizeWidth, height: sizeHeight } = size;

      if (sizeWidth === "cover") {
        const scaleRatio = Math.max(
          nodeLayout.width / imageAsset.width,
          nodeLayout.height / imageAsset.height,
        );
        scaleX = scaleRatio;
        scaleY = scaleRatio;
      } else if (sizeWidth === "contain") {
        const scaleRatio = Math.min(
          nodeLayout.width / imageAsset.width,
          nodeLayout.height / imageAsset.height,
        );
        scaleX = scaleRatio;
        scaleY = scaleRatio;
      } else {
        scaleX = this.parseSizeValue(
          sizeWidth,
          nodeLayout.width,
          imageAsset.width,
        );
        scaleY = this.parseSizeValue(
          sizeHeight || sizeWidth,
          nodeLayout.height,
          imageAsset.height,
        );
      }
    }

    if (position && nodeLayout && imageAsset) {
      const { x: posX, y: posY } = position;

      const scaledImageWidth = imageAsset.width * scaleX;
      const scaledImageHeight = imageAsset.height * scaleY;

      translateX = this.parsePositionValue(
        posX,
        nodeLayout.width,
        scaledImageWidth,
      );
      translateY = this.parsePositionValue(
        posY,
        nodeLayout.height,
        scaledImageHeight,
      );

      if (imageAsset.width > 0) {
        translateX = translateX / imageAsset.width;
      }
      if (imageAsset.height > 0) {
        translateY = translateY / imageAsset.height;
      }
    }

    return [
      [scaleX, 0, translateX],
      [0, scaleY, translateY],
    ];
  }

  private parseSizeValue(
    value: string,
    containerSize: number,
    imageSize: number,
  ): number {
    const trimmed = value.trim().toLowerCase();

    if (trimmed === "auto") {
      return 1;
    }

    if (trimmed.endsWith("%")) {
      const percentage = parseFloat(trimmed);
      return (containerSize * (percentage / 100)) / imageSize;
    }

    if (trimmed.endsWith("px")) {
      const pixels = parseFloat(trimmed);
      return pixels / imageSize;
    }

    const num = parseFloat(trimmed);
    if (!isNaN(num)) {
      return num / imageSize;
    }

    return 1;
  }

  private parsePositionValue(
    value: string,
    containerSize: number,
    imageSize: number,
  ): number {
    const trimmed = value.trim().toLowerCase();

    const keywordMap: Record<string, number> = {
      left: 0,
      top: 0,
      center: 0.5,
      right: 1,
      bottom: 1,
    };

    if (trimmed in keywordMap) {
      const ratio = keywordMap[trimmed];
      return (containerSize - imageSize) * ratio;
    }

    if (trimmed.endsWith("%")) {
      const percentage = parseFloat(trimmed) / 100;
      return (containerSize - imageSize) * percentage;
    }

    if (trimmed.endsWith("px")) {
      return parseFloat(trimmed);
    }

    const num = parseFloat(trimmed);
    if (!isNaN(num)) {
      return num;
    }

    return 0;
  }

  private async fetchImageViaProxy(
    url: string,
  ): Promise<{ bytes: Uint8Array; contentType?: string }> {
    try {
      const result = await fetchWithProxy(url);

      console.log(
        `  ✅ [PROXY] Successfully fetched image via proxy (${result.bytes.length} bytes, type: ${result.contentType})`,
      );

      this.imageFetchCache.set(url, result.bytes);
      // Note: we don't cache contentType in the bytes cache yet, but it's returned for immediate use
      return result;
    } catch (error) {
      console.error(
        `❌ [PROXY FAILED] All handoff server proxies failed for image fetch.`,
      );
      console.error(`   URL: ${url.substring(0, 60)}...`);
      console.error(`   DIAGNOSIS:`);
      console.error(
        `     1. Ensure handoff server is running: node handoff-server.cjs`,
      );
      console.error(
        `     2. Check server is accessible: curl http://localhost:4411/api/health`,
      );

      throw error;
    }
  }

  private isExternalUrl(url: string): boolean {
    // Data URLs and blob URLs are not external
    if (url.startsWith("data:") || url.startsWith("blob:")) {
      return false;
    }
    // For Figma plugin, all http/https URLs are external (plugin runs in sandbox)
    return url.startsWith("http://") || url.startsWith("https://");
  }

  private async fetchImage(
    url: string,
  ): Promise<{ bytes: Uint8Array; contentType?: string }> {
    if (this.imageFetchCache.has(url)) {
      return { bytes: this.imageFetchCache.get(url)! };
    }

    // For external URLs, skip direct fetch and use proxy immediately (avoids CORS)
    if (this.isExternalUrl(url)) {
      console.log(
        `  🔄 [PROXY] External URL detected, using proxy: ${url.substring(
          0,
          60,
        )}...`,
      );
      return this.fetchImageViaProxy(url);
    }

    // For data URLs and blob URLs, try direct fetch (no CORS issues)
    try {
      let signal: AbortSignal | undefined;
      let timeoutId: any;
      if (typeof AbortController !== "undefined") {
        const controller = new AbortController();
        timeoutId = setTimeout(() => controller.abort(), 8000); // 8s timeout (reduced)
        signal = controller.signal;
      }

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
      if (timeoutId) clearTimeout(timeoutId);

      if (response.ok) {
        const contentType = response.headers.get("content-type") || undefined;
        const arrayBuffer = await response.arrayBuffer();
        const bytes = new Uint8Array(arrayBuffer);
        this.imageFetchCache.set(url, bytes);
        return { bytes, contentType };
      }
      throw new Error(`HTTP ${response.status}`);
    } catch (directError) {
      // If direct fetch fails for data/blob URLs, try proxy as last resort
      console.warn(
        `  ⚠️ Direct fetch failed for ${url.substring(
          0,
          60,
        )}..., trying proxy:`,
        directError instanceof Error
          ? directError.message
          : String(directError),
      );
      return this.fetchImageViaProxy(url);
    }
  }

  private uint8ToBase64(bytes: Uint8Array): string {
    // Pure JavaScript base64 encoding - works in Figma's sandbox where btoa is unavailable
    const BASE64_CHARS =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let result = "";
    const len = bytes.length;

    for (let i = 0; i < len; i += 3) {
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

  private isWebpBytes(bytes: Uint8Array): boolean {
    // "RIFF"...."WEBP"
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
    // ISO BMFF: size(4) + 'ftyp'(4) + majorBrand(4)
    if (!bytes || bytes.length < 16) return false;
    const isFtyp =
      bytes[4] === 0x66 && // f
      bytes[5] === 0x74 && // t
      bytes[6] === 0x79 && // y
      bytes[7] === 0x70; // p
    if (!isFtyp) return false;
    const brand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
    return brand === "avif" || brand === "avis";
  }

  private async transcodeIfUnsupportedRaster(
    bytes: Uint8Array,
    mimeHint?: string,
    targetWidth?: number,
    targetHeight?: number,
  ): Promise<Uint8Array> {
    const hint = (mimeHint || "").toLowerCase();
    if (this.isAvifBytes(bytes) || hint.includes("avif")) {
      return requestImageTranscode(
        this.uint8ToBase64(bytes),
        "image/avif",
        targetWidth,
        targetHeight,
      );
    }
    if (this.isWebpBytes(bytes) || hint.includes("webp")) {
      return this.transcodeWebpWithRetry(this.uint8ToBase64(bytes), 2);
    }
    return bytes;
  }

  private getPlaceholderColor(data: any): RGBA {
    const defaultColor: RGBA = { r: 0.92, g: 0.92, b: 0.92, a: 1 };

    if (
      data?.imageHash &&
      this.assets?.images?.[data.imageHash]?.placeholderColor
    ) {
      const c = this.assets.images[data.imageHash].placeholderColor as any;
      if (
        typeof c.r === "number" &&
        typeof c.g === "number" &&
        typeof c.b === "number"
      ) {
        return { r: c.r, g: c.g, b: c.b, a: c.a !== undefined ? c.a : 1 };
      }
    }

    // CRITICAL FIX: Actually parse and return the background color if it exists
    // Check multiple sources: style.backgroundColor, backgroundColor, fillColor, cssVariables
    const bg =
      data?.style?.backgroundColor ||
      data?.backgroundColor ||
      data?.fillColor ||
      (data?.cssVariables &&
        Object.values(data.cssVariables).find(
          (v: any) =>
            typeof v === "string" &&
            (v.includes("rgb") || v.includes("#") || v.includes("hsl")),
        ));

    if (bg && typeof bg === "string") {
      const parsedColor = this.parseColorString(bg);
      if (parsedColor) {
        console.log(
          `  🎨 [getPlaceholderColor] Extracted color from ${data.name}:`,
          {
            source: data.style?.backgroundColor
              ? "style"
              : data.backgroundColor
                ? "direct"
                : "cssVariable",
            color: bg,
          },
        );
        return parsedColor;
      }
    }

    return defaultColor;
  }

  private findFirstImageHash(nodeData: any): string | undefined {
    if (!nodeData) return undefined;

    const fills = nodeData.fills || nodeData.backgrounds;
    if (Array.isArray(fills)) {
      for (const f of fills) {
        const fill = f?.fill || f;
        if (fill?.type === "IMAGE" && typeof fill.imageHash === "string") {
          return fill.imageHash;
        }
      }
    }

    if (nodeData.imageHash && typeof nodeData.imageHash === "string") {
      return nodeData.imageHash;
    }

    if (Array.isArray(nodeData.children)) {
      for (const child of nodeData.children) {
        const hash = this.findFirstImageHash(child);
        if (hash) return hash;
      }
    }

    return undefined;
  }

  private getBasicParentColor(nodeData: any): RGBA | undefined {
    // For now, this is a simplified approach that checks for common parent color patterns
    // without full schema traversal. This provides a basic safety net for inheritance.

    if (!nodeData) {
      return undefined;
    }

    try {
      // Check if the node has inheritance hints that we can use
      if (nodeData.colorInheritance?.backgroundColorSource === "inherited") {
        // If DOM extraction already marked this as inherited, try to extract the effective color
        if (nodeData.colorInheritance.effectiveColor) {
          const color = this.parseColorString(
            nodeData.colorInheritance.effectiveColor,
          );
          if (color && color.a > 0.05) {
            console.log(
              `  🔗 [BASIC-INHERITANCE] Using effective inherited color for ${nodeData.name}: ${nodeData.colorInheritance.effectiveColor}`,
            );
            return color;
          }
        }
      }

      // Check for common container background patterns
      if (nodeData.tagName) {
        const tagName = nodeData.tagName.toLowerCase();

        // For text elements, try to find a reasonable parent background
        if (
          ["span", "p", "h1", "h2", "h3", "h4", "h5", "h6", "li"].includes(
            tagName,
          )
        ) {
          // Use a light background as fallback for text elements without explicit colors
          // This prevents pure white text on transparent backgrounds
          return { r: 0.98, g: 0.98, b: 0.98, a: 0.8 };
        }
      }
    } catch (error) {
      console.warn("Error in getBasicParentColor:", error);
    }

    return undefined;
  }

  private shouldUseAutoLayoutForNode(data: any): boolean {
    // Skip auto-layout for elements that need precise pixel positioning
    if (this.requiresPrecisePositioning(data)) {
      return false;
    }

    // Use auto-layout for container elements with layout properties
    if (data.layout?.display === "flex" || data.layout?.display === "grid") {
      return true;
    }

    // Use auto-layout for YouTube-specific containers that benefit from responsive layout
    if (this.isYouTubeLayoutContainer(data)) {
      return true;
    }

    // Use auto-layout if schema already determined it's safe
    if (data.autoLayout?.validation?.safe === true) {
      return true;
    }

    // Default to absolute positioning for pixel-perfect accuracy
    return false;
  }

  private requiresPrecisePositioning(data: any): boolean {
    // Media elements need precise positioning
    if (data.type === "IMAGE" || data.type === "VIDEO") {
      return true;
    }

    // YouTube video player needs precise positioning
    if (
      data.htmlTag === "video" ||
      (data.name && data.name.includes("video player"))
    ) {
      return true;
    }

    // Elements with complex transforms need precise positioning
    if (
      data.layoutContext?.transform &&
      data.layoutContext.transform !== "none"
    ) {
      return true;
    }

    // Absolutely positioned elements in CSS should stay absolute in Figma
    if (
      data.layoutContext?.position === "absolute" ||
      data.layoutContext?.position === "fixed"
    ) {
      return true;
    }

    return false;
  }

  private isYouTubeLayoutContainer(data: any): boolean {
    // YouTube app container
    if (data.htmlTag === "ytd-app" || data.name === "ytd-app") {
      return true;
    }

    // Main content areas that benefit from responsive layout
    const containerClasses = [
      "ytd-page-manager",
      "ytd-watch-flexy",
      "ytd-two-column-browse-results-renderer",
    ];
    if (
      data.cssClasses?.some((cls: string) => containerClasses.includes(cls))
    ) {
      return true;
    }

    // Primary content containers
    if (
      data.layout?.display === "flex" &&
      data.layout?.flexDirection === "row" &&
      data.layout?.gap !== "normal"
    ) {
      return true;
    }

    return false;
  }

  private getLayoutReason(data: any): string {
    if (this.requiresPrecisePositioning(data)) {
      return "requires precise positioning";
    }
    if (!data.autoLayout) {
      return "no auto-layout data";
    }
    if (data.autoLayout?.validation?.safe === false) {
      return "failed validation";
    }
    return "default absolute positioning";
  }

  // PROFESSIONAL: Layout solver instance for advanced positioning
  private professionalLayoutSolver = new ProfessionalLayoutSolver();

  /**
   * PROFESSIONAL: Sub-pixel precision coordinate normalization
   * Uses professional 0.01px precision for maximum accuracy
   * Comparable to html2design and builder.io plugins
   */
  private roundForPixelPerfection(value: number): number {
    if (!isFinite(value)) return 0;

    // PROFESSIONAL: Use sub-pixel precision from layout solver
    return this.professionalLayoutSolver.handleSubPixelPrecision(value);
  }

  /**
   * COMPREHENSIVE COORDINATE VALIDATOR: Validates and normalizes layout coordinates
   * Implements comprehensive validation found necessary by data quality analysis
   */
  private validateAndNormalizeCoordinates(layout: any): {
    x: number;
    y: number;
    width: number;
    height: number;
    isValid: boolean;
    errors: string[];
  } {
    const errors: string[] = [];

    // Extract and validate coordinates
    const x = typeof layout?.x === "number" ? layout.x : 0;
    const y = typeof layout?.y === "number" ? layout.y : 0;
    const width = typeof layout?.width === "number" ? layout.width : 1;
    const height = typeof layout?.height === "number" ? layout.height : 1;

    // Validate coordinate ranges
    if (!isFinite(x) || !isFinite(y)) {
      errors.push(`Invalid position coordinates: x=${x}, y=${y}`);
    }
    if (!isFinite(width) || !isFinite(height) || width <= 0 || height <= 0) {
      errors.push(`Invalid dimensions: width=${width}, height=${height}`);
    }

    // Normalize coordinates
    const normalizedX = this.roundForPixelPerfection(x);
    const normalizedY = this.roundForPixelPerfection(y);
    const normalizedWidth = Math.max(this.roundForPixelPerfection(width), 0.01);
    const normalizedHeight = Math.max(
      this.roundForPixelPerfection(height),
      0.01,
    );

    return {
      x: normalizedX,
      y: normalizedY,
      width: normalizedWidth,
      height: normalizedHeight,
      isValid: errors.length === 0,
      errors,
    };
  }

  public parseColorString(value?: string): RGBA | undefined {
    if (!value || typeof value !== "string") return undefined;

    // PHASE 2: Cache color parsing results
    if (this.colorParseCache.has(value)) {
      return this.colorParseCache.get(value) || undefined;
    }

    const trimmed = value.trim();
    const lower = trimmed.toLowerCase(); // parseColorToRGBA handles case

    // Use shared parser for standard formats (hex, rgb, rgba, transparent)
    const parsed = parseColorToRGBA(trimmed);
    if (parsed) {
      // CRITICAL FIX: Only skip completely transparent colors
      // Match threshold with DOM extractor to prevent capture/import mismatches
      if (parsed.a <= 0.001) {
        this.colorParseCache.set(value, null);
        return undefined;
      }

      const result = {
        r: Math.round(parsed.r * 255) / 255,
        g: Math.round(parsed.g * 255) / 255,
        b: Math.round(parsed.b * 255) / 255,
        a: parsed.a,
      };
      this.colorParseCache.set(value, result);
      return result;
    }

    // Note: Modern CSS color formats (oklch, oklab, lch, lab, color-mix) should be
    // converted to rgb/rgba by the chrome extension's parseColorSafe function.
    // If we receive them here, it means the extension didn't convert them properly.
    // In that case, we return undefined and let the fallback logic handle it.
    if (/^(oklch|oklab|lch|lab|color-mix)\(/i.test(trimmed)) {
      console.warn(
        `⚠️ [parseColorString] Received modern color format in plugin context: ${trimmed}. This should have been converted by the extension.`,
      );
      return undefined;
    }

    // Handle hsl/hsla (convert to rgb)
    const hslMatch =
      /^hsla?\(\s*(\d+)\s*,\s*(\d+)%\s*,\s*(\d+)%(?:\s*,\s*(\d*\.?\d+))?\s*\)$/i.exec(
        trimmed,
      );
    if (hslMatch) {
      const h = parseInt(hslMatch[1], 10) / 360;
      const s = parseInt(hslMatch[2], 10) / 100;
      const l = parseInt(hslMatch[3], 10) / 100;
      const a = hslMatch[4]
        ? Math.max(0, Math.min(1, parseFloat(hslMatch[4])))
        : 1;
      if (a <= 0.001) return undefined;

      // Convert HSL to RGB
      const c = (1 - Math.abs(2 * l - 1)) * s;
      const x = c * (1 - Math.abs(((h * 6) % 2) - 1));
      const m = l - c / 2;

      let r = 0,
        g = 0,
        b = 0;
      if (h < 1 / 6) {
        r = c;
        g = x;
        b = 0;
      } else if (h < 2 / 6) {
        r = x;
        g = c;
        b = 0;
      } else if (h < 3 / 6) {
        r = 0;
        g = c;
        b = x;
      } else if (h < 4 / 6) {
        r = 0;
        g = x;
        b = c;
      } else if (h < 5 / 6) {
        r = x;
        g = 0;
        b = c;
      } else {
        r = c;
        g = 0;
        b = x;
      }

      return {
        r: Math.max(0, Math.min(1, r + m)),
        g: Math.max(0, Math.min(1, g + m)),
        b: Math.max(0, Math.min(1, b + m)),
        a: a,
      };
    }

    // Handle named colors (common CSS color names)
    const namedColors: Record<string, RGBA> = {
      black: { r: 0, g: 0, b: 0, a: 1 },
      white: { r: 1, g: 1, b: 1, a: 1 },
      red: { r: 1, g: 0, b: 0, a: 1 },
      green: { r: 0, g: 0.5, b: 0, a: 1 },
      blue: { r: 0, g: 0, b: 1, a: 1 },
      yellow: { r: 1, g: 1, b: 0, a: 1 },
      cyan: { r: 0, g: 1, b: 1, a: 1 },
      magenta: { r: 1, g: 0, b: 1, a: 1 },
      gray: { r: 0.5, g: 0.5, b: 0.5, a: 1 },
      grey: { r: 0.5, g: 0.5, b: 0.5, a: 1 },
      orange: { r: 1, g: 0.65, b: 0, a: 1 },
      pink: { r: 1, g: 0.75, b: 0.8, a: 1 },
      purple: { r: 0.5, g: 0, b: 0.5, a: 1 },
      brown: { r: 0.65, g: 0.16, b: 0.16, a: 1 },
    };
    if (namedColors[lower]) {
      return namedColors[lower];
    }

    return undefined;
  }

  private async createFigmaImageFromAsset(
    asset: any,
    hash: string,
    targetWidth?: number,
    targetHeight?: number,
  ): Promise<Image | null> {
    // ⚡️ PERFORMANCE FIX: Check object cache first to avoid redundant decode/createImage calls
    if (this.imageObjectCache.has(hash)) {
      return this.imageObjectCache.get(hash)!;
    }

    let base64Candidate: string | undefined =
      asset?.data || asset?.base64 || asset?.screenshot;
    const url = asset?.url;
    const isWebpAsset =
      asset?.mimeType === "image/webp" ||
      asset?.contentType === "image/webp" ||
      (typeof url === "string" && url.toLowerCase().includes(".webp"));
    const isAvifAsset =
      asset?.mimeType === "image/avif" ||
      asset?.contentType === "image/avif" ||
      (typeof url === "string" && url.toLowerCase().includes(".avif"));
    let isSvgAsset =
      (asset && asset.mimeType && asset.mimeType.includes("svg")) ||
      (asset && asset.contentType && asset.contentType.includes("svg")) ||
      (typeof url === "string" && url.toLowerCase().includes(".svg")) ||
      !!(asset && asset.svgCode);

    if (!isSvgAsset && base64Candidate) {
      const { payload, mimeTypeHint } =
        this.extractDataUrlParts(base64Candidate);
      const clean = this.normalizeBase64Payload(payload);
      if (this.isSvgPayload(clean, payload, mimeTypeHint)) {
        isSvgAsset = true;
      }
    }

    // Handle SVG by rasterizing via Figma before falling back to normal image path
    if (isSvgAsset) {
      try {
        let svgMarkup: string | null = asset?.svgCode || null;
        if (!svgMarkup && base64Candidate) {
          try {
            svgMarkup = await this.base64ToString(base64Candidate, {
              allowSvg: true,
            });
          } catch (decodeError) {
            console.warn(
              "SVG base64 decode failed, will try fetch",
              decodeError,
            );
          }
        }
        if (!svgMarkup && url) {
          try {
            // Use fetchImage which automatically routes external URLs to proxy
            const { bytes } = await this.fetchImage(url);
            svgMarkup = await this.uint8ToString(bytes);
          } catch (fetchError) {
            console.warn("SVG fetch failed", fetchError);
          }
        }

        if (svgMarkup) {
          // Inline external <use> references so sprite-based icons render
          // PERF-FIX: Yield before heavy SVG manipulation
          await new Promise((r) => setTimeout(r, 0));
          const inlinedMarkup = await this.inlineSvgUsesInPlugin(
            svgMarkup,
            url,
          );
          // PERF-FIX: Yield again before Figma's synchronous SVG parsing
          await new Promise((r) => setTimeout(r, 0));
          const vectorRoot = figma.createNodeFromSvg(inlinedMarkup);
          // Resize to expected dimensions if provided
          if (
            typeof asset?.width === "number" &&
            typeof asset?.height === "number" &&
            asset.width > 0 &&
            asset.height > 0
          ) {
            vectorRoot.resize(asset.width, asset.height);
          }
          // PERF-FIX: Yield before exportAsync (marks control back to Figma UI)
          await new Promise((r) => setTimeout(r, 0));
          const pngBytes = await vectorRoot.exportAsync({ format: "PNG" });
          vectorRoot.remove();
          const image = figma.createImage(pngBytes);
          this.imageObjectCache.set(hash, image);
          return image;
        }
      } catch (svgError) {
        console.warn(
          `❌ SVG rasterization failed for ${hash}, falling back to standard flow`,
          svgError,
        );
      }
    }

    const mimeHint =
      (typeof asset?.mimeType === "string" && asset.mimeType) ||
      (typeof asset?.contentType === "string" && asset.contentType) ||
      "";

    let imageBytes: Uint8Array | undefined;
    let triedUrl = false;
    if (base64Candidate) {
      try {
        // Deterministic: Figma createImage may not support AVIF (and sometimes WebP); transcode to PNG via UI.
        if (isAvifAsset) {
          const payload = base64Candidate.includes(",")
            ? base64Candidate.split(",")[1]
            : base64Candidate;
          imageBytes = await requestImageTranscode(
            payload,
            "image/avif",
            targetWidth,
            targetHeight,
          );
        } else if (isWebpAsset) {
          // Keep existing WebP path (uses retries + UI canvas).
          imageBytes = await this.base64ToImageBytes(base64Candidate, true);
        } else {
          imageBytes = await this.base64ToImageBytes(base64Candidate, false);
        }

        if (imageBytes?.length) {
          imageBytes = await this.transcodeIfUnsupportedRaster(
            imageBytes,
            mimeHint,
            targetWidth,
            targetHeight,
          );
        }
      } catch (error) {
        console.warn(
          `❌ base64 decode failed for ${hash}, will retry/transcode if possible`,
          error,
        );
      }
    }

    if (!imageBytes && url) {
      try {
        triedUrl = true;
        console.log(
          `  🔄 [FIGMA] Asset has URL fallback, trying fetch: ${url}`,
        );
        const { bytes: b, contentType: ct } = await this.fetchImage(url);
        imageBytes = b;
        if (imageBytes?.length) {
          imageBytes = await this.transcodeIfUnsupportedRaster(
            imageBytes,
            ct || mimeHint,
            targetWidth,
            targetHeight,
          );
        }
        console.log(`  ✅ Fetched bytes from URL: ${imageBytes.length}`);
      } catch (error) {
        console.warn(`  ❌ fetchImage failed for ${hash} (${url})`, error);
      }
    }

    if (!imageBytes && base64Candidate) {
      try {
        imageBytes = await this.base64ToImageBytes(base64Candidate, true);
      } catch (error) {
        console.warn(`❌ forced WebP transcode failed for ${hash}`, error);
      }
    }

    if (!imageBytes || !imageBytes.length) {
      console.warn(`❌ No image bytes available for ${hash}`);
      return null;
    }

    try {
      const image = figma.createImage(imageBytes);
      this.imageObjectCache.set(hash, image);
      return image;
    } catch (error: any) {
      const message = error?.message || String(error);
      console.warn(
        `❌ createImage failed for ${hash}: ${message} (bytes=${imageBytes.length})`,
      );

      // If we haven't tried URL fallback yet, do so now (CDNs often serve a more compatible format).
      if (url && !triedUrl) {
        try {
          triedUrl = true;
          const { bytes: fetchedBytes, contentType: fetchedContentType } =
            await this.fetchImage(url);
          const supported = await this.transcodeIfUnsupportedRaster(
            fetchedBytes,
            fetchedContentType || mimeHint,
            targetWidth,
            targetHeight,
          );
          const image = figma.createImage(supported);
          this.imageObjectCache.set(hash, image);
          console.log(`✅ createImage succeeded via URL fallback for ${hash}`);
          return image;
        } catch (urlFallbackError) {
          console.warn(
            `❌ URL fallback also failed for ${hash}`,
            urlFallbackError,
          );
        }
      }

      if (base64Candidate && message.toLowerCase().includes("unsupported")) {
        try {
          const hint = mimeHint.toLowerCase();
          let transBytes: Uint8Array | null = null;
          if (hint.includes("avif")) {
            const payload = base64Candidate.includes(",")
              ? base64Candidate.split(",")[1]
              : base64Candidate;
            transBytes = await requestImageTranscode(payload, "image/avif");
          } else {
            // Default to WebP transcode (best-effort) for unknown unsupported types.
            transBytes = await this.base64ToImageBytes(base64Candidate, true);
          }
          if (transBytes?.length) {
            const image = figma.createImage(transBytes);
            this.imageObjectCache.set(hash, image);
            console.log(`✅ createImage succeeded after transcode for ${hash}`);
            return image;
          }
        } catch (fallbackError) {
          console.warn(
            `❌ createImage still failed after transcode for ${hash}`,
            fallbackError,
          );
        }
      }
      return null;
    }
  }

  private isLikelyWebpBase64(clean: string): boolean {
    return clean.startsWith("UklG") || clean.includes("WEBP");
  }

  private async transcodeWebpWithRetry(
    base64: string,
    retries: number = 2,
  ): Promise<Uint8Array> {
    let lastError: any;
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const pngBytes = await requestWebpTranscode(base64);
        if (pngBytes && pngBytes.length > 0) {
          return pngBytes;
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

  private extractDataUrlParts(value: string): {
    payload: string;
    mimeTypeHint?: string;
    isBase64: boolean;
  } {
    if (typeof value !== "string") {
      return { payload: "", mimeTypeHint: undefined, isBase64: false };
    }

    if (!value.startsWith("data:")) {
      return { payload: value, mimeTypeHint: undefined, isBase64: true };
    }

    const commaIndex = value.indexOf(",");
    const meta = value.substring(5, commaIndex === -1 ? undefined : commaIndex);
    const payload = commaIndex === -1 ? "" : value.substring(commaIndex + 1);
    const parts = meta.split(";");
    const mimeTypeHint = parts[0] || undefined;
    const isBase64 = parts.includes("base64");

    return { payload, mimeTypeHint, isBase64 };
  }

  private safeDecodeUriComponent(value: string): string {
    if (typeof value !== "string") return "";
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }

  private normalizeBase64Payload(payload: string): string {
    if (typeof payload !== "string") return "";

    // PERF-FIX: Avoid multiple global regex passes on potentially huge strings.
    // Instead, do a single pass to strip whitespace and data URL prefixes.
    let cleanPayload = payload.trim();
    if (cleanPayload.startsWith("data:")) {
      const commaIndex = cleanPayload.indexOf(",");
      if (commaIndex !== -1) {
        cleanPayload = cleanPayload.substring(commaIndex + 1);
      }
    }

    // Single pass to remove all whitespace and invalid characters efficiently
    // This is much faster than .replace(/\s/g, '').replace(/-/g, '+')...
    let result = "";
    for (let i = 0; i < cleanPayload.length; i++) {
      const char = cleanPayload[i];
      // Skip whitespace
      if (char <= " ") continue;
      // Normalize URL-safe base64
      if (char === "-") {
        result += "+";
      } else if (char === "_") {
        result += "/";
      } else if (
        (char >= "A" && char <= "Z") ||
        (char >= "a" && char <= "z") ||
        (char >= "0" && char <= "9") ||
        char === "+" ||
        char === "/" ||
        char === "="
      ) {
        result += char;
      }
    }

    // Ensure proper padding
    while (result.length % 4 !== 0) {
      result += "=";
    }

    return result;
  }

  private isSvgPayload(
    normalizedBase64: string,
    rawPayload?: string,
    mimeTypeHint?: string,
  ): boolean {
    if (mimeTypeHint && mimeTypeHint.toLowerCase().includes("svg")) {
      return true;
    }
    const raw = rawPayload || "";
    const trimmedRaw = raw.trim();
    if (trimmedRaw.startsWith("<svg") || trimmedRaw.startsWith("<?xml")) {
      return true;
    }
    const clean = normalizedBase64.trim();
    return (
      clean.startsWith("PHN2Zy") ||
      clean.startsWith("PD94bW") ||
      clean.startsWith("c3Zn")
    );
  }

  private stringToUint8Array(value: string): Uint8Array {
    if (typeof TextEncoder !== "undefined") {
      return new TextEncoder().encode(value);
    }
    const bytes = new Uint8Array(value.length);
    for (let i = 0; i < value.length; i++) {
      bytes[i] = value.charCodeAt(i);
    }
    return bytes;
  }

  private async extractSvgMarkup(asset: any): Promise<string | null> {
    const mimeHint = asset?.mimeType || asset?.contentType;
    const rawSource =
      typeof asset?.data === "string"
        ? asset.data
        : typeof asset?.base64 === "string"
          ? asset.base64
          : typeof asset?.screenshot === "string"
            ? asset.screenshot
            : typeof asset?.url === "string" && asset.url.startsWith("data:")
              ? asset.url
              : undefined;

    if (!rawSource) return null;

    const { payload, mimeTypeHint, isBase64 } =
      this.extractDataUrlParts(rawSource);
    const mime = mimeHint || mimeTypeHint;
    const isSvgMime = mime ? mime.toLowerCase().includes("svg") : false;
    const combinedPayload = rawSource.startsWith("data:") ? payload : rawSource;

    if (isSvgMime && combinedPayload) {
      try {
        if (!isBase64 && combinedPayload.trim().startsWith("<")) {
          return combinedPayload;
        }
        return await this.base64ToString(combinedPayload, { allowSvg: true });
      } catch (error) {
        console.warn("Failed to decode SVG data URL", error);
      }
    }

    const looksLikeSvg = this.isSvgPayload(
      this.normalizeBase64Payload(combinedPayload),
      combinedPayload,
      mime,
    );
    if (!looksLikeSvg) {
      return null;
    }

    if (combinedPayload.trim().startsWith("<")) {
      return combinedPayload;
    }

    try {
      return await this.base64ToString(combinedPayload, { allowSvg: true });
    } catch (error) {
      const decoded = this.safeDecodeUriComponent(combinedPayload);
      if (decoded.trim().startsWith("<")) {
        return decoded;
      }
      console.warn("Unable to decode suspected SVG payload", error);
      return null;
    }
  }

  private createVectorFromSvgMarkup(
    svgString: string,
    data: any,
  ): SceneNode | null {
    // CRITICAL SAFETY CHECK: Skip massive SVGs to prevent WASM memory crashes
    // Figma's createNodeFromSvg engine crashes with "memory access out of bounds" on huge strings
    const MAX_SVG_LENGTH = 300000; // 300KB limit
    if (svgString && svgString.length > MAX_SVG_LENGTH) {
      console.warn(
        `⚠️ [SVG] Skipping massive SVG content (${(
          svgString.length / 1024
        ).toFixed(1)} KB) for ${
          data.name || "Vector"
        }. Will fallback to raster image.`,
      );
      return null;
    }

    try {
      // FIX: Resolve 'currentColor' using the node's fill color
      // This fixes icons that rely on CSS color inheritance
      let processedSvg = svgString;
      if (processedSvg.match(/currentcolor/i)) {
        let replacementColor = "#000000"; // Default fallback

        // Try to get color from fills
        if (data?.fills && Array.isArray(data.fills) && data.fills.length > 0) {
          const fill = data.fills.find(
            (f: any) => f.type === "SOLID" && f.visible !== false,
          );
          if (fill && fill.color) {
            const { r, g, b, a } = fill.color;
            // Use rgba for full fidelity including alpha
            replacementColor = `rgba(${Math.round(r * 255)}, ${Math.round(
              g * 255,
            )}, ${Math.round(b * 255)}, ${a !== undefined ? a : 1})`;
            console.log(
              `🎨 [SVG] Replaced currentColor with ${replacementColor} for ${data.name}`,
            );
          }
        } else if (data?.style?.color) {
          // Fallback to style.color if available
          replacementColor = data.style.color;
        }

        processedSvg = processedSvg.replace(/currentcolor/gi, replacementColor);
      }

      const {
        svg: resolvedSvg,
        replaced,
        unresolved,
      } = this.resolveSvgCssVarFallbacks(processedSvg);

      if (replaced > 0 || unresolved > 0) {
        console.log(
          `  🧩 [SVG] Resolved CSS var() in ${data?.name || "Vector"}:`,
          { replaced, unresolved },
        );
      }

      const vectorRoot = figma.createNodeFromSvg(resolvedSvg);
      vectorRoot.name = data?.name || "Vector";

      const targetWidth = data?.layout?.width;
      const targetHeight = data?.layout?.height;
      if (
        typeof targetWidth === "number" &&
        typeof targetHeight === "number" &&
        targetWidth > 0 &&
        targetHeight > 0
      ) {
        const needsResize =
          Math.abs(vectorRoot.width - targetWidth) > 0.1 ||
          Math.abs(vectorRoot.height - targetHeight) > 0.1;
        if (needsResize) {
          vectorRoot.resize(targetWidth, targetHeight);
        }
      }

      return vectorRoot;
    } catch (error) {
      console.warn("Failed to create vector from SVG markup", error);
      return null;
    }
  }

  private resolveSvgCssVarFallbacks(svgMarkup: string): {
    svg: string;
    replaced: number;
    unresolved: number;
  } {
    const input = typeof svgMarkup === "string" ? svgMarkup : String(svgMarkup);
    const len = input.length;
    let replaced = 0;
    let unresolved = 0;

    const isWhitespace = (ch: string) =>
      ch === " " || ch === "\t" || ch === "\n" || ch === "\r";

    const findVarCall = (start: number): number => {
      for (let i = start; i < len - 3; i++) {
        const c = input[i];
        if (c !== "v" && c !== "V") continue;
        const maybe = input.slice(i, i + 3).toLowerCase();
        if (maybe !== "var") continue;
        let j = i + 3;
        while (j < len && isWhitespace(input[j])) j++;
        if (input[j] === "(") return i;
      }
      return -1;
    };

    let out = "";
    let i = 0;
    while (i < len) {
      const idx = findVarCall(i);
      if (idx === -1) {
        out += input.slice(i);
        break;
      }

      out += input.slice(i, idx);

      // Advance to the opening paren after `var`
      let j = idx + 3;
      while (j < len && isWhitespace(input[j])) j++;
      if (input[j] !== "(") {
        out += input.slice(idx, j);
        i = j;
        continue;
      }

      const openParen = j;
      j++;
      let depth = 1;
      while (j < len && depth > 0) {
        const ch = input[j];
        if (ch === "(") depth++;
        else if (ch === ")") depth--;
        j++;
      }
      if (depth !== 0) {
        // Unbalanced; keep as-is.
        out += input.slice(idx);
        unresolved++;
        break;
      }

      const inner = input.slice(openParen + 1, j - 1);
      // Split `inner` at the first top-level comma to find a fallback.
      let commaIndex = -1;
      let innerDepth = 0;
      for (let k = 0; k < inner.length; k++) {
        const ch = inner[k];
        if (ch === "(") innerDepth++;
        else if (ch === ")") innerDepth = Math.max(0, innerDepth - 1);
        else if (ch === "," && innerDepth === 0) {
          commaIndex = k;
          break;
        }
      }

      if (commaIndex === -1) {
        // No fallback; replace with currentColor to keep the SVG visible.
        out += "currentColor";
        replaced++;
      } else {
        const fallback = inner.slice(commaIndex + 1).trim();
        if (fallback) {
          out += fallback;
          replaced++;
        } else {
          out += input.slice(idx, j);
          unresolved++;
        }
      }

      i = j;
    }

    return { svg: out, replaced, unresolved };
  }

  private async base64ToImageBytes(
    base64: string,
    forceWebp = false,
  ): Promise<Uint8Array> {
    const parts = this.extractDataUrlParts(base64);
    const payload = parts.payload;
    const clean = this.normalizeBase64Payload(payload);

    if (this.isSvgPayload(clean, payload, parts.mimeTypeHint) && !forceWebp) {
      throw new Error("SVG payload detected - not a raster image");
    }

    if (forceWebp || this.isLikelyWebpBase64(clean)) {
      try {
        const pngBytes = await this.transcodeWebpWithRetry(clean);
        if (pngBytes && pngBytes.length > 0) {
          return pngBytes;
        }
        console.warn("⚠️ WebP transcode returned empty result");
      } catch (error) {
        console.warn("❌ WebP transcode failed, cannot create image", error);
        if (!forceWebp) {
          return this.base64ToUint8Array(clean);
        }
        throw error;
      }
    }

    return this.base64ToUint8Array(clean);
  }

  private base64ToUint8Array(base64: string, allowSvg = false): Uint8Array {
    try {
      if (typeof base64 !== "string") {
        throw new Error(`Expected string for base64, got ${typeof base64}`);
      }

      const { payload, mimeTypeHint, isBase64 } =
        this.extractDataUrlParts(base64);
      const decodedPayload = this.safeDecodeUriComponent(payload);
      const clean = this.normalizeBase64Payload(decodedPayload);

      if (this.isSvgPayload(clean, decodedPayload, mimeTypeHint)) {
        if (!allowSvg) {
          console.warn(
            "⚠️ Detected SVG content in image asset. Figma createImage does not support SVGs.",
          );
          throw new Error(
            "SVG content detected - cannot create raster image from SVG data",
          );
        }
        if (!isBase64 && decodedPayload.trim().startsWith("<")) {
          return this.stringToUint8Array(decodedPayload);
        }
      }

      if (
        typeof figma !== "undefined" &&
        typeof (figma as any).base64Decode === "function"
      ) {
        return (figma as any).base64Decode(clean);
      }

      if (typeof atob === "function") {
        const binary = atob(clean);
        const len = binary.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
          bytes[i] = binary.charCodeAt(i);
        }
        return bytes;
      }

      const base64Chars =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
      const sanitized = clean.replace(/[^A-Za-z0-9+/=]/g, "");
      const outputLength =
        Math.floor((sanitized.length * 3) / 4) -
        (sanitized.endsWith("==") ? 2 : sanitized.endsWith("=") ? 1 : 0);
      const bytes = new Uint8Array(outputLength);

      let buffer = 0;
      let bitsCollected = 0;
      let byteIndex = 0;

      for (let i = 0; i < sanitized.length; i++) {
        const char = sanitized.charAt(i);
        if (char === "=") break;

        const value = base64Chars.indexOf(char);
        if (value === -1) continue;
        buffer = (buffer << 6) | value;
        bitsCollected += 6;
        if (bitsCollected >= 8) {
          bitsCollected -= 8;
          bytes[byteIndex++] = (buffer >> bitsCollected) & 0xff;
        }
      }

      return bytes;
    } catch (error) {
      console.error("❌ base64ToUint8Array failed:", error);
      const snippet =
        typeof base64 === "string"
          ? base64.substring(0, 50) + "..."
          : String(base64);
      console.error("Input snippet:", snippet);
      throw error;
    }
  }

  private async inlineSvgUsesInPlugin(
    svgMarkup: string,
    baseUrl?: string,
  ): Promise<string> {
    try {
      if (typeof (globalThis as any).DOMParser !== "function") {
        return svgMarkup;
      }

      const parser = new DOMParser();
      const doc = parser.parseFromString(svgMarkup, "image/svg+xml");
      const svg = doc.documentElement;
      const uses = Array.from(svg.querySelectorAll("use")) as Element[];
      if (!uses.length) return svgMarkup;

      const spriteCache = new Map<string, Document>();

      for (const use of uses) {
        const href =
          use.getAttribute("href") || use.getAttribute("xlink:href") || "";
        if (!href) continue;

        const [urlPart, fragmentPart] = href.split("#");
        const fragment = fragmentPart || "";

        let symbolDoc: Document | null = null;
        if (urlPart) {
          try {
            const absUrl = baseUrl ? new URL(urlPart, baseUrl).href : urlPart;
            if (spriteCache.has(absUrl)) {
              symbolDoc = spriteCache.get(absUrl)!;
            } else {
              const { bytes } = await this.fetchImage(absUrl);
              const text = await this.uint8ToString(bytes);
              symbolDoc = parser.parseFromString(text, "image/svg+xml");
              spriteCache.set(absUrl, symbolDoc);
            }
          } catch (fetchErr) {
            console.warn("Failed to fetch external SVG sprite", fetchErr);
          }
        } else {
          symbolDoc = doc;
        }

        if (!symbolDoc || !fragment) continue;

        const symbol =
          symbolDoc.getElementById(fragment) ||
          symbolDoc.querySelector(`symbol#${fragment}`) ||
          symbolDoc.querySelector(`#${fragment}`);
        if (!symbol) continue;

        const g = doc.createElementNS("http://www.w3.org/2000/svg", "g");
        const symbolClone = symbol.cloneNode(true) as Element;
        if (
          !svg.getAttribute("viewBox") &&
          symbolClone.getAttribute("viewBox")
        ) {
          svg.setAttribute(
            "viewBox",
            symbolClone.getAttribute("viewBox") || "",
          );
        }
        while (symbolClone.firstChild) {
          g.appendChild(symbolClone.firstChild);
        }

        const x = use.getAttribute("x");
        const y = use.getAttribute("y");
        if (x) g.setAttribute("x", x);
        if (y) g.setAttribute("y", y);

        use.parentNode?.replaceChild(g, use);
      }

      return svg.outerHTML;
    } catch (error) {
      console.warn(
        "inlineSvgUsesInPlugin failed, returning original SVG",
        error,
      );
      return svgMarkup;
    }
  }

  private async uint8ToString(bytes: Uint8Array): Promise<string> {
    if (typeof TextDecoder !== "undefined") {
      try {
        return new TextDecoder("utf-8").decode(bytes);
      } catch (e) {
        console.warn("TextDecoder failed, using fallback", e);
      }
    }

    let result = "";
    const CHUNK_SIZE = 8192;
    for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
      // PERF-FIX: Yield to main thread every 256kb to avoid blocking rAF
      if (i > 0 && i % 262144 === 0) {
        await new Promise((r) => setTimeout(r, 0));
      }
      const chunk = bytes.subarray(i, i + CHUNK_SIZE);
      result += String.fromCharCode.apply(null, chunk as any);
    }
    return result;
  }

  private async base64ToString(
    base64: string,
    options?: { allowSvg?: boolean },
  ): Promise<string> {
    const normalized = base64.includes(",") ? base64.split(",")[1] : base64;
    const clean = normalized.replace(/\s/g, "");

    const bytes = this.base64ToUint8Array(clean, options?.allowSvg === true);
    return await this.uint8ToString(bytes);
  }

  private mapFontWeight(weight: number): string {
    const w =
      typeof weight === "number" && Number.isFinite(weight) ? weight : 400;
    if (w >= 900) return "Black";
    if (w >= 800) return "Extra Bold";
    if (w >= 700) return "Bold";
    if (w >= 600) return "Semi Bold";
    if (w >= 500) return "Medium";
    if (w >= 400) return "Regular";
    if (w >= 300) return "Light";
    if (w >= 200) return "Extra Light";
    return "Thin";
  }

  private applyTransformMatrix(
    node: SceneNode,
    transform: any,
    transformOrigin?: { x: number; y: number; z?: number },
    layout?: { width: number; height: number; x: number; y: number },
  ): void {
    if (!transform?.matrix || !layout) {
      return;
    }

    const matrix = transform.matrix;

    if (matrix.length === 6) {
      const [a, b, c, d, tx, ty] = matrix;

      let finalX = layout.x;
      let finalY = layout.y;

      if (transformOrigin) {
        const originX = this.calculateTransformOriginOffset(
          transformOrigin.x,
          layout.width,
        );
        const originY = this.calculateTransformOriginOffset(
          transformOrigin.y,
          layout.height,
        );

        const offsetTx = tx + originX * (1 - a) - originY * c;
        const offsetTy = ty + originY * (1 - d) - originX * b;

        finalX += offsetTx;
        finalY += offsetTy;
      } else {
        finalX += tx;
        finalY += ty;
      }

      // HIGH FIDELITY FIX: Use relativeTransform if supported to preserve skew/scale/rotation precisely
      if ("relativeTransform" in node) {
        try {
          (node as any).relativeTransform = [
            [a, c, finalX],
            [b, d, finalY],
          ];
          // If we use relativeTransform, we don't need manual x/y/rotation/resize
          // But we DO need to ensure the node is at its untransformed size
          if ("resize" in node) {
            (node as LayoutMixin).resize(layout.width, layout.height);
          }
          return;
        } catch (e) {
          console.warn(`Failed to apply relativeTransform in fallback:`, e);
          // Continue to manual decomposition fallback
        }
      }

      node.x = finalX;
      node.y = finalY;

      // FIX P2: If element is transformed far off-screen, hide it
      // This handles sidebars/modals that are moved off-canvas via CSS transform
      if (Math.abs(finalX) > 5000 || Math.abs(finalY) > 5000) {
        if ("visible" in node) {
          (node as any).visible = false;
          console.log(
            `🙈 [TRANSFORM] Hiding off-screen element "${node.name}" at (${finalX}, ${finalY})`,
          );
        }
      }

      if ("rotation" in node && this.shouldApplyRotation(matrix)) {
        const rotationRadians = Math.atan2(b, a);
        const rotationDegrees = (rotationRadians * 180) / Math.PI;
        (node as any).rotation = rotationDegrees;
      }

      if ("resize" in node && this.shouldApplyScale(matrix)) {
        const scaleX = Math.hypot(a, b);
        const scaleY = Math.hypot(c, d);

        if (scaleX > 0.1 && scaleX < 10 && scaleY > 0.1 && scaleY < 10) {
          const newWidth = Math.max(layout.width * scaleX, 1);
          const newHeight = Math.max(layout.height * scaleY, 1);
          (node as LayoutMixin).resize(newWidth, newHeight);

          this.safeSetPluginData(
            node,
            "appliedScale",
            JSON.stringify({
              scaleX,
              scaleY,
              originalWidth: layout.width,
              originalHeight: layout.height,
            }),
          );
        }
      }

      if (this.hasComplexTransform(matrix)) {
        this.safeSetPluginData(
          node,
          "complexTransform",
          JSON.stringify({
            matrix,
            skew: transform.skew,
            decomposed: {
              translate: transform.translate,
              scale: transform.scale,
              rotate: transform.rotate,
              skew: transform.skew,
            },
          }),
        );
      }
    } else if (matrix.length === 16) {
      const tx = Number.isFinite(matrix[12]) ? matrix[12] : 0;
      const ty = Number.isFinite(matrix[13]) ? matrix[13] : 0;
      const tz = Number.isFinite(matrix[14]) ? matrix[14] : 0;

      const safeX = Number.isFinite(layout.x) ? layout.x : 0;
      const safeY = Number.isFinite(layout.y) ? layout.y : 0;
      node.x = safeX + tx;
      node.y = safeY + ty;

      this.safeSetPluginData(
        node,
        "transform3D",
        JSON.stringify({
          matrix,
          translate: { x: tx, y: ty, z: tz },
          originalPosition: { x: layout.x, y: layout.y },
        }),
      );

      console.warn(
        `3D transform applied to "${node.name}" - limited Figma support, stored for reference`,
      );
    }
  }

  private calculateTransformOriginOffset(
    value: number,
    dimension: number,
  ): number {
    if (value >= 0 && value <= 100) {
      return (value / 100) * dimension - dimension / 2;
    }
    return value - dimension / 2;
  }

  private shouldApplyRotation(matrix: number[]): boolean {
    if (matrix.length !== 6) return false;
    const [a, b] = matrix;
    const rotation = Math.atan2(b, a);
    return Math.abs(rotation) > 0.01;
  }

  private shouldApplyScale(matrix: number[]): boolean {
    if (matrix.length !== 6) return false;
    const [a, b, c, d] = matrix;
    const scaleX = Math.hypot(a, b);
    const scaleY = Math.hypot(c, d);
    return Math.abs(scaleX - 1) > 0.01 || Math.abs(scaleY - 1) > 0.01;
  }

  private hasComplexTransform(matrix: number[]): boolean {
    if (matrix.length !== 6) return true;
    const [a, b, c, d] = matrix;

    const crossProduct = a * c + b * d;
    const hasSkew = Math.abs(crossProduct) > 0.01;

    const scaleX = Math.hypot(a, b);
    const scaleY = Math.hypot(c, d);
    const hasNonUniformScale = Math.abs(scaleX - scaleY) > 0.01;

    return hasSkew || hasNonUniformScale;
  }

  private async bindVariablesToNode(
    node: GeometryMixin & SceneNode,
    data: any,
  ): Promise<void> {
    if (!this.designTokensManager) return;

    if (node.fills && Array.isArray(node.fills) && node.fills.length > 0) {
      const fills = node.fills as Paint[];
      for (let i = 0; i < fills.length; i++) {
        const fill = fills[i];
        if (fill.type === "SOLID" && "color" in fill) {
          const matchingVariable = this.findMatchingColorVariable(
            fill.color as RGB,
          );
          if (matchingVariable) {
            try {
              const alias =
                figma.variables.createVariableAlias(matchingVariable);
              node.fills = [{ ...fill, color: alias as any }];
              console.log(
                `🔗 Bound fill on ${node.name} to variable ${matchingVariable.name}`,
              );
              break;
            } catch (error) {
              console.warn(
                `Failed to bind fill variable on ${node.name}:`,
                error,
              );
            }
          }
        }
      }
    }

    if (
      node.strokes &&
      Array.isArray(node.strokes) &&
      node.strokes.length > 0
    ) {
      const strokes = node.strokes as Paint[];
      for (let i = 0; i < strokes.length; i++) {
        const stroke = strokes[i];
        if (stroke.type === "SOLID" && "color" in stroke) {
          const matchingVariable = this.findMatchingColorVariable(
            stroke.color as RGB,
          );
          if (matchingVariable) {
            try {
              const alias =
                figma.variables.createVariableAlias(matchingVariable);
              node.strokes = [{ ...stroke, color: alias as any }];
              console.log(
                `🔗 Bound stroke on ${node.name} to variable ${matchingVariable.name}`,
              );
              break;
            } catch (error) {
              console.warn(
                `Failed to bind stroke variable on ${node.name}:`,
                error,
              );
            }
          }
        }
      }
    }
  }

  private findMatchingColorVariable(color: RGB): Variable | undefined {
    if (!this.designTokensManager) return undefined;

    const allVariables = Array.from(figma.variables.getLocalVariables());

    const tolerance = 0.01;

    for (const variable of allVariables) {
      if (variable.resolvedType === "COLOR") {
        const collection = figma.variables.getVariableCollectionById(
          variable.variableCollectionId,
        );
        if (collection && collection.modes.length > 0) {
          const defaultMode = collection.modes[0];
          const value = variable.valuesByMode[defaultMode.modeId];

          if (value && typeof value === "object" && "r" in value) {
            const varColor = value as RGBA;
            if (
              Math.abs(varColor.r - color.r) < tolerance &&
              Math.abs(varColor.g - color.g) < tolerance &&
              Math.abs(varColor.b - color.b) < tolerance
            ) {
              return variable;
            }
          }
        }
      }
    }

    return undefined;
  }

  private safeSetPluginData(node: SceneNode, key: string, value: string) {
    try {
      node.setPluginData(key, value);
    } catch {
      // Some node types can't store plugin data; ignore
    }
  }

  /**
   * PROFESSIONAL: Apply professional positioning strategy with layout intelligence
   */
  private applyProfessionalPositioning(
    node: SceneNode,
    data: any,
    layoutIntelligence: any,
  ): void {
    const { hybridStrategy, confidenceScore } = layoutIntelligence;

    // Apply intelligent constraint calculation if confidence is high
    if (confidenceScore > 0.7 && data.constraints && "constraints" in node) {
      const optimizedConstraints =
        this.professionalLayoutSolver.calculateOptimalConstraints(
          data,
          {}, // parent data - would need to be passed from context
        );

      (node as ConstraintMixin).constraints = {
        horizontal: optimizedConstraints.horizontal,
        vertical: optimizedConstraints.vertical,
      };

      console.log(
        `🎯 [PROFESSIONAL POSITIONING] Applied intelligent constraints: ${optimizedConstraints.horizontal}/${optimizedConstraints.vertical}`,
      );
    }

    // CORRECTED: Apply layoutPositioning if specified (direct property on node)
    // CRITICAL FIX: Only set ABSOLUTE positioning if parent has layoutMode !== NONE
    if (data.layoutPositioning && "layoutPositioning" in node) {
      // Check if parent supports this layoutPositioning mode
      const canUseAbsolute =
        data.layoutPositioning === "AUTO" ||
        (node.parent &&
          "layoutMode" in node.parent &&
          (node.parent as FrameNode).layoutMode !== "NONE");

      if (canUseAbsolute) {
        (node as any).layoutPositioning = data.layoutPositioning;
        console.log(
          `📍 [PROFESSIONAL POSITIONING] Applied layoutPositioning: ${data.layoutPositioning}`,
        );
      } else {
        console.warn(
          `⚠️ [PROFESSIONAL POSITIONING] Skipping layoutPositioning=${data.layoutPositioning} - parent layoutMode is NONE`,
        );
        // Don't set layoutPositioning - leave it as default to prevent Figma API error
      }
    }

    // CORRECTED: Apply layoutAlign for Auto Layout children (direct property)
    if (data.layoutAlign && "layoutAlign" in node) {
      (node as any).layoutAlign = data.layoutAlign;
    }

    // CORRECTED: Apply layoutGrow for flexible layouts (direct property)
    if (data.layoutGrow !== undefined && "layoutGrow" in node) {
      (node as any).layoutGrow = data.layoutGrow;
    }
  }

  /**
   * PROFESSIONAL: Apply professional transform precision with relativeTransform API
   */
  private applyProfessionalTransform(
    node: SceneNode,
    data: any,
    x: number,
    y: number,
  ): void {
    // Check if we have CSS transform data that needs professional handling
    if (data.cssTransform && data.cssTransform !== "none") {
      try {
        const parsedTransform = parseTransform(data.cssTransform);

        if (parsedTransform) {
          // PROFESSIONAL: Use relativeTransform for precise transform application
          const transformMatrix = this.createProfessionalTransformMatrix(
            parsedTransform,
            x,
            y,
          );

          if ("relativeTransform" in node) {
            (node as SceneNode).relativeTransform = transformMatrix;
            console.log(
              `🔄 [PROFESSIONAL TRANSFORM] Applied relativeTransform matrix`,
            );
            // Mark as professionally transformed to prevent double application
            this.safeSetPluginData(
              node,
              "professionalTransformApplied",
              "true",
            );
            return; // Skip regular positioning since transform handles it
          }
        }
      } catch (error) {
        console.warn(
          `⚠️ [PROFESSIONAL TRANSFORM] Failed to parse transform: ${error}`,
        );
      }
    }

    // Apply professional sub-pixel precision to regular positioning
    if ("x" in node && "y" in node) {
      const professionalX =
        this.professionalLayoutSolver.handleSubPixelPrecision(x);
      const professionalY =
        this.professionalLayoutSolver.handleSubPixelPrecision(y);

      node.x = professionalX;
      node.y = professionalY;
    }
  }

  /**
   * CORRECTED: Create Figma-compatible transform matrix following API specification
   */
  private createProfessionalTransformMatrix(
    parsedTransform: ParsedTransform,
    x: number,
    y: number,
  ): Transform {
    // CORRECTED: Start with scale matrix per Figma API
    const scaleX =
      parsedTransform.scaleX !== undefined ? parsedTransform.scaleX : 1;
    const scaleY =
      parsedTransform.scaleY !== undefined ? parsedTransform.scaleY : 1;

    let matrix: Transform = [
      [scaleX, 0, 0],
      [0, scaleY, 0],
    ];

    // Apply rotation if present (per Figma API spec)
    if (parsedTransform.rotate !== undefined && parsedTransform.rotate !== 0) {
      const angle = (parsedTransform.rotate * Math.PI) / 180; // Convert to radians
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);

      // CORRECTED: Rotation matrix multiplication with scale
      const newMatrix: Transform = [
        [
          matrix[0][0] * cos - matrix[1][0] * sin,
          matrix[0][1] * cos - matrix[1][1] * sin,
          0,
        ],
        [
          matrix[0][0] * sin + matrix[1][0] * cos,
          matrix[0][1] * sin + matrix[1][1] * cos,
          0,
        ],
      ];
      matrix = newMatrix;
    }

    // Apply skew if present (following affine transform rules)
    if (parsedTransform.skewX || parsedTransform.skewY) {
      const skewX = parsedTransform.skewX
        ? Math.tan((parsedTransform.skewX * Math.PI) / 180)
        : 0;
      const skewY = parsedTransform.skewY
        ? Math.tan((parsedTransform.skewY * Math.PI) / 180)
        : 0;

      // Apply skew transformation to the existing matrix
      const newMatrix: Transform = [
        [
          matrix[0][0] + skewX * matrix[1][0],
          matrix[0][1] + skewX * matrix[1][1],
          matrix[0][2],
        ],
        [
          matrix[1][0] + skewY * matrix[0][0],
          matrix[1][1] + skewY * matrix[0][1],
          matrix[1][2],
        ],
      ];
      matrix = newMatrix;
    }

    // CORRECTED: Apply translation to the transform matrix (translation goes in [0][2] and [1][2])
    const preciseX = this.professionalLayoutSolver.handleSubPixelPrecision(x);
    const preciseY = this.professionalLayoutSolver.handleSubPixelPrecision(y);

    matrix[0][2] = preciseX;
    matrix[1][2] = preciseY;

    return matrix;
  }

  /**
   * PROFESSIONAL: Apply comprehensive layout validation and intelligent correction
   */
  private applyProfessionalLayoutValidation(data: any): any {
    const correctedData = { ...data };

    // CRITICAL FIX: Explicitly map CSS positioning to Figma layoutPositioning
    // This ensures absolute/fixed elements are not forced into Auto Layout flow
    const cssPosition =
      correctedData.computedPosition?.position ||
      correctedData.layoutContext?.position ||
      correctedData.position ||
      "static";

    if (cssPosition === "absolute" || cssPosition === "fixed") {
      correctedData.layoutPositioning = "ABSOLUTE";
    }

    // PROFESSIONAL: Validate and correct layout properties
    if (correctedData.layout) {
      const layoutIntelligence =
        this.professionalLayoutSolver.analyzeLayoutIntelligence(correctedData);

      // Apply intelligent corrections based on layout analysis
      // STRICTER THRESHOLD: 0.9 (was 0.8 during investigation)
      // If we are not 90% sure, we MUST fallback to absolute positioning to prevent
      // vertical stacking glitches on complex layouts.
      if (layoutIntelligence.confidenceScore > 0.9) {
        console.log(
          `🏆 [LAYOUT VALIDATION] High confidence layout detected (${(
            layoutIntelligence.confidenceScore * 100
          ).toFixed(1)}%) - applying professional corrections`,
        );

        // Auto-correct positioning strategy based on analysis
        if (layoutIntelligence.hybridStrategy.absoluteChildren.length > 0) {
          correctedData.layoutPositioning = "ABSOLUTE";

          // Apply intelligent constraints to absolute positioned elements
          const optimalConstraints =
            this.professionalLayoutSolver.calculateOptimalConstraints(
              correctedData,
              {}, // Parent context would be ideal here
            );

          correctedData.constraints = optimalConstraints;
        } else if (layoutIntelligence.inferredLayout.layoutMode !== "NONE") {
          correctedData.layoutPositioning = "AUTO";

          // Apply intelligent auto layout settings
          if (!correctedData.autoLayout) {
            correctedData.autoLayout = {};
          }

          // Copy professional layout configuration
          correctedData.autoLayout.layoutMode =
            layoutIntelligence.inferredLayout.layoutMode;
          correctedData.autoLayout.primaryAxisAlignItems =
            layoutIntelligence.inferredLayout.primaryAxisAlignItems;
          correctedData.autoLayout.counterAxisAlignItems =
            layoutIntelligence.inferredLayout.counterAxisAlignItems;
          correctedData.autoLayout.itemSpacing =
            layoutIntelligence.inferredLayout.itemSpacing;
          correctedData.autoLayout.strokesIncludedInLayout =
            layoutIntelligence.inferredLayout.strokesIncludedInLayout;
          correctedData.autoLayout.layoutWrap =
            layoutIntelligence.inferredLayout.layoutWrap;
        }
      } else {
        console.error(
          `🚫 [LAYOUT VALIDATION] Low confidence layout (${(
            layoutIntelligence.confidenceScore * 100
          ).toFixed(
            1,
          )}%) - REVOKING AUTO LAYOUT to prevent collapse. Strategy: ${
            layoutIntelligence.fallbackStrategy.mode
          }`,
        );

        // NUCLEAR OPTION: If confidence is low, strictly FORBID Auto Layout.
        // This prevents "Vertical Stacking" of desktop pages.
        if (correctedData.autoLayout) {
          delete correctedData.autoLayout;
        }

        // Apply fallback strategy
        switch (layoutIntelligence.fallbackStrategy.mode) {
          case "ABSOLUTE":
            correctedData.layoutPositioning = "ABSOLUTE";
            break;
          case "MIXED":
            correctedData.layoutPositioning = "ABSOLUTE"; // Conservative approach
            break;
          case "AUTO":
            correctedData.layoutPositioning = "AUTO";
            break;
        }
      }

      // PROFESSIONAL: Apply sub-pixel precision correction to coordinates
      if (correctedData.layout.x !== undefined) {
        correctedData.layout.x =
          this.professionalLayoutSolver.handleSubPixelPrecision(
            correctedData.layout.x,
          );
      }
      if (correctedData.layout.y !== undefined) {
        correctedData.layout.y =
          this.professionalLayoutSolver.handleSubPixelPrecision(
            correctedData.layout.y,
          );
      }
      if (correctedData.layout.width !== undefined) {
        correctedData.layout.width =
          this.professionalLayoutSolver.handleSubPixelPrecision(
            correctedData.layout.width,
          );
      }
      if (correctedData.layout.height !== undefined) {
        correctedData.layout.height =
          this.professionalLayoutSolver.handleSubPixelPrecision(
            correctedData.layout.height,
          );
      }
    }

    // PROFESSIONAL: Validate and enhance transform data
    if (correctedData.cssTransform && correctedData.cssTransform !== "none") {
      try {
        const parsedTransform = parseTransform(correctedData.cssTransform);
        if (parsedTransform) {
          // Store enhanced transform data for professional processing
          correctedData._professionalTransform = parsedTransform;
          console.log(
            `🔄 [LAYOUT VALIDATION] Enhanced transform data available`,
          );
        }
      } catch (error) {
        console.warn(
          `⚠️ [LAYOUT VALIDATION] Transform validation failed: ${error}`,
        );
        delete correctedData.cssTransform; // Remove invalid transform
      }
    }

    return correctedData;
  }
}
