/**
 * Layer Cleanup Optimizer
 *
 * Post-processing optimization that creates human-quality Figma documents by:
 * - Removing non-visual wrapper frames
 * - Merging adjacent rectangles with identical styles
 * - Merging consecutive text nodes with same styles
 * - Flattening unnecessary nesting
 *
 * Aligns with ARCHITECTURE.md BUILDER module principles:
 * - Editability over over-vectorization
 * - Clean, minimal layer structure
 * - Output resembles human-made Figma files, not DOM dumps
 */

export interface LayerCleanupOptions {
  removeNonVisualWrappers?: boolean;
  mergeAdjacentRectangles?: boolean;
  mergeConsecutiveText?: boolean;
  flattenUnnecessaryNesting?: boolean;
  maxNestingDepth?: number;
  minLayerSize?: number; // Minimum size in pixels to keep
}

export interface CleanupStats {
  originalLayerCount: number;
  finalLayerCount: number;
  wrappersRemoved: number;
  rectanglesMerged: number;
  textNodesMerged: number;
  layersFlattened: number;
}

/**
 * Checks if a frame node is a non-visual wrapper
 */
function isNonVisualWrapper(node: SceneNode): boolean {
  if (node.type !== "FRAME") {
    return false;
  }

  const frame = node as FrameNode;

  // Has children (otherwise not a wrapper)
  if (frame.children.length === 0) {
    return false;
  }

  // Check if it has any visual properties
  const hasVisualProps =
    (frame.fills !== figma.mixed && frame.fills.length > 0) ||
    frame.strokes.length > 0 ||
    frame.effects.length > 0 ||
    frame.opacity < 1 ||
    frame.blendMode !== "NORMAL";

  // Check if it provides layout value (Auto Layout, padding, etc.)
  const hasLayoutValue =
    frame.layoutMode !== "NONE" ||
    (frame.paddingLeft !== undefined && frame.paddingLeft > 0) ||
    (frame.paddingRight !== undefined && frame.paddingRight > 0) ||
    (frame.paddingTop !== undefined && frame.paddingTop > 0) ||
    (frame.paddingBottom !== undefined && frame.paddingBottom > 0) ||
    (frame.cornerRadius !== figma.mixed && frame.cornerRadius > 0) ||
    frame.clipsContent;

  // If no visual props and no layout value, it's a wrapper
  return !hasVisualProps && !hasLayoutValue;
}

/**
 * Checks if two fills are identical
 */
function fillsAreIdentical(fill1: Paint, fill2: Paint): boolean {
  if (fill1.type !== fill2.type) {
    return false;
  }

  if (fill1.type === "SOLID" && fill2.type === "SOLID") {
    return (
      fill1.color.r === fill2.color.r &&
      fill1.color.g === fill2.color.g &&
      fill1.color.b === fill2.color.b &&
      fill1.opacity === fill2.opacity
    );
  }

  // For other fill types, require exact match (conservative)
  return JSON.stringify(fill1) === JSON.stringify(fill2);
}

/**
 * Checks if two stroke styles are identical
 */
function strokesAreIdentical(
  strokes1: readonly Paint[],
  strokes2: readonly Paint[],
  weight1: number,
  weight2: number
): boolean {
  if (strokes1.length !== strokes2.length || weight1 !== weight2) {
    return false;
  }

  for (let i = 0; i < strokes1.length; i++) {
    if (!fillsAreIdentical(strokes1[i], strokes2[i])) {
      return false;
    }
  }

  return true;
}

/**
 * Checks if two rectangle nodes can be merged
 */
