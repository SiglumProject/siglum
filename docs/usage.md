# Using Siglum Engine


A browser-based LaTeX compiler. TeX Live running in WebAssembly, with lazy bundle loading and on-demand package fetching.

On initialization, the engine downloads:
- **WASM binary** with the TeX engine
- **Core bundles** with format files, fonts, and base packages

Common packages (amsmath, tikz, biblatex, etc.) are pre-bundled for fast loading. Less common packages are fetched from TexLive/CTAN automatically during compilation. Everything is cached in the browser for offline use.

Clients download the runtime files their documents need. The runtime manifest
records each asset's size and checksum.

**Guides:**
- [Examples & Playground Tutorial](../examples/README.md) — Build a LaTeX editor UI
- [CTAN Proxy Guide](ctan-proxy.md) — Use the public package API or run your own proxy
- [Building from Source](building.md) — Build WASM engine and bundles
- [Runtime setup](self-hosting.md) — Configure hosted or self-hosted runtime assets

## Project repositories

| Repository | Role |
| --- | --- |
| [siglum](https://github.com/SiglumProject/siglum) | The reusable `@siglum/engine` compiler, runtime bundles, and package resolver |
| [siglum-web](https://github.com/SiglumProject/siglum-web) | The browser editor and production CDN/package proxy adapter |
| [siglum-filesystem](https://github.com/SiglumProject/siglum-filesystem) | `@siglum/filesystem`, shared OPFS and IndexedDB storage |
| [siglum-git](https://github.com/SiglumProject/siglum-git) | `@siglum/git`, repository sync and conflict handling |
| [busytex](https://github.com/SiglumProject/busytex) | The pinned TeX Live compiler build, forked from BusyTeX |

## Hosted runtime and package API

`resolveRuntime()` selects the descriptor for the installed SDK, verifies its
manifest, and returns immutable WASM, bundle, and package URLs. Resolve once
when creating a compiler and keep those URLs for its lifetime.

The discovery service exposes `https://packages.siglum.org/latest`
as a redirect to the current manifest and `/latest.json` as its descriptor. Applications use
the SDK-specific `/engines/<sdk-version>/latest.json` through `resolveRuntime()`
so an older locked SDK keeps a compatible runtime as new SDKs are released.

Runtime archives and checksums are also available in the
[latest engine release](https://github.com/SiglumProject/siglum/releases/latest)
and [release history](https://github.com/SiglumProject/siglum/releases).

The [npm package](https://www.npmjs.com/package/@siglum/engine) provides the
JavaScript API and worker. The CDN provides the WASM and TeX files. The
[public package API guide](ctan-proxy.md#public-package-api) has runnable
examples for TeX Live archives, normalized packages and CTAN metadata.

## Quick Start (Local Demo)

Run the following development commands from the repository root.

The playground uses published package dependencies and a matching hosted
runtime. A complete matching runtime staged locally takes precedence in its
automatic mode.

```bash
bun install --frozen-lockfile
bun run dev
```

Open http://localhost:8787. The first hosted run needs an internet connection.
See [building](building.md) for local compiler assets and the editor's optional
[source workspace](https://github.com/SiglumProject/siglum-web/blob/main/docs/development.md#workspace)
for coordinated changes across the repositories.

## Installation

Install the engine. The npm package and runtime assets are distributed separately.

```sh
npm install @siglum/engine
```

This hosted Vite example resolves the runtime automatically. Apply the
[Vite setup](#usage-with-bundlers-vite-webpack-etc) before building it.

```javascript
import { SiglumCompiler, resolveRuntime } from '@siglum/engine';
import workerUrl from '@siglum/engine/worker?url';

const runtime = await resolveRuntime();
const compiler = new SiglumCompiler({
    ...runtime,
    workerUrl,
});
await compiler.init();
```

To host the same assets yourself, follow the [self-hosting guide](self-hosting.md).

## Usage

> **Note:** If using a bundler (Vite, Webpack, etc.), see [Usage with Bundlers](#usage-with-bundlers-vite-webpack-etc) for required setup.

```javascript
import { SiglumCompiler, resolveRuntime } from '@siglum/engine';

const compiler = new SiglumCompiler({
    ...await resolveRuntime(),
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

### `resolveRuntime(options?)`

Resolves the hosted runtime for the installed SDK. It checks the descriptor's
engine version, the manifest's SHA-256, and the content-derived release ID.
The result includes `wasmUrl`, `jsUrl`, `bundlesUrl`, `ctanProxyUrl`, and
`xzwasmUrl`, ready to pass to `SiglumCompiler`.

Options include `baseUrl` for another discovery service, `fetch` for a custom
fetch implementation, and `cacheStorage` for a Cache Storage instance or `null`
to disable metadata caching. Verification requires Web Crypto, available over
HTTPS or localhost.

A verified descriptor and manifest are cached together for the same service
and SDK. Network failures can reopen that verified pair offline. Invalid or
incompatible metadata is rejected. Compiling offline also requires the actual
engine, bundles, packages, and fonts to have been cached.

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
import { SiglumCompiler, resolveRuntime } from '@siglum/engine';
import workerUrl from '@siglum/engine/worker?url';

const compiler = new SiglumCompiler({
    ...await resolveRuntime(),
    workerUrl,
});
```

If your bundler does not support `?url`, copy
`node_modules/@siglum/engine/src/worker.js` to your public assets and use its
served URL. Copy it again whenever the engine package changes.

### Vite and optional BLAKE3 acceleration

The pinned `blake3-wasm` dependency has an incomplete browser ESM entry. Vite cannot bundle it
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

## Hosting

Use the [self-hosting guide](self-hosting.md) to serve a matched runtime and
package proxy for your application. Published runtime archives, manifests, and
checksums are available in the
[GitHub releases](https://github.com/SiglumProject/siglum/releases).

Serve the app with COOP `same-origin` and COEP `require-corp` for the faster
SharedArrayBuffer path. Cross-origin runtime responses need CORS headers. The
compiler also supports browsers without SharedArrayBuffer, including HTTP LAN
previews, by loading complete bundles.

### CTAN Proxy

The CTAN proxy fetches missing LaTeX packages on-demand:

```bash
bun packages/ctan-proxy.ts
```

The proxy defaults to the package year configured in `src/texlive.js`. It uses
current tlnet only while that year's marker is present, then uses the matching
historic archive. Supported compatibility years use separate archive URLs and
caches. Explicit compatibility requests never silently fall through to current
CTAN. Default requests can use CTAN fallback.

For configuration and deployment options, see **[docs/ctan-proxy.md](ctan-proxy.md)**.

## Browser Requirements

- Modern browser with WebAssembly support
- SharedArrayBuffer is optional; COOP/COEP enables its faster lazy-file path
- ~512MB RAM for compilation (max heap size)

## Acknowledgments

The compiler builds on [BusyTeX](https://github.com/busytex/busytex). This
repository pins the [Siglum BusyTeX fork](https://github.com/SiglumProject/busytex)
as its `busytex` submodule for the TeX Live WASM and matching formats.
Siglum adds the JavaScript API, worker orchestration, lazy bundle loading,
package resolution, and browser caches around that compiler.

## License

MIT
