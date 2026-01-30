const puppeteer = require("puppeteer");
const path = require("path");

// Use node-fetch if global fetch is not available (Node < 18)
const fetch = globalThis.fetch || require("node-fetch");

const EXTENSION_PATH = path.resolve(__dirname, "../chrome-extension/dist");
const URL_TO_CAPTURE = process.argv[2] || "https://example.com";

(async () => {
  console.log(`🚀 Starting capture automation for: ${URL_TO_CAPTURE}`);
  console.log(`📂 Extension path: ${EXTENSION_PATH}`);

  // Preflight: Verify server is running
  const SERVER_BASE = "http://localhost:4411";
  console.log(`🏥 Checking server health at ${SERVER_BASE}...`);
  try {
    const healthResponse = await fetch(`${SERVER_BASE}/api/health`);
    if (!healthResponse.ok) {
      throw new Error(`Server returned ${healthResponse.status}`);
    }
    const healthData = await healthResponse.json();
    console.log(
      `✅ Server is running (queue length: ${healthData.queueLength})`,
    );
  } catch (error) {
    console.error("❌ Server health check failed:", error.message);
    console.error("   Make sure the handoff server is running:");
    console.error("   node handoff-server.cjs");
    process.exit(1);
  }

  try {
    const browser = await puppeteer.launch({
      headless: false, // VISIBLE mode for debugging
      devtools: false, // Set to true if you need to inspect service worker
      defaultViewport: null, // Allow window size to dictate viewport
      args: [
        `--disable-extensions-except=${EXTENSION_PATH}`,
        `--load-extension=${EXTENSION_PATH}`,
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-blink-features=AutomationControlled",
        "--window-size=1600,1000", // Larger than our max viewport
        "--start-maximized",
      ],
    });

    // Monitor service worker logs (Background Script)
    const bgLogs = [];
    let serviceWorkerAttached = false;
    browser.on("targetcreated", async (target) => {
      if (target.type() === "service_worker") {
        try {
          const worker = await target.worker();
          if (worker) {
            worker.on("console", (msg) => {
              const text = msg.text();
              const type = msg.type();
              const prefix =
                type === "error"
                  ? "❌ BG ERROR:"
                  : type === "warning"
                    ? "⚠️  BG WARN:"
                    : "BG LOG:";
              console.log(`${prefix} ${text}`);
              bgLogs.push({ type, text, timestamp: Date.now() });
            });
            serviceWorkerAttached = true;
            console.log("✅ Attached to background service worker");
            console.log(
              "   Service worker URL:",
              await worker.evaluate(() => self.location.href),
            );
          }
        } catch (e) {
          console.error("⚠️ Could not attach to service worker:", e);
        }
      }
    });

    const page = await browser.newPage();

    // Enable console logs from browser to debug extension issues
    const pageLogs = [];
    page.on("console", (msg) => {
      const text = msg.text();
      const type = msg.type();
      const prefix =
        type === "error"
          ? "❌ PAGE ERROR:"
          : type === "warning"
            ? "⚠️  PAGE WARN:"
            : "PAGE LOG:";

      // Log only errors, warnings, and high-level markers to reduce noise
      if (
        text.includes("[FILL]") ||
        text.includes("[INHERITANCE]") ||
        text.includes("[TRANSFORM]")
      ) {
        return;
      }
      console.log(`${prefix} ${text}`);
      pageLogs.push({ type, text, timestamp: Date.now() });
    });

    console.log("🔗 Navigating...");
    await page.goto(URL_TO_CAPTURE, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });

    // Wait for content script to be ready
    console.log("⏳ Waiting for content script to initialize...");
    try {
      await page.waitForFunction(
        () => {
          const val =
            document.documentElement.getAttribute("data-web2figma-cs");
          console.log(`PAGE LOG: data-web2figma-cs = ${val}`);
          return val === "ready";
        },
        { timeout: 30000, polling: 1000 },
      );
      console.log("✅ Content script is ready!");
    } catch (e) {
      console.error("❌ Content script did not become ready within 30s");
      console.error("   This means the extension did not inject properly.");
      console.error(
        "   Check that WEB2FIGMA_AUTOMATION=1 was set during build.",
      );
      await browser.close();
      process.exit(1);
    }

    // Inject the trigger message with multi-viewport support
    const viewports = [
      { name: "Desktop", width: 1440, height: 900, deviceScaleFactor: 1 },
      { name: "Tablet", width: 768, height: 1024, deviceScaleFactor: 2 },
      { name: "Mobile", width: 375, height: 812, deviceScaleFactor: 2 },
    ];

    console.log(
      `📸 Triggering sequential multi-viewport capture (${viewports.length} viewports)...`,
    );

    await page.evaluate((vps) => {
      window.postMessage(
        {
          type: "START_CAPTURE_TEST",
          viewports: vps,
        },
        "*",
      );
    }, viewports);

    // Wait for completion (monitor console or specific indicator)
    // The content script sets data-capture-status="complete" on body
    console.log("⏳ Waiting for capture to complete...");

    // Check if service worker attached
    if (!serviceWorkerAttached) {
      console.warn("⚠️  WARNING: Service worker never attached!");
      console.warn("   The extension background script may not be running.");
      console.warn("   Check chrome://extensions in the DevTools window.");
    }

    try {
      await page.waitForFunction(
        () => document.body.getAttribute("data-capture-status") === "complete",
        { timeout: 180000, polling: 1000 }, // 180 seconds for larger pages
      );
      console.log("✅ Capture marked complete by extension!");
    } catch (e) {
      console.error(
        '❌ Capture timed out waiting for data-capture-status="complete"',
      );

      // Dump diagnostics
      console.error("\n📋 CAPTURE TIMEOUT DIAGNOSTICS:");
      console.error("   Last 15 background logs:");
      if (bgLogs.length > 0) {
        bgLogs.slice(-15).forEach((log) => {
          console.error(`     [${log.type}] ${log.text}`);
        });
      } else {
        console.error(
          "     (No background logs captured - service worker may not be running)",
        );
      }

      console.error("\n   Last 15 page logs:");
      if (pageLogs.length > 0) {
        pageLogs.slice(-15).forEach((log) => {
          console.error(`     [${log.type}] ${log.text}`);
        });
      } else {
        console.error("     (No page logs captured)");
      }

      // Dump body attributes for debug
      try {
        const attributes = await page.evaluate(() => {
          return Array.from(document.body.attributes).map(
            (a) => `${a.name}=${a.value}`,
          );
        });
        console.error("\n   Body attributes:", attributes);
      } catch (evalError) {
        console.error(
          "\n   Could not read body attributes (frame may be detached)",
        );
      }

      throw e;
    }

    // Verify job exists on server (CRITICAL - do not skip this!)
    console.log("⏳ Verifying job exists on server...");

    const VERIFICATION_TIMEOUT_MS = 30000; // 30 seconds
    const POLL_INTERVAL_MS = 1000; // 1 second
    const captureStartTime = Date.now();

    let jobVerified = false;
    let verifiedJobId = null;
    let attempts = 0;

    while (
      !jobVerified &&
      Date.now() - captureStartTime < VERIFICATION_TIMEOUT_MS
    ) {
      attempts++;
      try {
        const response = await fetch(`${SERVER_BASE}/api/jobs/recent?limit=5`);

        if (!response.ok) {
          console.warn(
            `⚠️ Server returned ${response.status} ${response.statusText}`,
          );
          await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
          continue;
        }

        const data = await response.json();

        // Look for a job queued in the last 60 seconds
        const recentJob = data.jobs.find(
          (job) => job.queuedAt && Date.now() - job.queuedAt < 60000,
        );

        if (recentJob) {
          jobVerified = true;
          verifiedJobId = recentJob.id;
          console.log(`✅ Job verified on server!`);
          console.log(`   Job ID: ${verifiedJobId}`);
          console.log(
            `   Queued at: ${new Date(recentJob.queuedAt).toISOString()}`,
          );
          console.log(`   Status: ${recentJob.status}`);
          console.log(
            `   Payload size: ${(recentJob.payloadSize / 1024).toFixed(1)} KB`,
          );
          console.log(
            `   Artifact path: artifacts/handoff/debug/${verifiedJobId}/`,
          );
          break;
        }

        console.log(`⏳ Attempt ${attempts}: No recent job found, retrying...`);
      } catch (err) {
        console.warn(
          `⚠️ Verification attempt ${attempts} failed:`,
          err.message,
        );
      }

      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }

    if (!jobVerified) {
      console.error(
        "❌ VERIFICATION FAILED: Job not found on server after timeout!",
      );
      console.error("\n📋 DIAGNOSTICS:");
      console.error(`   Server: ${SERVER_BASE}`);
      console.error(`   Timeout: ${VERIFICATION_TIMEOUT_MS}ms`);
      console.error(`   Attempts: ${attempts}`);
      console.error("\n   Last 50 background logs:");
      bgLogs.slice(-50).forEach((log) => {
        console.error(`     [${log.type}] ${log.text}`);
      });
      console.error("\n   Troubleshooting:");
      console.error("   1. Check that handoff-server is running on port 4411");
      console.error(
        "   2. Review background service worker logs above for errors",
      );
      console.error("   3. Check server logs for job receipt confirmation");

      await browser.close();
      process.exit(1);
    }

    await browser.close();
    console.log("👋 Browser closed.");
    console.log(`\n🎉 SUCCESS: Capture verified end-to-end!`);
  } catch (err) {
    console.error("💥 Fatal error:", err);
    process.exit(1);
  }
})();
