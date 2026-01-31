# Siglum

[![npm version](https://img.shields.io/npm/v/@siglum/engine)](https://www.npmjs.com/package/@siglum/engine)
[![license](https://img.shields.io/npm/l/@siglum/engine)](https://github.com/SiglumProject/siglum-engine/blob/main/LICENSE)

A browser-based LaTeX compiler. TeX Live 2025 running in WebAssembly, with lazy bundle loading and on-demand package fetching.

On initialization, the engine downloads:
- **WASM binary** (~29MB): the TeX engine
- **Core bundles** (~16MB for pdfLaTeX): format files, fonts, base packages

Common packages (amsmath, tikz, biblatex, etc.) are pre-bundled for fast loading. Less common packages are fetched from TexLive/CTAN automatically during compilation. Everything is cached in the browser for offline use.

The full bundle is ~195MB to deploy, but clients only download what their documents need.

**Guides:**
- [Examples & Playground Tutorial](examples/README.md) — Build a LaTeX editor UI
- [CTAN Proxy Guide](docs/ctan-proxy.md) — Self-host the package proxy for production
- [Building from Source](docs/building.md) — Build WASM engine and bundles

## Quick Start (Local Demo)

Clone the repo, download the WASM engine and pre-built bundles from [cdn.siglum.org](https://cdn.siglum.org) (or [GitHub Releases](https://github.com/SiglumProject/siglum-engine/releases)), then start the dev server.

We use [Bun](https://bun.sh) for development, it's faster than Node.js and runs TypeScript directly. Install it with:

```bash
curl -fsSL https://bun.sh/install | bash
```

Then:

```bash
git clone git@github.com:SiglumProject/siglum-engine.git
cd siglum-engine
bun install

# Download WASM and bundles
mkdir -p busytex/build/wasm
curl -Lo busytex/build/wasm/busytex.wasm https://cdn.siglum.org/tl2025/busytex.wasm
curl -Lo busytex/build/wasm/busytex.js https://cdn.siglum.org/tl2025/busytex.js
curl -LO https://cdn.siglum.org/tl2025/siglum-bundles-v0.1.0.tar.gz
tar -xzf siglum-bundles-v0.1.0.tar.gz -C packages/

# Start dev server
bun serve-local.ts
```

Open http://localhost:8787 to try the playground.

For disk-persistent package caching, run the CTAN proxy in a separate terminal:

```bash
bun packages/ctan-proxy.ts
```

## Installation

```bash
npm install @siglum/engine
```

### Download Runtime Assets

Download WASM and bundles from [cdn.siglum.org](https://cdn.siglum.org) or [GitHub Releases](https://github.com/SiglumProject/siglum-engine/releases/tag/v0.1.0):

```bash
curl -LO https://cdn.siglum.org/tl2025/busytex.wasm
curl -LO https://cdn.siglum.org/tl2025/busytex.js
curl -LO https://cdn.siglum.org/tl2025/siglum-bundles-v0.1.0.tar.gz

# Extract to your public directory
tar -xzf siglum-bundles-v0.1.0.tar.gz -C public/
mv busytex.wasm busytex.js public/
```

Then configure:

```javascript
import { SiglumCompiler } from '@siglum/engine';

const compiler = new SiglumCompiler({
    bundlesUrl: '/bundles',
    wasmUrl: '/busytex.wasm',
});
```

Or use the CDN directly (no self-hosting required):

```javascript
const compiler = new SiglumCompiler({
    bundlesUrl: 'https://cdn.siglum.org/tl2025/bundles',
    wasmUrl: 'https://cdn.siglum.org/tl2025/busytex.wasm',
});
```

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

Bundlers pre-bundle dependencies, which breaks the automatic worker loading. You need to copy the worker file and pass an explicit URL:

```json
// package.json
{
  "scripts": {
    "postinstall": "cp node_modules/@siglum/engine/src/worker.js public/worker.js"
  }
}
```

```javascript
const compiler = new SiglumCompiler({
    bundlesUrl: '/bundles',
    wasmUrl: '/busytex.wasm',
    workerUrl: '/worker.js',  // Explicit path to copied worker
});
```

The `postinstall` script runs automatically on `npm install`, keeping the worker in sync with the package version.

## Engines

| Engine | Status |
|--------|--------|
| pdfLaTeX | Full support, format caching |
| XeLaTeX | Full support, custom fonts via fontspec |

Use `engine: 'auto'` to auto-detect based on document content.

## Hosting / Production

Download assets from [cdn.siglum.org](https://cdn.siglum.org) or [GitHub Releases](https://github.com/SiglumProject/siglum-engine/releases/tag/v0.1.0):

| Asset | Size | Description |
|-------|------|-------------|
| `busytex.wasm` | 29 MB | WebAssembly TeX engine |
| `busytex.js` | 292 KB | Emscripten glue code |
| `siglum-bundles-v0.1.0.tar.gz` | ~195 MB | LaTeX packages & fonts |

Serve with these headers (required for SharedArrayBuffer):

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
Access-Control-Allow-Origin: *
Cross-Origin-Resource-Policy: cross-origin
```

Expected structure after extracting:

```
your-server.com/
├── busytex.wasm
├── busytex.js
└── bundles/
    ├── bundles.json
    ├── file-manifest.json
    ├── file-to-package.json
    ├── package-deps.json
    └── *.data.gz (54 bundle files)
```

### CTAN Proxy

The CTAN proxy fetches missing LaTeX packages on-demand:

```bash
bun packages/ctan-proxy.ts
```

Packages are cached permanently. The proxy tries TexLive 2025 archives first, then falls back to CTAN mirrors.

For configuration and deployment options, see **[docs/ctan-proxy.md](docs/ctan-proxy.md)**.

## Browser Requirements

- Modern browser with WebAssembly support
- SharedArrayBuffer (requires COOP/COEP headers)
- ~512MB RAM for compilation (max heap size)

## Acknowledgments

Built on [BusyTeX](https://github.com/AsciiHuang/busytex).

## License

MIT
