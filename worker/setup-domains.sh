#!/bin/bash
# Set up custom domains for siglum.org subdomains
# Run this after adding siglum.org to Cloudflare

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
WRANGLER="bunx wrangler"

echo "Enabling custom domain routes in wrangler.toml..."

# Uncomment the routes in wrangler.toml
sed -i.bak '
/# \[\[routes\]\]/s/# //
/# pattern = "packages.siglum.org/s/# //
/# zone_name = "siglum.org"/s/# //
/# pattern = "ctan-proxy.siglum.org/s/# //
' "$SCRIPT_DIR/wrangler.toml"

# Clean up extra comments
sed -i.bak '/^# $/d' "$SCRIPT_DIR/wrangler.toml"
rm -f "$SCRIPT_DIR/wrangler.toml.bak"

echo "Deploying worker with custom domains..."
cd "$SCRIPT_DIR"
$WRANGLER deploy --config wrangler.toml

echo ""
echo "Creating Pages project..."
$WRANGLER pages project create siglum-engine 2>/dev/null || echo "  Project already exists"

echo ""
echo "Building and deploying Pages..."
mkdir -p "$PROJECT_DIR/dist"
cp -r "$PROJECT_DIR/src/" "$PROJECT_DIR/dist/src/"
cp "$PROJECT_DIR/demo.html" "$PROJECT_DIR/dist/index.html"
mkdir -p "$PROJECT_DIR/dist/packages/bundles"
cp "$PROJECT_DIR/packages/bundles/"*.json "$PROJECT_DIR/dist/packages/bundles/"

cd "$PROJECT_DIR"
$WRANGLER pages deploy dist --project-name=siglum-engine

echo ""
echo "Done! Domains configured:"
echo "  - packages.siglum.org → Worker (R2 bundles)"
echo "  - ctan-proxy.siglum.org → Worker (CTAN proxy)"
echo "  - busytex-lazy.siglum.org → Pages (add manually in dashboard)"
echo ""
echo "To add busytex-lazy.siglum.org to Pages:"
echo "  Dashboard → Pages → siglum-engine → Custom domains → Add"
