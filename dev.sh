#!/bin/bash
# ============================================
# figmafi - Unified Start Script
# ============================================
# This script starts all services in WATCH mode.
#   1. Handoff Server: Restarts on change (Node --watch)
#   2. Chrome Extension: Rebuilds on change (Webpack --watch)
#   3. Figma Plugin: Rebuilds on change (Esbuild --watch)
# ============================================

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

echo -e "${BLUE}╔════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║          figmafi - Starting Services       ║   ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════════╝${NC}"
echo -e "${CYAN}Auto-rebuild and auto-restart enabled${NC}"
echo ""

# Function to cleanup on exit
cleanup() {
  echo ""
  echo -e "${YELLOW}🛑 Shutting down all watchers...${NC}"
  # Kill all background processes started by this script
  trap - SIGINT SIGTERM # Prevent recursive calls
  kill $(jobs -p) 2>/dev/null || true
  exit 0
}
trap cleanup SIGINT SIGTERM

# Function to check if a command exists
command_exists() {
  command -v "$1" >/dev/null 2>&1
}

# ============================================
# Kill existing processes before starting
# ============================================
echo -e "${YELLOW}🔍 Cleaning up existing processes...${NC}"

# 1. Kill handoff server by process name
if pkill -f "handoff-server\\.cjs" 2>/dev/null; then
  echo -e "${YELLOW}♻️  Killed existing handoff server process${NC}"
  sleep 1
fi

# 2. Kill process using port 4411 (handoff server)
if command_exists lsof; then
  PORT_PIDS=$(lsof -ti:4411 2>/dev/null || true)
  if [ -n "$PORT_PIDS" ]; then
    echo -e "${YELLOW}♻️  Killing process(es) using port 4411: $PORT_PIDS${NC}"
    echo "$PORT_PIDS" | xargs kill -9 2>/dev/null || true
    sleep 1
  fi
fi

# 3. Kill existing webpack watchers (extension)
if pkill -f "webpack.*watch" 2>/dev/null || pkill -f "npm run watch" 2>/dev/null; then
  echo -e "${YELLOW}♻️  Killed existing webpack watchers${NC}"
  sleep 0.5
fi

# 4. Kill existing esbuild watchers (plugin)
if pkill -f "esbuild.*watch" 2>/dev/null; then
  echo -e "${YELLOW}♻️  Killed existing esbuild watchers${NC}"
  sleep 0.5
fi

# 5. Verify port 4411 is free
if command_exists lsof; then
  if lsof -ti:4411 >/dev/null 2>&1; then
    echo -e "${RED}⚠️  Port 4411 is still in use after cleanup${NC}"
    echo -e "${YELLOW}   Manual cleanup: lsof -ti:4411 | xargs kill -9${NC}"
    exit 1
  else
    echo -e "${GREEN}✅ Port 4411 is free${NC}"
  fi
else
  echo -e "${YELLOW}⚠️  lsof not available, skipping port verification${NC}"
fi

echo ""

# ============================================
# Start watchers and server
# ============================================

# 1. Start Chrome Extension Watcher
echo -e "${YELLOW}🔨 Starting Chrome Extension watcher...${NC}"
cd chrome-extension
npm run watch > ../extension-watch.log 2>&1 &
cd ..

# 2. Start Figma Plugin Watcher
echo -e "${YELLOW}🔨 Starting Figma Plugin watcher...${NC}"
cd figma-plugin
npm run watch > ../plugin-watch.log 2>&1 &
cd ..

# 3. Start Handoff Server with Auto-Restart
echo -e "${YELLOW}🚀 Starting Handoff Server with --watch...${NC}"
# Note: --watch is available in Node.js 18.11.0+
node --watch handoff-server.cjs &

echo ""
echo -e "${GREEN}✨ All services are running in watch mode.${NC}"
echo -e "${CYAN}Extension logs: tail -f extension-watch.log${NC}"
echo -e "${CYAN}Plugin logs:    tail -f plugin-watch.log${NC}"
echo -e "${BLUE}Press Ctrl+C to stop everything.${NC}"
echo ""

# Keep script alive and wait for background jobs
wait
