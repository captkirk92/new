/**
 * threejs-skeleton.ts
 *
 * Three.js-based 3D skeleton animation that uses actual pieces of the captured
 * webpage flying into place. Creates a stunning visual effect during page capture.
 */

import * as THREE from "three";
import gsap from "gsap";

// Re-export the LayoutPreviewBlock interface
export interface LayoutPreviewBlock {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  hintType?: "header" | "hero" | "card" | "text" | "media" | "container";
  importance?: number;
  z?: number;
  parentId?: string;
  visible?: boolean;
}

export interface PageDimensions {
  width: number;
  height: number;
}

export interface Viewport {
  width: number;
  height: number;
}

export interface ThreeSkeletonOptions {
  container: HTMLElement;
  debug?: boolean;
}

interface LayerMesh {
  mesh: THREE.Mesh;
  block: LayoutPreviewBlock;
  target: { x: number; y: number; z: number };
  revealed: boolean;
}

// Constants for canvas texture generation
const CANVAS_PADDING = 20;
const RESOLUTION_SCALE = 2;

// Color palette for procedural blocks
const BLOCK_COLORS: Record<string, string> = {
  header: "#25252e",
  hero: "#2a2a35",
  card: "#3a3a4a",
  text: "#2a2a35",
  media: "#1e1e24",
  container: "#25252e",
};

// Shadow configuration
const SHADOW_CONFIG = {
  color: "#000000",
  blur: 40,
  opacity: 0.4,
  x: 2,
  y: 8,
};

export class ThreeSkeleton {
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private renderer: THREE.WebGLRenderer;
  private stageGroup: THREE.Group;
  private layers: LayerMesh[] = [];
  private container: HTMLElement;
  private animationId: number | null = null;
  private screenshot: string | null = null;
  private screenshotImage: HTMLImageElement | null = null;
  private mouse = { x: 0, y: 0 };
  private baseRotation = { x: 0.08, y: -0.15 };
  private isDestroyed = false;
  private resizeHandler: (() => void) | null = null;
  private mouseMoveHandler: ((e: MouseEvent) => void) | null = null;
  private debug: boolean;

  constructor(options: ThreeSkeletonOptions) {
    this.container = options.container;
    this.debug = options.debug ?? false;
    this.init();
  }

  private log(...args: unknown[]): void {
    if (this.debug) {
      console.log("🎭 [ThreeSkeleton]", ...args);
    }
  }

  private init(): void {
    this.log("Initializing Three.js scene");

    // Scene setup with dark background
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0f0f11);

    // Camera - perspective for 3D depth effect
    const width = this.container.clientWidth || 400;
    const height = this.container.clientHeight || 280;
    const aspect = width / height;
    this.camera = new THREE.PerspectiveCamera(35, aspect, 1, 2000);
    this.camera.position.set(0, 0, 120);

