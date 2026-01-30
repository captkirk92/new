import { LayoutPreviewBlock } from "./smart-skeleton";

// Declare THREE global since we're loading it via script tag
declare const THREE: any;

export class ScannerAnimation {
  private container: HTMLElement;
  private canvasPadding: number = 0;
  private isRunning: boolean = false;

  private particleSystem: ParticleSystem | null = null;
  private particleScanner: ParticleScanner | null = null;
  private cardStream: CardStreamController | null = null;
  private screenshotUrl: string | null = null;

  constructor(containerId: string) {
    const el = document.getElementById(containerId);
    if (!el) throw new Error(`Container ${containerId} not found`);
    this.container = el;
  }

  public init(screenshotUrl: string) {
    this.screenshotUrl = screenshotUrl;

    // Clear Container
    this.container.innerHTML = `
      <canvas id="particleCanvas"></canvas>
      <canvas id="scannerCanvas"></canvas>
      <div class="scanner-beam"></div>
      <div class="card-stream-container" id="cardStream">
        <div class="card-line" id="cardLine"></div>
      </div>
      <div class="scanner-overlay-text">
        <span class="scanner-status">SCANNING TARGET</span>
        <span class="scanner-coordinates">X: 000 Y: 000</span>
      </div>
    `;

    // Initialize Sub-systems
    // Use requestAnimationFrame to ensure DOM is ready and layout is calculated
    requestAnimationFrame(() => {
      try {
        if (typeof THREE !== "undefined") {
          this.particleSystem = new ParticleSystem();
        } else {
          console.warn("THREE.js not loaded, skipping 3D particles");
        }

        this.particleScanner = new ParticleScanner();
        this.cardStream = new CardStreamController(screenshotUrl);

        this.isRunning = true;
        this.container.classList.remove("hidden");
      } catch (e) {
        console.error("Failed to init scanner animation:", e);
      }
    });
  }

  public stop() {
    this.isRunning = false;
    this.particleSystem?.destroy();
    this.particleScanner?.destroy();
    this.cardStream?.destroy();
    this.container.innerHTML = "";
    this.container.classList.add("hidden");
  }

  public setProgress(percent: number) {
    if (this.particleScanner) {
      // Intensify scanner based on progress
      this.particleScanner.setIntensity(0.8 + percent / 100);
    }
  }
}

class CardStreamController {
  private container: HTMLElement;
  private cardLine: HTMLElement;
  private imageUrl: string;
  private position: number = 0;
  private velocity: number = 60; // Scaled down speed
  private direction: number = -1;
  private animationId: number | null = null;
  private lastTime: number = 0;

  // Dimensions
  private cardWidth: number = 100;
  private cardGap: number = 20;
  private cardLineWidth: number = 0;
  private containerWidth: number = 0;

  constructor(imageUrl: string) {
    this.container = document.getElementById("cardStream") as HTMLElement;
    this.cardLine = document.getElementById("cardLine") as HTMLElement;
    this.imageUrl = imageUrl;

    if (!this.container || !this.cardLine) return;

    this.init();
  }

  private init() {
    this.populateCardLine();
    this.calculateDimensions();
    this.animate();

    window.addEventListener("resize", this.handleResize);
  }

  private populateCardLine() {
    this.cardLine.innerHTML = "";
    const cardsCount = 12; // Enough to fill width + buffer
    for (let i = 0; i < cardsCount; i++) {
      const wrapper = this.createCardWrapper(i);
      this.cardLine.appendChild(wrapper);
    }
  }

  private createCardWrapper(index: number) {
    const wrapper = document.createElement("div");
    wrapper.className = "card-wrapper";
    // Scale down dimensions
    wrapper.style.width = `${this.cardWidth}px`;
    wrapper.style.height = `${Math.floor(this.cardWidth * 0.6)}px`; // Aspect ratio

    const card = document.createElement("div");
    card.className = "card-item";

    // Image Layer
    const img = document.createElement("img");
    img.className = "card-image";
    img.src = this.imageUrl;
    img.onload = () => {
      img.classList.add("loaded");
    };

    // Code Overlay Layer (Cyberpunk feel)
    const overlay = document.createElement("div");
    overlay.className = "card-overlay";
    overlay.innerHTML = this.generateMatrixCode();

    card.appendChild(img);
    card.appendChild(overlay);
    wrapper.appendChild(card);

    return wrapper;
  }

  private generateMatrixCode(): string {
    // Generate random hex strings
    return Array(6)
      .fill(0)
      .map(() => Math.random().toString(16).substring(2, 8).toUpperCase())
      .join(" ");
  }

  private calculateDimensions() {
    if (!this.container) return;
    this.containerWidth = this.container.offsetWidth;
    const cardCount = this.cardLine.children.length;
    this.cardLineWidth = (this.cardWidth + this.cardGap) * cardCount;
  }

  private handleResize = () => {
    this.calculateDimensions();
  };

  private animate = () => {
    const currentTime = performance.now();
    const deltaTime = (currentTime - this.lastTime) / 1000;
    this.lastTime = currentTime;

    // Movement
    this.position += this.velocity * this.direction * deltaTime;

    // Loop logic
    if (this.position < -this.cardLineWidth / 2) {
      this.position += this.cardWidth + this.cardGap;
    }

    this.cardLine.style.transform = `translateX(${this.position}px)`;

    // Update clipping/scanning effects
    this.updateScanningEffect();

    this.animationId = requestAnimationFrame(this.animate);
  };

