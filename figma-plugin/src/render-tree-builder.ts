/**
 * Render Tree Builder
 *
 * Transforms DOM tree into render tree by:
 * - Removing display:none and invisible nodes
 * - Materializing ::before and ::after pseudo-elements
 * - Flattening stacking contexts into paint order
 * - Resolving shadow DOM
 *
 * Aligns with ARCHITECTURE.md SERVER module principles:
 * - Build render tree (not DOM tree)
 * - Browser-rendered truth over DOM assumptions
 */

import type { ElementNode } from "../../shared/schema";

export interface RenderTreeOptions {
  materializePseudoElements?: boolean;
  flattenStackingContexts?: boolean;
  resolveShadowDOM?: boolean;
  removeInvisible?: boolean;
}

export interface StackingContext {
  node: ElementNode;
  zIndex: number;
  children: StackingContext[];
  paintOrder: number;
}

/**
 * Checks if a node should be removed from render tree
 */
function shouldRemoveNode(node: ElementNode): boolean {
  // Remove display:none
  if (node.computedStyles?.display === "none") {
    return true;
  }

  // Remove fully invisible (opacity 0 + no pointer events)
  if (
    node.computedStyles?.opacity === "0" &&
    node.computedStyles?.pointerEvents === "none"
  ) {
    return true;
  }

  // Remove zero-size elements without children
  if (
    (!node.children || node.children.length === 0) &&
    node.width === 0 &&
    node.height === 0
  ) {
    // Exception: Keep structural elements even if zero-size
    const structuralTypes = ["FRAME", "GROUP", "SECTION"];
    if (!structuralTypes.includes(node.type)) {
      return true;
    }
  }

  // Remove hidden visibility (unless children might be visible)
  if (
    node.computedStyles?.visibility === "hidden" &&
    (!node.children || node.children.length === 0)
  ) {
    return true;
  }

  return false;
}

/**
 * Materializes ::before and ::after pseudo-elements as actual nodes
 */
function materializePseudoElements(node: ElementNode): ElementNode[] {
  const pseudoNodes: ElementNode[] = [];

  // Check for ::before
  if (node.pseudoElements?.before) {
    const before = node.pseudoElements.before;
    const beforeNode: ElementNode = {
      id: `${node.id}::before`,
      type: "FRAME",
      name: `${node.name || "element"}::before`,
      x: node.x,
      y: node.y,
      width: before.width || 0,
      height: before.height || 0,
      children: [],
      computedStyles: before.styles,
      fills: before.fills || [],
      isPseudoElement: true,
      pseudoType: "before",
    };
    pseudoNodes.push(beforeNode);
  }

  // Check for ::after
  if (node.pseudoElements?.after) {
    const after = node.pseudoElements.after;
    const afterNode: ElementNode = {
      id: `${node.id}::after`,
      type: "FRAME",
      name: `${node.name || "element"}::after`,
      x: node.x + (node.width || 0),
      y: node.y,
      width: after.width || 0,
      height: after.height || 0,
      children: [],
      computedStyles: after.styles,
      fills: after.fills || [],
      isPseudoElement: true,
      pseudoType: "after",
    };
    pseudoNodes.push(afterNode);
  }

  return pseudoNodes;
}

/**
 * Builds stacking context tree from element tree
 */
function buildStackingContextTree(
  node: ElementNode,
  parentContext: StackingContext | null = null,
  paintOrderCounter: { value: number } = { value: 0 },
): StackingContext {
  const zIndex = node.computedStyles?.zIndex
    ? parseInt(String(node.computedStyles.zIndex), 10)
    : 0;

  const context: StackingContext = {
    node,
    zIndex: isNaN(zIndex) ? 0 : zIndex,
    children: [],
    paintOrder: paintOrderCounter.value++,
  };

  // Process children
  if (node.children && node.children.length > 0) {
    for (const child of node.children) {
      // Check if child creates new stacking context
      const createsStackingContext =
        child.computedStyles?.position === "relative" ||
        child.computedStyles?.position === "absolute" ||
        child.computedStyles?.position === "fixed" ||
        child.computedStyles?.position === "sticky" ||
        (child.computedStyles?.zIndex &&
          child.computedStyles.zIndex !== "auto") ||
        (child.computedStyles?.opacity &&
          parseFloat(String(child.computedStyles.opacity)) < 1) ||
        child.computedStyles?.transform !== "none" ||
        child.computedStyles?.filter !== "none";

      if (createsStackingContext) {
        const childContext = buildStackingContextTree(
          child,
          context,
          paintOrderCounter,
        );
        context.children.push(childContext);
      } else {
        // Child participates in parent stacking context
        const childContext = buildStackingContextTree(
          child,
          parentContext || context,
          paintOrderCounter,
        );
        context.children.push(childContext);
      }
    }
  }

  return context;
}

