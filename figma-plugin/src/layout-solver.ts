interface ElementNodeData {
  autoLayout?: {
    layoutMode?: "VERTICAL" | "HORIZONTAL" | "NONE";
    itemSpacing?: number;
    // Enhanced properties for professional Auto Layout
    primaryAxisAlignItems?: "MIN" | "CENTER" | "MAX" | "SPACE_BETWEEN";
    counterAxisAlignItems?: "MIN" | "CENTER" | "MAX" | "STRETCH";
    primaryAxisSizingMode?: "FIXED" | "AUTO";
    counterAxisSizingMode?: "FIXED" | "AUTO";
    paddingTop?: number;
    paddingRight?: number;
    paddingBottom?: number;
    paddingLeft?: number;
    // PROFESSIONAL: Advanced Auto Layout properties
    layoutWrap?: "NO_WRAP" | "WRAP";
    strokesIncludedInLayout?: boolean;
  };
  children?: ElementNodeData[];
  id?: string;
  name?: string;
  // Enhanced CSS properties for professional conversion
  layout?: {
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    display?: string;
    flexDirection?: string;
    gap?: string;
    justifyContent?: string;
    alignItems?: string;
    flexWrap?: string;
    flexGrow?: string | number;
    alignSelf?: string;
    // PROFESSIONAL: Additional layout properties
    position?: string;
    transform?: string;
  };
  // PROFESSIONAL: Advanced positioning properties
  layoutPositioning?: "AUTO" | "ABSOLUTE";
  layoutAlign?: "INHERIT" | "STRETCH" | "MIN" | "CENTER" | "MAX";
  layoutGrow?: number;
  constraints?: {
    horizontal: "MIN" | "CENTER" | "MAX" | "STRETCH" | "SCALE";
    vertical: "MIN" | "CENTER" | "MAX" | "STRETCH" | "SCALE";
  };
  // PROFESSIONAL: Transform and styling
  cssTransform?: string;
  borderRadius?: number | number[];
  strokeWeight?: number;
}

// PROFESSIONAL: Layout intelligence interfaces
interface LayoutIntelligence {
  inferredLayout: InferredAutoLayoutResult;
  confidenceScore: number;
  hybridStrategy: HybridLayoutPlan;
  fallbackStrategy: FallbackStrategy;
}

// CORRECTED: Match exact Figma API InferredAutoLayoutResult interface
interface InferredAutoLayoutResult {
  layoutMode: "NONE" | "HORIZONTAL" | "VERTICAL" | "GRID";
  primaryAxisSizingMode: "FIXED" | "AUTO";
  counterAxisSizingMode: "FIXED" | "AUTO";
  paddingTop: number;
  paddingRight: number;
  paddingBottom: number;
  paddingLeft: number;
  itemSpacing: number;
  primaryAxisAlignItems: "MIN" | "CENTER" | "MAX" | "SPACE_BETWEEN";
  counterAxisAlignItems: "MIN" | "CENTER" | "MAX" | "BASELINE" | "STRETCH";
  strokesIncludedInLayout: boolean;
  layoutWrap: "NO_WRAP" | "WRAP";
  // MISSING PROPERTIES from Figma API:
  counterAxisAlignContent?: "AUTO" | "SPACE_BETWEEN";
  counterAxisSpacing?: number | null;
  itemReverseZIndex?: boolean;
}

interface HybridLayoutPlan {
  autoLayoutChildren: ElementNodeData[];
  absoluteChildren: ElementNodeData[];
  frameConfig: FrameConfiguration;
  constraintOptimizations: ConstraintOptimization[];
}

interface FrameConfiguration {
  layoutMode: "NONE" | "HORIZONTAL" | "VERTICAL" | "GRID";
  primaryAxisSizingMode: "FIXED" | "AUTO";
  counterAxisSizingMode: "FIXED" | "AUTO";
  itemSpacing: number;
  padding: { top: number; right: number; bottom: number; left: number };
  strokesIncludedInLayout: boolean;
  layoutWrap: "NO_WRAP" | "WRAP";
  // Additional properties for full API support
  counterAxisAlignContent?: "AUTO" | "SPACE_BETWEEN";
  counterAxisSpacing?: number | null;
}

interface ConstraintOptimization {
  nodeId: string;
  constraints: { horizontal: string; vertical: string };
  reasoning: string;
}

interface FallbackStrategy {
  mode: "ABSOLUTE" | "MIXED" | "AUTO";
  reasoning: string;
}

