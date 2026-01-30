const puppeteer = require("puppeteer");
const fs = require("fs");
const path = require("path");

const LOG_FILE = path.join(__dirname, "../figma-debug.log");

// Clear previous log
fs.writeFileSync(LOG_FILE, "");
console.log(`🔌 Figma Debug Bridge starting...`);
console.log(`📂 Logging to: ${LOG_FILE}`);

(async () => {
  try {
    // Connect to the running Figma instance
    const browser = await puppeteer.connect({
      browserURL: "http://127.0.0.1:9222",
      defaultViewport: null,
    });

    console.log(`✅ Connected to Figma!`);

    // Monitor for new targets dynamically (in case Plugin spins up late)
    browser.on("targetcreated", async (target) => {
      await attachToTarget(target);
    });

    const targets = await browser.targets();
    console.log(`🎯 Found ${targets.length} initial targets.`);

    for (const target of targets) {
      await attachToTarget(target);
    }

    console.log(`Listenning for logs on all targets...`);
    console.log(`(Press Ctrl+C to stop)`);
  } catch (err) {
    console.error(`❌ Failed to connect: ${err.message}`);
    process.exit(1);
  }
})();

async function attachToTarget(target) {
  const url = target.url();
  const type = target.type();

  // Ignore browser internals to reduce noise
  if (url.startsWith("devtools://")) return;

  try {
    const client = await target.createCDPSession();
    await setupLogging(client, `[${type}] ${documentName(url)}`);
  } catch (e) {
    // Ignore attach errors
  }
}

async function setupLogging(client, label) {
  try {
    await client.send("Log.enable");
    await client.send("Runtime.enable");

    client.on("Log.entryAdded", ({ entry }) => {
      log(label, entry.level, entry.text);
    });

    client.on("Runtime.consoleAPICalled", ({ type, args, stackTrace }) => {
      const text = args.map((a) => formatRemoteObject(a)).join(" ");
      log(label, type, text);
    });
  } catch (e) {
    // detach
  }
}

function formatRemoteObject(obj) {
  if (obj.type === "string") return obj.value;
  if (obj.type === "number") return obj.value;
  if (obj.type === "boolean") return obj.value;
  if (obj.type === "undefined") return "undefined";
  if (obj.subtype === "null") return "null";
  if (obj.className) return `[${obj.className}]`;
  if (obj.description) return obj.description;
  return `[${obj.type}]`;
}

function documentName(url) {
  if (!url) return "Unknown";
  if (url.startsWith("file://")) return path.basename(url);
  if (url.length > 40) return url.substring(0, 37) + "...";
  return url;
}

function log(target, level, message) {
  // Filter noise
  if (message.includes("Download the React DevTools")) return;
  if (message.includes("[HMR]")) return;

  const timestamp = new Date().toISOString().split("T")[1].slice(0, -1);
  const logLine = `${timestamp} ${target} [${level.toUpperCase()}]: ${message}\n`;

  process.stdout.write(logLine);
  fs.appendFileSync(LOG_FILE, logLine);
}
