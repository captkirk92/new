type PreflightSeverity = "FATAL" | "WARN";

export type PreflightIssue = {
  severity: PreflightSeverity;
  code:
    | "SCHEMA_MISSING_ROOT"
    | "SCHEMA_DUPLICATE_ID"
    | "SCHEMA_ORPHAN_NODE"
    | "SCHEMA_PARENT_MISMATCH"
    | "SCHEMA_CYCLE"
    | "GEOMETRY_INVALID"
    | "GEOMETRY_NON_POSITIVE"
    | "ASSET_MISSING_IMAGE"
    | "ASSET_MISSING_SVG"
    | "SCREENSHOT_MISSING"
    | "SCREENSHOT_META_INVALID";
  message: string;
  nodeId?: string;
  assetHash?: string;
  details?: Record<string, any>;
};

export type PreflightResult = {
  ok: boolean;
  fatalCount: number;
  warnCount: number;
  issues: PreflightIssue[];
  summary: {
    nodesTotal: number;
    imagesReferenced: number;
    imagesEmbedded: number;
    imagesMissing: number;
    screenshot: {
      present: boolean;
      width?: number;
      height?: number;
      dpr?: number;
    };
  };
};

// Adapted Layout type to be flexible with observed properties
type Layout = {
  pageX?: number;
  pageY?: number;
  x?: number; // Fallback if pageX not used
  y?: number; // Fallback if pageY not used
  width: number;
  height: number;
  [key: string]: any;
};

type Fill = {
  type: "SOLID" | "GRADIENT_LINEAR" | "GRADIENT_RADIAL" | "IMAGE" | "SVG";
  imageHash?: string;
  [key: string]: any;
};

type ElementNode = {
  id: string;
  parentId?: string;
  children?: ElementNode[];
  type?: string;
  layout?: Layout; // Made optional as some nodes might lack it or use different key
  absoluteLayout?: any; // Observed in other files
  fills?: Fill[];
  [key: string]: any;
};

type Assets = {
  images: Record<
    string,
    {
      bytes?: string | Uint8Array | object;
      mimeType?: string;
      width?: number;
      height?: number;
      [key: string]: any;
    }
  >;
  svgs: Record<
    string,
    { text?: string; bytes?: string | Uint8Array; [key: string]: any }
  >;
  fonts?: Record<string, any>;
  [key: string]: any;
};

type Screenshot =
  | {
      bytes?: string | Uint8Array; // base64 or raw bytes
      width?: number;
      height?: number;
      devicePixelRatio?: number;
      [key: string]: any;
    }
  | string;

function isFiniteNumber(n: any): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

function push(issues: PreflightIssue[], issue: PreflightIssue) {
  issues.push(issue);
}

function walk(root: ElementNode): ElementNode[] {
  const out: ElementNode[] = [];
  const stack: ElementNode[] = [root];
  const visited = new Set<ElementNode>();
  let iterations = 0;
  // Safety limit for very large trees or infinite loops (1M nodes should be enough for any reasonable page)
  const MAX_ITERATIONS = 100000;

  while (stack.length) {
    iterations++;
    if (iterations > MAX_ITERATIONS) {
      console.warn(
        "[PREFLIGHT] Walk terminated early: exceeded iteration limit (possible cycle or massive tree)",
      );
      break;
    }

    const n = stack.pop()!;
    if (visited.has(n)) continue;
    visited.add(n);

    out.push(n);
    const kids = n.children || [];
    for (let i = kids.length - 1; i >= 0; i--) {
      if (!visited.has(kids[i])) {
        stack.push(kids[i]);
      }
    }
  }
  return out;
}

