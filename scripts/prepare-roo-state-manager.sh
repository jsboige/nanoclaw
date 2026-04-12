#!/bin/bash
# Prepare roo-state-manager for NanoClaw container integration
#
# This script:
# 1. Copies build/ + mcp-wrapper.cjs + package.json from a local roo-state-manager checkout
# 2. Builds Linux-compatible node_modules via Docker (sqlite3 native binding)
# 3. Result: deploy/roo-state-manager/ ready to be mounted into NanoClaw containers
#
# Usage:
#   ROO_STATE_MANAGER_SRC=/path/to/roo-state-manager ./scripts/prepare-roo-state-manager.sh
#
# Or with default path:
#   ./scripts/prepare-roo-state-manager.sh

set -e

DEFAULT_SRC="D:/roo-extensions/mcps/internal/servers/roo-state-manager"
SRC_DIR="${ROO_STATE_MANAGER_SRC:-$DEFAULT_SRC}"
DEST_DIR="$(cd "$(dirname "$0")/.." && pwd)/deploy/roo-state-manager"

if [ ! -d "$SRC_DIR" ]; then
  echo "ERROR: roo-state-manager source not found at: $SRC_DIR"
  echo "Set ROO_STATE_MANAGER_SRC to the path of your roo-state-manager checkout"
  exit 1
fi

if [ ! -f "$SRC_DIR/build/index.js" ]; then
  echo "ERROR: roo-state-manager not built. Run 'npm run build' in $SRC_DIR first"
  exit 1
fi

echo "→ Copying files from $SRC_DIR"
rm -rf "$DEST_DIR"
mkdir -p "$DEST_DIR"
cp -r "$SRC_DIR/build" "$DEST_DIR/"
cp "$SRC_DIR/mcp-wrapper.cjs" "$DEST_DIR/"
cp "$SRC_DIR/package.json" "$DEST_DIR/"
[ -f "$SRC_DIR/package-lock.json" ] && cp "$SRC_DIR/package-lock.json" "$DEST_DIR/"

# Stub .env to prevent dotenv errors (real values are injected via container env vars)
cat > "$DEST_DIR/.env" <<'EOF'
# Stub .env — real values are injected via container env vars by NanoClaw
# This file prevents dotenv.config() errors in the server
EOF

echo "→ Building Linux node_modules via Docker (this may take a minute)..."
MSYS_NO_PATHCONV=1 docker run --rm \
  -v "$DEST_DIR:/build" \
  -w /build \
  node:22-slim \
  sh -c "npm install --omit=dev 2>&1 | tail -3"

echo "→ Done. Contents:"
du -sh "$DEST_DIR"
ls "$DEST_DIR"

echo ""
echo "✓ roo-state-manager prepared at: $DEST_DIR"
echo "  NanoClaw will automatically mount this into agent containers."
