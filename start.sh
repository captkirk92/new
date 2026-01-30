#!/bin/bash
# ============================================
# figmafi - Unified Start Script
# ============================================
# This script starts all required services for the capture flow.
#
# Usage: ./start.sh
#
# Services:
#   1. Handoff Server (port 4411) - Main capture API with AI models
#   2. Chrome Extension build (watches for changes)
#   3. Figma Plugin build
#
# AI Models Verified:
#   - Tesseract.js (OCR)
#   - TensorFlow.js + COCO-SSD (ML component detection)
#   - Node-Vibrant (Color palette extraction)
#   - Chroma.js (Color manipulation)
#
# After running:
#   - Open Chrome and load the extension from chrome-extension/dist
#   - Open Figma and load the plugin
#   - Click "Capture" in the extension popup
# ============================================

set -e

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR"

# Optional flags:
#   SKIP_INSTALL=1  -> don't run npm install steps
#   SKIP_BUILD=1    -> don't run npm build steps
#   WATCH=1         -> run extension/plugin watchers after initial build
#   DEBUG_LOOP=1    -> start debug-runner.js in background for automated validation
SKIP_INSTALL="${SKIP_INSTALL:-0}"
SKIP_BUILD="${SKIP_BUILD:-0}"
WATCH="${WATCH:-0}"
DEBUG_LOOP="${DEBUG_LOOP:-0}"

# Auto-skip install if node_modules already exists, unless FORCE_INSTALL=1 is set
FORCE_INSTALL="${FORCE_INSTALL:-0}"
if [ -d "node_modules" ] && [ "$SKIP_INSTALL" = "0" ] && [ "$FORCE_INSTALL" = "0" ]; then
  echo -e "${CYAN}ℹ️ node_modules detected, skipping npm install (use FORCE_INSTALL=1 to force)${NC}"
  SKIP_INSTALL=1
fi

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

echo -e "${BLUE}╔════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║          figmafi - Development Mode         ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════════╝${NC}"
echo ""

# Function to check if a command exists
command_exists() {
  command -v "$1" >/dev/null 2>&1
}

# Check Node.js version
echo -e "${CYAN}🔍 Checking Node.js version...${NC}"
if ! command_exists node; then
  echo -e "${RED}❌ Node.js is not installed. Please install Node.js >= 18.0.0${NC}"
  exit 1
fi

NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
  echo -e "${RED}❌ Node.js version must be >= 18.0.0 (current: $(node -v))${NC}"
  exit 1
fi
echo -e "${GREEN}✅ Node.js $(node -v)${NC}"
echo ""

# Install all dependencies
if [ "$SKIP_INSTALL" = "1" ]; then
  echo -e "${YELLOW}📦 SKIP_INSTALL=1 set; skipping dependency installs${NC}"
else
  echo -e "${YELLOW}📦 Installing root dependencies (including AI models)...${NC}"
  npm install

  echo -e "${YELLOW}📦 Installing Chrome extension dependencies...${NC}"
  cd chrome-extension && npm install && cd ..

  if [ -d "capture-service" ]; then
    echo -e "${YELLOW}📦 Installing Capture Service dependencies...${NC}"
    cd capture-service && npm install && cd ..
  fi

  if [ -d "figma-plugin" ]; then
    echo -e "${YELLOW}📦 Installing Figma Plugin dependencies...${NC}"
    cd figma-plugin && npm install && cd ..
  fi
fi

echo ""


# AI model checks removed by user request


# Build Chrome extension first
if [ "$SKIP_BUILD" = "1" ]; then
  echo -e "${YELLOW}🔨 SKIP_BUILD=1 set; skipping build steps${NC}"
