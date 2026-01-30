/**
 * Semantic Tree Enhancer
 *
 * Transforms flat DOM trees into well-organized, semantic Figma hierarchies.
 *
 * Based on Figma best practices from Context7:
 * - Clear, semantic naming (not "Frame1268" but "Navigation", "ProductCard")
 * - Auto-layout application (layoutMode: VERTICAL/HORIZONTAL)
 * - Component detection for repeated patterns
 * - Role-based grouping (header, nav, main, footer)
 * - Visual hierarchy markers and naming conventions
 */

import type { ElementNode } from "../../shared/schema";

export interface SemanticEnhancementOptions {
  enableAutoLayout: boolean;
  detectComponents: boolean;
  groupByRole: boolean;
  applyNamingConventions: boolean;
  addVisualMarkers: boolean;
  minComponentInstances: number; // Minimum instances to create component
}

export interface ComponentPattern {
  name: string;
  instances: any[]; // Schema nodes or Figma nodes
  confidence: number;
  signature: string; // Hash of structure
}

export interface SemanticMetadata {
  role?: string; // HTML role or inferred semantic role
  purpose?: string; // Inferred purpose (navigation, content, ui-control, etc.)
  componentType?: string; // Button, Card, ListItem, etc.
  layoutDirection?: "HORIZONTAL" | "VERTICAL" | "NONE";
  isRepeating?: boolean; // Part of repeating pattern
}

// ============================================================================
// SEMANTIC ROLE DETECTION
// ============================================================================

const SEMANTIC_ROLES = {
  // Structure
  HEADER: ["header", "masthead", "site-header", "page-header"],
  NAVIGATION: ["nav", "navigation", "menu", "navbar", "sidebar"],
  MAIN: ["main", "content", "page-content", "article-content"],
  FOOTER: ["footer", "site-footer", "page-footer"],
  ASIDE: ["aside", "sidebar", "related", "complementary"],
  ARTICLE: ["article", "post", "entry"],
  SECTION: ["section", "region"],

  // UI Components
  BUTTON: ["button", "btn", "cta", "action"],
  CARD: ["card", "tile", "item", "product"],
  FORM: ["form", "search", "login", "signup"],
  INPUT: ["input", "textbox", "field"],
  LIST: ["list", "menu", "items"],
  MODAL: ["modal", "dialog", "popup", "overlay"],
  TABS: ["tabs", "tab-panel", "tabbed"],
  CAROUSEL: ["carousel", "slider", "slideshow"],
  DROPDOWN: ["dropdown", "select", "picker"],
  BADGE: ["badge", "label", "tag", "chip"],
  AVATAR: ["avatar", "profile-pic", "user-image"],
  ICON: ["icon", "svg"],

  // Content
  HEADING: ["h1", "h2", "h3", "h4", "h5", "h6", "heading", "title"],
  TEXT: ["p", "text", "paragraph", "copy"],
  IMAGE: ["img", "image", "picture", "photo"],
  VIDEO: ["video", "player"],
  LINK: ["a", "link"],
};

/**
 * Detect semantic role from node attributes
 */
function detectSemanticRole(node: any): string | undefined {
  const indicators = [
    node.htmlTag?.toLowerCase(),
    node.role?.toLowerCase(),
    node.id?.toLowerCase(),
    ...(node.cssClasses || []).map((c: string) => c.toLowerCase()),
    node.name?.toLowerCase(),
  ].filter(Boolean);

  for (const [role, keywords] of Object.entries(SEMANTIC_ROLES)) {
    if (
      indicators.some((indicator) =>
        keywords.some((keyword) => indicator.includes(keyword))
      )
    ) {
      return role;
    }
  }

  return undefined;
}

/**
 * Infer semantic purpose from position and content
 */
function inferSemanticPurpose(node: any, siblings: any[]): string {
  const role = detectSemanticRole(node);
  if (role) return role.toLowerCase();

  // Position-based inference
  const isTopSection = node.rect?.top < 100; // Top 100px of page
  const isBottomSection =
    node.rect?.top > (node.page?.height || 10000) - 500; // Bottom 500px

  if (isTopSection) {
    if (hasNavigation(node)) return "navigation";
    return "header";
  }

  if (isBottomSection) return "footer";

  // Content-based inference
  if (hasRepeatingPattern(node, siblings)) return "component";
  if (hasFormElements(node)) return "form";
  if (hasGridLayout(node)) return "grid";
  if (hasStackLayout(node)) return "stack";

  return "content";
}

