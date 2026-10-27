#!/usr/bin/env bash
# Renders public/og.png (link preview) from scripts/og.html with headless Chrome.
set -euo pipefail
PORT=5199
pnpm exec vite --port "$PORT" --strictPort >/dev/null 2>&1 &
VITE=$!
trap 'kill $VITE' EXIT
for _ in $(seq 1 40); do curl -sf "http://localhost:$PORT/scripts/og.html" >/dev/null && break; sleep 0.25; done
google-chrome --headless=new --disable-gpu --hide-scrollbars --window-size=1200,630 \
  --virtual-time-budget=10000 --screenshot=public/og.png "http://localhost:$PORT/scripts/og.html" 2>/dev/null
echo "public/og.png"