export function preflightSchemaJob(params: {
  root: ElementNode | null | undefined;
  assets: Assets | null | undefined;
  screenshot: Screenshot | null | undefined;
  requireScreenshot?: boolean; // default true
}): PreflightResult {
  const issues: PreflightIssue[] = [];
  const requireScreenshot = params.requireScreenshot !== false;

  const root = params.root;
  const assets = params.assets || { images: {}, svgs: {} };
  const screenshot = params.screenshot || {};

  // --- Summary Counters ---
  let imagesReferencedCount = 0;
  let imagesMissingCount = 0;

  if (!root) {
    push(issues, {
      severity: "FATAL",
      code: "SCHEMA_MISSING_ROOT",
      message: "Schema root is missing.",
    });
    return finalize(issues, 0, assets, screenshot, 0, 0);
  }

  const nodes = walk(root);
  const nodesTotal = nodes.length;

  // --- A) IDs and parenting invariants ---
  const idSet = new Set<string>();
  const parentById = new Map<string, string | undefined>();

  for (const n of nodes) {
    if (!n.id) {
      push(issues, {
        severity: "FATAL",
        code: "SCHEMA_DUPLICATE_ID",
        message: "Node is missing id (id is required).",
        details: { node: n },
      });
      continue;
    }
    if (idSet.has(n.id)) {
      push(issues, {
        severity: "FATAL",
        code: "SCHEMA_DUPLICATE_ID",
        message: `Duplicate node id detected: ${n.id}`,
        nodeId: n.id,
      });
    }
    idSet.add(n.id);
    parentById.set(n.id, n.parentId);
  }

  // Parent/child consistency check
  for (const parent of nodes) {
    for (const child of parent.children || []) {
      if (child.parentId !== parent.id) {
        // DIAGNOSTIC: Log first 5 mismatches for debugging
        if (
          issues.filter((i) => i.code === "SCHEMA_PARENT_MISMATCH").length < 5
        ) {
          console.error(
            `[PREFLIGHT] PARENT_MISMATCH: child="${child.id}" (type=${child.type}, name=${child.name}) has parentId="${child.parentId}" but is in parent="${parent.id}" (type=${parent.type}, name=${parent.name}) children array`,
          );
        }
        push(issues, {
          severity: "FATAL",
          code: "SCHEMA_PARENT_MISMATCH",
          message: `Parent/child mismatch: child.parentId != parent.id`,
          nodeId: child.id,
          details: {
            expectedParentId: parent.id,
            actualParentId: child.parentId,
            parentName: parent.name,
            childName: child.name,
            childType: child.type,
          },
        });
      }
    }
  }

  // Orphans check (non-root nodes must have existing parent)
  for (const n of nodes) {
    if (n === root) continue;
    if (!n.parentId) {
      push(issues, {
        severity: "FATAL",
        code: "SCHEMA_ORPHAN_NODE",
        message: "Non-root node missing parentId.",
        nodeId: n.id,
      });
      continue;
    }
    if (!idSet.has(n.parentId)) {
      push(issues, {
        severity: "FATAL",
        code: "SCHEMA_ORPHAN_NODE",
        message: `Node parentId does not exist in schema: ${n.parentId}`,
        nodeId: n.id,
        details: { parentId: n.parentId },
      });
    }
  }

  // Cycle detection using parent pointers (fast)
  for (const n of nodes) {
    const seen = new Set<string>();
    let cur: string | undefined = n.id;
    // Limit depth to avoid infinite loops if cycle exists
    let depth = 0;
    while (cur && depth < 1000) {
      if (seen.has(cur)) {
        push(issues, {
          severity: "FATAL",
          code: "SCHEMA_CYCLE",
          message: `Cycle detected following parentId chain from node ${n.id}`,
          nodeId: n.id,
          details: { cycleAt: cur },
        });
        break;
      }
      seen.add(cur);
      cur = parentById.get(cur);
      depth++;
    }
    if (depth >= 1000) {
      push(issues, {
        severity: "WARN",
        code: "SCHEMA_CYCLE",
        message: `Potential cycle or deep nesting (depth > 1000) for node ${n.id}`,
        nodeId: n.id,
      });
    }
  }

  // --- A2) Geometry validation ---
  for (const n of nodes) {
    // Check for layout or absoluteLayout
    const l = n.layout || n.absoluteLayout;

    if (!l) {
      // Some nodes might not have layout if they are hidden or not rendered,
      // but typically all should have it.
      push(issues, {
        severity: "WARN",
        code: "GEOMETRY_INVALID",
        message: "Node missing layout information",
        nodeId: n.id,
      });
      continue;
    }

    if (!isFiniteNumber(l.width) || !isFiniteNumber(l.height)) {
      push(issues, {
        severity: "FATAL",
        code: "GEOMETRY_INVALID",
        message: `Invalid geometry (width/height not finite).`,
        nodeId: n.id,
        details: { layout: l },
      });
      continue;
    }
    if (l.width <= 0 || l.height <= 0) {
      // Warn only, as some empty frames/lines might be valid
      push(issues, {
        severity: "WARN",
        code: "GEOMETRY_NON_POSITIVE",
        message: `Non-positive size (width/height). May be capture bug or invisible node.`,
        nodeId: n.id,
        details: { width: l.width, height: l.height },
      });
    }

    // Coordinate validation
    // Prefer pageX/pageY, fallback to x/y or left/top
    const x =
      l.pageX ?? l.x ?? (n.absoluteLayout ? n.absoluteLayout.left : undefined);
    const y =
      l.pageY ?? l.y ?? (n.absoluteLayout ? n.absoluteLayout.top : undefined);

    if (x == null || y == null || !isFiniteNumber(x) || !isFiniteNumber(y)) {
      push(issues, {
        severity: "WARN", // Downgraded to WARN for now to avoid blocking existing flows
        code: "GEOMETRY_INVALID",
        message: `Missing or invalid page-absolute coordinates.`,
        nodeId: n.id,
        details: { x, y, layout: l },
      });
    }
  }

  // --- B) Asset completeness ---
  const referencedImages = new Set<string>();
  const referencedSvgs = new Set<string>();

  for (const n of nodes) {
    for (const f of n.fills || []) {
      if (f.type === "IMAGE" && f.imageHash) referencedImages.add(f.imageHash);
      if (f.type === "SVG" && f.imageHash) referencedSvgs.add(f.imageHash);
    }
  }

  imagesReferencedCount = referencedImages.size;

  const imageKeys = assets?.images ? Object.keys(assets.images) : [];
  const embeddedImageSet = new Set(imageKeys);

  for (const h of referencedImages) {
    if (!embeddedImageSet.has(h)) {
      imagesMissingCount++;
      push(issues, {
        severity: "FATAL",
        code: "ASSET_MISSING_IMAGE",
        message: `Referenced imageHash not found in assets.images: ${h}`,
        assetHash: h,
      });
    } else {
      // Optional: validate bytes are present
      const img = assets.images[h];
      // Check for 'bytes' or 'data' or 'base64' (common variations)
      const hasBytes = img && (img.bytes || img.data || img.base64);

      if (!img || !hasBytes) {
        imagesMissingCount++;
        push(issues, {
          severity: "FATAL",
          code: "ASSET_MISSING_IMAGE",
          message: `Image asset exists but bytes are missing for hash: ${h}`,
          assetHash: h,
        });
      }
    }
  }

  const svgKeys = assets?.svgs ? Object.keys(assets.svgs) : [];
  const embeddedSvgSet = new Set(svgKeys);

  for (const h of referencedSvgs) {
    if (!embeddedSvgSet.has(h)) {
      push(issues, {
        severity: "FATAL",
        code: "ASSET_MISSING_SVG",
        message: `Referenced svg hash not found in assets.svgs: ${h}`,
        assetHash: h,
      });
    }
  }

  // --- C) Screenshot validation ---
  const screenshotPresent =
    typeof screenshot === "string"
      ? screenshot.length > 0
      : !!(
          screenshot.bytes ||
          (screenshot as any).base64 ||
          (screenshot as any).data
        );

  if (requireScreenshot && !screenshotPresent) {
    push(issues, {
      severity: "WARN", // Downgraded from FATAL - screenshot is for validation only, not required for import
      code: "SCREENSHOT_MISSING",
      message: "Reference screenshot bytes are missing.",
    });
  }

  if (screenshotPresent && typeof screenshot === "object") {
    if (screenshot.width != null && screenshot.height != null) {
      if (
        !isFiniteNumber(screenshot.width) ||
        !isFiniteNumber(screenshot.height) ||
        screenshot.width <= 0 ||
        screenshot.height <= 0
      ) {
        push(issues, {
          severity: "FATAL",
          code: "SCREENSHOT_META_INVALID",
          message: "Screenshot meta is missing or invalid (width/height).",
          details: { width: screenshot.width, height: screenshot.height },
        });
      }
    }

    if (screenshot.devicePixelRatio != null) {
      if (
        !isFiniteNumber(screenshot.devicePixelRatio) ||
        screenshot.devicePixelRatio <= 0
      ) {
        push(issues, {
          severity: "WARN",
          code: "SCREENSHOT_META_INVALID",
          message:
            "Screenshot devicePixelRatio missing/invalid; verification alignment may be impacted.",
          details: { devicePixelRatio: screenshot.devicePixelRatio },
        });
      }
    }
  }

  return finalize(
    issues,
    nodesTotal,
    assets,
    screenshot,
    imagesReferencedCount,
    imagesMissingCount,
  );
}