interface CSSAnalysis {
  display: string;
  flexDirection: string;
  justifyContent: string;
  alignItems: string;
  flexWrap: string;
  gap: number;
  padding: { top: number; right: number; bottom: number; left: number };
  position: string;
  transform: string;
}

const POSITION_TOLERANCE = 4; // px - legacy tolerance
const ENHANCED_POSITION_TOLERANCE = 8; // px - enhanced tolerance for better conflict resolution
const PROFESSIONAL_PRECISION = 0.001; // px - high-fidelity sub-pixel precision

/**
 * PROFESSIONAL LAYOUT INTELLIGENCE ENGINE
 * Implements professional-grade layout analysis comparable to html2design and builder.io
 */
export class ProfessionalLayoutSolver {
  /**
   * MAIN API: Analyze layout intelligence for a node
   */
  public analyzeLayoutIntelligence(
    nodeData: ElementNodeData,
  ): LayoutIntelligence {
    const cssAnalysis = this.analyzeCSSLayout(nodeData);
    const childrenAnalysis = this.analyzeChildrenDistribution(
      nodeData.children || [],
    );

    // Create intelligent Auto Layout configuration
    const inferredLayout: InferredAutoLayoutResult = {
      layoutMode: this.inferLayoutMode(cssAnalysis),
      primaryAxisSizingMode: this.inferPrimaryAxisSizing(cssAnalysis, nodeData),
      counterAxisSizingMode: this.inferCounterAxisSizing(cssAnalysis, nodeData),
      paddingTop: cssAnalysis.padding.top,
      paddingRight: cssAnalysis.padding.right,
      paddingBottom: cssAnalysis.padding.bottom,
      paddingLeft: cssAnalysis.padding.left,
      itemSpacing: cssAnalysis.gap,
      primaryAxisAlignItems: this.mapJustifyContentToFigma(
        cssAnalysis.justifyContent,
      ),
      counterAxisAlignItems: this.mapAlignItemsToFigma(cssAnalysis.alignItems),
      strokesIncludedInLayout: this.shouldIncludeStrokesInLayout(nodeData),
      layoutWrap: cssAnalysis.flexWrap === "wrap" ? "WRAP" : "NO_WRAP",
    };

    const confidenceScore = this.calculateConfidence(
      cssAnalysis,
      childrenAnalysis,
    );
    const hybridStrategy = this.createHybridStrategy(nodeData, inferredLayout);
    const fallbackStrategy = this.createFallbackStrategy(
      nodeData,
      confidenceScore,
    );

    return {
      inferredLayout,
      confidenceScore,
      hybridStrategy,
      fallbackStrategy,
    };
  }

  /**
   * PROFESSIONAL: Sub-pixel precision handling
   */
  public handleSubPixelPrecision(value: number): number {
    return Math.round(value / PROFESSIONAL_PRECISION) * PROFESSIONAL_PRECISION;
  }

  /**
   * PROFESSIONAL: Analyze CSS layout properties
   */
  private analyzeCSSLayout(nodeData: ElementNodeData): CSSAnalysis {
    const layout = nodeData.layout || {};

    return {
      display: layout.display || "block",
      flexDirection: layout.flexDirection || "row",
      justifyContent: layout.justifyContent || "flex-start",
      alignItems: layout.alignItems || "stretch",
      flexWrap: layout.flexWrap || "nowrap",
      gap: this.parseGap(layout.gap || "0"),
      padding: this.parsePadding(nodeData),
      position: layout.position || "static",
      transform: layout.transform || "none",
    };
  }

  /**
   * PROFESSIONAL: Analyze children distribution patterns
   */
  private analyzeChildrenDistribution(children: ElementNodeData[]): any {
    if (children.length === 0) return { isEmpty: true };

    // Analyze positioning patterns
    const positions = children.map((child) => ({
      x: child.layout?.x || 0,
      y: child.layout?.y || 0,
      width: child.layout?.width || 0,
      height: child.layout?.height || 0,
    }));

    // Check for grid-like distribution
    const isGridLike = this.detectGridPattern(positions);
    const isLinear = this.detectLinearPattern(positions);
    const hasOverlapping = this.detectOverlapping(positions);

    return {
      count: children.length,
      isGridLike,
      isLinear,
      hasOverlapping,
      averageSpacing: this.calculateAverageSpacing(positions),
    };
  }

