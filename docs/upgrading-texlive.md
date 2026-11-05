# Upgrading TeX Live

A TeX Live upgrade changes binaries, format files, bundled packages, lookup
indexes, and package fetching together. Publishing a JavaScript version alone
does not upgrade the runtime.

## Build and validate a matched set

1. Review the BusyTeX fork and upstream changes. Update the pinned submodule
   only after reviewing build and runtime compatibility.
2. Set the release's source and ISO URLs and checksums in `busytex/Makefile`.
   Use verified upstream filenames and checksums. Remove stale build inputs
   through a deliberate clean rebuild.
3. Follow [building](building.md): native/WASM, TeX installation, WASM formats,
   packaging, and bundle splitting. Do not reuse formats from a different engine.
4. Preserve the Makefile's `texmf.cnf` rewrite: kpathsea paths must resolve
   inside the packaged virtual filesystem without requiring a missing `ls-R`.
5. Include cm-super. The wrapper's `bundles` step runs both `split-bundle.ts`
   and `bundle-cm-super.ts`; splitting alone drops the separate font entries.
6. Regenerate font/package indexes against the matching TLPDB and refresh
   normalized build-required packages. Review generated changes.
7. Update the engine year and source policy in `src/texlive.js`, its tests,
   and the production adapter in `siglum-web/worker` together.
8. Run unit, type, browser, proxy, and Bun-provider checks; stage and verify
   the immutable runtime using the [build guide](building.md#stage-and-verify).

## Package-source policy

`TEXLIVE_YEAR` and `SUPPORTED_TL_YEARS` in `src/texlive.js` define the default
and compatibility years. Packages for the configured year come from tlnet only
while its matching year marker is present. After the mirror advances, the
resolver switches to that year's historic `tlnet-final`. Test both marker-present
and marker-absent paths so the pinned engine keeps its matching package year.

Publish new assets under a new immutable release prefix. Do not overwrite
files under an existing runtime ID. The deployed Cloudflare adapter is in
`siglum-web/worker`; old instructions to deploy this checkout's `cloudflare/`
directory are obsolete. npm publication, runtime upload, Worker deployment,
and Pages deployment are separate operations.

## LaTeX format updates

The BusyTeX fork overlays the packages pinned in `texlive-packages.lock.json`
on the ISO installation, then builds the lock's `formatVersion` with the WASM
that will load the formats. Review package revisions, checksums, the snapshot,
and the format generator before updating the submodule here.

The build lock governs bundled packages. On-demand dependencies follow the
package-source policy above. Stage a new immutable runtime for updated formats.
Verify that both pdfLaTeX and XeLaTeX report the lock's format version in their
compilation logs. Exercise a document with
`\DocumentMetadata{}`, a warmed compile, a fresh offline editor
reopen, and a bibliography with multiple passes.

## Review upstream changes

Compare the [Siglum compiler fork](https://github.com/SiglumProject/busytex)
with [BusyTeX upstream](https://github.com/busytex/busytex) from their merge
base. Record the reviewed revisions and decisions in the change description or
[release history](https://github.com/SiglumProject/busytex/releases).

Review engine security fixes, native dependencies, tool invocation, link
settings, filesystem behavior, and module lifetime changes. Check the active
source and extraction rules alongside declared ISO URLs. Evaluate upstream
build changes against the toolchain pinned by the build wrapper and CI.

For changes involving module reuse or heap restoration, exercise repeated
successful and failed compiles, file cleanup, and bibliography passes. Verify
which fixes already exist in the pinned TeX Live source before applying
backports. Keep engine, ISO, overlays, and format generation compatible.

## Upgrade checks

- Confirm the TeX Live and LaTeX banners in real compilation logs.
- Verify format loading in both pdfLaTeX and XeLaTeX.
- Compile common bundled packages and an unbundled package through the proxy.
- Exercise font-by-filename resolution and a normalized build-required package.
- Compile bibliographies and nested projects across multiple passes.
- Verify all runtime checksums and run the web production-preview tests.
