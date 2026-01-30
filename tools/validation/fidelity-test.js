#!/usr/bin/env node

/**
 * AUTOMATED FIDELITY TEST SUITE
 *
 * 1. Triggers capture via tools/capture-runner.js
 * 2. Waits for Figma plugin (must be running!) to import and upload render
 * 3. Downloads artifacts
 * 4. Runs pixel comparison
 * 5. Generates report
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const http = require('http');

const SERVER_BASE = 'http://localhost:4411';
const TEST_PAGES = [
  { name: 'simple-layout', url: 'http://localhost:8080/test/fidelity-pages/simple-layout.html', target: 98 },
  // Add other local test pages here. For now we assume a local server is running or file:// URLs if capture-runner supports them.
  // capture-runner supports file://? Let's check. It uses puppeteer.goto, so yes.
  // But let's use the file paths directly if we can't spin up a server.
  // The setup shows `test-images-simple.html` and `test-page.html` in root.
  // Let's use `test-page.html` as a smoke test.
];

// Helper to fetch JSON
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

// Helper to download file
function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    http.get(url, (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(`Failed to download ${url}: ${response.statusCode}`));
        return;
      }
      response.pipe(file);
      file.on('finish', () => {
        file.close(resolve);
      });
    }).on('error', (err) => {
      fs.unlink(dest, () => {});
      reject(err);
    });
  });
}

async function runCapture(url) {
  return new Promise((resolve, reject) => {
    console.log(`📸 Starting capture for ${url}...`);
    const proc = spawn('node', ['tools/capture-runner.js', url], {
      env: { ...process.env, WEB2FIGMA_AUTOMATION: '1' } // Ensure automation mode
    });

    let stdout = '';
    let stderr = '';
    let jobId = null;

    proc.stdout.on('data', data => {
      const str = data.toString();
      stdout += str;
      process.stdout.write(str); // Passthrough

      // Extract Job ID
      const match = str.match(/Job ID: ([a-f0-9-]+)/);
      if (match) {
        jobId = match[1];
      }
    });

    proc.stderr.on('data', data => {
      stderr += data.toString();
      process.stderr.write(data.toString());
    });

    proc.on('close', code => {
      if (code === 0 && jobId) {
        resolve(jobId);
      } else {
        reject(new Error(`Capture failed (code ${code}). Job ID found: ${jobId}`));
      }
    });
  });
}

async function waitForCompletion(jobId) {
  console.log(`⏳ Waiting for Figma import completion (Job: ${jobId})...`);
  console.log(`   👉 MAKE SURE FIGMA PLUGIN IS RUNNING IN AUTO-IMPORT MODE!`);

  const POLL_INTERVAL = 2000;
  const TIMEOUT = 120000; // 2 minutes
  const start = Date.now();

  while (Date.now() - start < TIMEOUT) {
    try {
      const job = await fetchJson(`${SERVER_BASE}/api/jobs/${jobId}`);
      if (job.status === 'completed' && job.hasFigmaScreenshot) {
        console.log(`✅ Import completed!`);
        return true;
      }
    } catch (e) {
      console.warn(`   Polling error: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL));
  }
  throw new Error('Timeout waiting for Figma import completion');
}

async function runPixelDiff(baseline, candidate, diff, threshold = 0.1) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [
      'tools/validation/pixel-diff.js',
      '--baseline', baseline,
      '--candidate', candidate,
      '--diff', diff,
      '--threshold', threshold.toString()
    ]);

    let output = '';
    proc.stdout.on('data', data => {
      output += data.toString();
      process.stdout.write(data.toString());
    });
    proc.stderr.on('data', data => {
        output += data.toString();
        process.stderr.write(data.toString());
    });

    proc.on('close', code => {
      // Parse output for structured result
      const match = output.match(/Pixel diff: (\d+) \(([0-9.]+)%\)/);
      if (match) {
        resolve({
          diffPixels: parseInt(match[1]),
          diffPercent: parseFloat(match[2])
        });
      } else {
        reject(new Error('Failed to parse pixel-diff output'));
      }
    });
  });
}

async function runTest(testPage) {
    console.log(`\n🧪 TEST: ${testPage.name}`);
    const resultDir = path.join('test/fidelity-results', testPage.name);
    fs.mkdirSync(resultDir, { recursive: true });
    
    // 1. Capture
    let jobId;
    try {
        jobId = await runCapture(testPage.url);
    } catch (e) {
        console.error(`❌ Capture failed: ${e.message}`);
        return { name: testPage.name, status: 'FAIL', reason: 'Capture failed' };
    }

    // 2. Wait for Import
    try {
        await waitForCompletion(jobId);
    } catch (e) {
        console.error(`❌ Import timeout: ${e.message}`);
        return { name: testPage.name, status: 'FAIL', reason: 'Import timeout' };
    }

    // 3. Download Artifacts
    const originalPath = path.join(resultDir, 'original.png');
    const figmaPath = path.join(resultDir, 'figma.png');
    const diffPath = path.join(resultDir, 'diff.png');

    // Currently capture-runner saves original to artifacts/handoff/debug/${jobId}/original_capture.png
    // We can fetch it locally or via server
    const serverArtifacts = `${SERVER_BASE}/api/jobs/${jobId}/screenshot`; // This is the Figma screenshot
    // The original is not exposed via specific API endpoint in handoff-server.cjs explicitly?
    // Looking at handoff-server.cjs:
    // It saves original to `artifacts/handoff/debug/${jobId}/original_capture.png`
    // It doesn't seem to expose it via GET /api/jobs/... 
    // Wait, the capture-runner output says "📸 Saved original capture to: ..."
    // Since we are local, we can copy it.
    
    // Handoff server directory
    const handoffDir = path.resolve('artifacts/handoff');
    const sourceOriginal = path.join(handoffDir, 'debug', jobId, 'original_capture.png');
    
    if (fs.existsSync(sourceOriginal)) {
        fs.copyFileSync(sourceOriginal, originalPath);
    } else {
        console.error(`❌ Original capture not found at ${sourceOriginal}`);
        return { name: testPage.name, status: 'FAIL', reason: 'Original missing' };
    }

    // Download Figma Render
    await downloadFile(serverArtifacts, figmaPath);

    // 4. Compare
    try {
        const result = await runPixelDiff(originalPath, figmaPath, diffPath);
        const passed = result.diffPercent <= (100 - testPage.target); // e.g. target 98% => diff <= 2%
        
        console.log(`\n📊 RESULT: ${passed ? 'PASS' : 'FAIL'}`);
        console.log(`   Fidelity: ${(100 - result.diffPercent).toFixed(2)}%`);
        console.log(`   Target: ${testPage.target}%`);
        
        return {
            name: testPage.name,
            status: passed ? 'PASS' : 'FAIL',
            fidelity: 100 - result.diffPercent,
            target: testPage.target,
            diffPercent: result.diffPercent
        };

    } catch (e) {
        console.error(`❌ Diff failed: ${e.message}`);
        return { name: testPage.name, status: 'FAIL', reason: 'Diff failed' };
    }
}

async function main() {
    // Quick test with a simple URL if provided
    const argUrl = process.argv[2];
    const tests = argUrl ? [{ name: 'cli-test', url: argUrl, target: 95 }] : TEST_PAGES;

    const results = [];
    for (const test of tests) {
        results.push(await runTest(test));
    }

    // Summary
    console.log(`\n${'='.repeat(50)}`);
    console.log(`SUMMARY`);
    console.log(`${'='.repeat(50)}`);
    results.forEach(r => {
        console.log(`${r.status === 'PASS' ? '✅' : '❌'} ${r.name}: ${r.fidelity ? r.fidelity.toFixed(2) + '%' : r.reason}`);
    });
}

main().catch(console.error);