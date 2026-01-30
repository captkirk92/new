/**
 * CaptureGlow - Full-viewport capture mode indicator
 * Shows an electric blue outer glow hugging the screen edges with pulse animation.
 */
export class CaptureGlow {
  private container: HTMLDivElement | null = null;
  private isActive: boolean = false;

  private readonly GLOW_COLOR = "#00ccff";
  private readonly GLOW_SIZE = "4px";
  private readonly PULSE_DURATION = "1.5s";

  show(): void {
    if (this.isActive) return;
    this.isActive = true;

    // Create container
    this.container = document.createElement("div");
    this.container.id = "web-to-figma-capture-glow";

    // Inject styles
    const style = document.createElement("style");
    style.textContent = `
      #web-to-figma-capture-glow {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        pointer-events: none;
        z-index: 2147483647;
        border: ${this.GLOW_SIZE} solid transparent;
        box-shadow: 
          inset 0 0 20px ${this.GLOW_COLOR},
          inset 0 0 40px rgba(0, 204, 255, 0.3),
          0 0 20px ${this.GLOW_COLOR},
          0 0 40px rgba(0, 204, 255, 0.3);
        animation: captureGlowPulse ${this.PULSE_DURATION} ease-in-out infinite;
        overflow: hidden;
      }

      @keyframes captureGlowPulse {
        0%, 100% {
          box-shadow: 
            inset 0 0 15px ${this.GLOW_COLOR},
            inset 0 0 30px rgba(0, 204, 255, 0.3),
            0 0 15px ${this.GLOW_COLOR},
            0 0 30px rgba(0, 204, 255, 0.3);
          opacity: 0.9;
        }
        50% {
          box-shadow: 
            inset 0 0 25px ${this.GLOW_COLOR},
            inset 0 0 50px rgba(0, 204, 255, 0.5),
            0 0 25px ${this.GLOW_COLOR},
            0 0 50px rgba(0, 204, 255, 0.5);
          opacity: 1;
        }
      }

    `;

    this.container.appendChild(style);
    document.body.appendChild(this.container);

    console.log("✨ [CAPTURE_GLOW] Viewport glow activated");
  }

  hide(): void {
    if (!this.isActive || !this.container) return;

    // Fade out animation
    this.container.style.transition = "opacity 0.3s ease-out";
    this.container.style.opacity = "0";

    setTimeout(() => {
      if (this.container && this.container.parentNode) {
        this.container.parentNode.removeChild(this.container);
      }
      this.container = null;
      this.isActive = false;
      console.log("✨ [CAPTURE_GLOW] Viewport glow deactivated");
    }, 300);
  }

  /**
   * Update the glow color (optional - for different capture phases)
   */
  setColor(color: string): void {
    if (this.container) {
      this.container.style.setProperty("--glow-color", color);
    }
  }
}

// Export singleton instance
export const captureGlow = new CaptureGlow();