function hasNavigation(node: any): boolean {
  return (
    node.children?.some(
      (child: any) =>
        child.htmlTag === "a" ||
        child.htmlTag === "nav" ||
        detectSemanticRole(child) === "NAVIGATION"
    ) || false
  );
}

function hasFormElements(node: any): boolean {
  const formTags = ["input", "textarea", "select", "button", "form"];
  return (
    node.children?.some((child: any) => formTags.includes(child.htmlTag)) ||
    false
  );
}

function hasGridLayout(node: any): boolean {
  return (
    (node.computedStyle && node.computedStyle.display && node.computedStyle.display.includes("grid")) ||
    (node.children?.length >= 4 && hasRegularSpacing(node.children))
  );
}

function hasStackLayout(node: any): boolean {
  return (
    (node.computedStyle && node.computedStyle.display && node.computedStyle.display.includes("flex")) ||
    (node.children?.length >= 2 && hasLinearArrangement(node.children))
  );
}

function hasRepeatingPattern(node: any, siblings: any[]): boolean {
  // Check if this node has similar siblings (same structure)
  const similarSiblings = siblings.filter(
    (s) => s !== node && areSimilarNodes(node, s)
  );
  return similarSiblings.length >= 2;
}

function areSimilarNodes(a: any, b: any): boolean {
  if (a.htmlTag !== b.htmlTag) return false;
  if (Math.abs((a.children?.length || 0) - (b.children?.length || 0)) > 1)
    return false;

  // Check structure similarity
  const aChildTags = (a.children || []).map((c: any) => c.htmlTag).sort();
  const bChildTags = (b.children || []).map((c: any) => c.htmlTag).sort();

  return aChildTags.join(",") === bChildTags.join(",");
}

function hasRegularSpacing(children: any[]): boolean {
  if (children.length < 2) return false;

  const gaps = [];
  for (let i = 1; i < children.length; i++) {
    const gap =
      children[i].rect.top -
      (children[i - 1].rect.top + children[i - 1].rect.height);
    gaps.push(gap);
  }

  const avgGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  const variance = gaps.reduce((sum, gap) => sum + Math.pow(gap - avgGap, 2), 0) / gaps.length;

  return variance < 100; // Low variance = regular spacing
}

function hasLinearArrangement(children: any[]): boolean {
  if (children.length < 2) return false;

  // Check all children have rect
  if (!children.every(child => child.rect)) return false;

  // Check if arranged horizontally or vertically
  const horizontalAlignment = children.every(
    (child, i) =>
      i === 0 ||
      Math.abs(child.rect.top - children[0].rect.top) < 10
  );

  const verticalAlignment = children.every(
    (child, i) =>
      i === 0 ||
      Math.abs(child.rect.left - children[0].rect.left) < 10
  );

  return horizontalAlignment || verticalAlignment;
}

// ============================================================================
// SEMANTIC NAMING
// ============================================================================

/**
 * Generate semantic name for node
 */
export function generateSemanticName(
  node: any,
  siblings: any[],
  metadata: SemanticMetadata
): string {
  // Priority 1: Explicit role/aria-label
  if (node.ariaLabel) return formatName(node.ariaLabel);
  if (node.role) return formatName(node.role);

  // Priority 2: Semantic role
  if (metadata.role) {
    const roleName = metadata.role;
    const index = siblings.filter((s) => s.metadata?.role === metadata.role).indexOf(node);
    return index > 0 ? `${roleName} ${index + 1}` : roleName;
  }

  // Priority 3: Component type
  if (metadata.componentType) {
    return metadata.componentType;
  }

  // Priority 4: Purpose-based naming
  if (metadata.purpose) {
    return formatName(metadata.purpose);
  }

  // Priority 5: ID or meaningful class
  if (node.id && !node.id.match(/^[a-z0-9-]+$/)) {
    return formatName(node.id);
  }

  const meaningfulClass = node.cssClasses?.find(
    (c: string) => c.length > 3 && !c.match(/^[a-z][0-9]+$/)
  );
  if (meaningfulClass) {
    return formatName(meaningfulClass);
  }

  // Priority 6: Text content (for text nodes)
  if (node.type === "TEXT" && node.text) {
    const preview = node.text.trim().substring(0, 30);
    return preview + (node.text.length > 30 ? "..." : "");
  }

  // Priority 7: HTML tag
  return formatName(node.htmlTag || "Frame");
}

