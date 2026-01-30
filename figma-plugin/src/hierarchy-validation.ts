/**
 * Hierarchy Validation Module
 *
 * Validates that the Figma tree structure matches the schema's intended
 * parent/child relationships. Reports mismatches for debugging.
 */

import { perfTracker } from "./perf-tracker";

/**
 * Parent mismatch entry
 */
export interface ParentMismatch {
  nodeId: string;
  nodeName: string;
  expectedParentId: string | null;
  actualParentId: string | null;
  expectedParentName?: string;
  actualParentName?: string;
}

/**
 * Hierarchy validation report
 */
export interface HierarchyValidationReport {
  totalNodesInSchema: number;
  totalNodesCreated: number;
  totalParentChildEdgesInSchema: number;
  totalParentChildEdgesInFigma: number;
  mismatchCount: number;
  mismatches: ParentMismatch[];
  orphanedNodes: string[];
  exceptions: Array<{ nodeId: string; reason: string }>;
  isValid: boolean;
}

/**
 * Hierarchy Validator
 *
 * Tracks expected parent relationships from schema and validates
 * against actual Figma tree structure.
 */
export class HierarchyValidator {
  // Schema-defined parent relationships: childId -> parentId
  private schemaParentMap = new Map<string, string>();

  // Schema node names for better reporting
  private schemaNodeNames = new Map<string, string>();

  // Created Figma nodes: schemaId -> FigmaNode
  private figmaNodeMap = new Map<string, SceneNode>();

  // Track legitimate re-parenting exceptions
  private exceptions: Array<{ nodeId: string; reason: string }> = [];

  /**
   * Build the schema parent map by traversing the schema tree
   */
  buildSchemaParentMap(schemaRoot: any): void {
    this.schemaParentMap.clear();
    this.schemaNodeNames.clear();

    const traverse = (node: any, parentId: string | null) => {
      if (!node || !node.id) return;

      // Store parent relationship
      if (parentId !== null) {
        this.schemaParentMap.set(node.id, parentId);
      }

      // Store node name for reporting
      const nodeName = node.name || node.htmlTag || node.type || "unnamed";
      this.schemaNodeNames.set(node.id, nodeName);

      // Process children
      if (Array.isArray(node.children)) {
        for (const child of node.children) {
          traverse(child, node.id);
        }
      }

      // Process pseudo-elements
      if (node.pseudoElements?.before) {
        traverse(node.pseudoElements.before, node.id);
      }
      if (node.pseudoElements?.after) {
        traverse(node.pseudoElements.after, node.id);
      }
    };

    traverse(schemaRoot, null);

    console.log(
      `📋 [HIERARCHY VALIDATION] Built schema parent map: ${this.schemaParentMap.size} parent-child edges`
    );
  }

  /**
   * Register a created Figma node
   */
  registerFigmaNode(schemaId: string, figmaNode: SceneNode): void {
    this.figmaNodeMap.set(schemaId, figmaNode);
  }

  /**
   * Register a legitimate re-parenting exception
   */
  registerException(nodeId: string, reason: string): void {
    this.exceptions.push({ nodeId, reason });
  }

  /**
   * Get the schema ID stored in a Figma node's plugin data
   */
  private getSchemaIdFromFigmaNode(node: SceneNode | null): string | null {
    if (!node) return null;

    try {
      // Try to get schema ID from plugin data
      const schemaId = node.getPluginData?.("schemaId");
      if (schemaId) return schemaId;

      // Fallback: look up in our reverse map
      for (const [id, figmaNode] of this.figmaNodeMap) {
        if (figmaNode.id === node.id) {
          return id;
        }
      }
    } catch (e) {
      // Node might be removed or inaccessible
    }

    return null;
  }

