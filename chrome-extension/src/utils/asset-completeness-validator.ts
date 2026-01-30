/**
 * Asset Completeness Validator
 *
 * Ensures every imageHash referenced in the schema has embedded bytes.
 * This is CRITICAL for pixel-perfect Figma imports - the plugin cannot
 * render images without bytes (figma.createImage requires Uint8Array).
 *
 * Two-tier approach:
 * - Tier A: Fetch/encode real image bytes where allowed
 * - Tier B: For CORS/tainted-canvas cases, capture DOM screenshot fallback
 */

import type { WebToFigmaSchema, ElementNode } from "../../../shared/schema";

export interface AssetMetrics {
  totalReferencedHashes: number;
  successfullyEmbedded: number;
  failedFetches: number;
  rasterFallbackCount: number;
  totalEmbeddedBytes: number;
  fetchAttempts: number;
  failureReasons: Map<string, number>;
}

export interface AssetValidationResult {
  isComplete: boolean;
  metrics: AssetMetrics;
  missingHashes: string[];
  fixedHashes: string[];
}

export interface AssetCompletenessOptions {
  enableRasterFallback: boolean;
  maxRasterAttempts: number;
  rasterQuality: number; // 0.0-1.0 for JPEG
  logVerbose: boolean;
}

const DEFAULT_OPTIONS: AssetCompletenessOptions = {
  enableRasterFallback: true,
  maxRasterAttempts: 2,
  rasterQuality: 0.92,
  logVerbose: true,
};

/**
 * Check if the current page URL is capturable via CDP/captureVisibleTab.
 * Chrome blocks CDP attachment to certain URL schemes for security.
 */
function isCapturablePageUrl(): boolean {
  const protocol = window.location.protocol;
  const restrictedProtocols = [
    "chrome-extension:",
    "chrome:",
    "edge:",
    "about:",
    "data:",
    "javascript:",
    "file:",
    "view-source:",
    "chrome-search:",
  ];
  return !restrictedProtocols.includes(protocol);
}

/**
 * Asset Completeness Validator
 *
 * Guarantees that every imageHash in the schema has embedded bytes.
 * If an asset is missing, it either:
 * 1. Retries fetch with background script (bypasses CORS via host permissions)
 * 2. Falls back to DOM element screenshot (rasterization)
 * 3. Removes the imageHash reference to prevent phantom builder errors
 */
export class AssetCompletenessValidator {
  private metrics: AssetMetrics;
  private options: AssetCompletenessOptions;
  private elementMap: Map<string, Element>;

  constructor(options: Partial<AssetCompletenessOptions> = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.metrics = this.createEmptyMetrics();
    this.elementMap = new Map();
  }

  private createEmptyMetrics(): AssetMetrics {
    return {
      totalReferencedHashes: 0,
      successfullyEmbedded: 0,
      failedFetches: 0,
      rasterFallbackCount: 0,
      totalEmbeddedBytes: 0,
      fetchAttempts: 0,
      failureReasons: new Map(),
    };
  }

  /**
   * Register an element by its schema ID for potential rasterization fallback
   */
  registerElement(schemaId: string, element: Element): void {
    this.elementMap.set(schemaId, element);
  }

  /**
   * Collect all imageHash references from the schema tree
   */
  collectReferencedHashes(root: ElementNode): Set<string> {
    const hashes = new Set<string>();

    const traverse = (node: any) => {
      if (!node) return;

      // Direct imageHash property
      if (node.imageHash) {
        hashes.add(node.imageHash);
      }

      // Fills array
      if (Array.isArray(node.fills)) {
        for (const fill of node.fills) {
          if (fill?.imageHash) {
            hashes.add(fill.imageHash);
          }
        }
      }

      // Background image fill
      if (node.backgroundImageAssetId) {
        hashes.add(node.backgroundImageAssetId);
      }

      // Screenshot asset
      if (node.screenshotAssetId) {
        hashes.add(node.screenshotAssetId);
      }

      // Pseudo-elements
      if (node.pseudoElements?.before) {
        traverse(node.pseudoElements.before);
      }
      if (node.pseudoElements?.after) {
        traverse(node.pseudoElements.after);
      }

      // Children
      if (Array.isArray(node.children)) {
        for (const child of node.children) {
          traverse(child);
        }
      }
    };

    traverse(root);
    return hashes;
  }

