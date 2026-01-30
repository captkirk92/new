/**
 * Tree Structure Validator
 * Verifies that DOM hierarchy is correctly preserved through Schema → Figma pipeline
 */

export interface TreeNode {
  id: string;
  name: string;
  type: string;
  parentId?: string;
  children?: TreeNode[];
  depth?: number;
}

export interface TreeValidationReport {
  isValid: boolean;
  totalNodes: number;
  maxDepth: number;
  issues: TreeValidationIssue[];
  summary: string;
  hierarchyMap: Map<string, TreeNodeInfo>;
}

export interface TreeValidationIssue {
  severity: "error" | "warning" | "info";
  nodeId: string;
  nodeName: string;
  issue: string;
  details?: any;
}

export interface TreeNodeInfo {
  id: string;
  name: string;
  type: string;
  parentId: string | null;
  childIds: string[];
  depth: number;
  path: string[];
}

export class TreeValidator {
  private issues: TreeValidationIssue[] = [];
  private hierarchyMap = new Map<string, TreeNodeInfo>();
  private maxDepth = 0;

  /**
   * Validate schema tree structure before Figma import
   */
  validateSchemaTree(schema: any): TreeValidationReport {
    console.log("🔍 [TREE VALIDATOR] Starting schema tree validation...");
    this.issues = [];
    this.hierarchyMap.clear();
    this.maxDepth = 0;

    if (!schema) {
      this.addIssue("error", "root", "Schema", "Schema is null or undefined");
      return this.generateReport();
    }

    const root = schema.root || schema.tree;
    if (!root) {
      this.addIssue(
        "error",
        "root",
        "Schema",
        "No root or tree found in schema",
        {
          schemaKeys: Object.keys(schema),
        },
      );
      return this.generateReport();
    }

    // Build hierarchy map
    this.buildHierarchyMap(root, null, 0, [], new Set());

    // Validate structure
    this.validateHierarchyIntegrity();
    this.validateParentChildRelationships();
    this.validateNoDuplicateIds();
    this.validateNoOrphanNodes();

    const report = this.generateReport();
    this.logReport(report);

    return report;
  }

  /**
   * Validate Figma tree matches schema tree
   */
  validateFigmaTree(
    figmaFrame: FrameNode,
    schemaRoot: any,
  ): TreeValidationReport {
    console.log("🔍 [TREE VALIDATOR] Starting Figma tree validation...");
    this.issues = [];
    this.hierarchyMap.clear();
    this.maxDepth = 0;

    // Build schema hierarchy map
    const schemaMap = new Map<string, TreeNodeInfo>();
    this.buildSchemaMap(schemaRoot, null, 0, [], schemaMap, new Set());

    // Build Figma hierarchy map
    const figmaMap = new Map<string, TreeNodeInfo>();
    this.buildFigmaMap(figmaFrame, null, 0, [], figmaMap, new Set());

    // Compare structures
    this.compareHierarchies(schemaMap, figmaMap);

    const report = this.generateReport();
    this.logReport(report);

    return report;
  }

  /**
   * Generate a visual tree diagram for debugging
   */
  generateTreeDiagram(node: any, prefix = "", isLast = true): string {
    const lines: string[] = [];
    const connector = isLast ? "└── " : "├── ";
    const name = node.name || node.tagName || node.type || "unnamed";
    const type = node.type || "unknown";
    const id = node.id || "no-id";

    lines.push(`${prefix}${connector}${name} (${type}) [${id}]`);

    const children = node.children || [];
    const childPrefix = prefix + (isLast ? "    " : "│   ");

    children.forEach((child: any, index: number) => {
      const childIsLast = index === children.length - 1;
      lines.push(this.generateTreeDiagram(child, childPrefix, childIsLast));
    });

    return lines.join("\n");
  }

  /**
   * Export tree structure to JSON for external analysis
   */
  exportTreeStructure(node: any): any {
    return {
      id: node.id,
      name: node.name || node.tagName,
      type: node.type,
      childCount: node.children ? node.children.length : 0,
      children: (node.children || []).map((child: any) =>
        this.exportTreeStructure(child),
      ),
    };
  }

  // Private helper methods

  private buildHierarchyMap(
    node: any,
    parentId: string | null,
    depth: number,
    path: string[],
    visited: Set<any>,
  ): void {
    if (!node) return;

    // Cycle detection
    if (visited.has(node)) {
      return;
    }
    visited.add(node);

    const nodeId = node.id || `temp_${Math.random().toString(36).substr(2, 9)}`;
    const nodeName = node.name || node.tagName || node.type || "unnamed";
    const nodeType = node.type || "unknown";
    const currentPath = [...path, nodeName];

    this.maxDepth = Math.max(this.maxDepth, depth);

    const childIds = (node.children || []).map(
      (child: any) =>
        child.id || `temp_${Math.random().toString(36).substr(2, 9)}`,
    );

    this.hierarchyMap.set(nodeId, {
      id: nodeId,
      name: nodeName,
      type: nodeType,
      parentId,
      childIds,
      depth,
      path: currentPath,
    });

    // Recursively process children
    if (node.children && Array.isArray(node.children)) {
      node.children.forEach((child: any) => {
        this.buildHierarchyMap(child, nodeId, depth + 1, currentPath, visited);
      });
    }
  }