function canMergeRectangles(node1: RectangleNode, node2: RectangleNode): boolean {
  // Must be adjacent or overlapping
  const isAdjacent =
    (node1.x + node1.width === node2.x && node1.y === node2.y) || // Horizontal
    (node1.y + node1.height === node2.y && node1.x === node2.x); // Vertical

  if (!isAdjacent) {
    return false;
  }

  // Must have identical visual properties
  if (
    node1.fills === figma.mixed ||
    node2.fills === figma.mixed ||
    node1.fills.length !== node2.fills.length
  ) {
    return false;
  }

  for (let i = 0; i < node1.fills.length; i++) {
    if (!fillsAreIdentical(node1.fills[i], node2.fills[i])) {
      return false;
    }
  }

  if (
    node1.strokeWeight === figma.mixed ||
    node2.strokeWeight === figma.mixed ||
    !strokesAreIdentical(
      node1.strokes,
      node2.strokes,
      node1.strokeWeight,
      node2.strokeWeight
    )
  ) {
    return false;
  }

  if (
    node1.opacity !== node2.opacity ||
    node1.blendMode !== node2.blendMode ||
    node1.cornerRadius === figma.mixed ||
    node2.cornerRadius === figma.mixed ||
    node1.cornerRadius !== node2.cornerRadius
  ) {
    return false;
  }

  return true;
}

/**
 * Checks if two text nodes can be merged
 */
function canMergeTextNodes(node1: TextNode, node2: TextNode): boolean {
  // Must be horizontally adjacent on same line
  const isAdjacent = node1.x + node1.width === node2.x && node1.y === node2.y;

  if (!isAdjacent) {
    return false;
  }

  // Must have identical text styles
  if (node1.fontSize !== node2.fontSize) {
    return false;
  }

  if (
    node1.fontName === figma.mixed ||
    node2.fontName === figma.mixed ||
    node1.fontName.family !== node2.fontName.family
  ) {
    return false;
  }

  if (node1.fontName.style !== node2.fontName.style) {
    return false;
  }

  if (node1.textAlignHorizontal !== node2.textAlignHorizontal) {
    return false;
  }

  if (
    node1.fills === figma.mixed ||
    node2.fills === figma.mixed ||
    node1.fills.length !== node2.fills.length
  ) {
    return false;
  }

  for (let i = 0; i < node1.fills.length; i++) {
    if (!fillsAreIdentical(node1.fills[i], node2.fills[i])) {
      return false;
    }
  }

  return true;
}

/**
 * Removes non-visual wrapper frames by hoisting children
 */
function removeNonVisualWrappers(
  parent: BaseNode & ChildrenMixin,
  stats: CleanupStats
): void {
  const childrenToProcess = [...parent.children];

  for (const child of childrenToProcess) {
    if (isNonVisualWrapper(child)) {
      const wrapper = child as FrameNode;
      const wrapperChildren = [...wrapper.children];

      // Hoist children to wrapper's parent
      for (const grandchild of wrapperChildren) {
        // Adjust coordinates to account for wrapper removal
        if ("x" in grandchild && "y" in grandchild) {
          grandchild.x += wrapper.x;
          grandchild.y += wrapper.y;
        }

        parent.appendChild(grandchild);
      }

      // Remove the wrapper
      wrapper.remove();
      stats.wrappersRemoved++;

      console.log(`[CLEANUP] Removed non-visual wrapper: ${wrapper.name}`);
    }

    // Recurse into children
    if ("children" in child) {
      removeNonVisualWrappers(child as BaseNode & ChildrenMixin, stats);
    }
  }
}

/**
 * Merges adjacent rectangles with identical styles
 */
function mergeAdjacentRectangles(
  parent: BaseNode & ChildrenMixin,
  stats: CleanupStats
): void {
  const children = [...parent.children];
  const rectangles: RectangleNode[] = [];

  // Collect all rectangles
  for (const child of children) {
    if (child.type === "RECTANGLE") {
      rectangles.push(child as RectangleNode);
    }
  }

  // Try to merge adjacent rectangles
  const merged = new Set<RectangleNode>();

  for (let i = 0; i < rectangles.length; i++) {
    if (merged.has(rectangles[i])) continue;

    for (let j = i + 1; j < rectangles.length; j++) {
      if (merged.has(rectangles[j])) continue;

      if (canMergeRectangles(rectangles[i], rectangles[j])) {
        const rect1 = rectangles[i];
        const rect2 = rectangles[j];

        // Merge rect2 into rect1
        const minX = Math.min(rect1.x, rect2.x);
        const minY = Math.min(rect1.y, rect2.y);
        const maxX = Math.max(rect1.x + rect1.width, rect2.x + rect2.width);
        const maxY = Math.max(rect1.y + rect1.height, rect2.y + rect2.height);

        rect1.x = minX;
        rect1.y = minY;
        rect1.resize(maxX - minX, maxY - minY);

        rect2.remove();
        merged.add(rect2);
        stats.rectanglesMerged++;

        console.log(
          `[CLEANUP] Merged rectangles: ${rect1.name} + ${rect2.name}`
        );
      }
    }
  }

  // Recurse into children
  for (const child of children) {
    if (!merged.has(child as RectangleNode) && "children" in child) {
      mergeAdjacentRectangles(child as BaseNode & ChildrenMixin, stats);
    }
  }
}

