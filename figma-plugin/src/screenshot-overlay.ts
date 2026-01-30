/**
 * Screenshot Overlay System for Visual Reference and Validation
 */
export class ScreenshotOverlay {
  
  /**
   * Create a semi-transparent reference overlay from the original screenshot
   */
  static async createReferenceOverlay(
    screenshotDataUrl: string,
    figmaFrame: FrameNode,
    options: {
      opacity?: number;
      visible?: boolean;
      position?: 'background' | 'foreground';
    } = {}
  ): Promise<RectangleNode | null> {
    
    if (!screenshotDataUrl || !figmaFrame) {
      console.warn('Cannot create reference overlay: missing screenshot or frame');
      return null;
    }

    try {
      // Convert data URL to Uint8Array
      const imageBytes = await this.dataUrlToBytes(screenshotDataUrl);
      const image = figma.createImage(imageBytes);
      
      // Create overlay rectangle
      const overlay = figma.createRectangle();
      overlay.name = '📸 Reference Screenshot';
      overlay.opacity = options.opacity ?? 0.3;
      overlay.visible = options.visible ?? true;
      overlay.locked = true; // Prevent accidental editing
      
      // Apply image fill
      overlay.fills = [{
        type: 'IMAGE',
        imageHash: image.hash,
        scaleMode: 'FIT'
      }];
      
      // Size to match frame
      overlay.resize(figmaFrame.width, figmaFrame.height);
      
      // Position based on preference
      if (options.position === 'foreground') {
        figmaFrame.appendChild(overlay);
      } else {
        figmaFrame.insertChild(0, overlay); // Background by default
      }
      
      console.log(`✅ Reference overlay created (${(imageBytes.length / 1024).toFixed(1)}KB)`);
      return overlay;
      
    } catch (error) {
      console.error('Failed to create reference overlay:', error);
      return null;
    }
  }
  
  /**
   * Create validation markers for positioning accuracy
   */
  static createValidationMarkers(
    figmaFrame: FrameNode,
    validationData: {
      accurateElements: Array<{ id: string; accuracy: number }>;
      inaccurateElements: Array<{ id: string; expectedPos: { x: number; y: number }; actualPos: { x: number; y: number } }>;
    }
  ): void {
    
    const markersGroup = figma.createFrame();
    markersGroup.name = '🎯 Validation Markers';
    markersGroup.layoutMode = 'NONE';
    markersGroup.clipsContent = false;
    markersGroup.fills = [];
    markersGroup.resize(figmaFrame.width, figmaFrame.height);
    
    // Create accurate position markers (green)
    validationData.accurateElements.forEach((element, index) => {
      const marker = this.createPositionMarker(
        element.accuracy,
        { r: 0, g: 1, b: 0, a: 0.7 }, // Green
        `✓ ${element.id} (${(element.accuracy * 100).toFixed(1)}%)`
      );
      markersGroup.appendChild(marker);
    });
    
    // Create inaccurate position markers (red) with arrows
    validationData.inaccurateElements.forEach((element, index) => {
      const expectedMarker = this.createPositionMarker(
        0.5,
        { r: 1, g: 0, b: 0, a: 0.5 }, // Red
        `✗ Expected: ${element.id}`
      );
      expectedMarker.x = element.expectedPos.x;
      expectedMarker.y = element.expectedPos.y;
      markersGroup.appendChild(expectedMarker);
      
      const actualMarker = this.createPositionMarker(
        0.5,
        { r: 1, g: 0.5, b: 0, a: 0.5 }, // Orange
        `📍 Actual: ${element.id}`
      );
      actualMarker.x = element.actualPos.x;
      actualMarker.y = element.actualPos.y;
      markersGroup.appendChild(actualMarker);
      
      // Create arrow between expected and actual
      const arrow = this.createArrow(element.expectedPos, element.actualPos);
      markersGroup.appendChild(arrow);
    });
    
    figmaFrame.appendChild(markersGroup);
  }
  