  private buildSchemaMap(
    node: any,
    parentId: string | null,
    depth: number,
    path: string[],
    map: Map<string, TreeNodeInfo>,
    visited: Set<any>,
  ): void {
    if (!node) return;

    if (visited.has(node)) return;
    visited.add(node);

    const nodeId = node.id;
    const nodeName = node.name || node.tagName || node.type || "unnamed";
    const currentPath = [...path, nodeName];

    const childIds = (node.children || []).map((child: any) => child.id);

    map.set(nodeId, {
      id: nodeId,
      name: nodeName,
      type: node.type || "unknown",
      parentId,
      childIds,
      depth,
      path: currentPath,
    });

    if (node.children && Array.isArray(node.children)) {
      node.children.forEach((child: any) => {
        this.buildSchemaMap(
          child,
          nodeId,
          depth + 1,
          currentPath,
          map,
          visited,
        );
      });
    }
  }

  private buildFigmaMap(
    node: SceneNode,
    parentId: string | null,
    depth: number,
    path: string[],
    map: Map<string, TreeNodeInfo>,
    visited: Set<any>,
  ): void {
    if (visited.has(node)) return;
    visited.add(node);

    // Try to get original schema ID from plugin data
    let nodeId: string;
    try {
      nodeId = node.getPluginData("schemaId") || node.id;
    } catch {
      nodeId = node.id;
    }

    const nodeName = node.name;
    const currentPath = [...path, nodeName];

    const childIds: string[] = [];
    if ("children" in node) {
      (node as FrameNode).children.forEach((child) => {
        try {
          childIds.push(child.getPluginData("schemaId") || child.id);
        } catch {
          childIds.push(child.id);
        }
      });
    }

    map.set(nodeId, {
      id: nodeId,
      name: nodeName,
      type: node.type,
      parentId,
      childIds,
      depth,
      path: currentPath,
    });

    if ("children" in node) {
      (node as FrameNode).children.forEach((child) => {
        this.buildFigmaMap(child, nodeId, depth + 1, currentPath, map, visited);
      });
    }
  }

  private validateHierarchyIntegrity(): void {
    // Check that all referenced parent IDs exist
    for (const [nodeId, info] of this.hierarchyMap) {
      if (info.parentId && !this.hierarchyMap.has(info.parentId)) {
        this.addIssue(
          "error",
          nodeId,
          info.name,
          `Parent ID "${info.parentId}" not found in hierarchy`,
          { expectedParentId: info.parentId },
        );
      }
    }
  }

  private validateParentChildRelationships(): void {
    // Verify bidirectional parent-child relationships
    for (const [nodeId, info] of this.hierarchyMap) {
      if (info.parentId) {
        const parent = this.hierarchyMap.get(info.parentId);
        if (parent && !parent.childIds.includes(nodeId)) {
          this.addIssue(
            "error",
            nodeId,
            info.name,
            `Node claims parent "${parent.name}" but parent doesn't list it as child`,
            {
              parentId: info.parentId,
              parentChildIds: parent.childIds,
            },
          );
        }
      }

      // Verify all children reference this node as parent
      for (const childId of info.childIds) {
        const child = this.hierarchyMap.get(childId);
        if (child && child.parentId !== nodeId) {
          this.addIssue(
            "error",
            childId,
            child.name,
            `Child's parent reference doesn't match actual parent`,
            {
              childParentId: child.parentId,
              actualParentId: nodeId,
            },
          );
        }
      }
    }
  }

  private validateNoDuplicateIds(): void {
    const idCounts = new Map<string, number>();

    for (const [nodeId] of this.hierarchyMap) {
      idCounts.set(nodeId, (idCounts.get(nodeId) || 0) + 1);
    }

    for (const [id, count] of idCounts) {
      if (count > 1) {
        const node = this.hierarchyMap.get(id);
        this.addIssue(
          "error",
          id,
          node?.name || "unknown",
          `Duplicate ID found ${count} times in tree`,
          { occurrences: count },
        );
      }
    }
  }

  private validateNoOrphanNodes(): void {
    // Find nodes with no parent except root
    let rootCount = 0;

    for (const [nodeId, info] of this.hierarchyMap) {
      if (!info.parentId) {
        rootCount++;
        if (rootCount > 1) {
          this.addIssue(
            "warning",
            nodeId,
            info.name,
            "Multiple root nodes detected (expected only one root)",
            { depth: info.depth },
          );
        }
      }
    }

    if (rootCount === 0) {
      this.addIssue(
        "error",
        "unknown",
        "Tree",
        "No root node found - all nodes have parents (circular reference?)",
      );
    }
  }