/**
 * Merges consecutive text nodes with same styles
 */
function mergeConsecutiveTextNodes(
  parent: BaseNode & ChildrenMixin,
  stats: CleanupStats
): void {
  const children = [...parent.children];
  const textNodes: TextNode[] = [];

  // Collect all text nodes
  for (const child of children) {
    if (child.type === "TEXT") {
      textNodes.push(child as TextNode);
    }
  }

  // Try to merge consecutive text nodes
  const merged = new Set<TextNode>();

  for (let i = 0; i < textNodes.length; i++) {
    if (merged.has(textNodes[i])) continue;

    for (let j = i + 1; j < textNodes.length; j++) {
      if (merged.has(textNodes[j])) continue;

      if (canMergeTextNodes(textNodes[i], textNodes[j])) {
        const text1 = textNodes[i];
        const text2 = textNodes[j];

        // Merge text2 into text1
        text1.characters = text1.characters + text2.characters;
        text1.resize(text1.width + text2.width, text1.height);

        text2.remove();
        merged.add(text2);
        stats.textNodesMerged++;

        console.log(`[CLEANUP] Merged text nodes: ${text1.name} + ${text2.name}`);
      }
    }
  }

  // Recurse into children
  for (const child of children) {
    if (!merged.has(child as TextNode) && "children" in child) {
      mergeConsecutiveTextNodes(child as BaseNode & ChildrenMixin, stats);
    }
  }
}

/**
 * Flattens unnecessary nesting by collapsing single-child frames
 */
function flattenUnnecessaryNesting(
  parent: BaseNode & ChildrenMixin,
  stats: CleanupStats,
  currentDepth: number = 0,
  maxDepth: number = 10
): void {
  if (currentDepth > maxDepth) {
    return;
  }

  const childrenToProcess = [...parent.children];

  for (const child of childrenToProcess) {
    if (child.type === "FRAME") {
      const frame = child as FrameNode;

      // If frame has single child and no special properties, flatten
      if (frame.children.length === 1 && isNonVisualWrapper(frame)) {
        const onlyChild = frame.children[0];

        // Adjust child coordinates
        if ("x" in onlyChild && "y" in onlyChild) {
          onlyChild.x += frame.x;
          onlyChild.y += frame.y;
        }

        // Hoist child
        parent.appendChild(onlyChild);
        frame.remove();
        stats.layersFlattened++;

        console.log(`[CLEANUP] Flattened single-child frame: ${frame.name}`);
      }
    }

    // Recurse
    if ("children" in child) {
      flattenUnnecessaryNesting(
        child as BaseNode & ChildrenMixin,
        stats,
        currentDepth + 1,
        maxDepth
      );
    }
  }
}

/**
 * Counts total nodes in a tree
 */
function countNodes(node: BaseNode): number {
  let count = 1;
  if ("children" in node) {
    for (const child of (node as BaseNode & ChildrenMixin).children) {
      count += countNodes(child);
    }
  }
  return count;
}

/**
 * Optimizes Figma layer tree by removing unnecessary layers and merging duplicates
 *
 * @param root - Root node to optimize
 * @param options - Cleanup options
 * @returns Statistics about optimizations performed
 */
