# TeX Live bundles

Siglum loads these TeX Live 2026 bundles as the document needs them. Keep the
data files, indexes, formats, and BusyTeX WASM from the same immutable runtime.

## Get the bundles

Download the matching runtime from the
[engine releases](https://github.com/SiglumProject/siglum/releases) or follow
the [build and restore instructions](../../docs/building.md). The release
includes a manifest for checking each artifact's size and SHA-256 hash.

## Files

- `*.data.gz` contains compressed concatenated bundle files.
- `*.raw` serves the same data for byte-range requests.
- `bundles.json` lists bundle sizes, file counts, package aliases, and
  dependencies. Its optional `sourceCommands` object maps TeX control-word
  names without the leading backslash to package names. The splitter preserves
  this field.
- `file-manifest.json` maps each `/texlive/` path to a bundle and byte range.
- `file-to-package.json` maps filenames to TeX Live package names.
- `package-deps.json` lists package dependencies.

See [self-hosting](../../docs/self-hosting.md) for serving an immutable runtime.
