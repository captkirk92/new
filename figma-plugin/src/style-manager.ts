import { DesignTokensManager } from './design-tokens-manager';

export class StyleManager {
  private paintStyles: Map<string, PaintStyle> = new Map();
  private textStyles: Map<string, TextStyle> = new Map();
  private effectStyles: Map<string, EffectStyle> = new Map();

  private styles: any;

  constructor(styles: any = {}, private designTokensManager?: DesignTokensManager) {
    // Ensure downstream style access always hits an object
    this.styles = styles || {};
  }

  /**
   * Find a matching design token for a color value
   */
  private findColorToken(color: { r: number; g: number; b: number; a?: number }): string | undefined {
    if (!this.designTokensManager) return undefined;

    // Look through the design tokens registry to find a matching color
    const tolerance = 0.01; // Allow small differences in color values
    
    for (const [tokenId, token] of Object.entries((this.designTokensManager as any).tokensRegistry.variables)) {
      const typedToken = token as any;
      if (typedToken.type === 'COLOR' && typedToken.resolvedValue) {
        const tokenColor = typedToken.resolvedValue;
        if (
          Math.abs(tokenColor.r - color.r) < tolerance &&
          Math.abs(tokenColor.g - color.g) < tolerance &&
          Math.abs(tokenColor.b - color.b) < tolerance
        ) {
          return tokenId;
        }
      }
    }

    return undefined;
  }

  // 8% HANG FIX - Timeout protected style creation
  async createFigmaStyles(): Promise<void> {
    console.log("🎨 [HANG-FIX] Style creation with timeout protection");
    const startTime = Date.now();
    const MAX_STYLES = 100; // Prevent memory issues
    
    try {
      // Timeout protection for entire operation
      await Promise.race([
        this.processStylesSafely(MAX_STYLES),
        this.createTimeout("Style processing", 15000)
      ]);
      
      console.log(`✅ Styles created in ${Date.now() - startTime}ms`);
    } catch (error) {
      console.warn("⚠️ [HANG-FIX] Style creation timeout/error:", error);
      // Continue execution instead of hanging
    }
  }
  
  private async processStylesSafely(maxStyles: number): Promise<void> {
    let count = 0;
    
    // Process colors with limits and timeouts
    if (this.styles.colors && count < maxStyles) {
      const colors = Object.entries(this.styles.colors).slice(0, maxStyles - count);
      for (const [key, colorData] of colors) {
        try {
          await Promise.race([
            this.createColorStyle(key, colorData),
            this.createTimeout("Color style", 1000)
          ]);
          count++;
          if (count % 10 === 0) await this.yield(); // Yield control
        } catch (err) {
          console.debug(`[StyleManager] Skipped color style "${key}": ${err}`);
        }
      }
    }
    
    // Process text styles with limits and timeouts
    if (this.styles.textStyles && count < maxStyles) {
      const textStyles = Object.entries(this.styles.textStyles).slice(0, maxStyles - count);
      for (const [key, textData] of textStyles) {
        try {
          await Promise.race([
            this.createTextStyle(key, textData),
            this.createTimeout("Text style", 3000)
          ]);
          count++;
          if (count % 5 === 0) await this.yield(); // Yield control
        } catch (err) {
          console.debug(`[StyleManager] Skipped text style "${key}": ${err}`);
        }
      }
    }
    
    // Process effects with limits and timeouts
    if (this.styles.effects && count < maxStyles) {
      const effects = Object.entries(this.styles.effects).slice(0, maxStyles - count);
      for (const [key, effectData] of effects) {
        try {
          await Promise.race([
            this.createEffectStyle(key, effectData),
            this.createTimeout("Effect style", 1000)
          ]);
          count++;
          if (count % 10 === 0) await this.yield(); // Yield control
        } catch (err) {
          console.debug(`[StyleManager] Skipped effect style "${key}": ${err}`);
        }
      }
    }
  }
  
  private async createColorStyle(key: string, colorData: any): Promise<void> {
    if (!colorData?.color) return;
    const style = figma.createPaintStyle();
    style.name = `Colors/${colorData.name || key}`;
    const { r = 0, g = 0, b = 0 } = colorData.color;
    
    const paint: SolidPaint = {
      type: "SOLID",
      color: { r, g, b },
      opacity: colorData.color.a ?? 1
    };
    
    if (this.designTokensManager) {
      try {
        const tokenId = this.findColorToken({ r, g, b, a: colorData.color.a });
        if (tokenId) {
          const variable = this.designTokensManager.getVariableByTokenId(tokenId);
          if (variable && variable.resolvedType === "COLOR") {
            const paintWithBinding: SolidPaint = {
              ...paint,
              boundVariables: { color: { type: "VARIABLE_ALIAS", id: variable.id } }
            };
            style.paints = [paintWithBinding];
            this.paintStyles.set(key, style);
            return;
          }
        }
      } catch (err) { /* Ignore token binding errors */ }
    }
    
    style.paints = [paint];
    this.paintStyles.set(key, style);
  }
  
  private async createTextStyle(key: string, textData: any): Promise<void> {
    if (!textData?.fontFamily) return;
    const style = figma.createTextStyle();
    style.name = `Text/${textData.name || key}`;
    
    try {
      await Promise.race([
        figma.loadFontAsync({
          family: textData.fontFamily,
          style: this.mapFontWeight(textData.fontWeight || 400)
        }),
        this.createTimeout("Font load", 2000)
      ]);
      
      style.fontName = {
        family: textData.fontFamily,
        style: this.mapFontWeight(textData.fontWeight || 400)
      };
      style.fontSize = textData.fontSize || 14;
      this.textStyles.set(key, style);
    } catch (fontErr) {
      // Skip on font load timeout
    }
  }
  
  private async createEffectStyle(key: string, effectData: any): Promise<void> {
    if (!Array.isArray(effectData)) return;
    const style = figma.createEffectStyle();
    style.name = `Effects/Shadow ${Object.keys(this.effectStyles).length + 1}`;
    
    const effects = this.convertEffects(effectData);
    if (effects.length > 0) {
      style.effects = effects;
      this.effectStyles.set(key, style);
    }
  }
  
  private createTimeout(op: string, ms: number): Promise<never> {
    return new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`${op} timeout`)), ms);
    });
  }
  
  private async yield(): Promise<void> {
    return new Promise(r => setTimeout(r, 1));
  }

  private convertEffects(effects: any[]): Effect[] {
    return effects.map(effect => {
      if (effect.type === 'DROP_SHADOW') {
        return {
          type: 'DROP_SHADOW',
          color: effect.color,
          offset: effect.offset,
          radius: effect.radius,
          spread: effect.spread || 0,
          visible: effect.visible,
          blendMode: effect.blendMode || 'NORMAL'
        } as DropShadowEffect;
      }
      return effect;
    });
  }

  private mapFontWeight(weight: number): string {
    const weightMap: { [key: number]: string } = {
      100: 'Thin',
      200: 'Extra Light',
      300: 'Light',
      400: 'Regular',
      500: 'Medium',
      600: 'Semi Bold',
      700: 'Bold',
      800: 'Extra Bold',
      900: 'Black'
    };
    return weightMap[weight] || 'Regular';
  }

  getStyleCount(): number {
    return this.paintStyles.size + this.textStyles.size + this.effectStyles.size;
  }

  getPaintStyle(key: string): PaintStyle | undefined {
    return this.paintStyles.get(key);
  }

  getTextStyle(key: string): TextStyle | undefined {
    return this.textStyles.get(key);
  }
  getEffectStyle(key: string): EffectStyle | undefined {
    return this.effectStyles.get(key);
  }
}
