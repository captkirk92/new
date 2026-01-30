#!/usr/bin/env node

/**
 * AUTOMATED FIDELITY TEST
 *
 * Complete workflow automation:
 * 1. Start Chrome with extension loaded
 * 2. Navigate to test page
 * 3. Trigger extension capture
 * 4. Wait for handoff server to receive schema
 * 5. Save original screenshot
 * 6. Trigger Figma import (manual step documented)
 * 7. Run pixel-diff comparison
 */

const puppeteer = require('puppeteer');
const fs = require('fs').promises;
const path = require('path');
const { spawn } = require('child_process');

const HANDOFF_SERVER = 'http://localhost:4411';
const EXTENSION_PATH = path.resolve(__dirname, '../../chrome-extension/dist');

/**
 * Wait for handoff server to be ready
 */
async function waitForHandoffServer(maxWaitMs = 10000) {
  const startTime = Date.now();
  while (Date.now() - startTime < maxWaitMs) {
    try {
      // Check the actual API endpoint that exists
      const response = await fetch(`${HANDOFF_SERVER}/api/jobs/next`);
      if (response.ok) {
        console.log('✅ Handoff server is ready');
        return true;
      }
    } catch (e) {
      // Server not ready yet
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error('Handoff server not responding');
}

/**
 * Get the latest job from handoff server
 */
async function getLatestJob() {
  try {
    const response = await fetch(`${HANDOFF_SERVER}/api/jobs/next`);
    const data = await response.json();
    if (data.job) {
      return data.job;
    }
    return null;
  } catch (error) {
    console.error('Failed to get latest job:', error.message);
    return null;
  }
}

/**
 * Poll handoff server for new capture
 */
async function waitForNewCapture(previousJobId, timeoutMs = 60000) {
  console.log('⏳ Waiting for extension to capture and upload schema...');
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const job = await getLatestJob();

    if (job && job.id !== previousJobId) {
      console.log(`✅ New capture received! Job ID: ${job.id}`);
      return job;
    }

    await new Promise(resolve => setTimeout(resolve, 1000));
    process.stdout.write('.');
  }

  throw new Error('Timeout waiting for capture');
}

/**
 * Get job payload from handoff server
 */
async function getJobPayload(jobId) {
  try {
    const response = await fetch(`${HANDOFF_SERVER}/poll`);
    const data = await response.json();

    if (data.job && data.job.id === jobId) {
      return data.job.payload;
    }

    return null;
  } catch (error) {
    console.error('Failed to get job payload:', error.message);
    return null;
  }
}

/**
 * Capture test page with extension
 */
async function captureWithExtension(testPageUrl, outputDir) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`🚀 Starting automated capture test`);
  console.log(`${'='.repeat(60)}\n`);

  await fs.mkdir(outputDir, { recursive: true });

  // Check if extension is built
  try {
    await fs.access(path.join(EXTENSION_PATH, 'manifest.json'));
    console.log(`✅ Extension found at: ${EXTENSION_PATH}`);
  } catch (error) {
    throw new Error(`Extension not built! Run: cd chrome-extension && npm run build`);
  }

  // Wait for handoff server
  await waitForHandoffServer();

  // Get current latest job (so we can detect new captures)
  const previousJob = await getLatestJob();
  const previousJobId = previousJob ? previousJob.id : null;
  console.log(`📋 Previous job ID: ${previousJobId || 'none'}`);

  // Launch Chrome with extension
  console.log('🌐 Launching Chrome with extension...');
  const browser = await puppeteer.launch({
    headless: false, // Must be non-headless to load extensions
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--window-size=1440,900'
    ],
    defaultViewport: {
      width: 1440,
      height: 900
    }
  });

  try {
    const page = await browser.newPage();

    // Navigate to test page
    console.log(`📄 Loading test page: ${testPageUrl}`);
    await page.goto(testPageUrl, { waitUntil: 'networkidle0' });

    // Wait for page to settle
    await page.waitForTimeout(1000);

    // Capture original screenshot
    console.log('📸 Capturing original screenshot...');
    const originalScreenshot = await page.screenshot({ fullPage: true });
    const originalPath = path.join(outputDir, 'original.png');
    await fs.writeFile(originalPath, originalScreenshot);
    console.log(`✅ Original saved: ${originalPath}`);

    // Trigger extension capture
    console.log('\n🔧 Triggering extension capture...');
    console.log('   Method: Injecting capture trigger script');

    // Inject script to trigger capture programmatically
    const captureTriggered = await page.evaluate(() => {
      // Try to trigger capture via window message
      window.postMessage({ type: 'TRIGGER_CAPTURE', source: 'automation' }, '*');

      // Also try direct call if the extension exposed it
      if (window.__FIGMA_CAPTURE_TRIGGER) {
        window.__FIGMA_CAPTURE_TRIGGER();
        return 'direct-call';
      }

      return 'message-posted';
    });

    console.log(`   Trigger result: ${captureTriggered}`);

    // Wait a moment for capture to start
    await page.waitForTimeout(2000);

    // Wait for new job to appear on handoff server
    const newJob = await waitForNewCapture(previousJobId, 60000);

    console.log(`\n✅ Capture completed!`);
    console.log(`   Job ID: ${newJob.id}`);
    console.log(`   Queued at: ${newJob.queuedAt}`);

    // Get full payload
    console.log('📥 Fetching schema payload...');
    const payload = await getJobPayload(newJob.id);

    if (payload) {
      const schemaPath = path.join(outputDir, 'schema.json');
      await fs.writeFile(schemaPath, JSON.stringify(payload, null, 2));
      console.log(`✅ Schema saved: ${schemaPath}`);

      // Print schema summary
      const nodeCount = payload.root ? countNodes(payload.root) : 0;
      const imageCount = payload.assets?.images ? Object.keys(payload.assets.images).length : 0;

      console.log(`\n📊 Schema Summary:`);
      console.log(`   Total nodes: ${nodeCount}`);
      console.log(`   Images: ${imageCount}`);
      console.log(`   Metadata URL: ${payload.metadata?.url || 'unknown'}`);
    } else {
      console.warn('⚠️  Could not fetch schema payload');
    }

    return {
      jobId: newJob.id,
      originalPath,
      schemaPath: path.join(outputDir, 'schema.json')
    };

  } finally {
    await browser.close();
    console.log('🔒 Browser closed');
  }
}

