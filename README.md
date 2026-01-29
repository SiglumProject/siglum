# Siglum Engine

A browser-based LaTeX compiler. TeX Live 2025 running in WebAssembly, with lazy bundle loading and on-demand package fetching.

On initialization, the engine downloads:
- **WASM binary** (~29MB):  the TeX engine
- **Core bundles** (~16MB for pdfLaTeX): format files, fonts, base packages

Missing packages are fetched from the TexLive archvie and CTAN automatically during compilation. Everything is cached in the browser (OPFS/IndexedDB) for offline use.

## Quick Start

```bash
git clone git@github.com:SiglumProject/siglum-engine.git
cd siglum-engine
bun install

# Download WASM files
mkdir -p busytex/build/wasm
curl -L -o busytex/build/wasm/busytex.wasm <release-url>/busytex.wasm
curl -L -o busytex/build/wasm/busytex.js <release-url>/busytex.js

# Download bundle files
curl -L -o bundles.tar.gz <release-url>/bundles.tar.gz
tar -xzf bundles.tar.gz -C packages/
rm bundles.tar.gz

# Start dev server
bun serve-local.ts
```

Open http://localhost:8787 to try the demo.

The dev server caches packages in memory. For disk persistence across restarts, run the CTAN proxy in a separate terminal:

```bash
bun packages/ctan-proxy.ts
```

The dev server automatically uses it when available.

Replace `<release-url>` with the URL from [GitHub Releases](https://github.com/SiglumProject/siglum-engine/releases).

## Installation

```bash
npm install @siglum/engine
```

Download WASM and bundle files from [GitHub Releases](https://github.com/SiglumProject/siglum-engine/releases) and place them in your public directory:

```bash
# Download and extract to your public directory
curl -L -o wasm.tar.gz <release-url>/wasm.tar.gz
curl -L -o bundles.tar.gz <release-url>/bundles.tar.gz
tar -xzf wasm.tar.gz -C public/
tar -xzf bundles.tar.gz -C public/
```

## Usage

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
    ctanProxyUrl: null,               // CTAN proxy for missing packages (optional)
    workerUrl: null,                  // Custom worker URL (uses embedded worker if null)

    // Feature flags
    enableCtan: true,                 // Fetch missing packages from CTAN
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

## Engines

| Engine | Status |
|--------|--------|
| pdfLaTeX | Full support, format caching |
| XeLaTeX | Full support, custom fonts via fontspec |

Use `engine: 'auto'` to auto-detect based on document content.

## Hosting / Production

To self-host, you need:

1. **Static assets** (WASM + bundles) served with COOP/COEP headers
2. **CTAN proxy** for on-demand package fetching

### Static Assets

Serve the release assets with these headers (required for SharedArrayBuffer):

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
Access-Control-Allow-Origin: *
Cross-Origin-Resource-Policy: cross-origin
```

Expected structure:

```
your-server.com/
├── wasm/
│   ├── busytex.wasm
│   └── busytex.js
└── bundles/
    ├── bundles.json
    ├── file-manifest.json
    ├── core.data.gz
    ├── fmt-pdflatex.data.gz
    └── ...
```

### CTAN Proxy

The CTAN proxy fetches missing LaTeX packages on-demand and caches them to disk:

```bash
bun packages/ctan-proxy.ts
```

Packages are cached permanently, CTAN is only contacted once per package. The proxy tries TexLive archives first, then falls back to CTAN mirrors.

For configuration and deployment options, see **[docs/CTAN_PROXY.md](docs/CTAN_PROXY.md)**.

### Configuration

```javascript
const compiler = new SiglumCompiler({
    bundlesUrl: 'https://your-server.com/bundles',
    wasmUrl: 'https://your-server.com/wasm/busytex.wasm',
    ctanProxyUrl: 'https://your-ctan-proxy.com',  // Your CTAN proxy URL
});
```

## Browser Requirements

- Modern browser with WebAssembly support
- SharedArrayBuffer (requires COOP/COEP headers)
- ~512MB RAM for compilation (max heap size)

## Acknowledgments

Built on [BusyTeX](https://github.com/AsciiHuang/busytex).

## License

MIT