export async function optimizeLayerTree(
  root: BaseNode & ChildrenMixin,
  options: LayerCleanupOptions = {}
): Promise<CleanupStats> {
  const defaultOptions: LayerCleanupOptions = {
    removeNonVisualWrappers: true,
    mergeAdjacentRectangles: true,
    mergeConsecutiveText: true,
    flattenUnnecessaryNesting: true,
    maxNestingDepth: 10,
    minLayerSize: 1,
    ...options,
  };

  const stats: CleanupStats = {
    originalLayerCount: countNodes(root),
    finalLayerCount: 0,
    wrappersRemoved: 0,
    rectanglesMerged: 0,
    textNodesMerged: 0,
    layersFlattened: 0,
  };

  console.log("[CLEANUP] Starting layer cleanup with options:", defaultOptions);
  console.log(`[CLEANUP] Original layer count: ${stats.originalLayerCount}`);

  // Pass 1: Remove non-visual wrappers
  if (defaultOptions.removeNonVisualWrappers) {
    console.log("[CLEANUP] Pass 1: Removing non-visual wrappers...");
    removeNonVisualWrappers(root, stats);
  }

  // Pass 2: Merge adjacent rectangles
  if (defaultOptions.mergeAdjacentRectangles) {
    console.log("[CLEANUP] Pass 2: Merging adjacent rectangles...");
    mergeAdjacentRectangles(root, stats);
  }

  // Pass 3: Merge consecutive text nodes
  if (defaultOptions.mergeConsecutiveText) {
    console.log("[CLEANUP] Pass 3: Merging consecutive text nodes...");
    mergeConsecutiveTextNodes(root, stats);
  }

  // Pass 4: Flatten unnecessary nesting
  if (defaultOptions.flattenUnnecessaryNesting) {
    console.log("[CLEANUP] Pass 4: Flattening unnecessary nesting...");
    flattenUnnecessaryNesting(
      root,
      stats,
      0,
      defaultOptions.maxNestingDepth || 10
    );
  }

  stats.finalLayerCount = countNodes(root);

  console.log("[CLEANUP] Cleanup complete:");
  console.log(`  - Final layer count: ${stats.finalLayerCount}`);
  console.log(`  - Layers removed: ${stats.originalLayerCount - stats.finalLayerCount}`);
  console.log(`  - Wrappers removed: ${stats.wrappersRemoved}`);
  console.log(`  - Rectangles merged: ${stats.rectanglesMerged}`);
  console.log(`  - Text nodes merged: ${stats.textNodesMerged}`);
  console.log(`  - Layers flattened: ${stats.layersFlattened}`);

  return stats;
}

/**
 * Validates that cleanup didn't break visual correctness
 */
export function validateCleanup(
  originalBounds: { width: number; height: number },
  cleanedRoot: BaseNode & ChildrenMixin
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  // Check that root bounds are still reasonable
  if ("width" in cleanedRoot && "height" in cleanedRoot) {
    const widthDiff = Math.abs(
      (cleanedRoot as any).width - originalBounds.width
    );
    const heightDiff = Math.abs(
      (cleanedRoot as any).height - originalBounds.height
    );

    if (widthDiff > 1 || heightDiff > 1) {
      errors.push(
        `Bounds changed significantly: ${widthDiff}px width, ${heightDiff}px height`
      );
    }
  }

  // Check for orphaned nodes (nodes outside parent bounds)
  function checkOrphans(node: BaseNode & ChildrenMixin) {
    if (!("x" in node) || !("y" in node)) return;

    const parent = node.parent;
    if (!parent || !("width" in parent) || !("height" in parent)) return;

    const nodeX = (node as any).x;
    const nodeY = (node as any).y;
    const nodeWidth = (node as any).width || 0;
    const nodeHeight = (node as any).height || 0;
    const parentWidth = (parent as any).width;
    const parentHeight = (parent as any).height;

    if (
      nodeX < -nodeWidth ||
      nodeY < -nodeHeight ||
      nodeX > parentWidth * 2 ||
      nodeY > parentHeight * 2
    ) {
      errors.push(`Orphaned node detected: ${node.name} at (${nodeX}, ${nodeY})`);
    }

    if ("children" in node) {
      for (const child of node.children) {
        if ("children" in child) {
          checkOrphans(child as BaseNode & ChildrenMixin);
        }
      }
    }
  }

  checkOrphans(cleanedRoot);

  return {
    valid: errors.length === 0,
    errors,
  };
}