/**
 * Count nodes in schema tree
 */
function countNodes(node) {
  let count = 1;
  if (node.children && Array.isArray(node.children)) {
    for (const child of node.children) {
      count += countNodes(child);
    }
  }
  return count;
}

/**
 * Print manual Figma import instructions
 */
function printFigmaInstructions(schemaPath, outputDir) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`📋 NEXT STEPS - MANUAL FIGMA IMPORT`);
  console.log(`${'='.repeat(60)}\n`);

  console.log(`The schema is ready on the handoff server.`);
  console.log(`\n1. Open Figma Desktop`);
  console.log(`2. Plugins → Development → Import plugin from manifest`);
  console.log(`   Select: figma-plugin/manifest.json`);
  console.log(`3. Run the plugin (Plugins → Development → [Your Plugin])`);
  console.log(`4. Click "Poll Server" or wait for auto-poll`);
  console.log(`5. The schema should import automatically`);
  console.log(`6. After import completes:`);
  console.log(`   a. Select the imported frame`);
  console.log(`   b. File → Export → PNG`);
  console.log(`   c. Save to: ${path.join(outputDir, 'figma.png')}`);
  console.log(`7. Then run: npm run validate:fidelity`);
  console.log(`\n💡 TIP: Keep the handoff server running (it's already running)`);
}

/**
 * Run pixel-diff comparison (if Figma render exists)
 */
