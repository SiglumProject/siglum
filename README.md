# Siglum

[![npm version](https://img.shields.io/npm/v/@siglum/engine)](https://www.npmjs.com/package/@siglum/engine)
[![weekly npm downloads](https://img.shields.io/npm/dw/@siglum/engine)](https://www.npmjs.com/package/@siglum/engine)
[![license](https://img.shields.io/npm/l/@siglum/engine)](https://github.com/SiglumProject/siglum/blob/main/LICENSE)

A browser-based LaTeX compiler. TeX Live 2026 running in WebAssembly, with lazy bundle loading and on-demand package fetching.

On initialization, the engine downloads:
- **WASM binary** (~29MB): the TeX engine
- **Core bundles** (~16MB for pdfLaTeX): format files, fonts, base packages

Common packages (amsmath, tikz, biblatex, etc.) are pre-bundled for fast loading. Less common packages are fetched from TexLive/CTAN automatically during compilation. Everything is cached in the browser for offline use.

The full bundle is ~195MB to deploy, but clients only download what their documents need.

**Guides:**
- [Examples & Playground Tutorial](examples/README.md) — Build a LaTeX editor UI
- [CTAN Proxy Guide](docs/ctan-proxy.md) — Use the public package API or run your own proxy
- [Building from Source](docs/building.md) — Build WASM engine and bundles
- [Runtime setup](docs/self-hosting.md) — Configure hosted or self-hosted runtime assets
- [Releasing](docs/releasing.md) — Publish npm packages and matched runtime assets

## Hosted runtime and package API

Use a single versioned base URL for the WASM, bundle files and package requests.
Choose the runtime that matches your engine version.

| Engine | Runtime manifest | Runtime archive and checksums |
| --- | --- | --- |
| 0.2.1, June 2026 LaTeX format | [June runtime manifest](https://packages.siglum.org/releases/tl2026-82d0f37405264c2b/runtime.json) | [v0.2.1 on GitHub](https://github.com/SiglumProject/siglum/releases/tag/v0.2.1) |
| 0.2.0 | [0.2.0 runtime manifest](https://packages.siglum.org/releases/tl2026-a609e31ad3926333/runtime.json) | [v0.2.0 on GitHub](https://github.com/SiglumProject/siglum/releases/tag/v0.2.0) |

The [npm package](https://www.npmjs.com/package/@siglum/engine) provides the
JavaScript API and worker. The CDN provides the WASM and TeX files. The
[public package API guide](docs/ctan-proxy.md#public-package-api) has runnable
examples for TeX Live archives, normalized packages and CTAN metadata.

## Quick Start (Local Demo)

This checkout builds TeX Live 2026 with the June 2026 LaTeX2e format.
Runtime binaries are separate from the npm package. Keep assets from the same
runtime manifest together.

For development, place `siglum-engine` and `siglum-filesystem` in sibling
directories. The filesystem override in package.json is for this checkout only;
package consumers use the published semver dependency.

```bash
bun install --frozen-lockfile
bun run --cwd ../siglum-filesystem build
# Restore the locally prepared runtime, or build it using docs/building.md.
bun run prepare:runtime
bun run dev
```

Open http://localhost:8787. The local server includes package proxy routes.
The four-repository UI workspace can prepare and test all dependencies together.

## Installation

Install the engine version that matches your runtime. npm and GitHub
publish independently. Check the version in npm before installing it.

```sh
npm view @siglum/engine version
npm install @siglum/engine@0.2.0
```

This Vite example uses the hosted 0.2.0 runtime. To use the June runtime,
install engine 0.2.1 when it appears in npm and use the June manifest's URL
without the trailing `/runtime.json`. See the [Vite setup](#usage-with-bundlers-vite-webpack-etc).

```javascript
import { SiglumCompiler } from '@siglum/engine';
import workerUrl from '@siglum/engine/worker?url';

const base = 'https://packages.siglum.org/releases/tl2026-a609e31ad3926333';
const compiler = new SiglumCompiler({
    workerUrl,
    wasmUrl: base + '/wasm/busytex.wasm',
    bundlesUrl: base + '/bundles',
    ctanProxyUrl: base,
    xzwasmUrl: base + '/xzwasm.js',
});
await compiler.init();
```

To host the same assets yourself, follow the [self-hosting guide](docs/self-hosting.md).

## Usage

> **Note:** If using a bundler (Vite, Webpack, etc.), see [Usage with Bundlers](#usage-with-bundlers-vite-webpack-etc) for required setup.

```javascript
import { SiglumCompiler } from '@siglum/engine';

const compiler = new SiglumCompiler({
    bundlesUrl: '/bundles',
    wasmUrl: '/wasm/busytex.wasm',
});

await compiler.init();

const result = await compiler.compile(`
\\documentclass{article}
\\begin{document}
Hello, World!
\\end{document}
`);

if (result.success) {
    const blob = new Blob([result.pdf], { type: 'application/pdf' });
    window.open(URL.createObjectURL(blob));
}
```

## API

### `new SiglumCompiler(options)`

```javascript
const compiler = new SiglumCompiler({
    // URLs
    bundlesUrl: '/bundles',           // URL to bundle files
    wasmUrl: '/wasm/busytex.wasm',    // URL to WASM binary
    jsUrl: null,                      // URL to busytex.js (derived from wasmUrl if null)
    ctanProxyUrl: null,               // CTAN proxy URL (enables CTAN fetching when set)
    workerUrl: null,                  // Custom worker URL (required for bundlers)

    // Feature flags
    enableCtan: false,                // Auto-enabled when ctanProxyUrl is set
    enableLazyFS: true,               // Load files on-demand (faster startup)
    enableDocCache: true,             // Cache compiled documents by preamble hash

    // Performance tuning
    maxRetries: 15,                   // Max retries for CTAN/bundle fetches per compile
    eagerBundles: {},                 // Bundles to load immediately (see below)
    verbose: false,                   // Log TeX stdout (disable for performance)

    // Callbacks
    onLog: (msg) => {},               // Log callback
    onProgress: (stage, detail) => {},  // Progress callback
});
```

#### `eagerBundles`

By default, large bundles like `cm-super` (fonts) are loaded on-demand when TeX requests them. This saves bandwidth but adds latency on first use. To pre-load specific bundles:

```javascript
// Load cm-super fonts eagerly for all engines
const compiler = new SiglumCompiler({
    eagerBundles: ['cm-super'],
});

// Or per-engine configuration
const compiler = new SiglumCompiler({
    eagerBundles: {
        pdflatex: ['cm-super'],
        xelatex: [],  // XeLaTeX uses system fonts
    },
});
```

#### `maxRetries`

Controls how many times the compiler retries when a package or bundle fetch fails. With pre-scanning (which batch-fetches most packages before compilation), retries are rare. Lower values fail faster if something is broken:

```javascript
const compiler = new SiglumCompiler({
    maxRetries: 5,  // Fail fast (default: 15)
});
```

#### `verbose`

Controls whether TeX stdout is sent to the `onLog` callback. Disabled by default for performance—a typical compilation generates ~4,000 log lines, each requiring a `postMessage` call from the worker.

```javascript
const compiler = new SiglumCompiler({
    verbose: true,  // Enable TeX stdout logging (default: false)
    onLog: (msg) => console.log(msg),
});

// Can also be changed after instantiation
compiler.verbose = true;   // Enable for next compile
await compiler.compile(source);
compiler.verbose = false;  // Disable again
```

When `verbose: false`:
- TeX stdout (`[TeX] ...`) is suppressed
- TeX errors (`[TeX ERR] ...`) are always logged
- Worker status messages are always logged
- Error detection still works (stdout is captured internally)

### `compiler.compile(source, options?)`

```javascript
const result = await compiler.compile(source, {
    engine: 'pdflatex',  // 'pdflatex' | 'xelatex' | 'auto'
    additionalFiles: {   // Include custom files
        'mypackage.sty': '\\ProvidesPackage{mypackage}...',
        'image.png': uint8Array,
    },
});

// result.success  — boolean
// result.pdf      — Uint8Array (if successful)
// result.log      — TeX log output
// result.error    — error message (if failed)
```

Local `.sty` and `.cls` files are scanned for dependencies and satisfy matching local package/class requests without a CTAN prefetch. Multi-file and nested projects compile without format caching so edits to a local dependency cannot reuse a stale format. Explicit `generateFormat` calls with `additionalFiles` or a nested `mainFile` return `null`.

### Project files and relative paths

`additionalFiles` keys are paths from the **virtual project root**. `mainFile`
identifies the main source within that root. TeX runs in the main file's directory,
so `\input`, `\includegraphics`, and other relative references behave like a local
compilation launched from that directory. The `source` argument supplies the main
file's contents; do not duplicate it in `additionalFiles`.

For this project:

```text
main.tex
logo.jpeg
figures/plot.pdf
revision/main.tex
revision/figures/plot.pdf
```

Compile the revision with:

```javascript
const result = await compiler.compile(revisionSource, {
    mainFile: 'revision/main.tex',
    additionalFiles: {
        'logo.jpeg': logoBytes,
        'figures/plot.pdf': originalPlotBytes,
        'revision/figures/plot.pdf': revisedPlotBytes,
    },
});
```

Inside `revisionSource`, `\includegraphics{../logo.jpeg}` and
`\includegraphics{../figures/plot.pdf}` use the root assets;
`\includegraphics{figures/plot.pdf}` uses the revision asset. The same rule applies
to `\input{../shared}` and nested chapters. Keep map keys rooted at the project;
`../logo.jpeg` is a TeX reference, not an `additionalFiles` key that escapes the root.
A leading `/` on a map key is accepted as a virtual-root alias. No host filesystem
is exposed. Without `mainFile`, the source is `document.tex` at the virtual root.

The filename also controls `\jobname`, PDF/auxiliary filenames, SyncTeX references,
and diagnostics. Projects with additional files compile afresh instead of reusing
a PDF cache keyed only by the main source. Nested documents and projects with local
dependencies skip the precompiled-preamble cache because those dependencies can change.

### Results and errors in TypeScript

With TypeScript 5.7 or newer, `CompileResult` narrows on `success`. A successful
result always contains an `ArrayBuffer`-backed PDF; no non-null assertion or
`BlobPart` cast is needed:

```typescript
const result = await compiler.compile(source, { mainFile: 'my.tex' });
if (result.success) {
    const blob = new Blob([result.pdf], { type: 'application/pdf' });
} else {
    console.error(result.error); // e.g. /my.tex:8: Undefined control sequence.
    console.error(result.log);   // original TeX log, including context
}
```

Undefined user commands remain compilation errors. The engine does not generate
empty replacement commands to make broken source compile. Retries remain available
when a missing package/bundle can be loaded or a known package-version fallback applies.

### `compiler.clearCache()`

Clear all cached packages and compiled PDFs.

### `compiler.unload()`

Free memory by unloading the WASM module. Call `init()` again to reload.

### `createBatchedLogger(onFlush)`

Helper to batch log messages and avoid DOM thrashing. The TeX compiler emits hundreds of log lines during compilation and updating the DOM on each message can cause significant slowdowns.

```javascript
import { SiglumCompiler, createBatchedLogger } from '@siglum/engine';

const compiler = new SiglumCompiler({
    bundlesUrl: '/bundles',
    wasmUrl: '/wasm/busytex.wasm',
    onLog: createBatchedLogger((messages) => {
        // Called once per animation frame with all buffered messages
        logDiv.textContent += messages.join('\n') + '\n';
        logDiv.scrollTop = logDiv.scrollHeight;
    }),
});
```

## Performance Tips

### Batch log updates

If you're displaying compiler logs in the UI, always use `createBatchedLogger` or implement your own batching. Unbatched DOM updates can add 2-3 seconds to compilation time.

### Pre-warm the compiler

Call `compiler.init()` early (e.g., on page load) so bundles are ready when the user compiles:

```javascript
// On page load
const compiler = new SiglumCompiler(options);
compiler.init(); // Fire and forget — bundles download in background

// Later, when user clicks compile
await compiler.compile(source); // Already warmed up
```

## Usage with Bundlers (Vite, Webpack, etc.)

Use the exported worker as a static asset and pass its URL explicitly:

```js
import { SiglumCompiler } from '@siglum/engine';
import workerUrl from '@siglum/engine/worker?url';

const compiler = new SiglumCompiler({
    bundlesUrl: '/releases/<releaseId>/bundles',
    wasmUrl: '/releases/<releaseId>/wasm/busytex.wasm',
    workerUrl,
});
```

If your bundler does not support `?url`, copy
`node_modules/@siglum/engine/src/worker.js` to your public assets and use its
served URL. Copy it again whenever the engine package changes.

### Vite and optional BLAKE3 acceleration

`blake3-wasm@2.1.5` has an incomplete browser ESM entry. Vite cannot bundle it
without a workaround, even though hashing has a fallback. Disable that optional
entry so the engine retains its built-in DJB2 change-detection hash:

```js
// blake3-disabled.js
throw new Error('BLAKE3 acceleration disabled in this build');
export function hash() {}
```

```js
// vite.config.mjs
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
    resolve: {
        alias: {
            'blake3-wasm/browser.js': fileURLToPath(
                new URL('./blake3-disabled.js', import.meta.url)
            ),
        },
        dedupe: ['@siglum/filesystem'],
    },
    build: { target: 'esnext' },
    define: { global: 'globalThis' },
});
```

The fallback is for cache/change detection, not cryptographic verification.
Runtime release integrity is checked separately with SHA-256. The configuration
above is tested against the packed engine, filesystem, and Git packages together.

## Engines

| Engine | Status |
|--------|--------|
| pdfLaTeX | Full support, format caching |
| XeLaTeX | Full support, custom fonts via fontspec |

Use `engine: 'auto'` to auto-detect based on document content.

BibTeX runs automatically when the document requests a bibliography, followed
by two TeX passes. Project `.bib` files and nested included chapters are supported.
Bibliography errors fail the compile instead of returning an unresolved PDF as
success. Biber is not bundled: use `biblatex` with `backend=bibtex` or provide a
prebuilt `.bbl`. This release does not claim automatic Biber support.

## Hosting / Production

The canonical Cloudflare adapter is tracked in `siglum-web/worker`; the local
`cloudflare/` directory in this repository is historical and is not deployed by
this release procedure.

```bash
node scripts/stage-runtime.mjs --combined-only
# Prints the immutable release ID and its local directory.
node scripts/verify-runtime.mjs .local-release/<releaseId>
DRY_RUN=1 bash scripts/release.sh --runtime-only
```

Staging validates TeX Live 2026 WASM banners, bundle coverage and file ranges,
then hashes every deployed byte. This includes prebuilt packages and raw bundles
used for HTTP Range requests. Browser bundle, format and document caches are
namespaced by runtime ID. Older unversioned caches are not reused.

Use [the June release steps](docs/releasing.md#june-2026-release) to upload
the immutable runtime and publish the matching engine patch. Verify the remote
runtime before deploying a UI that references it:

```bash
node scripts/verify-runtime.mjs https://packages.siglum.org/releases/<releaseId>
```

The UI must set both `VITE_API_BASE=https://packages.siglum.org` and
`VITE_ENGINE_RELEASE=<releaseId>`. Keep old release directories available for
older tabs and rollback. R2 uploads must never overwrite unversioned files as a
substitute for staging a new release.

Serve the app with COOP `same-origin` and COEP `require-corp` for the faster
SharedArrayBuffer path. Cross-origin runtime responses need CORS headers. The
compiler also supports browsers without SharedArrayBuffer, including HTTP LAN
previews, by loading complete bundles.

### CTAN Proxy

The CTAN proxy fetches missing LaTeX packages on-demand:

```bash
bun packages/ctan-proxy.ts
```

The proxy defaults to TeX Live 2026. It uses current tlnet only while its 2026
marker is present, then uses the historic 2026 archive. Explicit compatibility
requests for 2025, 2024 or 2023 use separate archive URLs and caches. They never
silently fall through to current CTAN. Default requests can use CTAN fallback.

For configuration and deployment options, see **[docs/ctan-proxy.md](docs/ctan-proxy.md)**.

## Browser Requirements

- Modern browser with WebAssembly support
- SharedArrayBuffer is optional; COOP/COEP enables its faster lazy-file path
- ~512MB RAM for compilation (max heap size)

## Acknowledgments

Built on [BusyTeX](https://github.com/AsciiHuang/busytex).

## License

MIT