  /**
   * Validate that every referenced hash has embedded bytes
   */
  findMissingAssets(
    referencedHashes: Set<string>,
    assets: Record<string, any>,
  ): string[] {
    const missing: string[] = [];

    // TS Fix: Convert Set iteration to Array
    for (const hash of Array.from(referencedHashes)) {
      const asset = assets[hash];

      // Check for embedded bytes (base64 or data field)
      const hasBytes =
        asset &&
        ((asset.base64 && asset.base64.length > 100) ||
          (asset.data && asset.data.length > 100) ||
          (asset.bytes?.kind === "inline-base64" &&
            asset.bytes.base64?.length > 100));

      if (!hasBytes) {
        missing.push(hash);

        if (this.options.logVerbose) {
          const reason = !asset ? "NO_ASSET_ENTRY" : "EMPTY_BYTES";
          console.warn(
            `⚠️ [ASSET_COMPLETENESS] Missing bytes for hash: ${hash} (${reason})`,
          );

          if (asset) {
            console.warn(`   Asset exists but has:`, {
              base64Length: asset.base64?.length || 0,
              dataLength: asset.data?.length || 0,
              url: asset.url?.substring(0, 80),
              error: asset.error,
            });
          }
        }
      }
    }

    return missing;
  }

  /**
   * Attempt to capture a DOM element as a raster image
   * Used as Tier B fallback when image fetch fails
   *
   * Uses multiple capture strategies:
   * 1. Direct canvas draw (works for same-origin images)
   * 2. CDP clip capture via background script (works for CORS-protected images)
   * 3. SVG foreignObject (last resort for complex elements)
   */
  async captureElementAsRaster(
    element: Element,
    width: number,
    height: number,
  ): Promise<{ base64: string; mimeType: string } | null> {
    // Early exit for non-capturable URLs (chrome-extension://, chrome://, etc.)
    // CDP/captureVisibleTab always fails on these URLs - skip to avoid runaway loops
    if (!isCapturablePageUrl()) {
      return null;
    }

    try {
      // Strategy 1: For images, try direct canvas draw (fastest if same-origin)
      if (element instanceof HTMLImageElement) {
        try {
          const canvas = document.createElement("canvas");
          const scale = window.devicePixelRatio || 1;
          canvas.width = Math.max(1, Math.round(width * scale));
          canvas.height = Math.max(1, Math.round(height * scale));

          const ctx = canvas.getContext("2d");
          if (ctx) {
            ctx.drawImage(element, 0, 0, canvas.width, canvas.height);
            const dataUrl = canvas.toDataURL("image/png");
            const base64 = dataUrl.split(",")[1];

            if (base64 && base64.length > 100) {
              console.log(
                `✅ [RASTER] Captured image element via canvas: ${base64.length} bytes`,
              );
              return { base64, mimeType: "image/png" };
            }
          }
        } catch (e) {
          // Tainted canvas - continue to CDP capture
          console.warn(
            `⚠️ [RASTER] Canvas draw failed (CORS), trying CDP capture...`,
          );
        }
      }

      // Strategy 2: CDP clip capture via background script
      // This captures what's actually visible on screen - works for any CORS-protected content
      try {
        const rect = element.getBoundingClientRect();
        const scrollX = window.scrollX;
        const scrollY = window.scrollY;

        // Absolute coordinates on page
        const clipRect = {
          x: rect.left + scrollX,
          y: rect.top + scrollY,
          width: rect.width,
          height: rect.height,
          scale: window.devicePixelRatio || 1,
        };

        // Skip if element is off-screen or too small
        if (clipRect.width < 1 || clipRect.height < 1) {
          console.warn(`⚠️ [RASTER] Element too small for CDP capture`);
          return null;
        }

        // CDP with captureBeyondViewport:true can capture elements outside the visible viewport
        // No viewport check needed - try CDP capture for all valid-sized elements
        // CRITICAL: Pass clipRect (page coordinates) not rect (viewport coordinates)
        const result = await this.captureElementViaCDP(clipRect);
        if (result) {
          console.log(
            `✅ [RASTER] Captured element via CDP screenshot: ${result.base64.length} bytes`,
          );
          return result;
        }
      } catch (e) {
        console.warn(`⚠️ [RASTER] CDP capture failed: ${e}`);
      }

      // Strategy 3: SVG foreignObject (last resort - limited compatibility)
      try {
        const canvas = document.createElement("canvas");
        const scale = window.devicePixelRatio || 1;
        canvas.width = Math.max(1, Math.round(width * scale));
        canvas.height = Math.max(1, Math.round(height * scale));
        const ctx = canvas.getContext("2d");

        if (!ctx) return null;

        const svgData = `
          <svg xmlns="http://www.w3.org/2000/svg" width="${
            canvas.width
          }" height="${canvas.height}">
            <foreignObject width="100%" height="100%">
              <div xmlns="http://www.w3.org/1999/xhtml" style="
                width: ${width}px;
                height: ${height}px;
                background: ${this.captureElementBackground(element)};
                transform-origin: top left;
                transform: scale(${scale});
              "></div>
            </foreignObject>
          </svg>
        `;

        const svgBlob = new Blob([svgData], {
          type: "image/svg+xml;charset=utf-8",
        });
        const url = URL.createObjectURL(svgBlob);

        return new Promise((resolve) => {
          const img = new Image();
          img.onload = () => {
            URL.revokeObjectURL(url);
            try {
              ctx.drawImage(img, 0, 0);
              const dataUrl = canvas.toDataURL("image/png");
              const base64 = dataUrl.split(",")[1];
              if (base64 && base64.length > 100) {
                console.log(
                  `✅ [RASTER] Captured via SVG foreignObject: ${base64.length} bytes`,
                );
                resolve({ base64, mimeType: "image/png" });
              } else {
                resolve(null);
              }
            } catch {
              resolve(null);
            }
          };
          img.onerror = () => {
            URL.revokeObjectURL(url);
            resolve(null);
          };
          img.src = url;
        });
      } catch (e) {
        console.warn(`⚠️ [RASTER] SVG foreignObject failed: ${e}`);
      }

      return null;
    } catch (error) {
      console.warn(`❌ [RASTER] Failed to capture element:`, error);
      return null;
    }
  }

