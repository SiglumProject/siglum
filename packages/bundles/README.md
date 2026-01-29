# TeX Bundles

This directory contains pre-bundled TeX Live packages for lazy loading in the browser.

## Files

### Bundle Data
- `*.data.gz` - Gzipped bundle data files containing concatenated file contents
- `*.meta.json` - Metadata for each bundle (file paths, offsets, sizes)

### Index Files
- `bundles.json` - Main bundle registry listing all available bundles and their metadata
- `file-manifest.json` - Maps full file paths to bundle name + byte offset
- `file-to-package.json` - Maps filenames (e.g., `geometry.sty`) to CTAN package names
- `package-deps.json` - Package dependency graph extracted from .sty files

## Build Tools

Bundles are generated using scripts in the parent `packages/` directory:

- `update-bundles-tl2025.ts` - Main script to create bundles from TeX Live 2025
- `split-bundle.ts` - Splits large bundles into smaller chunks
- `bundle-cm-super.ts` - Creates the cm-super font bundle
- `consolidate-metadata.cjs` - Consolidates metadata into bundles.json

The `file-to-package.json` index is generated from the TeX Live package database:

```bash
# Download TLPDB and build index
curl -o /tmp/tlpdb.txt https://mirrors.ctan.org/systems/texlive/tlnet/tlpkg/texlive.tlpdb
node scripts/build-file-index.js packages/bundles/file-to-package.json
```

## Path Convention

All file paths in bundles start with `/texlive/` to match the TeX Live directory structure used by BusyTeX.

Example: `/texlive/texmf-dist/tex/latex/geometry/geometry.sty`