function formatName(raw: string): string {
  return raw
    .replace(/[-_]/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2") // camelCase to spaces
    .split(" ")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

// ============================================================================
// AUTO-LAYOUT DETECTION
// ============================================================================

/**
 * Detect auto-layout direction from children arrangement
 */
export function detectAutoLayoutDirection(
  node: any
): "HORIZONTAL" | "VERTICAL" | "NONE" {
  const children = node.children || [];
  if (children.length < 2) return "NONE";

  // Check all children have rect
  if (!children.every((child: any) => child.rect)) return "NONE";

  // Check flexbox/grid from CSS
  const display = node.computedStyle?.display;
  const flexDirection = node.computedStyle?.flexDirection;

  if (display === "flex") {
    if (flexDirection === "row" || flexDirection === "row-reverse") {
      return "HORIZONTAL";
    }
    if (flexDirection === "column" || flexDirection === "column-reverse") {
      return "VERTICAL";
    }
  }

  if (display && display.includes("grid")) {
    // Grid can be both - check dominant direction
    const horizontalGaps = [];
    const verticalGaps = [];

    for (let i = 1; i < children.length; i++) {
      horizontalGaps.push(children[i].rect.left - children[i - 1].rect.left);
      verticalGaps.push(children[i].rect.top - children[i - 1].rect.top);
    }

    const avgHorizontalGap =
      horizontalGaps.reduce((a, b) => a + Math.abs(b), 0) / horizontalGaps.length;
    const avgVerticalGap =
      verticalGaps.reduce((a, b) => a + Math.abs(b), 0) / verticalGaps.length;

    return avgHorizontalGap > avgVerticalGap ? "HORIZONTAL" : "VERTICAL";
  }

  // Geometric detection - check if children are primarily stacked or side-by-side
  const horizontallyAligned = children.every(
    (child: any, i: number) =>
      i === 0 ||
      Math.abs(child.rect.top - children[0].rect.top) <
        (child.rect.height + children[0].rect.height) / 4
  );

  const verticallyAligned = children.every(
    (child: any, i: number) =>
      i === 0 ||
      Math.abs(child.rect.left - children[0].rect.left) <
        (child.rect.width + children[0].rect.width) / 4
  );

  if (horizontallyAligned && !verticallyAligned) return "HORIZONTAL";
  if (verticallyAligned && !horizontallyAligned) return "VERTICAL";

  // Check spacing pattern
  const verticalSpacing = children
    .slice(1)
    .map(
      (child: any, i: number) =>
        child.rect.top - (children[i].rect.top + children[i].rect.height)
    );

  const horizontalSpacing = children
    .slice(1)
    .map(
      (child: any, i: number) =>
        child.rect.left - (children[i].rect.left + children[i].rect.width)
    );

  const avgVerticalSpacing =
    verticalSpacing.reduce((a: number, b: number) => a + Math.abs(b), 0) /
    verticalSpacing.length;
  const avgHorizontalSpacing =
    horizontalSpacing.reduce((a: number, b: number) => a + Math.abs(b), 0) /
    horizontalSpacing.length;

  if (avgVerticalSpacing > avgHorizontalSpacing * 2) return "VERTICAL";
  if (avgHorizontalSpacing > avgVerticalSpacing * 2) return "HORIZONTAL";

  return "NONE";
}

// ============================================================================
// COMPONENT DETECTION
// ============================================================================

/**
 * Detect repeating component patterns
 */
export function detectComponentPatterns(
  nodes: any[],
  minInstances: number = 3
): ComponentPattern[] {
  const patterns: Map<string, ComponentPattern> = new Map();

  for (const node of nodes) {
    const signature = generateStructureSignature(node);
    if (!patterns.has(signature)) {
      patterns.set(signature, {
        name: generateComponentName(node),
        instances: [node],
        confidence: 0,
        signature,
      });
    } else {
      patterns.get(signature)!.instances.push(node);
    }
  }

  // Filter by minimum instances and calculate confidence
  const validPatterns = Array.from(patterns.values())
    .filter((p) => p.instances.length >= minInstances)
    .map((p) => ({
      ...p,
      confidence: calculatePatternConfidence(p),
    }))
    .sort((a, b) => b.confidence - a.confidence);

  return validPatterns;
}

function generateStructureSignature(node: any): string {
  const parts = [
    node.htmlTag,
    (node.children || []).map((c: any) => c.htmlTag).join(","),
    node.computedStyle?.display,
    (node.children || []).length,
  ];

  return parts.join("|");
}

function generateComponentName(node: any): string {
  const role = detectSemanticRole(node);
  if (role) return `${role} Component`;

  if (node.cssClasses?.length > 0) {
    const mainClass = node.cssClasses[0];
    return formatName(mainClass) + " Component";
  }

  return node.htmlTag + " Component";
}

function calculatePatternConfidence(pattern: ComponentPattern): number {
  let confidence = 0;

  // More instances = higher confidence
  confidence += Math.min(pattern.instances.length / 10, 5);

  // Similar sizing = higher confidence (if rect data available)
  const instancesWithRect = pattern.instances.filter(n => n.rect);
  if (instancesWithRect.length >= 2) {
    const sizes = instancesWithRect.map(
      (n) => n.rect.width * n.rect.height
    );
    const avgSize = sizes.reduce((a, b) => a + b, 0) / sizes.length;
    const sizeVariance =
      sizes.reduce((sum, size) => sum + Math.pow(size - avgSize, 2), 0) /
      sizes.length;
    const sizeConsistency = 1 / (1 + sizeVariance / (avgSize * avgSize));
    confidence += sizeConsistency * 5;
  } else {
    // No rect data, use moderate confidence based on instances only
    confidence += 2.5;
  }

  return Math.min(confidence, 10);
}

// ============================================================================
// MAIN ENHANCEMENT FUNCTION
// ============================================================================

/**
 * Enhance tree with semantic structure
 */
export function enhanceTreeStructure(
  rootNode: any,
  options: SemanticEnhancementOptions
): any {
  console.log("🎨 [SEMANTIC] Enhancing tree structure...");

  // Traverse and add metadata
  addSemanticMetadata(rootNode, [], options);

  // Detect component patterns
  if (options.detectComponents) {
    const allNodes: any[] = [];
    collectAllNodes(rootNode, allNodes);
    const patterns = detectComponentPatterns(
      allNodes,
      options.minComponentInstances
    );

    console.log(
      `🔄 [SEMANTIC] Detected ${patterns.length} component patterns`
    );

    // Mark component instances
    for (const pattern of patterns) {
      for (const instance of pattern.instances) {
        if (!instance.metadata) instance.metadata = {};
        instance.metadata.componentType = pattern.name;
        instance.metadata.isRepeating = true;
      }
    }
  }

  // Apply naming conventions
  if (options.applyNamingConventions) {
    applySemanticNaming(rootNode, []);
  }

  return rootNode;
}

function addSemanticMetadata(
  node: any,
  siblings: any[],
  options: SemanticEnhancementOptions
): void {
  if (!node.metadata) node.metadata = {};

  const metadata = node.metadata as SemanticMetadata;

  metadata.role = detectSemanticRole(node);
  metadata.purpose = inferSemanticPurpose(node, siblings);

  if (options.enableAutoLayout) {
    metadata.layoutDirection = detectAutoLayoutDirection(node);
  }

  // Recurse
  if (node.children) {
    for (const child of node.children) {
      addSemanticMetadata(child, node.children, options);
    }
  }
}

function applySemanticNaming(node: any, siblings: any[]): void {
  if (node.metadata) {
    node.name = generateSemanticName(node, siblings, node.metadata);
  }

  if (node.children) {
    for (const child of node.children) {
      applySemanticNaming(child, node.children);
    }
  }
}

function collectAllNodes(node: any, result: any[]): void {
  result.push(node);
  if (node.children) {
    for (const child of node.children) {
      collectAllNodes(child, result);
    }
  }
}
