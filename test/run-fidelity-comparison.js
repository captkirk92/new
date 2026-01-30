#!/usr/bin/env node

/**
 * Pixel-Perfect Fidelity Comparison Runner
 *
 * This script orchestrates the complete fidelity testing workflow:
 * 1. Captures a webpage with the extension
 * 2. Imports to Figma
 * 3. Exports from Figma at exact dimensions
 * 4. Runs pixel-diff comparison
 * 5. Analyzes discrepancies
 * 6. Reports what needs to be fixed
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Colors for terminal output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m'
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function header(message) {
  log('\n' + '═'.repeat(60), 'cyan');
  log(message, 'bright');
  log('═'.repeat(60), 'cyan');
}

function step(number, message) {
  log(`\n${number}. ${message}`, 'blue');
}

function success(message) {
  log(`✅ ${message}`, 'green');
}

function warning(message) {
  log(`⚠️  ${message}`, 'yellow');
}

function error(message) {
  log(`❌ ${message}`, 'red');
}

function checkServerRunning() {
  try {
    const result = execSync('curl -s http://localhost:4411/api/health', { timeout: 2000 });
    return true;
  } catch (err) {
    return false;
  }
}

function createTestPage() {
  const testHTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Fidelity Test Page</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@100;200;300;400;500;600;700;800;900&display=swap" rel="stylesheet">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Inter', sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      padding: 40px;
      min-height: 100vh;
    }
    .container {
      max-width: 1200px;
      margin: 0 auto;
      background: white;
      border-radius: 16px;
      padding: 40px;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
    }
    h1 {
      font-size: 48px;
      font-weight: 700;
      color: #1a1a1a;
      margin-bottom: 16px;
    }
    h2 {
      font-size: 32px;
      font-weight: 600;
      color: #4a5568;
      margin-top: 32px;
      margin-bottom: 16px;
    }
    p {
      font-size: 18px;
      line-height: 1.6;
      color: #4a5568;
      margin-bottom: 16px;
    }
    .font-weights {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 16px;
      margin-top: 24px;
    }
    .weight-test {
      padding: 16px;
      background: #f7fafc;
      border-radius: 8px;
      text-align: center;
    }
    .w100 { font-weight: 100; }
    .w200 { font-weight: 200; }
    .w300 { font-weight: 300; }
    .w400 { font-weight: 400; }
    .w500 { font-weight: 500; }
    .w600 { font-weight: 600; }
    .w700 { font-weight: 700; }
    .w800 { font-weight: 800; }
    .w900 { font-weight: 900; }
    .shadow-test {
      margin-top: 24px;
      padding: 32px;
      background: white;
      box-shadow: 0 4px 8px rgba(0, 0, 0, 0.3);
      border-radius: 8px;
    }
    .transform-test {
      margin-top: 24px;
      padding: 24px;
      background: #4299e1;
      color: white;
      transform: rotate(5deg);
      border-radius: 8px;
    }
    .image-test {
      margin-top: 24px;
      width: 300px;
      height: 200px;
      background: linear-gradient(45deg, #f093fb 0%, #f5576c 100%);
      border-radius: 8px;
    }
    .flex-test {
      display: flex;
      gap: 16px;
      margin-top: 24px;
    }
    .flex-item {
      width: 100px;
      height: 100px;
      background: #48bb78;
      border-radius: 8px;
      display: flex;
      align-items: center;
      justify-content: center;
      color: white;
      font-weight: 600;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>Fidelity Test Page</h1>
    <p>This page tests all critical fidelity aspects: text rendering, layouts, shadows, transforms, and images.</p>

    <h2>Font Weights (100-900)</h2>
    <div class="font-weights">
      <div class="weight-test w100">Thin 100</div>
      <div class="weight-test w200">Extra Light 200</div>
      <div class="weight-test w300">Light 300</div>
      <div class="weight-test w400">Regular 400</div>
      <div class="weight-test w500">Medium 500</div>
      <div class="weight-test w600">SemiBold 600</div>
      <div class="weight-test w700">Bold 700</div>
      <div class="weight-test w800">Extra Bold 800</div>
      <div class="weight-test w900">Black 900</div>
    </div>

    <h2>Box Shadow Test</h2>
    <div class="shadow-test">
      <p>This box has: box-shadow: 0 4px 8px rgba(0,0,0,0.3)</p>
      <p>Check if shadow blur matches browser exactly.</p>
    </div>

    <h2>Transform Test</h2>
    <div class="transform-test">
      <p>This box is rotated 5 degrees.</p>
      <p>Check if position and rotation are pixel-perfect.</p>
    </div>

    <h2>Image Test</h2>
    <div class="image-test"></div>

    <h2>Flexbox Layout Test</h2>
    <div class="flex-test">
      <div class="flex-item">1</div>
      <div class="flex-item">2</div>
      <div class="flex-item">3</div>
    </div>
  </div>
</body>
</html>`;

  const testDir = path.join(__dirname, 'pages');
  if (!fs.existsSync(testDir)) {
    fs.mkdirSync(testDir, { recursive: true });
  }

  const testFile = path.join(testDir, 'fidelity-test.html');
  fs.writeFileSync(testFile, testHTML);

  return testFile;
}

function analyzePixelDiff(diffPercent, diffPixels, totalPixels) {
  header('FIDELITY ANALYSIS');

  const fidelityScore = 100 - diffPercent;

  log(`\nTotal Pixels: ${totalPixels.toLocaleString()}`, 'cyan');
  log(`Different Pixels: ${diffPixels.toLocaleString()}`, 'cyan');
  log(`Difference: ${diffPercent.toFixed(2)}%`, 'cyan');
  log(`Fidelity Score: ${fidelityScore.toFixed(2)}%`, 'bright');

  if (diffPercent < 1) {
    success('EXCELLENT: Pixel-perfect fidelity achieved!');
    return 'excellent';
  } else if (diffPercent < 3) {
    warning('GOOD: Minor discrepancies detected');
    return 'good';
  } else if (diffPercent < 5) {
    warning('FAIR: Moderate discrepancies detected');
    return 'fair';
  } else {
    error('POOR: Major discrepancies detected');
    return 'poor';
  }
}

function suggestFixes(diffPercent) {
  header('RECOMMENDED FIXES');

  if (diffPercent < 1) {
    log('\n✅ No fixes needed - fidelity is excellent!');
    return;
  }

  log('\nBased on the difference percentage, likely issues:');

  if (diffPercent > 10) {
    log('\n🔴 CRITICAL ISSUES (>10% diff):');
    log('  • Missing elements - Check render tree builder');
    log('  • Wrong dimensions - Check viewport capture');
    log('  • Color inversion - Check fill conversion');
    log('  • Missing images - Check image embedding');
    log('\n📍 Files to check:');
    log('  - figma-plugin/src/render-tree-builder.ts');
    log('  - chrome-extension/src/utils/dom-extractor.ts');
    log('  - figma-plugin/src/node-builder.ts (convertFills)');
  }

  if (diffPercent > 5 && diffPercent <= 10) {
    log('\n🟠 MAJOR ISSUES (5-10% diff):');
    log('  • Transform precision - Check matrix decomposition');
    log('  • Image scaling - Check object-fit calculation');
    log('  • Shadow blur - May need conversion factor');
    log('  • Text wrapping - Check line break positions');
    log('\n📍 Files to check:');
    log('  - figma-plugin/src/node-builder.ts:8404 (applyTransformMatrix)');
    log('  - figma-plugin/src/node-builder.ts (image creation)');
    log('  - chrome-extension/src/utils/dom-extractor.ts:8053 (box-shadow)');
  }

  if (diffPercent > 3 && diffPercent <= 5) {
    log('\n🟡 MODERATE ISSUES (3-5% diff):');
    log('  • Font-weight rendering - Check weight mapping');
    log('  • Flexbox spacing - Check Auto Layout conversion');
    log('  • Border radius - Check corner rendering');
    log('  • Opacity/blend modes - Check effect application');
    log('\n📍 Files to check:');
    log('  - figma-plugin/src/node-builder.ts:8390 (mapFontWeight)');
    log('  - figma-plugin/src/layout-solver.ts');
  }

  if (diffPercent > 1 && diffPercent <= 3) {
    log('\n🟢 MINOR ISSUES (1-3% diff):');
    log('  • Subpixel positioning - Acceptable variation');
    log('  • Anti-aliasing differences - Browser vs Figma rendering');
    log('  • Text rendering - Minor font metric differences');
    log('  • Shadow edges - May need fine-tuning');
    log('\n📍 Files to check:');
    log('  - figma-plugin/src/node-builder.ts (text positioning)');
    log('  - chrome-extension/src/utils/dom-extractor.ts (shadow parsing)');
  }

  log('\n💡 NEXT STEPS:');
  log('  1. Open diff.png to visually inspect differences');
  log('  2. Identify which category of issue is dominant');
  log('  3. Apply fixes to the suggested files');
  log('  4. Rebuild: npm run build:all');
  log('  5. Re-run this test to verify improvement');
}

function main() {
  header('PIXEL-PERFECT FIDELITY COMPARISON');

  log('\nThis script will guide you through testing fidelity.', 'cyan');
  log('Make sure you have:', 'yellow');
  log('  • Handoff server running (port 4411)');
  log('  • Chrome extension loaded');
  log('  • Figma Desktop open with plugin loaded\n');

  // Step 1: Check server
  step(1, 'Checking handoff server...');
  if (checkServerRunning()) {
    success('Handoff server is running on port 4411');
  } else {
    error('Handoff server is NOT running');
    log('\nStart the server with:');
    log('  node handoff-server.cjs', 'yellow');
    log('\nOr:');
    log('  ./start.sh', 'yellow');
    process.exit(1);
  }

  // Step 2: Create test page
  step(2, 'Creating test page...');
  const testFile = createTestPage();
  success(`Test page created: ${testFile}`);

  log('\n' + '═'.repeat(60), 'bright');
  log('MANUAL STEPS REQUIRED', 'yellow');
  log('═'.repeat(60) + '\n', 'bright');

  log('Follow these steps carefully:\n');

  log('STEP 3: CAPTURE', 'cyan');
  log('  1. Open Chrome and navigate to:');
  log(`     file://${testFile}`, 'bright');
  log('  2. Open Web-to-Figma extension popup');
  log('  3. Click "Capture Website"');
  log('  4. Verify console shows 0 CDP errors\n');

  log('STEP 4: IMPORT', 'cyan');
  log('  1. Open Figma Desktop');
  log('  2. Run Web-to-Figma plugin');
  log('  3. Click "Import to Figma"');
  log('  4. Wait for import to complete\n');

  log('STEP 5: EXPORT FROM FIGMA', 'cyan');
  log('  1. Select the imported frame');
  log('  2. Right-click → Export');
  log('  3. Format: PNG, Scale: 1x');
  log('  4. Save to: test/results/figma-export.png\n');

  log('STEP 6: BROWSER SCREENSHOT', 'cyan');
  log('  1. Return to Chrome tab with test page');
  log('  2. Take screenshot (one of these methods):');
  log('     • Chrome DevTools: Cmd+Shift+P → "Capture full size screenshot"');
  log('     • Mac: Cmd+Shift+4, Space, click window');
  log('  3. Save to: test/results/browser-screenshot.png\n');

  log('STEP 7: RUN COMPARISON', 'cyan');
  log('  After completing steps 3-6, run:');
  log('  node test/analyze-fidelity.js\n', 'bright');

  log('═'.repeat(60) + '\n', 'cyan');
}

main();