  /**
   * CORRECTED: Infer optimal layout mode from CSS (with GRID support)
   */
  private inferLayoutMode(
    cssAnalysis: CSSAnalysis,
  ): "NONE" | "HORIZONTAL" | "VERTICAL" | "GRID" {
    if (cssAnalysis.display === "flex") {
      return cssAnalysis.flexDirection === "column" ||
        cssAnalysis.flexDirection === "column-reverse"
        ? "VERTICAL"
        : "HORIZONTAL";
    }

    if (cssAnalysis.display === "grid") {
      // CORRECTED: Use GRID layout mode for CSS Grid
      return "GRID";
    }

    return "NONE";
  }

  /**
   * PROFESSIONAL: Infer primary axis sizing mode
   */
  private inferPrimaryAxisSizing(
    cssAnalysis: CSSAnalysis,
    nodeData: ElementNodeData,
  ): "FIXED" | "AUTO" {
    const layout = nodeData.layout;
    if (!layout) return "AUTO";

    // If width/height is explicitly set and flex container, use FIXED
    if (cssAnalysis.display === "flex") {
      const isHorizontal =
        cssAnalysis.flexDirection === "row" ||
        cssAnalysis.flexDirection === "row-reverse";
      const relevantSize = isHorizontal ? layout.width : layout.height;

      if (relevantSize && relevantSize > 0) {
        return "FIXED";
      }
    }

    return "AUTO";
  }

  /**
   * PROFESSIONAL: Infer counter axis sizing mode
   */
  private inferCounterAxisSizing(
    cssAnalysis: CSSAnalysis,
    nodeData: ElementNodeData,
  ): "FIXED" | "AUTO" {
    const layout = nodeData.layout;
    if (!layout) return "AUTO";

    // Counter axis is opposite of primary
    if (cssAnalysis.display === "flex") {
      const isHorizontal =
        cssAnalysis.flexDirection === "row" ||
        cssAnalysis.flexDirection === "row-reverse";
      const relevantSize = isHorizontal ? layout.height : layout.width;

      if (relevantSize && relevantSize > 0) {
        return "FIXED";
      }
    }

    return "AUTO";
  }

  /**
   * PROFESSIONAL: Map CSS justify-content to Figma primaryAxisAlignItems
   */
  private mapJustifyContentToFigma(
    justifyContent: string,
  ): "MIN" | "CENTER" | "MAX" | "SPACE_BETWEEN" {
    switch (justifyContent) {
      case "flex-start":
      case "start":
        return "MIN";
      case "center":
        return "CENTER";
      case "flex-end":
      case "end":
        return "MAX";
      case "space-between":
        return "SPACE_BETWEEN";
      default:
        return "MIN";
    }
  }

  /**
   * CORRECTED: Map CSS align-items to Figma counterAxisAlignItems (with BASELINE support)
   */
  private mapAlignItemsToFigma(
    alignItems: string,
  ): "MIN" | "CENTER" | "MAX" | "BASELINE" | "STRETCH" {
    switch (alignItems) {
      case "flex-start":
      case "start":
        return "MIN";
      case "center":
        return "CENTER";
      case "flex-end":
      case "end":
        return "MAX";
      case "baseline":
        return "BASELINE";
      case "stretch":
        return "STRETCH";
      default:
        return "STRETCH";
    }
  }

  /**
   * PROFESSIONAL: Determine if strokes should be included in layout
   */
  private shouldIncludeStrokesInLayout(nodeData: ElementNodeData): boolean {
    // If element has border and is a container, include strokes
    return !!(
      nodeData.strokeWeight &&
      nodeData.strokeWeight > 0 &&
      nodeData.children &&
      nodeData.children.length > 0
    );
  }

  /**
   * PROFESSIONAL: Create hybrid positioning strategy
   */
  public createHybridStrategy(
    nodeData: ElementNodeData,
    inferredLayout: InferredAutoLayoutResult,
  ): HybridLayoutPlan {
    const children = nodeData.children || [];
    const autoLayoutChildren: ElementNodeData[] = [];
    const absoluteChildren: ElementNodeData[] = [];
    const constraintOptimizations: ConstraintOptimization[] = [];

    for (const child of children) {
      const shouldUseAbsolute = this.shouldUseAbsolutePositioning(
        child,
        nodeData,
      );

      if (shouldUseAbsolute) {
        // Configure for absolute positioning
        const enhancedChild = {
          ...child,
          layoutPositioning: "ABSOLUTE" as const,
          constraints: this.calculateOptimalConstraints(child, nodeData),
        };

        absoluteChildren.push(enhancedChild);

        constraintOptimizations.push({
          nodeId: child.id || "unknown",
          constraints: enhancedChild.constraints!,
          reasoning:
            "Element breaks Auto Layout flow - positioned absolutely with intelligent constraints",
        });
      } else {
        // Configure for Auto Layout
        const enhancedChild = {
          ...child,
          layoutPositioning: "AUTO" as const,
          layoutAlign: this.calculateLayoutAlign(child, nodeData),
          layoutGrow: this.calculateLayoutGrow(child, nodeData),
        };

        autoLayoutChildren.push(enhancedChild);
      }
    }

    return {
      autoLayoutChildren,
      absoluteChildren,
      frameConfig: this.buildFrameConfiguration(inferredLayout),
      constraintOptimizations,
    };
  }