/**
 * Flattens stacking context tree into paint order
 */
function flattenStackingContexts(context: StackingContext): ElementNode[] {
  const flattened: Array<{ node: ElementNode; paintOrder: number }> = [];

  function collect(ctx: StackingContext) {
    flattened.push({ node: ctx.node, paintOrder: ctx.paintOrder });
    for (const child of ctx.children) {
      collect(child);
    }
  }

  collect(context);

  // Sort by z-index first, then paint order
  flattened.sort((a, b) => {
    const aZ = a.node.computedStyles?.zIndex
      ? parseInt(String(a.node.computedStyles.zIndex), 10)
      : 0;
    const bZ = b.node.computedStyles?.zIndex
      ? parseInt(String(b.node.computedStyles.zIndex), 10)
      : 0;

    if (aZ !== bZ) {
      return aZ - bZ;
    }

    return a.paintOrder - b.paintOrder;
  });

  return flattened.map((item) => item.node);
}

/**
 * Processes a single node and its children recursively
 */
function processNodeRecursive(
  node: ElementNode,
  options: RenderTreeOptions,
): ElementNode | null {
  // Remove invisible nodes
  if (options.removeInvisible && shouldRemoveNode(node)) {
    return null;
  }

  // Clone node to avoid mutations
  const processed: ElementNode = {
    ...node,
    children: [],
  };

  // Materialize pseudo-elements
  const pseudoNodes: ElementNode[] = [];
  if (options.materializePseudoElements) {
    pseudoNodes.push(...materializePseudoElements(node));
  }

  // Process children
  const processedChildren: ElementNode[] = [];

  if (node.children && node.children.length > 0) {
    for (const child of node.children) {
      const processedChild = processNodeRecursive(child, options);
      if (processedChild) {
        processedChildren.push(processedChild);
      }
    }
  }

  // Add pseudo-elements
  if (pseudoNodes.length > 0) {
    processed.children = [...pseudoNodes, ...processedChildren];
  } else {
    processed.children = processedChildren;
  }

  return processed;
}

/**
 * Builds render tree from DOM tree
 *
 * @param root - Root element node from DOM tree
 * @param options - Processing options
 * @returns Render tree with optimizations applied
 */
export function buildRenderTree(
  root: ElementNode,
  options: RenderTreeOptions = {},
): ElementNode | null {
  const defaultOptions: RenderTreeOptions = {
    materializePseudoElements: true,
    flattenStackingContexts: false, // Default to false to preserve hierarchy
    resolveShadowDOM: false,
    removeInvisible: true,
    ...options,
  };

  console.log(
    "[RENDER_TREE] Building render tree with options:",
    defaultOptions,
  );

  // Step 1: Process nodes recursively
  let processed = processNodeRecursive(root, defaultOptions);
  if (!processed) {
    console.warn("[RENDER_TREE] Root node was removed during processing");
    return null;
  }

  // Step 2: Flatten stacking contexts if enabled
  if (defaultOptions.flattenStackingContexts && processed.children) {
    console.log("[RENDER_TREE] Flattening stacking contexts...");
    const stackingContext = buildStackingContextTree(processed);
    const flattened = flattenStackingContexts(stackingContext);

    // Reconstruct tree with flattened order
    // CRITICAL FIX: Filter out the root node itself to prevent circular reference (root.children containing root)
    processed.children = flattened.filter((node) => node !== processed);
  }

  console.log("[RENDER_TREE] Render tree built successfully");
  return processed;
}

/**
 * Gets statistics about render tree transformations
 */
export function getRenderTreeStats(
  original: ElementNode,
  renderTree: ElementNode | null,
): {
  originalNodeCount: number;
  renderNodeCount: number;
  removedNodes: number;
  pseudoElementsAdded: number;
} {
  function countNodes(node: ElementNode | null): number {
    if (!node) return 0;
    let count = 1;
    if (node.children) {
      for (const child of node.children) {
        count += countNodes(child);
      }
    }
    return count;
  }

  function countPseudoElements(node: ElementNode | null): number {
    if (!node) return 0;
    let count = node.isPseudoElement ? 1 : 0;
    if (node.children) {
      for (const child of node.children) {
        count += countPseudoElements(child);
      }
    }
    return count;
  }

  const originalNodeCount = countNodes(original);
  const renderNodeCount = countNodes(renderTree);

  return {
    originalNodeCount,
    renderNodeCount,
    removedNodes: originalNodeCount - renderNodeCount,
    pseudoElementsAdded: countPseudoElements(renderTree),
  };
}
