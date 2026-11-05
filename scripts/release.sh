#!/usr/bin/env bash
# Publish the reviewed engine package or an immutable runtime. Nothing is
# uploaded in DRY_RUN=1; local staging and checksum verification still run.
set -euo pipefail
cd "$(dirname "$0")/.."
RAW_VERSION="${1:-}"
if [ "$#" != 1 ]; then echo 'Usage: DRY_RUN=1 scripts/release.sh <version|--runtime-only>' >&2; exit 2; fi
RUNTIME_ONLY=0
if [ "$RAW_VERSION" = '--runtime-only' ]; then
  RUNTIME_ONLY=1
  if [ "${SKIP_R2:-0}" = 1 ]; then echo '--runtime-only requires an R2 upload' >&2; exit 1; fi
else
  VERSION="${RAW_VERSION#v}"
  PACKAGE_VERSION="$(node -p "require('./package.json').version")"
  if [ "$VERSION" != "$PACKAGE_VERSION" ]; then echo 'Version must match package.json' >&2; exit 1; fi
  TAG="v$VERSION"
  RELEASE_COMMIT="$(git rev-parse HEAD)"
  if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then echo "Tag already exists: $TAG" >&2; exit 1; fi
fi
if [ "${DRY_RUN:-0}" != 1 ]; then
  WORKTREE_STATUS="$(git status --porcelain)"
  if [ -n "$WORKTREE_STATUS" ]; then echo 'Commit the reviewed release changes first.' >&2; exit 1; fi
fi
# Reuse the reviewed manifest when the assets are already deployed. Re-staging
# here could omit generated files removed from the working tree since upload.
if [ "$RUNTIME_ONLY" = 1 ]; then
  node scripts/stage-runtime.mjs --combined-only
elif [ "${SKIP_R2:-0}" != 1 ]; then
  node scripts/stage-runtime.mjs
fi
RUNTIME_DIR="$(node -p "require('./.local-release/current.json').directory")"
RUNTIME_ID="$(node -p "require('./.local-release/current.json').releaseId")"
node scripts/verify-runtime.mjs "$RUNTIME_DIR"
RUNTIME_VERSION="$(node -p 'require(process.argv[1]).engineVersion' "$RUNTIME_DIR/runtime.json")"
if [ "$RUNTIME_ONLY" = 1 ]; then
  TAG="v$RUNTIME_VERSION"
  # The existing tag supplies the matching SDK and the serialized promotion job.
  if [ "${DRY_RUN:-0}" != 1 ]; then
    gh api "repos/{owner}/{repo}/git/ref/tags/$TAG" > /dev/null
  fi
else
  if [ "$RUNTIME_VERSION" != "$PACKAGE_VERSION" ]; then echo 'Runtime version must match package.json' >&2; exit 1; fi
fi
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
if [ "$RUNTIME_ONLY" = 0 ]; then
  TARBALL=".local-release/siglum-runtime-$TAG.tar.gz"
  run tar -czf "$TARBALL" -C "$RUNTIME_DIR" .
  run gh release create "$TAG" "$RUNTIME_DIR/runtime.json" "$TARBALL" --target "$RELEASE_COMMIT" --title "$TAG" --generate-notes
else
  run gh workflow run release.yml --ref "$TAG" -f "runtime_manifest_url=https://packages.siglum.org/releases/$RUNTIME_ID/runtime.json"
fi
printf 'Runtime: %s\nThe release workflow verifies the hosted assets and promotes discovery metadata.\nFor the editor release build, set VITE_ENGINE_RELEASE=%s after verification.\n' "$RUNTIME_ID" "$RUNTIME_ID"
