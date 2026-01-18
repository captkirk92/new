// figma-plugin/src/scene-graph-exporter.ts
// Exports the actual Figma scene graph for gap analysis comparison

/**
 * FigmaNodeSnapshot represents a flattened view of a Figma node
 * with all the data needed for gap analysis
 */
export interface FigmaNodeSnapshot {
  figmaId: string;
  schemaId?: string;
  name: string;
  type: string;
  visible: boolean;
  opacity: number;
  clipsContent: boolean;
  absoluteBoundingBox: {
    x: number;
    y: number;
    width: number;
    height: number;
  } | null;
  fills: readonly Paint[] | null;
  strokes: readonly Paint[] | null;
  effects: readonly Effect[] | null;
  // Parent chain for debugging clip/visibility inheritance
  parentId?: string;
  depth: number;
}

/**
 * SceneGraphExport is the full export structure
 */
export interface SceneGraphExport {
  exportId: string;
  timestamp: string;
  rootNodeId: string;
  rootNodeName: string;
  totalNodes: number;
  flatNodes: FigmaNodeSnapshot[];
  metadata: {
    figmaFileKey?: string;
    exportedAt: number;
    pluginVersion: string;
  };
}

/**
 * SceneGraphExporter - Traverses and exports Figma nodes for gap analysis
 *
 * Usage:
 * ```ts
 * const exporter = new SceneGraphExporter();
 * const snapshot = exporter.exportFromNode(figmaRootNode);
 * figma.ui.postMessage({ type: 'scene-graph-export', data: snapshot });
 * ```
 */
export class SceneGraphExporter {
  private schemaIdKey = "schemaId";

  /**
   * Export a complete scene graph from a root node
   */
  exportFromNode(rootNode: SceneNode): SceneGraphExport {
    const flatNodes: FigmaNodeSnapshot[] = [];
    this.traverseNode(rootNode, flatNodes, 0);

    return {
      exportId: `export-${Date.now()}-${Math.random()
        .toString(36)
        .substr(2, 9)}`,
      timestamp: new Date().toISOString(),
      rootNodeId: rootNode.id,
      rootNodeName: rootNode.name,
      totalNodes: flatNodes.length,
      flatNodes,
      metadata: {
        exportedAt: Date.now(),
        pluginVersion: "1.0.0",
      },
    };
  }

  /**
   * Export the current selection or the entire page
   */
  exportCurrentSelection(): SceneGraphExport | null {
    const selection = figma.currentPage.selection;
    if (selection.length === 0) {
      console.warn("No selection - exporting entire page");
      return this.exportFromNode(figma.currentPage as unknown as SceneNode);
    }

    // If single node selected, export from that
    if (selection.length === 1) {
      return this.exportFromNode(selection[0]);
    }

    // Multiple selection - wrap in a virtual container
    const flatNodes: FigmaNodeSnapshot[] = [];
    for (const node of selection) {
      this.traverseNode(node, flatNodes, 0);
    }

    return {
      exportId: `export-${Date.now()}-${Math.random()
        .toString(36)
        .substr(2, 9)}`,
      timestamp: new Date().toISOString(),
      rootNodeId: "multi-selection",
      rootNodeName: `Selection (${selection.length} nodes)`,
      totalNodes: flatNodes.length,
      flatNodes,
      metadata: {
        exportedAt: Date.now(),
        pluginVersion: "1.0.0",
      },
    };
  }

  /**
   * Export nodes that have schemaId plugin data (imported nodes only)
   */
  exportImportedNodes(rootNode: SceneNode): SceneGraphExport {
    const flatNodes: FigmaNodeSnapshot[] = [];
    this.traverseNode(rootNode, flatNodes, 0, true);

    return {
      exportId: `export-imported-${Date.now()}-${Math.random()
        .toString(36)
        .substr(2, 9)}`,
      timestamp: new Date().toISOString(),
      rootNodeId: rootNode.id,
      rootNodeName: rootNode.name,
      totalNodes: flatNodes.length,
      flatNodes,
      metadata: {
        exportedAt: Date.now(),
        pluginVersion: "1.0.0",
      },
    };
  }

  /**
   * Traverse and collect node data recursively
   */
  private traverseNode(
    node: SceneNode | PageNode,
    result: FigmaNodeSnapshot[],
    depth: number,
    importedOnly: boolean = false
  ): void {
    // Get schemaId from plugin data if set during import
    let schemaId: string | undefined;
    try {
      const pluginData = node.getPluginData(this.schemaIdKey);
      if (pluginData) {
        schemaId = pluginData;
      }
    } catch (e) {
      // Some node types don't support plugin data
    }

    // If we only want imported nodes and this doesn't have schemaId, skip it
    // But still traverse children
    const includeNode = !importedOnly || !!schemaId;

    if (includeNode && node.type !== "PAGE") {
      const snapshot = this.snapshotNode(node as SceneNode, schemaId, depth);
      if (snapshot) {
        result.push(snapshot);
      }
    }

    // Traverse children
    if ("children" in node) {
      for (const child of node.children) {
        this.traverseNode(child, result, depth + 1, importedOnly);
      }
    }
  }