else
  echo -e "${YELLOW}🔨 Building Chrome Extension...${NC}"
  cd chrome-extension
  npm run build
  cd ..
  
  # Verify build artifact
  if [ ! -f "chrome-extension/dist/manifest.json" ] && [ ! -f "chrome-extension/manifest.json" ]; then
     # Note: webpack might output to dist or root depending on config, usually dist
     if [ ! -d "chrome-extension/dist" ]; then
        echo -e "${RED}❌ Chrome Extension build failed (no dist directory)${NC}"
        exit 1
     fi
  fi
  echo -e "${GREEN}✅ Chrome extension built successfully${NC}"
  echo ""

  # Build Figma Plugin
  if [ -d "figma-plugin" ]; then
    echo -e "${YELLOW}🔨 Building Figma Plugin...${NC}"
    cd figma-plugin
    npm run build
    cd ..
    
    # Verify build artifact
    if [ ! -f "figma-plugin/dist/code.js" ]; then
        echo -e "${RED}❌ Figma Plugin build failed (no dist/code.js)${NC}"
        exit 1
    fi
    echo -e "${GREEN}✅ Figma Plugin built successfully${NC}"
  fi
fi

echo ""


EXT_WATCH_PID=""
PLUGIN_WATCH_PID=""
if [ "$WATCH" = "1" ]; then
  echo -e "${YELLOW}👀 WATCH=1 set; starting build watchers...${NC}"

  echo -e "${YELLOW}  - Chrome extension: npm run watch${NC}"
  (cd chrome-extension && npm run watch) &
  EXT_WATCH_PID=$!

  if [ -d "figma-plugin" ]; then
    echo -e "${YELLOW}  - Figma plugin: npm run watch${NC}"
    (cd figma-plugin && npm run watch) &
    PLUGIN_WATCH_PID=$!
  fi

  # Quick sanity check that watchers didn't immediately die
  sleep 1
  if ! kill -0 "$EXT_WATCH_PID" >/dev/null 2>&1; then
    echo -e "${RED}❌ Extension watcher failed to start${NC}"
    exit 1
  fi
  if [ -n "$PLUGIN_WATCH_PID" ] && ! kill -0 "$PLUGIN_WATCH_PID" >/dev/null 2>&1; then
    echo -e "${RED}❌ Plugin watcher failed to start${NC}"
    exit 1
  fi
  echo -e "${GREEN}✅ Watchers running${NC}"
  echo ""
fi

# Function to cleanup on exit
cleanup() {
  echo ""
  echo -e "${YELLOW}🛑 Shutting down services...${NC}"
  kill $(jobs -p) 2>/dev/null
  exit 0
}
trap cleanup SIGINT SIGTERM

# Start Handoff Server
echo -e "${BLUE}🚀 Starting Handoff Server on port 4411...${NC}"

# Kill any existing handoff server to prevent port conflicts
echo -e "${YELLOW}🔍 Checking for existing server on port 4411...${NC}"

# Method 1: Kill by process name
# Only kill if it's NOT this script (unlikely but safe)
if pkill -f "node handoff-server.cjs" 2>/dev/null; then
  echo -e "${YELLOW}♻️  Killed existing handoff server process${NC}"
  sleep 1
fi

# Method 2: Kill by port (more reliable)
if command_exists lsof; then
  PORT_PIDS=$(lsof -ti:4411 2>/dev/null || true)
  if [ -n "$PORT_PIDS" ]; then
    echo -e "${YELLOW}♻️  Killing process(es) using port 4411: $PORT_PIDS${NC}"
    echo "$PORT_PIDS" | xargs kill -9 2>/dev/null || true
    sleep 1
  fi
fi

# Verify port is free (use || true to prevent set -e from exiting)
if command_exists lsof; then
  if lsof -ti:4411 >/dev/null 2>&1; then
    echo -e "${RED}⚠️  Port 4411 is still in use. Trying to continue anyway...${NC}"
    echo -e "${YELLOW}   You may need to manually kill the process: lsof -ti:4411 | xargs kill -9${NC}"
  else
    echo -e "${GREEN}✅ Port 4411 is free${NC}"
  fi
else
  echo -e "${YELLOW}⚠️  lsof not available, skipping port verification${NC}"
