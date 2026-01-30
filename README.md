# figmafi - Web to Figma Converter

Convert any website directly into pixel-perfect, editable Figma designs with Auto Layout, components, and interactive states.


## ⚡ **Quick Start: URL to Figma in 3 Steps**


### **Step 1: Load the Plugin**

1. Open **Figma Desktop**
2. Go to **Plugins → Development → Import plugin from manifest**
3. Select `figma-plugin/manifest.json`


### **Step 2: Convert Any URL**

1. Launch **"figmafi"** plugin
2. Enter any website URL (e.g., `https://github.com`)
3. Click **"Capture from Cloud"**
4. Wait 30-60 seconds for processing


### **Step 3: Auto-Import**

- Plugin automatically imports the captured design
- Creates pixel-perfect Figma frames with Auto Layout
- Extracts colors, text styles, and components
- **Done! 🎉**

---

## **System Architecture**

This is a complete end-to-end system with two deployment options:

### **🌐 Cloud Deployment (Recommended)**
- **Chrome Extension** - Captures any webpage in your browser
- **Cloud Capture Service** - Serverless headless browser processing
- **Figma Plugin** - Auto-imports designs with cloud polling

### **🏠 Local Development**
- **Chrome Extension** - Browser-based DOM extraction
- **Local Handoff Server** - Coordinates local data transfer  
- **Figma Plugin** - Imports from local server or JSON files

## **✨ What Gets Converted**

### **🎯 Layout & Structure**
- **Pixel-perfect positioning** - Exact element placement preserved
- **Auto Layout frames** - CSS Flexbox → Figma Auto Layout
- **Responsive design** - Multiple viewport captures
- **CSS transforms** - Rotation, scale, translate effects
- **Z-index layering** - Proper stacking order

### **🎨 Visual Design**
- **Colors & gradients** - Extracted as reusable Figma styles
- **Typography** - Font families, sizes, weights, line heights
- **Images & SVGs** - High-resolution asset extraction
- **Shadows & effects** - Drop shadows, inner shadows, blurs
- **Border radius** - Corner radius preservation

### **🧩 Components & Assets**
- **Component detection** - Repeated UI patterns become components
- **Interactive states** - Hover, focus, active state variants
- **Design system** - Automatic color and text style libraries
- **Asset optimization** - Compressed images with cloud storage

---

## **🚀 Cloud Setup (Production Ready)**

For production use with any URL conversion:

### **1. Deploy Cloud Service**
```bash
# Deploy to Railway (or AWS/Heroku)
cd capture-service
npm install
npm run build
# Follow deployment guide in RAILWAY_DEPLOY_STEPS.md
```

### **2. Configure Plugin**
```typescript
// Update figma-plugin/src/code-clean.ts
const cloudClient = new CloudServiceClient({
  apiBaseUrl: 'https://your-service.up.railway.app',
  apiKey: 'your-api-key'
});
```

### **3. Build & Load Plugin**
```bash
cd figma-plugin
npm install
npm run build
# Load manifest.json in Figma Desktop
```

**✅ Ready! Convert any URL instantly.**

---

## **🏠 Local Development Setup**

### **Prerequisites**
- Node.js 18+
- Chrome browser
- Figma Desktop

### **1. Install Dependencies**
```bash
# Install all workspaces
npm install
cd chrome-extension && npm install
cd ../figma-plugin && npm install
```

### **2. Start Handoff Server**
```bash
npm run handoff-server  # Runs on localhost:4411
```

### **3. Build & Load Chrome Extension**
```bash
cd chrome-extension
npm run build  # or 'npm run watch' for development

# Load in Chrome:
# 1. Go to chrome://extensions
# 2. Enable Developer Mode
# 3. Click "Load unpacked" 
# 4. Select chrome-extension/dist folder
```

### **4. Build & Load Figma Plugin**
```bash
cd figma-plugin
npm run build  # or 'npm run watch' for development

# Load in Figma Desktop:
# 1. Plugins → Development → Import plugin from manifest
# 2. Select figma-plugin/manifest.json
```

### **5. Capture Any Page**
1. Navigate to any website in Chrome
2. Click the extension icon
3. Click **"Capture & Send to Figma"**
4. Watch auto-import in Figma plugin

---

## **🔧 Advanced Usage**

### **Headless Capture (No Browser)**
```bash
npm run capture  # Uses Puppeteer for headless capture
node puppeteer-auto-import.js https://example.com
```

### **Visual Validation**
```bash
npm run validate:pixels  # Compare original vs Figma output
```










### **Custom Cloud Deployment**
- See `capture-service/DEPLOYMENT.md` for AWS, Kubernetes, Docker options
- Configure custom domains and SSL certificates
- Scale workers for high-volume processing

---

## **📐 Schema Architecture**

The capture pipeline produces a structured JSON schema that drives pixel-perfect Figma reconstruction.