  /**
   * PROFESSIONAL: Calculate optimal constraints for absolute positioned elements
   */
  public calculateOptimalConstraints(
    childData: ElementNodeData,
    parentData: ElementNodeData,
  ): {
    horizontal: "MIN" | "CENTER" | "MAX" | "STRETCH" | "SCALE";
    vertical: "MIN" | "CENTER" | "MAX" | "STRETCH" | "SCALE";
  } {
    const childRect = childData.layout;
    const parentRect = parentData.layout;

    if (!childRect || !parentRect) {
      return { horizontal: "MIN", vertical: "MIN" };
    }

    // Professional constraint calculation based on position analysis
    const centerX = childRect.x + childRect.width / 2;
    const centerY = childRect.y + childRect.height / 2;
    const parentCenterX = parentRect.width / 2;
    const parentCenterY = parentRect.height / 2;

    // Intelligent horizontal constraint
    let horizontal: "MIN" | "CENTER" | "MAX" | "STRETCH" | "SCALE";
    const horizontalTolerance = 20;

    if (Math.abs(centerX - parentCenterX) < horizontalTolerance) {
      horizontal = "CENTER";
    } else if (
      childRect.x + childRect.width >=
      parentRect.width - horizontalTolerance
    ) {
      horizontal = "MAX"; // Right edge
    } else if (childRect.x <= horizontalTolerance) {
      horizontal = "MIN"; // Left edge
    } else if (childRect.width / parentRect.width > 0.7) {
      horizontal = "STRETCH"; // Takes up most width
    } else {
      horizontal = "SCALE"; // Proportional scaling
    }

    // Intelligent vertical constraint
    let vertical: "MIN" | "CENTER" | "MAX" | "STRETCH" | "SCALE";
    const verticalTolerance = 20;

    if (Math.abs(centerY - parentCenterY) < verticalTolerance) {
      vertical = "CENTER";
    } else if (
      childRect.y + childRect.height >=
      parentRect.height - verticalTolerance
    ) {
      vertical = "MAX"; // Bottom edge
    } else if (childRect.y <= verticalTolerance) {
      vertical = "MIN"; // Top edge
    } else if (childRect.height / parentRect.height > 0.7) {
      vertical = "STRETCH"; // Takes up most height
    } else {
      vertical = "SCALE"; // Proportional scaling
    }

    // Special handling for fixed positioning (e.g. Headers)
    if (childData.layout?.position === "fixed") {
      // If it's near the top (header), force TOP constraint
      if (childRect.y < 100) {
        vertical = "MIN";
      }
      // If it's wide (full width), force STRETCH
      if (childRect.width / parentRect.width > 0.8) {
        horizontal = "STRETCH";
      }
    }

    return { horizontal, vertical };
  }

  // Helper methods for professional layout analysis
  private parseGap(gap: string): number {
    return parseFloat(gap.replace(/px|em|rem/, "")) || 0;
  }

  private parsePadding(nodeData: ElementNodeData): {
    top: number;
    right: number;
    bottom: number;
    left: number;
  } {
    const autoLayout = nodeData.autoLayout;
    return {
      top: autoLayout?.paddingTop || 0,
      right: autoLayout?.paddingRight || 0,
      bottom: autoLayout?.paddingBottom || 0,
      left: autoLayout?.paddingLeft || 0,
    };
  }

  private detectGridPattern(positions: any[]): boolean {
    // Simplified grid detection - can be enhanced
    return positions.length > 4; // Basic heuristic
  }

  private detectLinearPattern(positions: any[]): boolean {
    if (positions.length < 2) return false;

    // Check if elements are linearly arranged
    const sortedByX = [...positions].sort((a, b) => a.x - b.x);
    const sortedByY = [...positions].sort((a, b) => a.y - b.y);

    // Check horizontal alignment
    const horizontallyAligned = sortedByX.every(
      (pos, i) => i === 0 || Math.abs(pos.y - sortedByX[0].y) < 20,
    );

    // Check vertical alignment
    const verticallyAligned = sortedByY.every(
      (pos, i) => i === 0 || Math.abs(pos.x - sortedByY[0].x) < 20,
    );

    return horizontallyAligned || verticallyAligned;
  }