  /**
   * Capture element using Chrome DevTools Protocol clip screenshot
   * This works for CORS-protected images because it captures rendered pixels
   */
  private async captureElementViaCDP(clip: {
    x: number;
    y: number;
    width: number;
    height: number;
    scale?: number;
  }): Promise<{ base64: string; mimeType: string } | null> {
    // Early exit for non-capturable URLs - CDP always fails on chrome-extension://, etc.
    if (!isCapturablePageUrl()) {
      return null;
    }

    try {
      // Request CDP clip capture from background script
      const response: any = await new Promise((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("CDP capture timeout")),
          5000,
        );

        chrome.runtime.sendMessage(
          {
            type: "CAPTURE_CDP_CLIP",
            clip: {
              x: Math.round(clip.x),
              y: Math.round(clip.y),
              width: Math.round(clip.width),
              height: Math.round(clip.height),
              scale: clip.scale ?? window.devicePixelRatio ?? 1,
            },
          },
          (response) => {
            clearTimeout(timeout);
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
            } else {
              resolve(response);
            }
          },
        );
      });

      if (response?.ok && (response.dataUrl || response.data)) {
        // Handle both property names for compatibility (background sends dataUrl, some paths send data)
        const rawData = response.dataUrl || response.data;
        const base64 = rawData.startsWith("data:")
          ? rawData.split(",")[1]
          : rawData;

        if (base64 && base64.length > 100) {
          return { base64, mimeType: "image/png" };
        }
      }

      return null;
    } catch (e) {
      console.warn(`❌ [RASTER] CDP clip capture error:`, e);
      return null;
    }
  }

  private captureElementBackground(element: Element): string {
    try {
      const computed = window.getComputedStyle(element);
      return computed.backgroundColor || "transparent";
    } catch {
      return "transparent";
    }
  }

  /**
   * Attempt to fix missing assets via background fetch or rasterization
   */
  async fixMissingAssets(
    missingHashes: string[],
    assets: Record<string, any>,
    nodeHashMap: Map<
      string,
      { nodeId: string; url?: string; element?: Element }
    >,
    fetchViaBackground: (
      url: string,
    ) => Promise<{ base64: string; mimeType?: string } | null>,
  ): Promise<string[]> {
    const fixedHashes: string[] = [];

    // Phase 1: Tier A (Parallel Fetch)
    // We can fetch many images at once via background script
    console.log(
      `🔄 [ASSET_FIX] Phase 1: Parallel Fetch (Tier A) for ${missingHashes.length} assets...`,
    );
    const FETCH_BATCH_SIZE = 10;
    for (let i = 0; i < missingHashes.length; i += FETCH_BATCH_SIZE) {
      const batch = missingHashes.slice(i, i + FETCH_BATCH_SIZE);
      await Promise.all(
        batch.map(async (hash) => {
          const nodeInfo = nodeHashMap.get(hash);
          if (nodeInfo?.url && !nodeInfo.url.startsWith("missing_img_")) {
            this.metrics.fetchAttempts++;
            try {
              const result = await fetchViaBackground(nodeInfo.url);
              if (result?.base64 && result.base64.length > 100) {
                if (!assets[hash]) assets[hash] = { id: hash };
                assets[hash].base64 = result.base64;
                assets[hash].data = result.base64;
                assets[hash].mimeType = result.mimeType || "image/png";
                // Preserve URL for plugin fallback
                assets[hash].url = nodeInfo.url;
                assets[hash].originalUrl = nodeInfo.url;
                this.metrics.successfullyEmbedded++;
                this.metrics.totalEmbeddedBytes += result.base64.length;
                fixedHashes.push(hash);
              } else {
                // Fetch returned no base64 - still preserve URL for plugin to try proxy
                if (!assets[hash]) assets[hash] = { id: hash };
                assets[hash].url = nodeInfo.url;
                assets[hash].originalUrl = nodeInfo.url;
              }
            } catch (e) {
              this.recordFailureReason("Fetch failed");
              // Fetch failed - still preserve URL for plugin to try proxy
              if (!assets[hash]) assets[hash] = { id: hash };
              assets[hash].url = nodeInfo.url;
              assets[hash].originalUrl = nodeInfo.url;
            }
          }
        }),
      );
      if (i > 0 && i % 50 === 0) console.log(`   Processed ${i} fetches...`);
    }

    // Phase 2: Tier B (Serial Rasterization)
    // CDP debugger cannot be shared easily, so we rasterize serially
    const remainingToFix = missingHashes.filter(
      (h) => !fixedHashes.includes(h),
    );
    if (remainingToFix.length > 0 && this.options.enableRasterFallback) {
      console.log(
        `🔄 [ASSET_FIX] Phase 2: Serial Rasterization (Tier B) for ${remainingToFix.length} assets...`,
      );
      for (let i = 0; i < remainingToFix.length; i++) {
        const hash = remainingToFix[i];
        const nodeInfo = nodeHashMap.get(hash);
        if (nodeInfo?.element) {
          try {
            const rect = nodeInfo.element.getBoundingClientRect();
            const result = await this.captureElementAsRaster(
              nodeInfo.element,
              rect.width,
              rect.height,
            );
            if (result?.base64 && result.base64.length > 100) {
              const rasterHash = `raster_${hash}`;
              assets[rasterHash] = {
                id: rasterHash,
                base64: result.base64,
                data: result.base64,
                mimeType: result.mimeType,
                width: Math.round(rect.width),
                height: Math.round(rect.height),
                isRasterFallback: true,
                originalHash: hash,
              };

              if (!assets[hash]) assets[hash] = { id: hash };
              assets[hash].rasterFallbackHash = rasterHash;
              assets[hash].renderMode = "rasterize";
              assets[hash].base64 = result.base64;
              assets[hash].data = result.base64;
              assets[hash].mimeType = result.mimeType;
              // Preserve URL for plugin fallback
              if (nodeInfo.url) {
                assets[hash].url = nodeInfo.url;
                assets[hash].originalUrl = nodeInfo.url;
              }

              this.metrics.rasterFallbackCount++;
              this.metrics.totalEmbeddedBytes += result.base64.length;
              fixedHashes.push(hash);
            } else if (nodeInfo.url) {
              // Rasterization returned no base64 - still preserve URL for plugin to try proxy
              if (!assets[hash]) assets[hash] = { id: hash };
              assets[hash].url = nodeInfo.url;
              assets[hash].originalUrl = nodeInfo.url;
            }
          } catch (e) {
            this.recordFailureReason("Rasterization failed");
            // Rasterization failed - still preserve URL for plugin to try proxy
            if (nodeInfo.url) {
              if (!assets[hash]) assets[hash] = { id: hash };
              assets[hash].url = nodeInfo.url;
              assets[hash].originalUrl = nodeInfo.url;
            }
          }
        }
        if (i > 0 && i % 10 === 0) {
          console.log(`   Rasterized ${i}/${remainingToFix.length}...`);
          // Check for timeout to avoid hanging the whole capture (60s limit)
          const elapsed = Date.now() - (this as any)._passStartTime || 0;
          if (elapsed > 60000) {
            console.warn(
              "⚠️ [ASSET_FIX] Asset validation taking too long (>60s), aborting remaining scans",
            );
            break;
          }
        }
      }
    }

    this.metrics.failedFetches = missingHashes.length - fixedHashes.length;
    return fixedHashes;
  }

  private recordFailureReason(reason: string): void {
    // Normalize reason string
    const normalized = reason.toLowerCase();
    let key = "unknown";

    if (normalized.includes("cors") || normalized.includes("cross-origin")) {
      key = "CORS_BLOCKED";
    } else if (normalized.includes("tainted")) {
      key = "TAINTED_CANVAS";
    } else if (normalized.includes("network") || normalized.includes("fetch")) {
      key = "NETWORK_ERROR";
    } else if (normalized.includes("timeout")) {
      key = "TIMEOUT";
    } else if (normalized.includes("404") || normalized.includes("not found")) {
      key = "NOT_FOUND";
    } else if (normalized.includes("403") || normalized.includes("forbidden")) {
      key = "FORBIDDEN";
    }

    this.metrics.failureReasons.set(
      key,
      (this.metrics.failureReasons.get(key) || 0) + 1,
    );
  }

  /**
   * Handle unfixed image references - PRESERVE URLs for plugin fallback
   *
   * CRITICAL FIX: Previously this deleted imageHash references, preventing
   * the Figma plugin from using its own URL-based fallback (proxy fetch).
   * Now we preserve the URL so the plugin can attempt to fetch the image.
   */
  removeUnfixedReferences(
    root: ElementNode,
    unfixedHashes: Set<string>,
    assets?: Record<string, any>,
  ): number {
    let preservedCount = 0;
    let removedCount = 0;

    const traverse = (node: any) => {
      if (!node) return;

      // For direct imageHash, check if we have a URL in asset
      // If URL exists, KEEP the imageHash - plugin can fetch via proxy
      if (node.imageHash && unfixedHashes.has(node.imageHash)) {
        const asset = assets?.[node.imageHash];
        const hasUrl =
          asset?.url && typeof asset.url === "string" && asset.url.length > 0;

        if (hasUrl) {
          // PRESERVE: Plugin can fetch this via proxy
          console.log(
            `✅ [ASSET_PRESERVE] Keeping imageHash ${node.imageHash} (URL available for plugin fallback)`,
          );
          preservedCount++;
          // Don't delete - let plugin try URL fetch
        } else {
          // No URL available - log but still preserve for plugin to handle
          console.warn(
            `⚠️ [ASSET_PRESERVE] No URL for imageHash: ${
              node.imageHash
            } on node ${
              node.id || node.name
            } - preserving anyway for plugin diagnostics`,
          );
          preservedCount++;
          // Don't delete - plugin has fallback logic
        }
      }

      // For fills array, also preserve instead of removing
      if (Array.isArray(node.fills)) {
        for (const fill of node.fills) {
          if (fill?.imageHash && unfixedHashes.has(fill.imageHash)) {
            const asset = assets?.[fill.imageHash];
            const hasUrl =
              asset?.url &&
              typeof asset.url === "string" &&
              asset.url.length > 0;

            if (hasUrl) {
              console.log(
                `✅ [ASSET_PRESERVE] Keeping fill imageHash ${fill.imageHash} (URL available)`,
              );
            } else {
              console.warn(
                `⚠️ [ASSET_PRESERVE] No URL for fill imageHash: ${fill.imageHash} - preserving for plugin`,
              );
            }
            preservedCount++;
          }
        }
        // Don't filter fills - preserve all
      }

      // Traverse children and pseudo-elements
      if (node.pseudoElements?.before) traverse(node.pseudoElements.before);
      if (node.pseudoElements?.after) traverse(node.pseudoElements.after);
      if (Array.isArray(node.children)) {
        for (const child of node.children) {
          traverse(child);
        }
      }
    };

    traverse(root);

    console.log(
      `📦 [ASSET_PRESERVE] Preserved ${preservedCount} imageHash references for plugin fallback`,
    );
    return removedCount; // Returns 0 now since we don't remove
  }

  /**
   * Main validation entry point
   */
  async validate(
    schema: WebToFigmaSchema,
    nodeHashMap: Map<
      string,
      { nodeId: string; url?: string; element?: Element }
    >,
    fetchViaBackground: (
      url: string,
    ) => Promise<{ base64: string; mimeType?: string } | null>,
  ): Promise<AssetValidationResult> {
    this.metrics = this.createEmptyMetrics();
    (this as any)._passStartTime = Date.now();

    console.log("\n" + "=".repeat(60));
    console.log("🔍 [ASSET_COMPLETENESS] Starting asset validation...");
    console.log("=".repeat(60));

    // Step 1: Collect all referenced hashes
    const referencedHashes = this.collectReferencedHashes(schema.root);
    this.metrics.totalReferencedHashes = referencedHashes.size;

    if (referencedHashes.size === 0) {
      console.log("ℹ️ [ASSET_COMPLETENESS] No images referenced in schema.");
      return {
        isComplete: true,
        metrics: this.metrics,
        missingHashes: [],
        fixedHashes: [],
      };
    }

    console.log(
      `📋 [ASSET_COMPLETENESS] Found ${referencedHashes.size} unique imageHash references`,
    );

    // Step 2: Find missing assets
    const assets = schema.assets?.images || {};
    const missingBefore = this.findMissingAssets(referencedHashes, assets);
    console.log(
      `⚠️ [ASSET_COMPLETENESS] ${missingBefore.length} hashes missing embedded bytes`,
    );

    // Count already-embedded
    const alreadyEmbedded = referencedHashes.size - missingBefore.length;
    this.metrics.successfullyEmbedded = alreadyEmbedded;
    // TS Fix: Convert Set iteration to Array
    for (const hash of Array.from(referencedHashes)) {
      const asset = assets[hash];
      if (asset?.base64) {
        this.metrics.totalEmbeddedBytes += asset.base64.length;
      }
    }

    // Step 3: Attempt to fix missing assets
    const fixedHashes = await this.fixMissingAssets(
      missingBefore,
      assets,
      nodeHashMap,
      fetchViaBackground,
    );

    // Step 4: Check what's still missing
    const missingAfter = this.findMissingAssets(referencedHashes, assets);

    // Step 5: Preserve unfixed references for plugin fallback (don't delete)
    if (missingAfter.length > 0) {
      const unfixedSet = new Set(missingAfter);
      const preservedCount = this.removeUnfixedReferences(
        schema.root,
        unfixedSet,
        assets,
      );
      console.log(
        `📦 [ASSET_COMPLETENESS] ${missingAfter.length} imageHash refs preserved for plugin URL fallback`,
      );
    }

    // Final report
    const isComplete = missingAfter.length === 0;

    console.log("\n" + "=".repeat(60));
    console.log("📊 [ASSET_COMPLETENESS] VALIDATION REPORT");
    console.log("=".repeat(60));
    console.log(
      `   Total Referenced Hashes:  ${this.metrics.totalReferencedHashes}`,
    );
    console.log(
      `   Successfully Embedded:    ${this.metrics.successfullyEmbedded}`,
    );
    console.log(`   Failed Fetches:           ${this.metrics.failedFetches}`);
    console.log(
      `   Raster Fallbacks:         ${this.metrics.rasterFallbackCount}`,
    );
    console.log(
      `   Total Embedded Bytes:     ${(
        this.metrics.totalEmbeddedBytes /
        1024 /
        1024
      ).toFixed(2)} MB`,
    );
    console.log(`   Fetch Attempts:           ${this.metrics.fetchAttempts}`);
    console.log(`   Fixed in This Pass:       ${fixedHashes.length}`);
    console.log(`   Still Missing:            ${missingAfter.length}`);
    console.log(
      `   Status:                   ${
        isComplete ? "✅ COMPLETE" : "⚠️ INCOMPLETE"
      }`,
    );

    if (this.metrics.failureReasons.size > 0) {
      console.log(`   Failure Reasons:`);
      // TS Fix: Convert Map iteration to Array
      for (const [reason, count] of Array.from(this.metrics.failureReasons)) {
        console.log(`      ${reason}: ${count}`);
      }
    }
    console.log("=".repeat(60) + "\n");

    return {
      isComplete,
      metrics: this.metrics,
      missingHashes: missingAfter,
      fixedHashes,
    };
  }

  /**
   * Get current metrics
   */
  getMetrics(): AssetMetrics {
    return { ...this.metrics };
  }
}

// Singleton instance
export const assetValidator = new AssetCompletenessValidator();
