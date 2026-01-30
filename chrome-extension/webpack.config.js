const path = require("path");
const CopyPlugin = require("copy-webpack-plugin");

// Check if automation mode is enabled via environment variable
const isAutomationBuild = process.env.WEB2FIGMA_AUTOMATION === "1";
const manifestSource = isAutomationBuild
  ? "manifest.automation.json"
  : "manifest.json";

if (isAutomationBuild) {
  console.log(
    "🤖 Building in AUTOMATION mode - content scripts will auto-inject",
  );
} else {
  console.log(
    "📦 Building in NORMAL mode - content scripts require manual injection",
  );
}

module.exports = {
  mode: "production",
  // CRITICAL: Disable eval-based devtools to comply with Chrome extension CSP
  // Service workers cannot use eval() - must use 'source-map' or false
  devtool: false,
  entry: {
    background: "./src/background.ts",
    "content-script": "./src/content-script.ts",
    "injected-script": "./src/injected-script.ts",
    "popup/popup": "./src/popup/popup.ts",
  },
  output: {
    path: path.resolve(__dirname, "dist"),
    filename: "[name].js",
  },
  resolve: {
    extensions: [".ts", ".js"],
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        use: "ts-loader",
        exclude: /node_modules/,
      },
    ],
  },
  plugins: [
    new CopyPlugin({
      patterns: [
        { from: manifestSource, to: "manifest.json" },
        { from: "icons", to: "icons" },
        { from: "src/popup/popup.html", to: "popup/popup.html" },
        { from: "src/popup/popup.css", to: "popup/popup.css" },
        { from: "src/popup/stars.css", to: "popup/stars.css" },
        { from: "src/popup/three.min.js", to: "popup/three.min.js" },
        { from: "src/popup/icons", to: "popup/icons" },
      ],
    }),
  ],
};