  private detectOverlapping(positions: any[]): boolean {
    for (let i = 0; i < positions.length; i++) {
      for (let j = i + 1; j < positions.length; j++) {
        const a = positions[i];
        const b = positions[j];

        const overlap = !(
          a.x + a.width <= b.x ||
          b.x + b.width <= a.x ||
          a.y + a.height <= b.y ||
          b.y + b.height <= a.y
        );

        if (overlap) return true;
      }
    }
    return false;
  }

  private calculateAverageSpacing(positions: any[]): number {
    if (positions.length < 2) return 0;

    let totalSpacing = 0;
    let spacingCount = 0;

    for (let i = 1; i < positions.length; i++) {
      const prev = positions[i - 1];
      const curr = positions[i];

      const horizontalSpacing = Math.max(0, curr.x - (prev.x + prev.width));
      const verticalSpacing = Math.max(0, curr.y - (prev.y + prev.height));

      if (horizontalSpacing > 0) {
        totalSpacing += horizontalSpacing;
        spacingCount++;
      }
      if (verticalSpacing > 0) {
        totalSpacing += verticalSpacing;
        spacingCount++;
      }
    }

    return spacingCount > 0 ? totalSpacing / spacingCount : 0;
  }

  private calculateConfidence(
    cssAnalysis: CSSAnalysis,
    childrenAnalysis: any,
  ): number {
    let score = 0.5; // Base score

    // Increase confidence for flex/grid layouts
    if (cssAnalysis.display === "flex") score += 0.3;
    if (cssAnalysis.display === "grid") score += 0.2;

    // Increase confidence for linear arrangements
    if (childrenAnalysis.isLinear) score += 0.2;

    // Decrease confidence for overlapping elements
    if (childrenAnalysis.hasOverlapping) score -= 0.3;

    return Math.max(0, Math.min(1, score));
  }

  private shouldUseAbsolutePositioning(
    child: ElementNodeData,
    parent: ElementNodeData,
  ): boolean {
    const childLayout = child.layout;
    if (!childLayout) return false;

    // Use absolute positioning for:
    // 1. Elements with absolute/fixed position
    if (childLayout.position === "absolute" || childLayout.position === "fixed")
      return true;

    // 2. Elements with transforms
    if (child.cssTransform && child.cssTransform !== "none") return true;

    // 3. Elements that are positioned outside normal flow
    const isOutsideFlow = childLayout.x < -10 || childLayout.y < -10;
    if (isOutsideFlow) return true;

    return false;
  }

  private calculateLayoutAlign(
    child: ElementNodeData,
    parent: ElementNodeData,
  ): "INHERIT" | "STRETCH" | "MIN" | "CENTER" | "MAX" {
    const alignSelf = child.layout?.alignSelf;

    switch (alignSelf) {
      case "flex-start":
        return "MIN";
      case "center":
        return "CENTER";
      case "flex-end":
        return "MAX";
      case "stretch":
        return "STRETCH";
      default:
        return "INHERIT";
    }
  }

  private calculateLayoutGrow(
    child: ElementNodeData,
    parent: ElementNodeData,
  ): number {
    const flexGrow = child.layout?.flexGrow;
    if (typeof flexGrow === "number") return flexGrow;
    if (typeof flexGrow === "string") return parseFloat(flexGrow) || 0;
    return 0;
  }

  private buildFrameConfiguration(
    inferredLayout: InferredAutoLayoutResult,
  ): FrameConfiguration {
    return {
      layoutMode: inferredLayout.layoutMode,
      primaryAxisSizingMode: inferredLayout.primaryAxisSizingMode,
      counterAxisSizingMode: inferredLayout.counterAxisSizingMode,
      itemSpacing: inferredLayout.itemSpacing,
      padding: {
        top: inferredLayout.paddingTop,
        right: inferredLayout.paddingRight,
        bottom: inferredLayout.paddingBottom,
        left: inferredLayout.paddingLeft,
      },
      strokesIncludedInLayout: inferredLayout.strokesIncludedInLayout,
      layoutWrap: inferredLayout.layoutWrap,
    };
  }

  private createFallbackStrategy(
    nodeData: ElementNodeData,
    confidence: number,
  ): FallbackStrategy {
    if (confidence < 0.3) {
      return {
        mode: "ABSOLUTE",
        reasoning:
          "Low confidence in Auto Layout compatibility - using absolute positioning",
      };
    } else if (
      confidence < 0.7 &&
      nodeData.children &&
      nodeData.children.length > 0
    ) {
      return {
        mode: "MIXED",
        reasoning:
          "Medium confidence - using hybrid Auto Layout with absolute positioned elements",
      };
    } else {
      return {
        mode: "AUTO",
        reasoning: "High confidence - using pure Auto Layout",
      };
    }
  }
}

