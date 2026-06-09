#!/bin/bash
# Double-click to preview the FSDO Notification Generator locally.
# Serves this folder over http://localhost so the app can fetch fsdo_offices.json
# (browsers block fetch() on file:// URLs).

cd "$(dirname "$0")" || exit 1

PORT=8765
URL="http://localhost:${PORT}/index.html"

echo "──────────────────────────────────────────────"
echo "  FSDO Notification Generator — local preview"
echo "  Serving: $(pwd)"
echo "  URL:     ${URL}"
echo "  (Press Ctrl-C in this window to stop.)"
echo "──────────────────────────────────────────────"

# Open the browser a moment after the server starts.
( sleep 1; open "${URL}" ) &

# Python 3 ships with macOS; -u keeps logs unbuffered.
exec python3 -u -m http.server "${PORT}"