  /**
   * Convert data URL to Uint8Array for Figma image creation
   */
  private static async dataUrlToBytes(dataUrl: string): Promise<Uint8Array> {
    const base64 = dataUrl.split(',')[1];
    
    // Use Figma's native base64 decoder which is available in the main thread
    if (typeof figma !== 'undefined' && typeof figma.base64Decode === 'function') {
      return figma.base64Decode(base64);
    }
    
    // Fallback manual decoder for other environments
    const binaryString = this.atobFallback(base64);
    const bytes = new Uint8Array(binaryString.length);
    
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    
    return bytes;
  }

  private static atobFallback(base64: string): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const lookup = new Uint8Array(256);
    for (let i = 0; i < chars.length; i++) lookup[chars.charCodeAt(i)] = i;

    const len = base64.length;
    let bufferLength = len * 0.75;
    if (base64[len - 1] === '=') {
      bufferLength--;
      if (base64[len - 2] === '=') bufferLength--;
    }

    const bytes = new Uint8Array(bufferLength);
    for (let i = 0, p = 0; i < len; i += 4) {
      const encoded1 = lookup[base64.charCodeAt(i)];
      const encoded2 = lookup[base64.charCodeAt(i + 1)];
      const encoded3 = lookup[base64.charCodeAt(i + 2)];
      const encoded4 = lookup[base64.charCodeAt(i + 3)];

      bytes[p++] = (encoded1 << 2) | (encoded2 >> 4);
      bytes[p++] = ((encoded2 & 15) << 4) | (encoded3 >> 2);
      bytes[p++] = ((encoded3 & 3) << 6) | (encoded4 & 63);
    }

    let result = '';
    for (let i = 0; i < bytes.length; i++) {
      result += String.fromCharCode(bytes[i]);
    }
    return result;
  }
  
  /**
   * Create a position accuracy marker
   */
  private static createPositionMarker(
    accuracy: number,
    color: RGBA,
    label: string
  ): EllipseNode {
    const marker = figma.createEllipse();
    marker.name = label;
    marker.resize(12, 12);
    marker.fills = [{ type: 'SOLID', color }];
    marker.strokes = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }];
    marker.strokeWeight = 2;
    return marker;
  }
  
  /**
   * Create an arrow between two positions
   */
  private static createArrow(
    from: { x: number; y: number },
    to: { x: number; y: number }
  ): LineNode {
    const line = figma.createLine();
    line.name = '→ Position Offset';
    line.x = from.x;
    line.y = from.y;
    line.resize(Math.abs(to.x - from.x), 0);
    const rotationRadians = Math.atan2(to.y - from.y, to.x - from.x);
    line.rotation = (rotationRadians * 180) / Math.PI;
    line.strokes = [{ 
      type: 'SOLID', 
      color: { r: 1, g: 0, b: 0 } 
    }];
    line.strokeWeight = 3;
    return line;
  }
  
  /**
   * Toggle overlay visibility for validation
   */
  static toggleOverlayVisibility(frame: FrameNode, visible: boolean): void {
    const overlays = frame.findAll(node => 
      node.name.includes('Reference Screenshot') ||
      node.name.includes('Validation Markers')
    );
    
    overlays.forEach(overlay => {
      overlay.visible = visible;
    });
    
    console.log(`${visible ? 'Showing' : 'Hiding'} ${overlays.length} overlay elements`);
  }
  
  /**
   * Remove all overlays from frame
   */
  static removeOverlays(frame: FrameNode): void {
    const overlays = frame.findAll(node => 
      node.name.includes('Reference Screenshot') ||
      node.name.includes('Validation Markers')
    );
    
    overlays.forEach(overlay => overlay.remove());
    console.log(`Removed ${overlays.length} overlay elements`);
  }
}

export interface ValidationReport {
  totalElements: number;
  accurateElements: number;
  averageAccuracy: number;
  worstOffsets: Array<{
    elementId: string;
    offsetX: number;
    offsetY: number;
    offsetMagnitude: number;
  }>;
}