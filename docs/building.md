# Building Siglum Engine

The npm library and TeX runtime have separate builds. For a prebuilt runtime,
use a matching [GitHub release](https://github.com/SiglumProject/siglum/releases/latest)
and follow [self-hosting](self-hosting.md). Match the runtime manifest's
`engineVersion` to the installed engine package and keep its assets together.

## Source checkout

Clone `SiglumProject/siglum` and install its published package dependencies.
Initialize the pinned BusyTeX submodule when building the compiler runtime.

```sh
git submodule update --init --recursive
bun install --frozen-lockfile
bun run build:types
```

The default filesystem dependency uses the range in `package.json`. Use the Bun
tooling pinned by the CI workflows and the checked-in lockfile. For coordinated
source changes across packages, use the editor's optional
[source workspace](https://github.com/SiglumProject/siglum-web/blob/main/docs/development.md#workspace).

## TeX Live runtime

The supported build wrapper is `busytex/build-wasm.sh`, using Podman and its
digest-pinned Emscripten image. Keep the wrapper and CI toolchain inputs aligned.
Install Podman, Bun, Python, and the archive tools used by the Makefile.
Start the Podman machine before building. Reserve substantial
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

`wasm` builds the native tools before the WASM targets in the same checkout.
`texlive` installs the TeX Live base pinned in `busytex/Makefile`. `formats`
applies the checksum-verified package archives listed in
`busytex/texlive-packages.lock.json` and generates LaTeX formats for its
`formatVersion` with the exact combined BusyTeX WASM from the build. This includes
pdfLaTeX, XeLaTeX, and LuaHBLaTeX format files. The browser compiler exposes
pdfLaTeX and XeLaTeX.

`package` verifies the format and runtime hashes before packaging.
`bundles` splits the data and adds the separate cm-super font bundle.
Use `./build-wasm.sh all` to run the wrapper's complete pipeline.
The manual **Build TeX Live WASM** workflow applies the same overlay and
verifies the packaged format byte ranges against the generated files.

The bundle registry's `sourceCommands` field declares package dependencies
for LaTeX commands that load support files implicitly. The engine resolves
those dependencies through its normal bundle lookup. The build checks that
each declared package is bundled for offline use.

Outputs include `busytex/build/wasm/busytex.{js,wasm}` and
`packages/bundles/`. Keep the generated formats, engine binaries, and bundled
packages from the same build together. The ISO supplies the base installation;
the package lock and format-generation step are also required build inputs.

### Restore CI build outputs

Use the `runtime-build-inputs` artifact from the same engine commit and
BusyTeX pin. From the engine repository root, set `run_id` to the successful
workflow run. Keep the downloaded artifacts separate from the source checkout.

```sh
export SIGLUM_RUNTIME_INPUTS="$PWD/.local-release/build-$run_id"
gh run download "$run_id" --name runtime-build-inputs --dir "$SIGLUM_RUNTIME_INPUTS"
mkdir -p "$SIGLUM_RUNTIME_INPUTS/packages"
tar -xzf "$SIGLUM_RUNTIME_INPUTS/siglum-bundles.tar.gz" -C "$SIGLUM_RUNTIME_INPUTS/packages"
```

The artifact carries the combined WASM and glue, the format hashes, the
bundle indexes and the TeX inputs needed to build normalized packages.
Generate those packages with the downloaded runtime.

```sh
build_dir="$SIGLUM_RUNTIME_INPUTS/busytex/build"
cp "$build_dir/wasm/busytex.js" "$build_dir/wasm/busytex.cjs"
SIGLUM_BUSYTEX_JS="$build_dir/wasm/busytex.cjs" \
SIGLUM_BUSYTEX_WASM="$build_dir/wasm/busytex.wasm" \
SIGLUM_BUSYTEX_TEXMF="$build_dir/texlive-basic/texmf-dist" \
  bun scripts/prebuild-packages.js
mkdir -p "$SIGLUM_RUNTIME_INPUTS/packages/bundles/prebuilt"
cp -R packages/bundles/prebuilt/. "$SIGLUM_RUNTIME_INPUTS/packages/bundles/prebuilt/"
```

## Stage and verify

When building locally from the ISO, run `bun scripts/build-font-file-index.js`
and `bun scripts/prebuild-packages.js` first. The font index script reads the
submodule's TLPDB by default and accepts `TLPDB_PATH` as an override. When using
CI artifacts, keep `SIGLUM_RUNTIME_INPUTS` set so staging reads those inputs.

```sh
node scripts/stage-runtime.mjs --combined-only
node scripts/verify-runtime.mjs "$(node -p "require('./.local-release/current.json').directory")"
```

Review all generated bundle and index changes before committing. The
`--combined-only` option stages the combined BusyTeX engine. Staging checks the WASM,
glue and bundled format bytes against the fork's
`build/texlive-basic-formats.sha256` and creates a content-addressed runtime
under `.local-release/<releaseId>`. Git tracks the build inputs. See
[self-hosting](self-hosting.md) to serve a verified runtime for your application.

## Validation

```sh
bun run test:run
bun run test:types
bun run test:browser:run
bun run test:proxy
bun run test:bun-parity
```

The browser suite requires Playwright, the local ISO package archives and the
runtime copies in `dist/` prepared by `bun run prepare:runtime`. Test
pdfLaTeX, XeLaTeX, bibliography passes, nested projects, fonts, and packages
fetched through the proxy. Biber is not bundled; use BibTeX or a prebuilt `.bbl`.
Use the [web development guide](https://github.com/SiglumProject/siglum-web/blob/main/docs/development.md)
to test the runtime in the editor.

For upgrades see [upgrading TeX Live](upgrading-texlive.md).