    // Renderer with antialiasing
    try {
      this.renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: true,
        powerPreference: "high-performance",
      });
      this.renderer.setSize(width, height);
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      this.renderer.outputColorSpace = THREE.SRGBColorSpace;
      this.container.appendChild(this.renderer.domElement);

      // Style the canvas
      this.renderer.domElement.style.borderRadius = "8px";
    } catch (error) {
      console.error("WebGL not supported:", error);
      return;
    }

    // Create stage group for rotation/parallax
    this.stageGroup = new THREE.Group();
    this.stageGroup.rotation.x = this.baseRotation.x;
    this.stageGroup.rotation.y = this.baseRotation.y;
    this.scene.add(this.stageGroup);

    // Set up event listeners
    this.setupEventListeners();

    this.log("Scene initialized");
  }

  private setupEventListeners(): void {
    // Resize handler
    this.resizeHandler = () => {
      if (this.isDestroyed) return;
      const width = this.container.clientWidth || 400;
      const height = this.container.clientHeight || 280;
      this.camera.aspect = width / height;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(width, height);
    };
    window.addEventListener("resize", this.resizeHandler);

    // Mouse move for parallax
    this.mouseMoveHandler = (e: MouseEvent) => {
      if (this.isDestroyed) return;
      const rect = this.container.getBoundingClientRect();
      this.mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      this.mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    };
    this.container.addEventListener("mousemove", this.mouseMoveHandler);
  }

  /**
   * Load screenshot for slicing into 3D pieces
   */
  public async loadScreenshot(dataUrl: string): Promise<void> {
    this.log("Loading screenshot for slicing");
    return new Promise((resolve, reject) => {
      this.screenshot = dataUrl;
      this.screenshotImage = new Image();
      this.screenshotImage.onload = () => {
        this.log(
          "Screenshot loaded:",
          this.screenshotImage!.width,
          "x",
          this.screenshotImage!.height,
        );
        // Upgrade from placeholders to grid if needed
        if (
          this.layers.length > 0 &&
          this.layers[0].block.id.startsWith("ph-")
        ) {
          this.log("Upgrading from placeholders to screenshot grid");
          this.renderGridFromScreenshot();
        }
        resolve();
      };
      this.screenshotImage.onerror = (err) => {
        console.error("Failed to load screenshot:", err);
        reject(err);
      };
      this.screenshotImage.src = dataUrl;
    });
  }

  /**
   * Render grid of tiles from screenshot for "building page" effect
   */
  private renderGridFromScreenshot(): void {
    if (!this.screenshotImage || this.isDestroyed) return;

    this.log("Rendering grid from screenshot");
    const imgW = this.screenshotImage.width;
    const imgH = this.screenshotImage.height;

    // Create 6x8 grid
    const cols = 6;
    const rows = 8;
    const cellW = imgW / cols;
    const cellH = imgH / rows;

    const gridBlocks: LayoutPreviewBlock[] = [];

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        gridBlocks.push({
          id: `grid-${r}-${c}`,
          x: c * cellW,
          y: r * cellH,
          width: cellW - 2, // Slight gap for tile effect
          height: cellH - 2,
          hintType: "container",
          importance: 8 - r * 0.5, // Importance biases reveal order slightly
          z: 2 + Math.random(),
        });
      }
    }

    // Render these blocks
    this.render(
      gridBlocks,
      { width: imgW, height: imgH },
      { width: imgW, height: imgH },
    );
  }

  /**
   * Create 3D pieces from layout blocks
   */
  public render(
    blocks: LayoutPreviewBlock[],
    viewport: Viewport,
    page?: PageDimensions,
  ): void {
    if (this.isDestroyed) return;

    // Use page dimensions or fall back to viewport
    const pageDims = page || { width: viewport.width, height: viewport.height };

    this.log("Rendering", blocks.length, "blocks");
    this.log("Page dimensions:", pageDims);

    // Clear existing layers
    this.clearLayers();

    // Filter and sort blocks by importance/z-index
    const validBlocks = blocks
      .filter((b) => b.width > 10 && b.height > 10)
      .sort((a, b) => (a.z || 0) - (b.z || 0));

    // Scale factor to fit page into 3D space
    const maxDim = Math.max(pageDims.width, pageDims.height);
    const scale3D = 60 / maxDim;

    validBlocks.forEach((block, i) => {
      // Create texture from screenshot slice or procedural
      const texture = this.createBlockTexture(block, pageDims);

      // Geometry sized to match layout block (with padding for shadow)
      const paddedW = block.width + CANVAS_PADDING * 2;
      const paddedH = block.height + CANVAS_PADDING * 2;
      const geoW = paddedW * scale3D;
      const geoH = paddedH * scale3D;
      const geometry = new THREE.PlaneGeometry(geoW, geoH);

      const material = new THREE.MeshBasicMaterial({
        map: texture,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0,
        depthTest: true,
        depthWrite: false,
      });

      const mesh = new THREE.Mesh(geometry, material);

      // Calculate target position based on actual layout
      // Center the layout in 3D space
      const centerX = pageDims.width / 2;
      const centerY = pageDims.height / 2;
      const blockCenterX = block.x + block.width / 2;
      const blockCenterY = block.y + block.height / 2;

      const targetX = (blockCenterX - centerX) * scale3D;
      const targetY = -(blockCenterY - centerY) * scale3D; // Flip Y for Three.js
      const targetZ = ((block.z || 0) + i * 0.1) * 0.3; // Slight z-offset for layering

      this.stageGroup.add(mesh);
      this.layers.push({
        mesh,
        block,
        target: { x: targetX, y: targetY, z: targetZ },
        revealed: false,
      });
    });

    this.log("Created", this.layers.length, "layer meshes");

    // Start the render loop and animation
    this.startRenderLoop();
    this.playAnimation();
  }

  /**
   * Create texture from screenshot slice or procedural placeholder
   */
  private createBlockTexture(
    block: LayoutPreviewBlock,
    page: PageDimensions,
  ): THREE.Texture {
    const realW = block.width;
    const realH = block.height;

    const canvasW = (realW + CANVAS_PADDING * 2) * RESOLUTION_SCALE;
    const canvasH = (realH + CANVAS_PADDING * 2) * RESOLUTION_SCALE;

    const canvas = document.createElement("canvas");
    canvas.width = canvasW;
    canvas.height = canvasH;
    const ctx = canvas.getContext("2d")!;

    ctx.scale(RESOLUTION_SCALE, RESOLUTION_SCALE);
    ctx.clearRect(0, 0, canvasW / RESOLUTION_SCALE, canvasH / RESOLUTION_SCALE);

    const x = CANVAS_PADDING;
    const y = CANVAS_PADDING;
    const radius = Math.min(12, realW * 0.03, realH * 0.03);

    // Draw shadow
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(x, y, realW, realH, radius);

    const shadowColor = new THREE.Color(SHADOW_CONFIG.color);
    ctx.shadowColor = `rgba(${shadowColor.r * 255}, ${shadowColor.g * 255}, ${shadowColor.b * 255}, ${SHADOW_CONFIG.opacity})`;
    ctx.shadowBlur = SHADOW_CONFIG.blur;
    ctx.shadowOffsetX = SHADOW_CONFIG.x;
    ctx.shadowOffsetY = SHADOW_CONFIG.y;
    ctx.fillStyle = BLOCK_COLORS[block.hintType || "container"];
    ctx.fill();
    ctx.restore();

    // Draw content (clipped to rounded rect)
    ctx.save();
    ctx.translate(CANVAS_PADDING, CANVAS_PADDING);

    ctx.beginPath();
    ctx.roundRect(0, 0, realW, realH, radius);
    ctx.clip();

    if (this.screenshotImage) {
      // Slice from actual screenshot
      try {
        ctx.drawImage(
          this.screenshotImage,
          block.x,
          block.y,
          block.width,
          block.height, // Source
          0,
          0,
          realW,
          realH, // Destination
        );
        // Add slight overlay for depth perception
        ctx.fillStyle = "rgba(0, 0, 0, 0.05)";
        ctx.fillRect(0, 0, realW, realH);
      } catch (e) {
        // Fallback to procedural if slicing fails
        this.drawProceduralContent(ctx, block, realW, realH);
      }
    } else {
      // Procedural placeholder
      this.drawProceduralContent(ctx, block, realW, realH);
    }

    ctx.restore();

    const texture = new THREE.CanvasTexture(canvas);
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.anisotropy = 16;
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  }

  /**
   * Draw procedural UI content when screenshot not available
   */
  private drawProceduralContent(
    ctx: CanvasRenderingContext2D,
    block: LayoutPreviewBlock,
    w: number,
    h: number,
  ): void {
    // Base color
    ctx.fillStyle = BLOCK_COLORS[block.hintType || "container"];
    ctx.fillRect(0, 0, w, h);

    // Add shimmer lines based on type
    ctx.fillStyle = "rgba(255, 255, 255, 0.08)";

    switch (block.hintType) {
      case "header":
        // Navigation-like bars
        ctx.fillRect(20, h / 2 - 6, w * 0.3, 12);
        for (let i = 0; i < 4; i++) {
          ctx.fillRect(w - 200 + i * 45, h / 2 - 6, 35, 12);
        }
        break;

      case "hero":
        // Large heading + subtext
        ctx.fillRect(w * 0.15, h * 0.3, w * 0.7, 16);
        ctx.fillRect(w * 0.25, h * 0.45, w * 0.5, 10);
        // CTA button
        ctx.fillStyle = "rgba(100, 150, 255, 0.3)";
        ctx.fillRect(w * 0.4, h * 0.65, w * 0.2, 24);
        break;

      case "card":
        // Card content lines
        for (let i = 0; i < 4; i++) {
          const lineW = i === 0 ? w * 0.7 : w * (0.4 + Math.random() * 0.3);
          ctx.fillRect(15, 15 + i * 20, lineW, 10);
        }
        break;

      case "text":
        // Paragraph lines
        for (let i = 0; i < Math.min(6, Math.floor(h / 18)); i++) {
          const lineW =
            i === Math.floor(h / 18) - 1
              ? w * 0.5
              : w * (0.7 + Math.random() * 0.25);
          ctx.fillRect(10, 10 + i * 16, lineW, 8);
        }
        break;

      case "media":
        // Image placeholder
        ctx.fillStyle = "rgba(255, 255, 255, 0.05)";
        ctx.fillRect(0, 0, w, h);
        // Play button or image icon
        ctx.fillStyle = "rgba(255, 255, 255, 0.15)";
        const iconSize = Math.min(w, h) * 0.2;
        ctx.beginPath();
        ctx.arc(w / 2, h / 2, iconSize, 0, Math.PI * 2);
        ctx.fill();
        break;

      default:
        // Generic container with subtle lines
        for (let i = 0; i < 3; i++) {
          ctx.fillRect(20, 20 + i * 25, w * (0.4 + Math.random() * 0.4), 12);
        }
    }
  }

  /**
   * GSAP animation - pieces fly in from scattered positions
   */
  private playAnimation(): void {
    const duration = 2.0;

    this.layers.forEach((layer, i) => {
      const { mesh, target } = layer;

      // Start from random scattered position
      const startX = (Math.random() - 0.5) * 150;
      const startY = (Math.random() - 0.5) * 100;
      const startZ = target.z + 80 + Math.random() * 40;

      mesh.position.set(startX, startY, startZ);
      mesh.rotation.set(
        (Math.random() - 0.5) * Math.PI * 0.5,
        Math.random() * Math.PI * 4,
        (Math.random() - 0.5) * Math.PI * 0.3,
      );
      mesh.scale.set(0.1, 0.1, 0.1);

      // Stagger delay based on importance (higher importance = earlier)
      const importance = layer.block.importance || 5;
      const staggerDelay = i * 0.025 + (10 - importance) * 0.02;

      // Position animation
      gsap.to(mesh.position, {
        x: target.x,
        y: target.y,
        z: target.z,
        duration,
        ease: "power3.out",
        delay: staggerDelay,
      });

      // Rotation animation - settle to flat
      gsap.to(mesh.rotation, {
        x: 0,
        y: 0,
        z: 0,
        duration: duration * 1.1,
        ease: "elastic.out(1, 0.7)",
        delay: staggerDelay,
      });

      // Scale animation
      gsap.to(mesh.scale, {
        x: 1,
        y: 1,
        z: 1,
        duration: duration * 0.7,
        ease: "back.out(1.4)",
        delay: staggerDelay,
      });

      // Opacity animation
      gsap.to(mesh.material, {
        opacity: 1,
        duration: duration * 0.4,
        delay: staggerDelay,
        onComplete: () => {
          layer.revealed = true;
        },
      });
    });
  }

  /**
   * Render loop with parallax effect
   */
  private startRenderLoop(): void {
    if (this.animationId || this.isDestroyed) return;

    const animate = () => {
      if (this.isDestroyed) return;
      this.animationId = requestAnimationFrame(animate);

      // Subtle parallax on hover
      const targetRotX = this.baseRotation.x + this.mouse.y * 0.04;
      const targetRotY = this.baseRotation.y + this.mouse.x * 0.06;

      this.stageGroup.rotation.x +=
        (targetRotX - this.stageGroup.rotation.x) * 0.08;
      this.stageGroup.rotation.y +=
        (targetRotY - this.stageGroup.rotation.y) * 0.08;

      this.renderer.render(this.scene, this.camera);
    };

    animate();
  }

  /**
   * Update progress - progressively reveal more pieces
   */
  public reveal(progress: number): void {
    if (this.isDestroyed || this.layers.length === 0) return;

    // Already handled by playAnimation for initial reveal
    // This can be used for additional visual feedback
    const revealCount = Math.floor((progress / 100) * this.layers.length);

    // Add shimmer intensity based on progress
    this.layers.forEach((layer, i) => {
      if (i < revealCount && !layer.revealed) {
        gsap.to(layer.mesh.material, { opacity: 1, duration: 0.3 });
        layer.revealed = true;
      }
    });
  }

  /**
   * Update progress bar style
   */
  public style(progress: number): void {
    // Can add visual effects based on progress
    // For now, adjust camera zoom slightly
    if (this.isDestroyed) return;

    const targetZ = 120 - (progress / 100) * 10;
    gsap.to(this.camera.position, {
      z: targetZ,
      duration: 0.5,
      ease: "power2.out",
    });
  }

  /**
   * Start the skeleton (called when capture begins)
   * Creates initial placeholder animation immediately
   */
  public start(): void {
    this.log("Starting skeleton animation");

    // Ensure scene is visible
    if (this.renderer && this.renderer.domElement) {
      this.renderer.domElement.style.opacity = "1";
    }

    // Clear any existing layers
    this.clearLayers();

    // Create placeholder blocks for immediate visual feedback
    // These will be replaced when actual layout data arrives
    const placeholderBlocks: LayoutPreviewBlock[] = [
      // Header
      {
        id: "ph-header",
        x: 0,
        y: 0,
        width: 400,
        height: 60,
        hintType: "header",
        importance: 10,
        z: 1,
      },
      // Hero section
      {
        id: "ph-hero",
        x: 20,
        y: 80,
        width: 360,
        height: 120,
        hintType: "hero",
        importance: 9,
        z: 2,
      },
      // Content cards row
      {
        id: "ph-card1",
        x: 20,
        y: 220,
        width: 110,
        height: 90,
        hintType: "card",
        importance: 7,
        z: 3,
      },
      {
        id: "ph-card2",
        x: 145,
        y: 220,
        width: 110,
        height: 90,
        hintType: "card",
        importance: 7,
        z: 3,
      },
      {
        id: "ph-card3",
        x: 270,
        y: 220,
        width: 110,
        height: 90,
        hintType: "card",
        importance: 7,
        z: 3,
      },
      // Text blocks
      {
        id: "ph-text1",
        x: 20,
        y: 330,
        width: 240,
        height: 50,
        hintType: "text",
        importance: 5,
        z: 4,
      },
      {
        id: "ph-text2",
        x: 280,
        y: 330,
        width: 100,
        height: 50,
        hintType: "media",
        importance: 5,
        z: 4,
      },
      // Footer
      {
        id: "ph-footer",
        x: 0,
        y: 400,
        width: 400,
        height: 40,
        hintType: "container",
        importance: 4,
        z: 5,
      },
    ];

    const placeholderViewport = { width: 400, height: 450 };
    const placeholderPage = { width: 400, height: 450 };

    // Render placeholder blocks
    this.renderPlaceholders(
      placeholderBlocks,
      placeholderViewport,
      placeholderPage,
    );
  }

  /**
   * Render placeholder blocks for initial animation
   */
  private renderPlaceholders(
    blocks: LayoutPreviewBlock[],
    viewport: Viewport,
    page: PageDimensions,
  ): void {
    if (this.isDestroyed) return;

    this.log("Rendering", blocks.length, "placeholder blocks");

    // Scale factor to fit page into 3D space
    const maxDim = Math.max(page.width, page.height);
    const scale3D = 60 / maxDim;

    blocks.forEach((block, i) => {
      // Create procedural texture
      const texture = this.createBlockTexture(block, page);

      // Geometry sized to match layout block (with padding for shadow)
      const paddedW = block.width + CANVAS_PADDING * 2;
      const paddedH = block.height + CANVAS_PADDING * 2;
      const geoW = paddedW * scale3D;
      const geoH = paddedH * scale3D;
      const geometry = new THREE.PlaneGeometry(geoW, geoH);

      const material = new THREE.MeshBasicMaterial({
        map: texture,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0,
        depthTest: true,
        depthWrite: false,
      });

      const mesh = new THREE.Mesh(geometry, material);

      // Calculate target position based on actual layout
      const centerX = page.width / 2;
      const centerY = page.height / 2;
      const blockCenterX = block.x + block.width / 2;
      const blockCenterY = block.y + block.height / 2;

      const targetX = (blockCenterX - centerX) * scale3D;
      const targetY = -(blockCenterY - centerY) * scale3D;
      const targetZ = ((block.z || 0) + i * 0.1) * 0.3;

      this.stageGroup.add(mesh);
      this.layers.push({
        mesh,
        block,
        target: { x: targetX, y: targetY, z: targetZ },
        revealed: false,
      });
    });

    this.log("Created", this.layers.length, "placeholder meshes");

    // Start the render loop and animation
    this.startRenderLoop();
    this.playAnimation();
  }

  /**
   * Show final screenshot and fade out 3D scene
   */
  public showSnapshot(dataUrl: string): void {
    if (this.isDestroyed) return;
    this.log("Transitioning to final snapshot");

    // Animate pieces flying away slightly
    this.layers.forEach((layer, i) => {
      gsap.to(layer.mesh.position, {
        z: layer.target.z - 5,
        duration: 0.5,
        ease: "power2.in",
        delay: i * 0.01,
      });
      gsap.to(layer.mesh.material, {
        opacity: 0,
        duration: 0.5,
        delay: i * 0.01 + 0.2,
      });
    });

    // Fade out the renderer
    if (this.renderer && this.renderer.domElement) {
      gsap.to(this.renderer.domElement, {
        opacity: 0,
        duration: 0.8,
        delay: 0.3,
        onComplete: () => {
          // Don't destroy immediately - let the popup handle cleanup
          this.log("Snapshot transition complete");
        },
      });
    }
  }

  /**
   * Clear all layer meshes
   */
  private clearLayers(): void {
    this.layers.forEach(({ mesh }) => {
      this.stageGroup.remove(mesh);
      mesh.geometry.dispose();
      const material = mesh.material as THREE.MeshBasicMaterial;
      if (material.map) {
        material.map.dispose();
      }
      material.dispose();
    });
    this.layers = [];
  }

  /**
   * Clean up all resources
   */
  public destroy(): void {
    if (this.isDestroyed) return;
    this.isDestroyed = true;
    this.log("Destroying skeleton");

    // Cancel animation frame
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }

    // Remove event listeners
    if (this.resizeHandler) {
      window.removeEventListener("resize", this.resizeHandler);
    }
    if (this.mouseMoveHandler) {
      this.container.removeEventListener("mousemove", this.mouseMoveHandler);
    }

    // Kill all GSAP animations
    gsap.killTweensOf(this.layers.map((l) => l.mesh.position));
    gsap.killTweensOf(this.layers.map((l) => l.mesh.rotation));
    gsap.killTweensOf(this.layers.map((l) => l.mesh.scale));
    gsap.killTweensOf(this.layers.map((l) => l.mesh.material));

    // Clear layers
    this.clearLayers();

    // Dispose renderer
    if (this.renderer) {
      this.renderer.dispose();
      if (this.renderer.domElement && this.renderer.domElement.parentNode) {
        this.renderer.domElement.parentNode.removeChild(
          this.renderer.domElement,
        );
      }
    }

    // Clear screenshot reference
    this.screenshot = null;
    this.screenshotImage = null;

    this.log("Skeleton destroyed");
  }
}
