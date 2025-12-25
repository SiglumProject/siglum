#!/bin/bash
# Upload bundles and WASM to Cloudflare R2
# Requires: wrangler CLI authenticated (wrangler login)
#
# Usage:
#   ./upload-to-r2.sh                           # Uses default siglum-engine path
#   ./upload-to-r2.sh /path/to/siglum-engine   # Custom path
#
# After uploading config files (*.json), remember to:
# 1. Bump CACHE_VERSION in src/index.ts
# 2. Run: wrangler deploy

set -e

BUCKET_NAME="siglum-bundles"

# Default to siglum-engine in parent directory structure
ENGINE_DIR="${1:-$HOME/code/siglum-engine}"

if [ ! -d "$ENGINE_DIR/packages/bundles" ]; then
    echo "Error: Cannot find bundles at $ENGINE_DIR/packages/bundles"
    echo "Usage: ./upload-to-r2.sh /path/to/siglum-engine"
    exit 1
fi

# Use full path to bunx if available
if [ -x "$HOME/.bun/bin/bunx" ]; then
    WRANGLER="$HOME/.bun/bin/bunx wrangler"
elif command -v bunx &> /dev/null; then
    WRANGLER="bunx wrangler"
else
    WRANGLER="npx wrangler"
fi

echo "Uploading from: $ENGINE_DIR"
echo ""

# Upload bundle data files (large, change rarely)
echo "Uploading bundle data files..."
for file in "$ENGINE_DIR"/packages/bundles/*.data.gz; do
    if [ -f "$file" ]; then
        filename=$(basename "$file")
        echo "  $filename"
        $WRANGLER r2 object put "$BUCKET_NAME/$filename" --file="$file" --content-type="application/gzip"
    fi
done

# Upload bundle metadata files
echo "Uploading bundle metadata..."
for file in "$ENGINE_DIR"/packages/bundles/*.meta.json; do
    if [ -f "$file" ]; then
        filename=$(basename "$file")
        echo "  $filename"
        $WRANGLER r2 object put "$BUCKET_NAME/$filename" --file="$file" --content-type="application/json"
    fi
done

# Upload registry and manifest files
echo "Uploading config files..."
for file in "$ENGINE_DIR"/packages/bundles/*.json; do
    if [ -f "$file" ]; then
        filename=$(basename "$file")
        # Skip meta.json files (already uploaded above)
        if [[ ! "$filename" == *.meta.json ]]; then
            echo "  $filename"
            $WRANGLER r2 object put "$BUCKET_NAME/$filename" --file="$file" --content-type="application/json"
        fi
    fi
done

# Upload WASM files
echo "Uploading WASM files..."
if [ -f "$ENGINE_DIR/busytex.wasm" ]; then
    echo "  busytex.wasm"
    $WRANGLER r2 object put "$BUCKET_NAME/wasm/busytex.wasm" --file="$ENGINE_DIR/busytex.wasm" --content-type="application/wasm"
fi
if [ -f "$ENGINE_DIR/busytex.js" ]; then
    echo "  busytex.js"
    $WRANGLER r2 object put "$BUCKET_NAME/wasm/busytex.js" --file="$ENGINE_DIR/busytex.js" --content-type="application/javascript"
fi

echo ""
echo "Done! If you updated config files:"
echo "  1. Bump CACHE_VERSION in src/index.ts"
echo "  2. Run: wrangler deploy"
