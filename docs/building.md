# Building Siglum Engine

The npm library and TeX runtime have separate builds. For a prebuilt runtime,
use the matching [GitHub release](https://github.com/SiglumProject/siglum/releases)
and follow [self-hosting](self-hosting.md). Do not use older release assets with
the TeX Live 2026 engine.

## Source checkout

Clone `SiglumProject/siglum` as `siglum-engine`, with `siglum-filesystem` beside
it. Initialize the pinned BusyTeX submodule and build the filesystem dependency:

```sh
git submodule update --init --recursive
bun install --frozen-lockfile
bun run --cwd ../siglum-filesystem build
bun run build:types
```

The local filesystem override is for development. Published npm consumers use
`@siglum/filesystem@^0.3.0`. See [release steps](releasing.md) for packing without
local overrides.

## TeX Live 2026 runtime

The supported build wrapper is `busytex/build-wasm.sh`, using Podman and
Emscripten **3.1.43**. Install Podman, Bun, Python 3, and the archive tools used
by the Makefile. Start the Podman machine before building. Reserve substantial
working space for the ISO, extracted sources, native build, and WASM build.

```sh
cd busytex
make source/texmfrepo.txt
./build-wasm.sh wasm
./build-wasm.sh texlive
./build-wasm.sh formats
./build-wasm.sh package
./build-wasm.sh bundles
```

`wasm` builds native tools and the WASM targets; it already invokes
`make wasm-all`. `wasm-all` is not a wrapper command. `formats` generates the
formats with the WASM engine, avoiding native/WASM format mismatches.
`bundles` splits the data and adds the separate cm-super font bundle.
Use `./build-wasm.sh all` to run the wrapper's complete pipeline.

Outputs include `busytex/build/wasm/{busytex,pdftex,xetex}.{js,wasm}` and
`packages/bundles/`. The formats, engine binaries, and bundled packages must
belong to the same TeX Live release. `packages/update-bundles-tl2025.ts` is a
legacy targeted update script, not the 2026 rebuild procedure.

## Indexes, normalized packages, and staging

From the engine repository root:

```sh
bun scripts/build-font-file-index.js
bun scripts/prebuild-packages.js
bun run prepare:runtime
bun run stage:runtime
node scripts/verify-runtime.mjs "$(node -p "require('./.local-release/current.json').directory")"
```

The font index uses the submodule's TLPDB by default (`TLPDB_PATH` overrides it).
Review all generated bundle/index changes before committing. Staging checks
bundle byte ranges and creates a content-addressed runtime under
`.local-release/tl2026-…`; it does not upload anything. Bulk runtime files are
ignored by Git and must be distributed separately.

## Validation

```sh
bun run test:run
bun run test:types
bun run test:browser:run
bun run test:proxy
bun run test:bun-parity
```

The browser suite requires Playwright and the locally built runtime. Test
pdfLaTeX, XeLaTeX, bibliography passes, nested projects, fonts, and packages
fetched through the proxy. Biber is not bundled; use BibTeX or a prebuilt `.bbl`.

For upgrades see [upgrading TeX Live](upgrading-texlive.md). For publication,
use [release steps](releasing.md); merging or running a build does not deploy.