  /**
   * Create a snapshot of a single node
   */
  private snapshotNode(
    node: SceneNode,
    schemaId: string | undefined,
    depth: number
  ): FigmaNodeSnapshot | null {
    // Get absolute bounding box
    let absoluteBoundingBox: FigmaNodeSnapshot["absoluteBoundingBox"] = null;
    try {
      if ("absoluteBoundingBox" in node && node.absoluteBoundingBox) {
        absoluteBoundingBox = {
          x: node.absoluteBoundingBox.x,
          y: node.absoluteBoundingBox.y,
          width: node.absoluteBoundingBox.width,
          height: node.absoluteBoundingBox.height,
        };
      } else if (
        "absoluteTransform" in node &&
        "width" in node &&
        "height" in node
      ) {
        // Fallback: compute from transform matrix
        const transform = node.absoluteTransform;
        absoluteBoundingBox = {
          x: transform[0][2],
          y: transform[1][2],
          width: (node as LayoutMixin).width,
          height: (node as LayoutMixin).height,
        };
      }
    } catch (e) {
      // Some nodes don't have bounding boxes
    }

    // Get fills
    let fills: readonly Paint[] | null = null;
    if ("fills" in node) {
      try {
        const nodeFills = (node as GeometryMixin).fills;
        if (nodeFills !== figma.mixed) {
          fills = nodeFills;
        }
      } catch (e) {
        console.debug(`[SceneGraph] Failed to read fills from ${node.name}: ${e}`);
      }
    }

    // Get strokes
    let strokes: readonly Paint[] | null = null;
    if ("strokes" in node) {
      try {
        strokes = (node as GeometryMixin).strokes;
      } catch (e) {
        console.debug(`[SceneGraph] Failed to read strokes from ${node.name}: ${e}`);
      }
    }

    // Get effects
    let effects: readonly Effect[] | null = null;
    if ("effects" in node) {
      try {
        effects = (node as BlendMixin).effects;
      } catch (e) {
        console.debug(`[SceneGraph] Failed to read effects from ${node.name}: ${e}`);
      }
    }

    // Get visibility
    let visible = true;
    if ("visible" in node) {
      visible = node.visible;
    }

    // Get opacity
    let opacity = 1.0;
    if ("opacity" in node) {
      opacity = (node as BlendMixin).opacity;
    }

    // Get clips content
    let clipsContent = false;
    if ("clipsContent" in node) {
      clipsContent = (node as FrameNode).clipsContent;
    }

    // Get parent id
    let parentId: string | undefined;
    if (
      node.parent &&
      node.parent.type !== "PAGE" &&
      node.parent.type !== "DOCUMENT"
    ) {
      parentId = node.parent.id;
    }

    return {
      figmaId: node.id,
      schemaId,
      name: node.name,
      type: node.type,
      visible,
      opacity,
      clipsContent,
      absoluteBoundingBox,
      fills,
      strokes,
      effects,
      parentId,
      depth,
    };
  }

  /**
   * Set schemaId on a node during import (call this when creating nodes)
   */
  static setSchemaId(node: SceneNode, schemaId: string): void {
    try {
      node.setPluginData("schemaId", schemaId);
    } catch (e) {
      console.warn(`Failed to set schemaId on node ${node.id}:`, e);
    }
  }
}

/**
 * Helper function to export scene graph and download as JSON
 */
export function exportSceneGraphToFile(rootNode?: SceneNode): void {
  const exporter = new SceneGraphExporter();

  let snapshot: SceneGraphExport | null;
  if (rootNode) {
    snapshot = exporter.exportFromNode(rootNode);
  } else {
    snapshot = exporter.exportCurrentSelection();
  }

  if (!snapshot) {
    figma.notify("No nodes to export");
    return;
  }

  // Send to UI for download
  figma.ui.postMessage({
    type: "scene-graph-export-download",
    data: snapshot,
    filename: `figma-nodes-${snapshot.exportId}.json`,
  });

  figma.notify(`Exported ${snapshot.totalNodes} nodes`);
}

/**
 * Helper function to export only imported nodes (those with schemaId)
 */
export function exportImportedNodesToFile(rootNode: SceneNode): void {
  const exporter = new SceneGraphExporter();
  const snapshot = exporter.exportImportedNodes(rootNode);

  // Send to UI for download
  figma.ui.postMessage({
    type: "scene-graph-export-download",
    data: snapshot,
    filename: `figma-imported-nodes-${snapshot.exportId}.json`,
  });

  figma.notify(`Exported ${snapshot.totalNodes} imported nodes`);
}