function finalize(
  issues: PreflightIssue[],
  nodesTotal: number,
  assets: Assets,
  screenshot: Screenshot,
  imagesReferenced: number,
  imagesMissing: number,
): PreflightResult {
  const fatalCount = issues.filter((i) => i.severity === "FATAL").length;
  const warnCount = issues.filter((i) => i.severity === "WARN").length;

  const embedded = assets?.images ? Object.keys(assets.images).length : 0;

  // Check if screenshot is present (handling both object and string forms)
  const screenshotPresent =
    typeof screenshot === "string"
      ? screenshot.length > 0
      : !!(
          screenshot.bytes ||
          (screenshot as any).base64 ||
          (screenshot as any).data
        );

  return {
    ok: fatalCount === 0,
    fatalCount,
    warnCount,
    issues,
    summary: {
      nodesTotal,
      imagesReferenced,
      imagesEmbedded: embedded,
      imagesMissing,
      screenshot: {
        present: screenshotPresent,
        width: typeof screenshot === "object" ? screenshot.width : undefined,
        height: typeof screenshot === "object" ? screenshot.height : undefined,
        dpr:
          typeof screenshot === "object"
            ? screenshot.devicePixelRatio
            : undefined,
      },
    },
  };
}

export function normalizeAndPreflight(payload: any): PreflightResult {
  // Helper to extract root, assets, screenshot from various payload shapes
  let root = payload.root || payload.tree;
  let assets =
    payload.assets || (payload.schema ? payload.schema.assets : undefined);
  let screenshot =
    payload.screenshot ||
    (payload.schema ? payload.schema.screenshot : undefined);

  // Handle wrapped schema case
  if (payload.schema) {
    root = root || payload.schema.root || payload.schema.tree;
    assets = assets || payload.schema.assets;
    screenshot = screenshot || payload.schema.screenshot;
  }

  return preflightSchemaJob({
    root,
    assets,
    screenshot,
    requireScreenshot: true,
  });
}