  private updateScanningEffect() {
    const scannerCenter = this.containerWidth / 2;
    const scannerWidth = 4; // Beam width

    // Check each card intersection with center
    const wrappers = this.cardLine.children;
    for (let i = 0; i < wrappers.length; i++) {
      const wrapper = wrappers[i] as HTMLElement;
      const rect = wrapper.getBoundingClientRect();
      const containerRect = this.container.getBoundingClientRect();

      // Config relative to container
      const cardLeft = rect.left - containerRect.left;
      const cardRight = rect.right - containerRect.left;

      if (cardLeft < scannerCenter && cardRight > scannerCenter) {
        wrapper.classList.add("scanning");
        // Calculate intersect percentage
        const progress = (scannerCenter - cardLeft) / (cardRight - cardLeft);
        wrapper.style.setProperty("--scan-progress", `${progress * 100}%`);
      } else {
        wrapper.classList.remove("scanning");
      }
    }
  }

  public destroy() {
    if (this.animationId) cancelAnimationFrame(this.animationId);
    window.removeEventListener("resize", this.handleResize);
  }
}

class ParticleSystem {
  private scene: any;
  private camera: any;
  private renderer: any;
  private particles: any;
  private canvas: HTMLCanvasElement;
  private animationId: number | null = null;

  constructor() {
    this.canvas = document.getElementById(
      "particleCanvas",
    ) as HTMLCanvasElement;
    if (!this.canvas) throw new Error("No particle canvas");
    this.init();
  }

  private init() {
    const width = this.canvas.parentElement?.offsetWidth || 300;
    const height = this.canvas.parentElement?.offsetHeight || 200;

    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(
      -width / 2,
      width / 2,
      height / 2,
      -height / 2,
      1,
      1000,
    );
    this.camera.position.z = 100;

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      alpha: true,
      antialias: true,
    });
    this.renderer.setSize(width, height);

    this.createParticles(width, height);
    this.animate();
  }

  private createParticles(w: number, h: number) {
    const count = 150; // Reduced for performance
    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const sizes = new Float32Array(count);

    for (let i = 0; i < count; i++) {
      positions[i * 3] = (Math.random() - 0.5) * w;
      positions[i * 3 + 1] = (Math.random() - 0.5) * h;
      positions[i * 3 + 2] = 0;

      colors[i * 3] = 0.2; // R
      colors[i * 3 + 1] = 0.8; // G
      colors[i * 3 + 2] = 0.9; // B

      sizes[i] = Math.random() * 2;
    }

    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geometry.setAttribute("size", new THREE.BufferAttribute(sizes, 1));

    const material = new THREE.PointsMaterial({
      size: 2,
      vertexColors: true,
      transparent: true,
      opacity: 0.6,
      blending: THREE.AdditiveBlending,
    });

    this.particles = new THREE.Points(geometry, material);
    this.scene.add(this.particles);
  }

  private animate = () => {
    // Simple rotation/movement
    if (this.particles) {
      this.particles.rotation.y += 0.002;
      this.particles.rotation.x += 0.001;
    }
    this.renderer.render(this.scene, this.camera);
    this.animationId = requestAnimationFrame(this.animate);
  };

  public destroy() {
    if (this.animationId) cancelAnimationFrame(this.animationId);
    if (this.renderer) this.renderer.dispose();
  }
}

class ParticleScanner {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private width: number = 0;
  private height: number = 0;
  private animationId: number | null = null;
  private intensity: number = 1.0;

  constructor() {
    this.canvas = document.getElementById("scannerCanvas") as HTMLCanvasElement;
    this.ctx = this.canvas.getContext("2d") as CanvasRenderingContext2D;
    this.init();
  }

  private init() {
    const parent = this.canvas.parentElement;
    if (parent) {
      this.width = parent.offsetWidth;
      this.height = parent.offsetHeight;
      this.canvas.width = this.width;
      this.canvas.height = this.height;
    }
    this.animate();
  }

  public setIntensity(val: number) {
    this.intensity = val;
  }

  private animate = () => {
    this.ctx.clearRect(0, 0, this.width, this.height);

    const centerX = this.width / 2;

    // Draw Beam
    const gradient = this.ctx.createLinearGradient(
      centerX - 2,
      0,
      centerX + 2,
      0,
    );
    gradient.addColorStop(0, "rgba(0, 255, 255, 0)");
    gradient.addColorStop(0.5, `rgba(0, 255, 255, ${0.5 * this.intensity})`);
    gradient.addColorStop(1, "rgba(0, 255, 255, 0)");

    this.ctx.fillStyle = gradient;
    this.ctx.fillRect(centerX - 10, 0, 20, this.height);

    // Draw Scan Line Pulse
    const time = Date.now() / 1000;
    const y = (Math.sin(time * 2) * 0.5 + 0.5) * this.height;

    this.ctx.strokeStyle = `rgba(0, 255, 255, ${0.8 * this.intensity})`;
    this.ctx.lineWidth = 1;
    this.ctx.beginPath();
    this.ctx.moveTo(0, y);
    this.ctx.lineTo(this.width, y);
    this.ctx.stroke();

    this.animationId = requestAnimationFrame(this.animate);
  };

  public destroy() {
    if (this.animationId) cancelAnimationFrame(this.animationId);
  }
}
