export interface LayoutPreviewBlock {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  hintType: "header" | "hero" | "card" | "text" | "media" | "container";
  importance: number;
  z?: number;
}

export interface SkeletonOptions {
  container: HTMLElement;
  maxBlocks?: number;
  minBlockSize?: number;
  debug?: boolean;
}

type Viewport = { width: number; height: number };

export class SmartSkeleton {
  private readonly container: HTMLElement;
  private loader: HTMLElement | null = null;
  private linesContainer: HTMLElement | null = null;
  private progressBar: HTMLElement | null = null;
  private pillText: HTMLElement | null = null;

  private readonly maxBlocks: number;
  private readonly minBlockSize: number;
  private readonly debug: boolean;

  constructor(options: SkeletonOptions) {
    this.container = options.container;
    // The container ID #skeleton-animation from popup.html wraps the .ui-loader
    this.loader = this.container.querySelector(".ui-loader");
    this.linesContainer = this.container.querySelector(
      "#skeleton-lines-container",
    );
    this.progressBar = this.container.querySelector("#skeleton-progress-bar");
    this.pillText = this.container.querySelector("#loader-pill-text");

    this.maxBlocks =
      typeof options.maxBlocks === "number" ? options.maxBlocks : 10; // Fewer lines fit in the card
    this.minBlockSize =
      typeof options.minBlockSize === "number" ? options.minBlockSize : 0.05;
    this.debug = !!options.debug;
  }

  private log(...args: unknown[]) {
    if (this.debug) console.log(...args);
  }

  public start() {
    this.log("🦴 [SKELETON] start()");

    this.container.classList.remove("hidden");
    this.container.style.display = "flex";
    this.container.setAttribute("aria-hidden", "false");

    // Reset State
    if (this.progressBar) {
      this.progressBar.style.transform = "translateX(-100%)";
      this.progressBar.classList.add("animating");
    }
    if (this.pillText) this.pillText.textContent = "Scanning";

    // Reset lines to default if empty (or always reset to 'scanning' state)
    this.renderDefaults();
  }

  private renderDefaults() {
    if (!this.linesContainer) return;
    this.linesContainer.innerHTML = "";

    // Default nice looking lines
    const defaults = ["wide", "wide", "short"];
    defaults.forEach((type) => {
      const el = document.createElement("div");
      el.className = `sk sk-${type}`;
      this.linesContainer?.appendChild(el);
    });
  }

  public render(blocks: LayoutPreviewBlock[], viewport: Viewport) {
    if (!this.linesContainer || !Array.isArray(blocks) || blocks.length === 0)
      return;

    // We can map captured blocks to lines.
    // Logic: sort by importance/area, take top N, map width % to line width.

    const vpW = Math.max(1, viewport.width);

    const validBlocks = blocks
      .filter((b) => b.width / vpW > 0.1) // minimal width
      .sort((a, b) => (b.importance || 0) - (a.importance || 0))
      .slice(0, 6); // Max 6 lines to fit nicely

    if (validBlocks.length === 0) return;

    this.linesContainer.innerHTML = "";

    for (const block of validBlocks) {
      const el = document.createElement("div");
      el.className = "sk";

      // Calculate width percentage
      const widthPct = Math.min(100, Math.max(10, (block.width / vpW) * 100));
      el.style.width = `${widthPct}%`;

      // Optional: Add some variety based on type
      if (block.hintType === "header" || block.hintType === "hero") {
        el.style.height = "16px";
        el.style.marginBottom = "8px";
      }

      this.linesContainer.appendChild(el);
    }
  }

  public reveal(progress: number) {
    // Reveal maps to progress bar and text status
    const clamped = Math.max(0, Math.min(100, progress));

    if (this.progressBar) {
      // Transform from -100% to 0%
      const translate = -100 + clamped;
      this.progressBar.style.transform = `translateX(${translate}%)`;
    }

    if (this.pillText) {
      if (progress < 30) this.pillText.textContent = "Scanning";
      else if (progress < 70) this.pillText.textContent = "Processing";
      else this.pillText.textContent = "Uploading";
    }
  }

  public style(progress: number) {
    // No-op for this style (CSS handles shimmer)
  }

  public showSnapshot(dataUrl: string) {
    // Glassmorphism loader doesn't support snapshot preview inside it.
    // We just finish the progress and maybe hide.
    // The main popup logic handles showing the "Preview" card separately.
    if (this.progressBar) {
      this.progressBar.style.transform = "translateX(0%)";
    }
    if (this.pillText) {
      this.pillText.textContent = "Done";
    }
  }

  public send() {
    if (this.pillText) this.pillText.textContent = "Sending";
  }

  public clear() {
    this.container.classList.add("hidden");
    this.container.style.display = ""; // Reset to default (which is likely hidden via class)
    this.renderDefaults(); // Reset content for next time
  }

  public destroy() {
    this.loader = null;
    this.linesContainer = null;
    this.progressBar = null;
  }
}
