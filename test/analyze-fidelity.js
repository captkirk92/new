#!/usr/bin/env node

/**
 * Fidelity Analysis Script
 *
 * Runs pixel-diff comparison and provides detailed analysis of discrepancies
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m'
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function header(message) {
  log('\n' + '═'.repeat(70), 'cyan');
  log(message, 'bright');
  log('═'.repeat(70), 'cyan');
}

function main() {
  header('ANALYZING PIXEL-DIFF RESULTS');

  const browserPath = path.join(__dirname, 'results/browser-screenshot.png');
  const figmaPath = path.join(__dirname, 'results/figma-export.png');
  const diffPath = path.join(__dirname, 'results/diff.png');

  // Check files exist
  if (!fs.existsSync(browserPath)) {
    log(`\n❌ Browser screenshot not found: ${browserPath}`, 'red');
    log('\nMake sure you completed Step 6 from run-fidelity-comparison.js', 'yellow');
    process.exit(1);
  }

  if (!fs.existsSync(figmaPath)) {
    log(`\n❌ Figma export not found: ${figmaPath}`, 'red');
    log('\nMake sure you completed Step 5 from run-fidelity-comparison.js', 'yellow');
    process.exit(1);
  }

  log('\n✅ Both images found, running comparison...\n', 'green');

  // Run smart-compare
  const compareScript = path.join(__dirname, '../tools/validation/smart-compare.js');

  try {
    const result = execSync(
      `node "${compareScript}" "${browserPath}" "${figmaPath}" "${diffPath}"`,
      { encoding: 'utf8', stdio: 'pipe' }
    );

    // Display result
    log(result);

    // Parse metrics
    const diffMatch = result.match(/Difference: ([\d.]+)%/);
    const diffPixelsMatch = result.match(/Different pixels: ([\d,]+)/);
    const totalPixelsMatch = result.match(/Total pixels: ([\d,]+)/);
    const fidelityMatch = result.match(/FIDELITY SCORE: ([\d.]+)%/);

    if (diffMatch && fidelityMatch) {
      const diffPercent = parseFloat(diffMatch[1]);
      const fidelityScore = parseFloat(fidelityMatch[1]);

      suggestFixes(diffPercent);

      // Save report
      const report = {
        timestamp: new Date().toISOString(),
        diffPercent,
        fidelityScore,
        browserScreenshot: browserPath,
        figmaExport: figmaPath,
        diffImage: diffPath,
        passed: diffPercent < 1.0
      };

      const reportPath = path.join(__dirname, 'results/fidelity-report.json');
      fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

      log('\n' + '═'.repeat(70), 'cyan');
      log(`📊 Report saved: ${reportPath}`, 'green');
      log(`📷 Diff image: ${diffPath}`, 'yellow');
      log('═'.repeat(70) + '\n', 'cyan');

      log('Next steps:', 'bright');
      if (diffPercent < 1) {
        log('  ✅ Fidelity is excellent! No fixes needed.', 'green');
      } else {
        log(`  1. Open diff.png to visually inspect differences`);
        log(`  2. Apply suggested fixes`);
        log(`  3. Rebuild: npm run build:all`);
        log(`  4. Re-run: node test/run-fidelity-comparison.js\n`);
      }

    } else {
      log('❌ Could not parse comparison results', 'red');
      process.exit(1);
    }

  } catch (error) {
    log(`\n❌ Comparison failed: ${error.message}`, 'red');
    log('\nMake sure smart-compare.js exists:', 'yellow');
    log('  tools/validation/smart-compare.js\n');
    process.exit(1);
  }
}

function suggestFixes(diffPercent) {
  header('RECOMMENDED FIXES');

  if (diffPercent < 1) {
    log('\n✅ No fixes needed - fidelity is excellent!', 'green');
    return;
  }

  log('\nBased on pixel-diff analysis:\n');

  if (diffPercent > 10) {
    log('🔴 CRITICAL ISSUES (>10% diff):\n', 'red');
    log('  LIKELY CAUSES:');
    log('  • Missing elements - Render tree not materializing all nodes');
    log('  • Wrong viewport dimensions - DPR mismatch');
    log('  • Color inversion or missing fills');
    log('  • Images not embedding properly\n');

    log('  FILES TO FIX:', 'bright');
    log('  1. figma-plugin/src/render-tree-builder.ts');
    log('     → Check buildRenderTree() removes invisible nodes correctly');
    log('  2. chrome-extension/src/utils/dom-extractor.ts');
    log('     → Verify viewport.width/height match window dimensions');
    log('  3. figma-plugin/src/node-builder.ts');
    log('     → Check convertFillsAsync() for color parsing\n');
  }

  if (diffPercent > 5 && diffPercent <= 10) {
    log('🟠 MAJOR ISSUES (5-10% diff):\n', 'yellow');
    log('  LIKELY CAUSES:');
    log('  • Transform matrix precision loss (rotated elements offset)');
    log('  • Image object-fit not calculated correctly');
    log('  • Box-shadow blur radius conversion needed');
    log('  • Text line breaks in wrong positions\n');

    log('  FILES TO FIX:', 'bright');
    log('  1. figma-plugin/src/node-builder.ts:8404');
    log('     → Check applyTransformMatrix() decomposition');
    log('  2. figma-plugin/src/node-builder.ts (search: object-fit)');
    log('     → Verify cover/contain calculations');
    log('  3. chrome-extension/src/utils/dom-extractor.ts:8062');
    log('     → Test blur radius * 0.5 conversion');
    log('  4. figma-plugin/src/node-builder.ts (text wrapping)');
    log('     → Check text.width matches renderedMetrics.width\n');
  }

  if (diffPercent > 3 && diffPercent <= 5) {
    log('🟡 MODERATE ISSUES (3-5% diff):\n', 'yellow');
    log('  LIKELY CAUSES:');
    log('  • Font-weight not mapping correctly to styles');
    log('  • Flexbox Auto Layout spacing errors');
    log('  • Border-radius rendering differences');
    log('  • Blend modes not applied correctly\n');

    log('  FILES TO FIX:', 'bright');
    log('  1. figma-plugin/src/node-builder.ts:2498');
    log('     → Verify mapFontWeight() is called for inline styles');
    log('  2. figma-plugin/src/layout-solver.ts');
    log('     → Check confidence threshold for Auto Layout');
    log('  3. figma-plugin/src/node-builder.ts (border-radius)');
    log('     → Verify cornerRadius values match CSS\n');
  }

  if (diffPercent > 1 && diffPercent <= 3) {
    log('🟢 MINOR ISSUES (1-3% diff):\n', 'green');
    log('  LIKELY CAUSES:');
    log('  • Subpixel positioning differences (acceptable)');
    log('  • Anti-aliasing browser vs Figma');
    log('  • Font rendering subtle differences');
    log('  • Shadow edge blur variations\n');

    log('  RECOMMENDATIONS:');
    log('  • Open diff.png to identify dominant issue');
    log('  • If shadows: fine-tune blur conversion');
    log('  • If text: check letter-spacing and line-height');
    log('  • If edges: acceptable anti-aliasing difference\n');
  }

  log('💡 DEBUG WORKFLOW:\n', 'cyan');
  log('  1. Open test/results/diff.png');
  log('  2. Identify which elements show the most difference');
  log('  3. Check if issue is: text, layout, shadows, or images');
  log('  4. Go to suggested file and line number');
  log('  5. Add console.log to verify values');
  log('  6. Rebuild and re-test\n');
}

main();