async function runPixelDiff(outputDir) {
  const originalPath = path.join(outputDir, 'original.png');
  const figmaPath = path.join(outputDir, 'figma.png');
  const diffPath = path.join(outputDir, 'diff.png');

  // Check if Figma render exists
  try {
    await fs.access(figmaPath);
  } catch {
    console.log(`\n⚠️  Figma render not found at: ${figmaPath}`);
    console.log(`   Complete manual Figma export first, then re-run this script.`);
    return null;
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`🔍 Running pixel-diff comparison...`);
  console.log(`${'='.repeat(60)}\n`);

  return new Promise((resolve, reject) => {
    const proc = spawn('node', [
      'tools/validation/pixel-diff.js',
      '--baseline', originalPath,
      '--candidate', figmaPath,
      '--diff', diffPath,
      '--threshold', '0.1'
    ]);

    let output = '';
    proc.stdout.on('data', data => {
      const text = data.toString();
      output += text;
      process.stdout.write(text);
    });

    proc.stderr.on('data', data => {
      const text = data.toString();
      output += text;
      process.stderr.write(text);
    });

    proc.on('close', code => {
      const match = output.match(/Pixel diff: (\d+) \(([0-9.]+)%\)/);
      if (match) {
        const diffPixels = parseInt(match[1]);
        const diffPercent = parseFloat(match[2]);
        const fidelity = 100 - diffPercent;

        console.log(`\n📊 FIDELITY SCORE: ${fidelity.toFixed(2)}%`);

        resolve({ fidelity, diffPixels, diffPercent });
      } else {
        reject(new Error('Could not parse pixel diff output'));
      }
    });
  });
}

/**
 * Main execution
 */
async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help')) {
    console.log(`Automated Fidelity Test`);
    console.log(``);
    console.log(`Usage:`);
    console.log(`  node tools/automation/auto-capture-test.js <test-page> [output-dir]`);
    console.log(``);
    console.log(`Examples:`);
    console.log(`  node tools/automation/auto-capture-test.js test/fidelity-pages/simple-layout.html`);
    console.log(`  node tools/automation/auto-capture-test.js http://localhost:8000/test.html results/test1`);
    console.log(``);
    console.log(`What it does:`);
    console.log(`  1. Launches Chrome with your extension`);
    console.log(`  2. Navigates to test page`);
    console.log(`  3. Captures original screenshot`);
    console.log(`  4. Triggers extension capture`);
    console.log(`  5. Waits for schema to appear on handoff server`);
    console.log(`  6. Saves schema and provides Figma import instructions`);
    console.log(`  7. (Optional) Runs pixel-diff if Figma render exists`);
    process.exit(0);
  }

  const testPageInput = args[0];
  if (!testPageInput) {
    console.error('❌ Error: Test page URL required');
    console.log('Usage: node tools/automation/auto-capture-test.js <test-page>');
    process.exit(1);
  }

  // Convert relative path to file:// URL if needed
  let testPageUrl = testPageInput;
  if (!testPageInput.startsWith('http://') && !testPageInput.startsWith('https://') && !testPageInput.startsWith('file://')) {
    const absolutePath = path.resolve(testPageInput);
    testPageUrl = `file://${absolutePath}`;
  }

  // Determine output directory
  const testName = path.basename(testPageInput, '.html');
  const outputDir = args[1] || path.join(__dirname, '../../test/fidelity-results', testName);

  try {
    // Run capture
    const result = await captureWithExtension(testPageUrl, outputDir);

    // Print Figma instructions
    printFigmaInstructions(result.schemaPath, outputDir);

    // Try to run pixel-diff if Figma render already exists
    try {
      const comparison = await runPixelDiff(outputDir);
      if (comparison) {
        const reportPath = path.join(outputDir, 'report.json');
        await fs.writeFile(reportPath, JSON.stringify({
          testName,
          url: testPageUrl,
          timestamp: new Date().toISOString(),
          fidelity: comparison.fidelity,
          diffPixels: comparison.diffPixels,
          diffPercent: comparison.diffPercent,
          jobId: result.jobId,
          paths: {
            original: result.originalPath,
            schema: result.schemaPath,
            figma: path.join(outputDir, 'figma.png'),
            diff: path.join(outputDir, 'diff.png')
          }
        }, null, 2));
        console.log(`\n📄 Report saved: ${reportPath}`);
      }
    } catch (error) {
      // Figma render doesn't exist yet - that's okay
    }

    console.log(`\n✅ Automated capture complete!`);
    console.log(`📁 Results saved to: ${outputDir}`);

  } catch (error) {
    console.error(`\n❌ Test failed:`, error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

main();