// Create global instance for use by existing functions
const professionalLayoutSolver = new ProfessionalLayoutSolver();

export function prepareLayoutSchema(schema: any): void {
  const root = schema?.root || schema?.tree;
  if (!root) return;
  traverseNode(root);
}

function traverseNode(node: ElementNodeData | undefined | null): void {
  if (!node) return;

  if (shouldAttemptAutoLayout(node)) {
    const convertible = canUseAutoLayout(node);
    if (!convertible) {
      disableAutoLayout(node);
    } else {
      resetChildOffsets(node);
    }
  }

  for (const child of node.children || []) {
    traverseNode(child);
  }
}

function shouldAttemptAutoLayout(node: ElementNodeData): boolean {
  // Enable Auto Layout for nodes that have layoutMode from extraction
  // This is set when CSS display:flex or display:grid is detected
  const layoutMode = (node as any).layoutMode;
  if (layoutMode === "HORIZONTAL" || layoutMode === "VERTICAL") {
    return true;
  }
  // Also check autoLayout.layoutMode for backward compatibility
  if (node.autoLayout?.layoutMode && node.autoLayout.layoutMode !== "NONE") {
    return true;
  }
  return false;
}

function canUseAutoLayout(node: ElementNodeData): boolean {
  // PROFESSIONAL: Use advanced layout intelligence
  try {
    const layoutIntelligence =
      professionalLayoutSolver.analyzeLayoutIntelligence(node);

    // Use professional confidence scoring
    // STRICTER THRESHOLD: Increased from 0.7 to 0.85 to prevent "messy" Auto Layouts
    // that destroy absolute positioning in complex desktop layouts.
    const shouldUseAutoLayout =
      layoutIntelligence.confidenceScore > 0.85 &&
      layoutIntelligence.inferredLayout.layoutMode !== "NONE";

    if (shouldUseAutoLayout) {
      console.log(
        `[LAYOUT] ✅ Applying Auto Layout to "${node.name}" (${node.id}) | Mode: ${layoutIntelligence.inferredLayout.layoutMode} | Score: ${layoutIntelligence.confidenceScore.toFixed(2)}`,
      );
      // Apply professional layout configuration to the node
      applyProfessionalLayoutConfig(node, layoutIntelligence);
    } else {
      console.log(
        `[LAYOUT] 🚫 Skipping Auto Layout for "${node.name}" (${node.id}) | Score: ${layoutIntelligence.confidenceScore.toFixed(2)} (Threshold: 0.85)`,
      );
    }

    return shouldUseAutoLayout;
  } catch (error) {
    console.warn(
      "Professional layout analysis failed, falling back to basic analysis:",
      error,
    );

    // Fallback to basic analysis
    if (!node.children || node.children.length <= 1) {
      return !!(
        node.autoLayout?.layoutMode && node.autoLayout.layoutMode !== "NONE"
      );
    }

    const result = analyzeLayoutCompatibility(node);
    // STRICTER THRESHOLD for fallback as well
    return result.compatibilityScore > 0.85;
  }
}

/**
 * PROFESSIONAL: Apply intelligent layout configuration to node
 */
function applyProfessionalLayoutConfig(
  node: ElementNodeData,
  intelligence: LayoutIntelligence,
): void {
  const { inferredLayout, hybridStrategy } = intelligence;

  // Configure the node with professional Auto Layout settings
  if (!node.autoLayout) {
    node.autoLayout = {};
  }

  node.autoLayout.layoutMode = inferredLayout.layoutMode as any;
  node.autoLayout.primaryAxisAlignItems = inferredLayout.primaryAxisAlignItems;
  node.autoLayout.counterAxisAlignItems =
    inferredLayout.counterAxisAlignItems as any;
  node.autoLayout.primaryAxisSizingMode = inferredLayout.primaryAxisSizingMode;
  node.autoLayout.counterAxisSizingMode = inferredLayout.counterAxisSizingMode;
  node.autoLayout.itemSpacing = inferredLayout.itemSpacing;
  node.autoLayout.paddingTop = inferredLayout.paddingTop;
  node.autoLayout.paddingRight = inferredLayout.paddingRight;
  node.autoLayout.paddingBottom = inferredLayout.paddingBottom;
  node.autoLayout.paddingLeft = inferredLayout.paddingLeft;
  node.autoLayout.layoutWrap = inferredLayout.layoutWrap;
  node.autoLayout.strokesIncludedInLayout =
    inferredLayout.strokesIncludedInLayout;

  // Apply hybrid positioning strategy to children
  if (node.children && hybridStrategy) {
    // Update children with professional positioning
    for (const child of node.children) {
      const autoChild = hybridStrategy.autoLayoutChildren.find(
        (c) => c === child,
      );
      const absoluteChild = hybridStrategy.absoluteChildren.find(
        (c) => c === child,
      );

      if (autoChild) {
        child.layoutPositioning = autoChild.layoutPositioning;
        child.layoutAlign = autoChild.layoutAlign;
        child.layoutGrow = autoChild.layoutGrow;
      } else if (absoluteChild) {
        child.layoutPositioning = absoluteChild.layoutPositioning;
        child.constraints = absoluteChild.constraints;
        // Explicitly set for resetChildOffsets check
        (child as any).layoutPositioning = "ABSOLUTE";
      }
    }
  }
}

