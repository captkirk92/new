const puppeteer = require("puppeteer");
const path = require("path");
const fs = require("fs");

const EXTENSION_PATH = path.resolve(__dirname, "../chrome-extension/dist");
const URL_TO_CAPTURE = process.argv[2] || "https://github.com/microsoft/vscode";

(async () => {
  console.log(
    `🚀 Starting headless capture (Bypass CSP) for: ${URL_TO_CAPTURE}`,
  );

  try {
    const browser = await puppeteer.launch({
      headless: false, // Use headful or "new" with a real window to ensure extension works better
      args: [
        `--disable-extensions-except=${EXTENSION_PATH}`,
        `--load-extension=${EXTENSION_PATH}`,
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-blink-features=AutomationControlled",
        "--window-size=1440,900",
        "--disable-web-security",
      ],
    });

    const page = await browser.newPage();
    await page.setBypassCSP(true); // CRITICAL to bypass GitHub CSP

    // Log ALL console messages
    page.on("console", (msg) => {
      console.log(`PAGE [${msg.type()}]: ${msg.text()}`);
    });

    page.on("error", (err) => console.error(`PAGE_ERROR: ${err.message}`));
    page.on("pageerror", (err) => console.error(`PAGE_CRASH: ${err.message}`));

    console.log("🔗 Navigating...");
    await page.goto(URL_TO_CAPTURE, {
      waitUntil: "networkidle2",
      timeout: 120000,
    });

    console.log("⏳ Waiting for content script check...");
    await new Promise((r) => setTimeout(r, 5000));

    const csReady = await page.evaluate(
      () =>
        document.documentElement.getAttribute("data-web2figma-cs") === "ready",
    );
    if (csReady) {
      console.log("✅ Content script ready.");
    } else {
      console.warn(
        "⚠️ Content script NOT ready. Attempting to force injection...",
      );
    }

    // Diagnostics
    let state = await page.evaluate(() => ({
      loaded: !!window.__FigmaCaptureLoaded__,
      listener: !!window.__FigmaCaptureMessageListener__,
    }));
    console.log(
      `💉 Injection state: Loaded=${state.loaded}, Listener=${state.listener}`,
    );

    if (!state.loaded) {
      console.log("💉 Manually injecting script since extension failed...");
      const scriptPath = path.join(EXTENSION_PATH, "injected-script.js");
      const scriptCode = fs.readFileSync(scriptPath, "utf8");

      // Use raw evaluate to inject code
      await page.evaluate((code) => {
        try {
          const script = document.createElement("script");
          script.textContent = code;
          (document.head || document.documentElement).appendChild(script);
          console.log("✅ Manually injected script code.");
        } catch (e) {
          console.error("❌ Manual injection failed:", e.message);
        }
      }, scriptCode);
    }

    // Wait and verify
    await new Promise((r) => setTimeout(r, 3000));
    state = await page.evaluate(() => ({
      loaded: !!window.__FigmaCaptureLoaded__,
      listener: !!window.__FigmaCaptureMessageListener__,
    }));
    console.log(
      `💉 Final Injection state: Loaded=${state.loaded}, Listener=${state.listener}`,
    );

    if (!state.listener) {
      console.error(
        "❌ ABORTING: Could not install capture listener. Check CSP bypass.",
      );
      await browser.close();
      process.exit(1);
    }

    console.log("📸 Triggering capture...");
    await page.evaluate(() => {
      window.postMessage({ type: "START_CAPTURE" }, "*");
    });

    console.log("⏳ Waiting for completion...");

    let startTime = Date.now();
    const monitor = setInterval(async () => {
      try {
        const res = await page.evaluate(() => ({
          status: document.documentElement.getAttribute("data-capture-status"),
          progress:
            document.documentElement.getAttribute("data-capture-progress") ||
            "0",
          nodeCount: document.querySelectorAll("*").length,
        }));

        const elapsed = Math.round((Date.now() - startTime) / 1000);
        console.log(
          `🕒 [${elapsed}s] Status: ${res.status || "RUNNING"}, Progress: ${res.progress}%, Nodes on page: ${res.nodeCount}`,
        );

        if (res.status === "complete" || res.status === "error") {
          clearInterval(monitor);
        }
      } catch (e) {}
    }, 10000);

    await page.waitForFunction(
      () => {
        const s = document.documentElement.getAttribute("data-capture-status");
        return s === "complete" || s === "error";
      },
      { timeout: 900000 },
    );

    clearInterval(monitor);

    const results = await page.evaluate(() => ({
      nodeCount: document.querySelectorAll("*").length,
      status: document.documentElement.getAttribute("data-capture-status"),
      error: document.documentElement.getAttribute("data-capture-error"),
    }));

    console.log("🏁 Results:", results);

    await browser.close();
    process.exit(results.status === "complete" ? 0 : 1);
  } catch (err) {
    console.error("❌ Fatal error:", err);
    process.exit(1);
  }
})();
