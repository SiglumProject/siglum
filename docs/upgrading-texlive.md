# Upgrading TeX Live

A TeX Live upgrade changes binaries, format files, bundled packages, lookup
indexes, and package fetching together. Publishing a JavaScript version alone
does not upgrade the runtime.

## Build and validate a matched set

1. Review the BusyTeX fork and upstream changes. Update the pinned submodule
   only after reviewing build and runtime compatibility.
2. Set the release's source and ISO URLs in `busytex/Makefile`. The 2026 ISO is
   `texlive2026-20260301.iso`; use the checked-in source URL rather than guessing
   a filename. Remove stale build inputs through a deliberate clean rebuild.
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
   the immutable runtime before publishing. See [release steps](releasing.md).

## Package-source policy

For the 2026 engine, the default fetch year is **2026**, not 2025. Current-year
packages come from tlnet only while its `TEXLIVE_2026` marker is present. After
the mirror advances, the resolver switches to historic 2026 `tlnet-final`.
Explicit older-year compatibility requests remain available. Test both marker
present and marker absent paths; never let a pinned engine follow a future year.

Publish new assets under a new immutable release prefix. Do not overwrite
files under an existing runtime ID. The deployed Cloudflare adapter is in
`siglum-web/worker`; old instructions to deploy this checkout's `cloudflare/`
directory are obsolete. npm publication, runtime upload, Worker deployment,
and Pages deployment are separate operations.

## June 2026 LaTeX format update

This refresh keeps the TeX Live engine and package routes on 2026. The BusyTeX
fork overlays the 13 packages pinned in `texlive-packages.lock.json` on the March
ISO installation, then builds the LaTeX2e `2026-06-01` formats with the WASM
that will load them. Review the package pins and format generator in the fork
before updating the submodule here.

The build lock governs bundled packages. On-demand dependencies still follow
the 2026 package-source policy above. Stage a new immutable runtime for the
updated formats and verify that both pdfLaTeX and XeLaTeX report
`LaTeX2e <2026-06-01>` in their compilation logs. Exercise a document with
`\DocumentMetadata{}`, a warmed compile, a fresh offline editor
reopen, and a bibliography with multiple passes.

## Upstream review for the June release

Reviewed upstream main through
[`2beec8b`](https://github.com/busytex/busytex/commit/2beec8babad2f00b0429b548f51afcbcd8a53eb4)
on November 4, 2026. The fork's published main at `c2c008e` is 10 commits
ahead and 109 behind. Both Makefiles list the March 1, 2026 ISO. Upstream's
active archive extraction rule still reads its 2023 cache URLs, and its
compiler source is also pinned to TeX Live 2023. The June branch uses the
verified 2026 ISO and overlays the locked June packages. The November 1
upstream changes alter FreeType/ICU tool invocation and README examples.

[Upstream PR #14](https://github.com/busytex/busytex/pull/14), merged October 16,
closes file streams retained when reusing a module and restoring its heap.
Siglum's `src/worker.js` uses fresh modules for each TeX/BibTeX pass via
`getOrCreateModule` and `resetForPass`. The upstream stream fix applies to
`busytex_pipeline.js` and its heap-restore reuse path. Bring it into a reuse
experiment with repeated successful and failed runs. Review upstream build
changes on a separate branch against the pinned Emscripten 3.1.43 toolchain.
Upstream's stricter link checks are worth evaluating there. The current
combined relink warns about an unresolved `getpass` symbol. The pdfTeX boolean
allocation fixes in upstream's 2023 backports already exist in the fork's
pinned 2026 source.

## Upgrade checks

- Confirm the TeX Live and LaTeX banners in real compilation logs.
- Verify format loading in both pdfLaTeX and XeLaTeX.
- Compile common bundled packages and an unbundled package through the proxy.
- Exercise font-by-filename resolution and a normalized build-required package.
- Compile bibliographies and nested projects across multiple passes.
- Verify all runtime checksums and run the web production-preview tests.
