#!/bin/bash

# Quick automated test wrapper
# Usage: ./tools/automation/quick-test.sh [test-page]

set -e

TEST_PAGE="${1:-test/fidelity-pages/simple-layout.html}"

echo "🚀 Quick Fidelity Test"
echo "======================"
echo ""
echo "Test page: $TEST_PAGE"
echo ""

# Check if handoff server is running
if ! curl -s http://localhost:4411/health > /dev/null 2>&1; then
  echo "⚠️  Handoff server not running!"
  echo "   Starting it now..."
  node handoff-server.cjs &
  HANDOFF_PID=$!
  sleep 2
  echo "✅ Handoff server started (PID: $HANDOFF_PID)"
else
  echo "✅ Handoff server already running"
fi

# Check if extension is built
if [ ! -f "chrome-extension/dist/manifest.json" ]; then
  echo "⚠️  Extension not built!"
  echo "   Building now..."
  cd chrome-extension && npm run build && cd ..
  echo "✅ Extension built"
else
  echo "✅ Extension already built"
fi

# Run automated capture
echo ""
echo "🔧 Running automated capture..."
echo ""

node tools/automation/auto-capture-test.js "$TEST_PAGE"

echo ""
echo "✅ Test complete!"