/**
 * ENHANCED LAYOUT CONFLICT RESOLUTION
 * Analyzes layout compatibility and provides detailed compatibility scoring
 */
function analyzeLayoutCompatibility(node: ElementNodeData): {
  compatibilityScore: number;
  isMonotonic: boolean;
  isAligned: boolean;
  hasConsistentSpacing: boolean;
  canMapToFigmaAutoLayout: boolean;
  conflictingNodes: number[];
} {
  const axis = node.autoLayout?.layoutMode || "NONE";
  const children = node.children || [];

  // If no explicit layout mode is set, this node shouldn't use Auto Layout
  if (axis === "NONE" || !axis || axis === undefined) {
    return {
      compatibilityScore: 0,
      isMonotonic: false,
      isAligned: false,
      hasConsistentSpacing: false,
      canMapToFigmaAutoLayout: false,
      conflictingNodes: [],
    };
  }

  if (children.length <= 1) {
    return {
      compatibilityScore: 1.0,
      isMonotonic: true,
      isAligned: true,
      hasConsistentSpacing: true,
      canMapToFigmaAutoLayout: true,
      conflictingNodes: [],
    };
  }

  const positions = children.map((child, index) => ({
    index,
    x: child.layout?.x ?? 0,
    y: child.layout?.y ?? 0,
    width: child.layout?.width ?? 0,
    height: child.layout?.height ?? 0,
  }));

  let isMonotonic = false;
  let isAligned = false;
  let hasConsistentSpacing = false;
  let conflictingNodes: number[] = [];

  if (axis === "VERTICAL") {
    isMonotonic = isMonotonicEnhanced(positions, "y", conflictingNodes);
    isAligned = isAlignedEnhanced(positions, "x");
    hasConsistentSpacing = hasConsistentVerticalSpacing(positions);
  } else if (axis === "HORIZONTAL") {
    isMonotonic = isMonotonicEnhanced(positions, "x", conflictingNodes);
    isAligned = isAlignedEnhanced(positions, "y");
    hasConsistentSpacing = hasConsistentHorizontalSpacing(positions);
  } else {
    // No clear layout direction - can't use auto layout
    return {
      compatibilityScore: 0,
      isMonotonic: false,
      isAligned: false,
      hasConsistentSpacing: false,
      canMapToFigmaAutoLayout: false,
      conflictingNodes: [],
    };
  }

  // Calculate compatibility score based on multiple factors
  let score = 0;
  if (isMonotonic) score += 0.4; // 40% weight for monotonic ordering
  if (isAligned) score += 0.3; // 30% weight for alignment
  if (hasConsistentSpacing) score += 0.3; // 30% weight for consistent spacing

  // Penalize for conflicting nodes
  const conflictPenalty = Math.min(0.2, conflictingNodes.length * 0.05);
  score = Math.max(0, score - conflictPenalty);

  return {
    compatibilityScore: score,
    isMonotonic,
    isAligned,
    hasConsistentSpacing,
    canMapToFigmaAutoLayout: score > 0.85,
    conflictingNodes,
  };
}

function isMonotonic(
  positions: Array<{ index: number; x: number; y: number }>,
  axis: "x" | "y",
): boolean {
  const sorted = [...positions].sort((a, b) => a[axis] - b[axis]);
  for (let i = 0; i < positions.length; i++) {
    if (sorted[i].index !== positions[i].index) {
      return false;
    }
  }

  for (let i = 1; i < positions.length; i++) {
    if (sorted[i][axis] + POSITION_TOLERANCE < sorted[i - 1][axis]) {
      return false;
    }
  }

  return true;
}

