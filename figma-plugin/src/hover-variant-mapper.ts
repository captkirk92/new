/**
 * Hover State to Figma Variant Mapper
 * Converts hoverStates captured by Puppeteer into Figma component variants
 */

import { parseColorWithOpacity, parseBoxShadow as parseBoxShadowShared } from "../../shared/color-utils";

// Helper function to safely set plugin data
function safeSetPluginData(node: SceneNode, key: string, value: string): void {
  try {
    if ("setPluginData" in node) {
      (node as any).setPluginData(key, value);
    }
  } catch (error) {
    console.warn(`⚠️ Failed to set plugin data ${key}:`, error);
  }
}

interface HoverState {
  id: string;
  default: Record<string, string>;
  hover: Record<string, string>;
}

interface VariantCreationResult {
  componentSet: ComponentSetNode | null;
  defaultVariant: ComponentNode | null;
  hoverVariant: ComponentNode | null;
  success: boolean;
  error?: string;
}

/**
 * Create Figma component variants from hover state data
 */
export async function createHoverVariants(
  hoverStates: HoverState[],
  nodeMap: Map<string, SceneNode>
): Promise<Map<string, VariantCreationResult>> {
  const results = new Map<string, VariantCreationResult>();

  if (!hoverStates?.length) {
    console.log("ℹ️ No hover states to process");
    return results;
  }

  console.log(`🎭 Processing ${hoverStates.length} hover states...`);

  for (const state of hoverStates) {
    try {
      const node = nodeMap.get(state.id);
      if (!node || !("type" in node) || node.type === "TEXT") {
        continue; // Skip text nodes and missing nodes
      }

      const result = await createVariantFromHoverState(node, state);
      results.set(state.id, result);
    } catch (error) {
      console.warn(`⚠️ Failed to create variant for ${state.id}:`, error);
      results.set(state.id, {
        componentSet: null,
        defaultVariant: null,
        hoverVariant: null,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const successCount = Array.from(results.values()).filter(
    (r) => r.success
  ).length;
  console.log(
    `✅ Created ${successCount}/${hoverStates.length} hover variants`
  );

  return results;
}

/**
 * Convert a single node with hover state into a component set with variants
 */
async function createVariantFromHoverState(
  node: SceneNode,
  state: HoverState
): Promise<VariantCreationResult> {
  // Only process frame-like nodes
  if (!("children" in node)) {
    return {
      componentSet: null,
      defaultVariant: null,
      hoverVariant: null,
      success: false,
    };
  }

  const frame = node as FrameNode;

  // Clone the frame for the default variant
  const defaultVariant = figma.createComponent();
  defaultVariant.name = "State=Default";
  defaultVariant.resize(frame.width, frame.height);
  copyNodeProperties(frame, defaultVariant);

  // Clone for hover variant
  const hoverVariant = figma.createComponent();
  hoverVariant.name = "State=Hover";
  hoverVariant.resize(frame.width, frame.height);
  copyNodeProperties(frame, hoverVariant);

  // Apply hover style differences
  applyHoverStyles(hoverVariant, state.default, state.hover);

  // Create ComponentSet containing both variants
  const componentSet = figma.combineAsVariants(
    [defaultVariant, hoverVariant],
    figma.currentPage
  );
  componentSet.name = `${frame.name} (Interactive)`;

  // Position near the original
  componentSet.x = frame.x;
  componentSet.y = frame.y + frame.height + 20;

  // Replace original node with instance of default variant
  const instance = defaultVariant.createInstance();
  if (frame.parent) {
    const index = frame.parent.children.indexOf(frame);
    if (index >= 0) {
      (frame.parent as ChildrenMixin).insertChild(index, instance);
      frame.remove();
    }
  }

  // CRITICAL: Set up prototype interaction with onHover trigger
  // This makes the hover state work when hovering in Figma
  try {
    if (hoverVariant) {
      // Use Figma's reactions property to set up hover interaction
      // ON_HOVER trigger -> CHANGE_TO action to switch to hover variant
      // Note: reactions is a property on ComponentInstance nodes
      if (instance.type === "INSTANCE" && "reactions" in instance) {
        try {
          // Set up the hover reaction
          (instance as any).reactions = [
            {
              trigger: {
                type: "ON_HOVER",
              },
              action: {
                type: "CHANGE_TO",
                destination: hoverVariant,
              },
            },
          ];
          console.log(
            `✅ [HOVER] Set up onHover interaction for ${frame.name} (will switch to hover variant on hover)`
          );
        } catch (reactionError) {
          console.warn(
            `⚠️ [HOVER] Could not set reactions property directly:`,
            reactionError
          );
          // Fallback: Store in plugin data
          safeSetPluginData(instance, "hoverVariantId", hoverVariant.id);
          safeSetPluginData(
            instance,
            "hoverInteraction",
            JSON.stringify({
              trigger: "ON_HOVER",
              action: "CHANGE_TO",
              destination: hoverVariant.id,
            })
          );
        }
      } else {
        // Fallback: Store in plugin data if reactions API not available
        safeSetPluginData(instance, "hoverVariantId", hoverVariant.id);
        safeSetPluginData(
          instance,
          "hoverInteraction",
          JSON.stringify({
            trigger: "ON_HOVER",
            action: "CHANGE_TO",
            destination: hoverVariant.id,
          })
        );
        console.log(
          `ℹ️ [HOVER] Stored hover interaction in plugin data for ${frame.name} (instance type: ${instance.type})`
        );
      }
    }
  } catch (error) {
    console.warn(`⚠️ [HOVER] Failed to set up prototype interaction:`, error);
    // Fallback: Store in plugin data
    if (hoverVariant) {
      safeSetPluginData(instance, "hoverVariantId", hoverVariant.id);
    }
  }

  return {
    componentSet,
    defaultVariant,
    hoverVariant,
    success: true,
  };
}

/**
 * Copy node properties from source to target
 */
function copyNodeProperties(
  source: FrameNode | ComponentNode,
  target: FrameNode | ComponentNode
): void {
  // Copy fills
  if (source.fills && source.fills !== figma.mixed) {
    target.fills = JSON.parse(JSON.stringify(source.fills));
  }

  // Copy strokes
  if (source.strokes) {
    target.strokes = JSON.parse(JSON.stringify(source.strokes));
  }

  // Copy effects
  if (source.effects) {
    target.effects = JSON.parse(JSON.stringify(source.effects));
  }

  // Copy corner radius
  if (typeof source.cornerRadius === "number") {
    target.cornerRadius = source.cornerRadius;
  }

  // Copy padding
  target.paddingLeft = source.paddingLeft;
  target.paddingRight = source.paddingRight;
  target.paddingTop = source.paddingTop;
  target.paddingBottom = source.paddingBottom;
}

/**
 * Apply hover style differences to a variant
 */
function applyHoverStyles(
  variant: ComponentNode,
  defaultStyles: Record<string, string>,
  hoverStyles: Record<string, string>
): void {
  // Find style differences and apply them
  for (const [prop, hoverValue] of Object.entries(hoverStyles)) {
    if (defaultStyles[prop] !== hoverValue) {
      applyStyleProperty(variant, prop, hoverValue);
    }
  }
}

/**
 * Apply a single CSS style property to a Figma node
 */
function applyStyleProperty(
  node: ComponentNode,
  prop: string,
  value: string
): void {
  switch (prop) {
    case "backgroundColor":
      const bgColor = parseColor(value);
      if (bgColor) {
        node.fills = [
          {
            type: "SOLID",
            color: bgColor.color,
            opacity: bgColor.opacity,
          },
        ];
      }
      break;

    case "opacity":
      node.opacity = parseFloat(value) || 1;
      break;

    case "transform":
      // Transform changes are complex, store as metadata
      node.setPluginData("hoverTransform", value);
      break;

    case "boxShadow":
      const shadow = parseBoxShadow(value);
      if (shadow) {
        node.effects = [shadow];
      }
      break;
  }
}

// Use shared color utilities - parseColorWithOpacity imported at top
const parseColor = parseColorWithOpacity;

/**
 * Parse CSS box-shadow to Figma effect (wrapper around shared implementation)
 */
function parseBoxShadow(shadow: string): DropShadowEffect | null {
  const parsed = parseBoxShadowShared(shadow);
  if (!parsed) return null;

  return {
    type: "DROP_SHADOW",
    color: { r: parsed.color.r, g: parsed.color.g, b: parsed.color.b, a: parsed.color.a },
    offset: { x: parsed.offsetX, y: parsed.offsetY },
    radius: parsed.blur,
    spread: parsed.spread,
    visible: true,
    blendMode: "NORMAL",
  };
}