  /**
   * Validate the Figma tree against schema parent relationships
   */
  validate(): HierarchyValidationReport {
    const mismatches: ParentMismatch[] = [];
    const orphanedNodes: string[] = [];
    let figmaEdgeCount = 0;

    // Check each schema node's parent relationship
    for (const [childId, expectedParentId] of this.schemaParentMap) {
      const figmaNode = this.figmaNodeMap.get(childId);

      if (!figmaNode) {
        // Node wasn't created - skip validation
        continue;
      }

      // Check if this is an exception
      const isException = this.exceptions.some((e) => e.nodeId === childId);
      if (isException) {
        continue;
      }

      // Get actual parent
      const actualParent = figmaNode.parent;
      const actualParentId = this.getSchemaIdFromFigmaNode(
        actualParent as SceneNode
      );

      // Count Figma edges
      if (actualParent) {
        figmaEdgeCount++;
      } else {
        orphanedNodes.push(childId);
      }

      // Compare with expected
      if (actualParentId !== expectedParentId) {
        // Check if parent is the main frame (acceptable for root-level nodes)
        const isMainFrameParent =
          actualParent?.type === "FRAME" &&
          ((actualParent.name && actualParent.name.includes("Import")) || !actualParentId);

        // Root-level nodes parented to main frame are acceptable
        if (isMainFrameParent && !expectedParentId) {
          continue;
        }

        mismatches.push({
          nodeId: childId,
          nodeName: this.schemaNodeNames.get(childId) || "unknown",
          expectedParentId,
          actualParentId,
          expectedParentName: expectedParentId
            ? this.schemaNodeNames.get(expectedParentId)
            : "ROOT",
          actualParentName: actualParent
            ? (actualParent as any).name || actualParent.type
            : "NONE",
        });
      }
    }

    const report: HierarchyValidationReport = {
      totalNodesInSchema: this.schemaNodeNames.size,
      totalNodesCreated: this.figmaNodeMap.size,
      totalParentChildEdgesInSchema: this.schemaParentMap.size,
      totalParentChildEdgesInFigma: figmaEdgeCount,
      mismatchCount: mismatches.length,
      mismatches: mismatches.slice(0, 20), // First 20 mismatches
      orphanedNodes: orphanedNodes.slice(0, 10), // First 10 orphans
      exceptions: this.exceptions,
      isValid: mismatches.length === 0 && orphanedNodes.length === 0,
    };

    return report;
  }

  /**
   * Print validation report to console
   */
  printReport(report: HierarchyValidationReport): void {
    console.log("\n" + "=".repeat(60));
    console.log("🌳 [HIERARCHY VALIDATION] PARENT-CHILD RELATIONSHIP REPORT");
    console.log("=".repeat(60));
    console.log("");
    console.log("--- Summary ---");
    console.log(`  Nodes in Schema:        ${report.totalNodesInSchema}`);
    console.log(`  Nodes Created:          ${report.totalNodesCreated}`);
    console.log(
      `  Schema Parent Edges:    ${report.totalParentChildEdgesInSchema}`
    );
    console.log(
      `  Figma Parent Edges:     ${report.totalParentChildEdgesInFigma}`
    );
    console.log(`  Mismatches:             ${report.mismatchCount}`);
    console.log(`  Orphaned Nodes:         ${report.orphanedNodes.length}`);
    console.log(`  Exceptions:             ${report.exceptions.length}`);
    console.log(
      `  Valid:                  ${report.isValid ? "✅ YES" : "❌ NO"}`
    );

    if (report.mismatches.length > 0) {
      console.log("");
      console.log("--- First 20 Mismatches ---");
      for (const m of report.mismatches) {
        console.log(
          `  ❌ Node "${m.nodeName}" (${m.nodeId.substring(0, 8)}...)`
        );
        console.log(
          `     Expected parent: "${m.expectedParentName}" (${
            m.expectedParentId?.substring(0, 8) || "ROOT"
          })`
        );
        console.log(
          `     Actual parent:   "${m.actualParentName}" (${
            m.actualParentId?.substring(0, 8) || "NONE"
          })`
        );
      }
    }

    if (report.exceptions.length > 0) {
      console.log("");
      console.log("--- Documented Exceptions ---");
      for (const e of report.exceptions) {
        console.log(`  ℹ️ Node ${e.nodeId.substring(0, 8)}...: ${e.reason}`);
      }
    }

    console.log("");
    console.log("=".repeat(60));
  }

  /**
   * Reset for new import
   */
  reset(): void {
    this.schemaParentMap.clear();
    this.schemaNodeNames.clear();
    this.figmaNodeMap.clear();
    this.exceptions.length = 0;
  }
}

// Singleton instance
export const hierarchyValidator = new HierarchyValidator();
