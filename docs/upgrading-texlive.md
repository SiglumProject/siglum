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

## Upstream review for the 0.2.0 release

Reviewed upstream main through
[`2beec8b`](https://github.com/busytex/busytex/commit/2beec8babad2f00b0429b548f51afcbcd8a53eb4)
on November 2, 2026. The November 1 changes alter FreeType/ICU build-tool
invocation and README examples. They are not published security advisories.
The current fork remains pinned at `c2c008ef28f8058fa6888853dbaf55fa91b19eda`;
this review does not claim the fork contains every upstream change.

[Upstream PR #14](https://github.com/busytex/busytex/pull/14), merged October 16,
closes file streams retained when reusing a module and restoring its heap.
Siglum's `src/worker.js` uses fresh modules for each TeX/BibTeX pass via
`getOrCreateModule` and `resetForPass`; it does not ship the upstream
`busytex_pipeline.js` reuse path. Do not import the upstream build changes
blindly into the tested Emscripten 3.1.43 pipeline. If module reuse is introduced,
carry forward the stream-cleanup fix and test repeated successful and failed
runs. This is an applicability review of those updates, not a full audit of
TeX Live's native dependencies.

## Upgrade checks

- Confirm the TeX Live and LaTeX banners in real compilation logs.
- Verify format loading in both pdfLaTeX and XeLaTeX.
- Compile common bundled packages and an unbundled package through the proxy.
- Exercise font-by-filename resolution and a normalized build-required package.
- Compile bibliographies and nested projects across multiple passes.
- Verify all runtime checksums and run the web production-preview tests.
