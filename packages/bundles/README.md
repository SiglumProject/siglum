# TeX Bundles

Pre-bundled TeX Live 2025 packages for lazy loading in the browser.

## Download

Bundle data files are not checked into git. Download from CDN:

```bash
curl -LO https://cdn.siglum.org/tl2025/siglum-bundles-v0.1.0.tar.gz
tar -xzf siglum-bundles-v0.1.0.tar.gz -C packages/
```

Or from [GitHub Releases](https://github.com/SiglumProject/siglum-engine/releases).

## Files

### Bundle Data (downloaded)
- `*.data.gz` — Gzipped bundle data containing concatenated file contents

### Index Files (in git)
- `bundles.json` — Bundle registry with metadata (sizes, file counts, hashes)
- `file-manifest.json` — Maps file paths → bundle name + byte offset
- `file-to-package.json` — Maps filenames (e.g., `geometry.sty`) → CTAN package names
- `package-deps.json` — Package dependency graph extracted from .sty files

## Building from Source

See **[docs/building.md](../../docs/building.md)** for complete build instructions.

Quick reference — bundles are generated using scripts in the parent `packages/` directory:

```bash
cd packages
bun run split-bundle.ts           # Split texlive-basic into bundles
bun run update-bundles-tl2025.ts  # Update bundles from TeX Live archives
```

The `file-to-package.json` index maps filenames to CTAN packages:

```bash
curl -o /tmp/tlpdb.txt https://mirrors.ctan.org/systems/texlive/tlnet/tlpkg/texlive.tlpdb
node scripts/build-file-index.js packages/bundles/file-to-package.json
```

## Path Convention

All file paths start with `/texlive/` to match the TeX Live directory structure used by BusyTeX.

Example: `/texlive/texmf-dist/tex/latex/geometry/geometry.sty`