### **Capture Method**

Uses **100% pure browser DOM APIs** (no CDP/DevTools protocol):

| API | Purpose |
|-----|---------|
| `window.getComputedStyle(element)` | Extract all CSS properties |
| `element.getBoundingClientRect()` | Get viewport-relative geometry |
| `element.offsetLeft/Top/Width/Height` | Get parent-relative layout |
| `window.scrollX/Y` | Compute page-absolute coordinates |
| Canvas 2D API | Image capture and optimization |

### **Layout Schema (`ElementNode.layout`)**

```typescript
layout: {
  // PAGE_ABSOLUTE_CSS_PX coordinates (authoritative)
  pageX: number;           // CSS pixels from document (0,0)
  pageY: number;
  x: number;               // Parent-relative X
  y: number;               // Parent-relative Y
  width: number;
  height: number;
  
  // Flexbox/Grid layout
  display?: string;        // "flex", "grid", "block", etc.
  flexDirection?: string;
  justifyContent?: string;
  alignItems?: string;
  gap?: string;
  flexWrap?: string;
  position?: string;       // static, relative, absolute, fixed, sticky
  
  // Grid-specific
  gridTemplateColumns?: string;
  gridTemplateRows?: string;
}
```

Also captures `absoluteLayout` (left/top/right/bottom) and `viewportLayout`.

### **Fills Schema (`Fill[]`)**

```typescript
{
  type: "SOLID" | "GRADIENT_LINEAR" | "GRADIENT_RADIAL" | "IMAGE" | "SVG";
  color?: { r: number, g: number, b: number };  // 0-1 range
  opacity?: number;
  visible?: boolean;
  gradientStops?: GradientStop[];
  imageHash?: string;      // Reference to assets.images[hash]
  scaleMode?: "FILL" | "FIT" | "CROP" | "TILE";
}
```

### **Effects Schema (`Effect[]`)**

```typescript
{
  type: "DROP_SHADOW" | "INNER_SHADOW" | "LAYER_BLUR" | "BACKGROUND_BLUR";
  visible: boolean;
  radius: number;
  color?: { r: number, g: number, b: number, a: number };
  offset?: { x: number, y: number };
  spread?: number;
}
```

### **Computed Styles (`computedStyle`)**

Extracted via `window.getComputedStyle()`:
- `backgroundColor`, `display`, `position`, `overflow`
- `visibility`, `zIndex`, `transform`, `transformOrigin`
- `transition`, `animation`, `cursor`, `pointerEvents`

### **Asset Storage**

```typescript
assets: {
  images: { [hash: string]: ImageAsset };   // Embedded images
  svgs: { [hash: string]: SvgAsset };       // Inline SVGs
  fonts: { [hash: string]: FontAsset };     // @font-face definitions
}
```

See [`shared/schema.ts`](shared/schema.ts) for the complete type definitions.

---

## **📚 Documentation**

- **[CLAUDE.md](CLAUDE.md)** - Complete technical architecture
- **[RAILWAY_DEPLOY_STEPS.md](RAILWAY_DEPLOY_STEPS.md)** - Cloud deployment guide  
- **[capture-service/](capture-service/)** - Cloud service implementation
- **[docs/](docs/)** - Architecture and validation guides

## **🚨 Troubleshooting**

| Issue | Solution |
|-------|----------|
| Plugin shows "Waiting for handoff server" | Start `npm run handoff-server` on port 4411 |
| Extension popup shows red status | Verify handoff server is running |
| Manifest errors in Chrome | Run `npm run build` in chrome-extension/ |
| Figma import stalls | Check plugin console for error logs |
| Cloud capture fails | Verify cloud service deployment and API keys |
| Missing fonts/images | Enable screenshot option in capture settings |

### **Common Issues**

**"Cannot load extension"**
```bash
cd chrome-extension
npm run build
# Reload extension in chrome://extensions
```

**"Plugin not found in Figma"**  
```bash
cd figma-plugin  
npm run build
# Re-import manifest.json in Figma Desktop
```

**"Cloud service unreachable"**
- Check your deployed service URL
- Verify API keys match in plugin configuration
- Test health endpoint: `curl https://your-service.com/health`

---

## **🎯 Examples & Use Cases**

- **Landing pages** - Convert marketing sites to design mockups
- **Component libraries** - Extract UI patterns from existing apps  
- **Competitive analysis** - Study competitor designs in Figma
- **Design handoff** - Turn production sites into editable designs
- **Responsive design** - Capture multiple breakpoints automatically

**Perfect for:** Designers, developers, product managers, and agencies working with web-to-design workflows.

---

## **📄 License & Support**

- **MIT License** - Free for commercial and personal use
- **GitHub Issues** - Report bugs and feature requests
- **Documentation** - Complete guides in `/docs` folder
- **Community** - Contribute improvements and extensions
# figmafi