  private compareHierarchies(
    schemaMap: Map<string, TreeNodeInfo>,
    figmaMap: Map<string, TreeNodeInfo>,
  ): void {
    // Check for missing nodes in Figma
    for (const [schemaId, schemaInfo] of schemaMap) {
      if (!figmaMap.has(schemaId)) {
        this.addIssue(
          "error",
          schemaId,
          schemaInfo.name,
          "Node exists in schema but not in Figma",
          {
            schemaType: schemaInfo.type,
            schemaDepth: schemaInfo.depth,
            schemaPath: schemaInfo.path.join(" > "),
          },
        );
      } else {
        // Node exists - verify structure matches
        const figmaInfo = figmaMap.get(schemaId)!;

        if (schemaInfo.childIds.length !== figmaInfo.childIds.length) {
          this.addIssue(
            "warning",
            schemaId,
            schemaInfo.name,
            "Child count mismatch between schema and Figma",
            {
              schemaChildCount: schemaInfo.childIds.length,
              figmaChildCount: figmaInfo.childIds.length,
            },
          );
        }

        if (schemaInfo.depth !== figmaInfo.depth) {
          this.addIssue(
            "warning",
            schemaId,
            schemaInfo.name,
            "Depth mismatch between schema and Figma",
            {
              schemaDepth: schemaInfo.depth,
              figmaDepth: figmaInfo.depth,
            },
          );
        }
      }
    }

    // Check for extra nodes in Figma
    for (const [figmaId, figmaInfo] of figmaMap) {
      if (!schemaMap.has(figmaId)) {
        this.addIssue(
          "info",
          figmaId,
          figmaInfo.name,
          "Node exists in Figma but not in schema (may be generated, e.g., background rect)",
          {
            figmaType: figmaInfo.type,
            figmaDepth: figmaInfo.depth,
          },
        );
      }
    }
  }

  private addIssue(
    severity: "error" | "warning" | "info",
    nodeId: string,
    nodeName: string,
    issue: string,
    details?: any,
  ): void {
    this.issues.push({
      severity,
      nodeId,
      nodeName,
      issue,
      details,
    });
  }

  private generateReport(): TreeValidationReport {
    const errorCount = this.issues.filter((i) => i.severity === "error").length;
    const warningCount = this.issues.filter(
      (i) => i.severity === "warning",
    ).length;

    let summary = `Tree validation complete: ${this.hierarchyMap.size} nodes, max depth ${this.maxDepth}`;

    if (errorCount > 0) {
      summary += ` | ❌ ${errorCount} errors`;
    }
    if (warningCount > 0) {
      summary += ` | ⚠️ ${warningCount} warnings`;
    }
    if (errorCount === 0 && warningCount === 0) {
      summary += " | ✅ No issues";
    }

    return {
      isValid: errorCount === 0,
      totalNodes: this.hierarchyMap.size,
      maxDepth: this.maxDepth,
      issues: this.issues,
      summary,
      hierarchyMap: this.hierarchyMap,
    };
  }

  private logReport(report: TreeValidationReport): void {
    console.log("\n" + "=".repeat(80));
    console.log("🔍 TREE VALIDATION REPORT");
    console.log("=".repeat(80));
    console.log(report.summary);
    console.log("=".repeat(80));

    if (report.issues.length > 0) {
      console.log("Issues:");

      const errors = report.issues.filter((i) => i.severity === "error");
      const warnings = report.issues.filter((i) => i.severity === "warning");
      const infos = report.issues.filter((i) => i.severity === "info");

      if (errors.length > 0) {
        console.log("  ❌ Errors:");
        errors.forEach((issue) => {
          console.log(
            `    [${issue.nodeId}] ${issue.nodeName}: ${issue.issue}`,
          );
          if (issue.details) {
            console.log(
              "      Details:",
              JSON.stringify(issue.details, null, 2),
            );
          }
        });
      }

      if (warnings.length > 0) {
        console.log("  ⚠️ Warnings:");
        warnings.forEach((issue) => {
          console.log(
            `    [${issue.nodeId}] ${issue.nodeName}: ${issue.issue}`,
          );
          if (issue.details) {
            console.log(
              "      Details:",
              JSON.stringify(issue.details, null, 2),
            );
          }
        });
      }

      if (infos.length > 0) {
        console.log("  ℹ️ Info:");
        infos.forEach((issue) => {
          console.log(
            `    [${issue.nodeId}] ${issue.nodeName}: ${issue.issue}`,
          );
          if (issue.details) {
            console.log(
              "      Details:",
              JSON.stringify(issue.details, null, 2),
            );
          }
        });
      }
    }

    console.log("=".repeat(80) + "\n");
  }
}