function isAligned(
  positions: Array<{ index: number; x: number; y: number }>,
  axis: "x" | "y",
): boolean {
  if (positions.length <= 1) return true;
  const baseline = positions[0][axis];
  return positions.every(
    (pos) => Math.abs(pos[axis] - baseline) <= POSITION_TOLERANCE,
  );
}

function disableAutoLayout(node: ElementNodeData): void {
  if (!node.autoLayout) return;
  node.autoLayout.layoutMode = "NONE";
}

function resetChildOffsets(node: ElementNodeData): void {
  if (!node.children) return;
  for (const child of node.children) {
    if (child.layout) {
      // Preserve absolute-positioned children inside Auto Layout parents.
      // Resetting these would collapse elements into a single column.
      const layoutPositioning = (child as any).layoutPositioning;

      // SAFETY CHECK: Also check CSS position and layout object manually if layoutPositioning missing
      const cssPosition = child.layout.position;
      const isAbsoluteCSS =
        cssPosition === "absolute" || cssPosition === "fixed";

      const isAbsoluteInAutoLayout =
        layoutPositioning === "ABSOLUTE" || isAbsoluteCSS;

      if (isAbsoluteInAutoLayout) {
        // console.log(`[LAYOUT] Preserving absolute offsets for child of ${node.id}`);
        continue;
      }

      child.layout.x = 0;
      child.layout.y = 0;
    }
  }
}

/**
 * ENHANCED LAYOUT VALIDATION FUNCTIONS
 */

function isMonotonicEnhanced(
  positions: Array<{
    index: number;
    x: number;
    y: number;
    width: number;
    height: number;
  }>,
  axis: "x" | "y",
  conflictingNodes: number[],
): boolean {
  if (positions.length <= 1) return true;

  const sorted = [...positions].sort((a, b) => a.index - b.index);
  let conflicts = 0;

  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const curr = sorted[i];

    // Check if current position is less than previous (non-monotonic)
    if (curr[axis] < prev[axis] - ENHANCED_POSITION_TOLERANCE) {
      conflicts++;
      conflictingNodes.push(curr.index);
    }
  }

  // Allow some conflicts if they're minor
  const conflictRatio = conflicts / (sorted.length - 1);
  return conflictRatio <= 0.2; // Allow up to 20% conflicts
}

function isAlignedEnhanced(
  positions: Array<{
    index: number;
    x: number;
    y: number;
    width: number;
    height: number;
  }>,
  axis: "x" | "y",
): boolean {
  if (positions.length <= 1) return true;

  // Use median position as baseline for better alignment detection
  const axisValues = positions.map((pos) => pos[axis]).sort((a, b) => a - b);
  const median = axisValues[Math.floor(axisValues.length / 2)];

  const alignedCount = positions.filter(
    (pos) => Math.abs(pos[axis] - median) <= ENHANCED_POSITION_TOLERANCE,
  ).length;

  // Require at least 70% of elements to be aligned
  return alignedCount / positions.length >= 0.7;
}

function hasConsistentVerticalSpacing(
  positions: Array<{
    index: number;
    x: number;
    y: number;
    width: number;
    height: number;
  }>,
): boolean {
  if (positions.length <= 2) return true;

  const sorted = [...positions].sort((a, b) => a.y - b.y);
  const gaps: number[] = [];

  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const curr = sorted[i];
    const gap = curr.y - (prev.y + prev.height);
    gaps.push(gap);
  }

  // Check if gaps are reasonably consistent
  const avgGap = gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length;
  const consistentGaps = gaps.filter(
    (gap) => Math.abs(gap - avgGap) <= ENHANCED_POSITION_TOLERANCE,
  ).length;

  return consistentGaps / gaps.length >= 0.7;
}

function hasConsistentHorizontalSpacing(
  positions: Array<{
    index: number;
    x: number;
    y: number;
    width: number;
    height: number;
  }>,
): boolean {
  if (positions.length <= 2) return true;

  const sorted = [...positions].sort((a, b) => a.x - b.x);
  const gaps: number[] = [];

  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const curr = sorted[i];
    const gap = curr.x - (prev.x + prev.width);
    gaps.push(gap);
  }

  // Check if gaps are reasonably consistent
  const avgGap = gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length;
  const consistentGaps = gaps.filter(
    (gap) => Math.abs(gap - avgGap) <= ENHANCED_POSITION_TOLERANCE,
  ).length;

  return consistentGaps / gaps.length >= 0.7;
}
