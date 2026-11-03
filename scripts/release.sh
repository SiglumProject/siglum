#!/usr/bin/env bash
# Publish the reviewed engine package and its immutable runtime. Nothing is
# uploaded in DRY_RUN=1; local staging and checksum verification still run.
set -euo pipefail
cd "$(dirname "$0")/.."
RAW_VERSION="${1:-}"
VERSION="${RAW_VERSION#v}"
if [ -z "$VERSION" ]; then echo 'Usage: DRY_RUN=1 scripts/release.sh <version>' >&2; exit 2; fi
PACKAGE_VERSION="$(node -p "require('./package.json').version")"
if [ "$VERSION" != "$PACKAGE_VERSION" ]; then echo 'Version must match package.json' >&2; exit 1; fi
TAG="v$VERSION"
RELEASE_COMMIT="$(git rev-parse HEAD)"
if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then echo "Tag already exists: $TAG" >&2; exit 1; fi
if [ -n "$(git status --porcelain)" ] && [ "${DRY_RUN:-0}" != 1 ]; then echo 'Commit the reviewed release changes first.' >&2; exit 1; fi
# Reuse the reviewed manifest when the assets are already deployed. Re-staging
# here could omit generated files removed from the working tree since upload.
if [ "${SKIP_R2:-0}" != 1 ]; then node scripts/stage-runtime.mjs; fi
RUNTIME_DIR="$(node -p "require('./.local-release/current.json').directory")"
RUNTIME_ID="$(node -p "require('./.local-release/current.json').releaseId")"
node scripts/verify-runtime.mjs "$RUNTIME_DIR"
run() { if [ "${DRY_RUN:-0}" = 1 ]; then echo "DRY: $*"; else "$@"; fi; }
if [ "${SKIP_R2:-0}" != 1 ]; then
  # runtime.json is uploaded last; the UI must only be deployed after remote verification.
  while IFS=$'\t' read -r asset content_type; do
    run bunx wrangler r2 object put "siglum-bundles/releases/$RUNTIME_ID/$asset" --remote --file="$RUNTIME_DIR/$asset" --content-type="$content_type"
  done < <(node --input-type=module - "$RUNTIME_DIR" <<'JS'
import {readFileSync} from 'node:fs';
const manifest=JSON.parse(readFileSync(process.argv[2]+'/runtime.json','utf8'));
for(const name of [...Object.keys(manifest.files),'runtime.json']) {
 const type=name.endsWith('.wasm')?'application/wasm':name.endsWith('.js')?'application/javascript':name.endsWith('.json')?'application/json':name.endsWith('.gz')?'application/gzip':'application/octet-stream';
 console.log(name+'\t'+type);
}
JS
)
fi
TARBALL=".local-release/siglum-runtime-$TAG.tar.gz"
run tar -czf "$TARBALL" -C "$RUNTIME_DIR" .
run gh release create "$TAG" "$TARBALL" --target "$RELEASE_COMMIT" --title "$TAG" --generate-notes
printf 'Runtime: %s\nBefore deploying the UI, verify this runtime at the deployed API URL and set VITE_ENGINE_RELEASE=%s.\n' "$RUNTIME_ID" "$RUNTIME_ID"