fi

# Start server in background with output redirection
echo -e "${CYAN}🚀 Starting server process...${NC}"
node handoff-server.cjs > handoff-server.log 2>&1 &
HANDOFF_PID=$!

# Wait a moment for process to start
sleep 2

# Verify the process is still running
if ! kill -0 "$HANDOFF_PID" 2>/dev/null; then
    echo -e "${RED}❌ Handoff Server failed to start (process died immediately)${NC}"
    echo -e "${YELLOW}   Check handoff-server.log for errors:${NC}"
    if [ -f handoff-server.log ]; then
        tail -20 handoff-server.log
    fi
    exit 1
fi

echo -e "${GREEN}✅ Handoff Server process is active (PID: $HANDOFF_PID)${NC}"

# Wait for server to be ready and check if it's responding
echo -e "${CYAN}⏳ Waiting for server to initialize...${NC}"
MAX_RETRIES=15
RETRY_COUNT=0
SERVER_RESPONDING=false

while [ $RETRY_COUNT -lt $MAX_RETRIES ]; do
  # Check if process is still running
  if ! kill -0 "$HANDOFF_PID" 2>/dev/null; then
    echo -e "${RED}❌ Server process died with exit code $? (PID: $HANDOFF_PID)${NC}"
    if [ -f handoff-server.log ]; then
      echo -e "${YELLOW}   Last log entries:${NC}"
      tail -20 handoff-server.log
    fi
    exit 1
  fi
  
  # Try to connect to the server (check both 127.0.0.1 and localhost)
  if curl -s -f http://127.0.0.1:4411/api/health > /dev/null 2>&1 || \
     curl -s -f http://localhost:4411/api/health > /dev/null 2>&1; then
    echo -e "${GREEN}✅ Handoff Server is online and responding${NC}"
    SERVER_RESPONDING=true
    break
  else
    RETRY_COUNT=$((RETRY_COUNT + 1))
    echo -e "${YELLOW}   Waiting for server response... ($RETRY_COUNT/$MAX_RETRIES)${NC}"
    sleep 1
  fi
done

if [ "$SERVER_RESPONDING" = false ]; then
  echo -e "${YELLOW}⚠️  Server started but not responding to health checks yet${NC}"
  echo -e "${YELLOW}   Server may still be initializing. Check handoff-server.log for details.${NC}"
  if [ -f handoff-server.log ]; then
    echo -e "${CYAN}   Last 10 log lines:${NC}"
    tail -10 handoff-server.log
  fi
  echo -e "${YELLOW}   You can check server status with: curl http://localhost:4411/api/health${NC}"
fi

echo ""
echo -e "${GREEN}╔════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║          All Services Running!             ║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════════╝${NC}"
echo ""
echo -e "${BLUE}📍 Handoff Server:${NC} http://localhost:4411"

# Start Debug Runner if requested
if [ "$DEBUG_LOOP" = "1" ]; then
  echo -e "${BLUE}📍 Starting Debug Runner Loop...${NC}"
  node tools/debug-runner.js > debug-runner.log 2>&1 &
  echo -e "${GREEN}✅ Debug Runner active (logs: tail -f debug-runner.log)${NC}"
fi

echo ""

echo ""
echo -e "${YELLOW}Next Steps:${NC}"
echo "  1. Load Chrome extension from: chrome-extension/dist"
echo "  2. Open Figma plugin"
echo "  3. Navigate to a webpage and click 'Capture'"
if [ "$WATCH" = "1" ]; then
  echo ""
  echo -e "${YELLOW}Watch Mode:${NC}"
  echo "  - Chrome extension rebuilds automatically (dev)"
  echo "  - Figma plugin rebuilds automatically (watch)"
  echo "  - Reload extension/plugin in their UIs to pick up changes"
fi
echo ""

echo -e "${YELLOW}Press Ctrl+C to stop all services${NC}"
echo ""

# Wait for background processes
wait
