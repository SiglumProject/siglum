# Siglum Engine Examples

Interactive playground for browser-based LaTeX compilation.

**Run locally:**
```bash
bun serve-local.ts
# Open http://localhost:8787
```

> **See also:** [CTAN Proxy Guide](../docs/ctan-proxy.md) for self-hosting the package proxy in production.

## Hosted compiler

Install the engine:

```sh
npm install @siglum/engine
```

For Vite, apply the [bundler setup](../docs/usage.md#usage-with-bundlers-vite-webpack-etc),
then resolve the hosted runtime for the installed SDK:

```js
import { SiglumCompiler, resolveRuntime } from '@siglum/engine';
import workerUrl from '@siglum/engine/worker?url';

const compiler = new SiglumCompiler({ ...await resolveRuntime(), workerUrl });
await compiler.init();
```

The resolver returns immutable asset URLs and caches the verified descriptor and
manifest together. An offline reopen also needs the engine and the document's
packages and fonts in cache. The local playground below uses the runtime served
by the source checkout.

---

## Building a LaTeX Playground

This guide breaks down `playground.html` into its core components.

### 1. Required Headers

Siglum's faster lazy-file path uses SharedArrayBuffer, which requires these
HTTP headers:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

The dev server (`serve-local.ts`) adds these automatically. Browsers without
SharedArrayBuffer use complete bundle loading instead.

### 2. Import Map

The engine depends on `@siglum/filesystem` for browser storage:

```html
<script type="importmap">
{
  "imports": {
    "@siglum/filesystem": "/node_modules/@siglum/filesystem/dist/index.js"
  }
}
</script>
```

### 3. Initialize the Compiler

```javascript
import { SiglumCompiler } from '@siglum/engine';

const compiler = new SiglumCompiler({
    // Required: where to load bundles and WASM
    bundlesUrl: '/bundles',
    wasmUrl: '/wasm/busytex.wasm',

    // Optional: enables fetching packages not in bundles
    ctanProxyUrl: 'http://localhost:8787',

    // Optional: callbacks for UI updates
    onLog: (msg) => console.log(msg),
    onProgress: (stage, detail) => updateStatusBar(stage),
});

await compiler.init();
```

**Configuration options:**

| Option | Default | Description |
|--------|---------|-------------|
| `bundlesUrl` | required | URL to bundle files |
| `wasmUrl` | required | URL to busytex.wasm |
| `jsUrl` | derived | URL to busytex.js (auto-derived from wasmUrl) |
| `workerUrl` | null | Worker URL (required for bundlers, see below) |
| `ctanProxyUrl` | null | CTAN proxy for missing packages |
| `verbose` | false | Log TeX stdout (slower) |
| `eagerBundles` | {} | Bundles to preload (e.g., `['cm-super']`) |

> **Bundler note:** Pass the exported worker as a static asset, or copy it to
> your public folder and pass its served URL as `workerUrl`. See the main
> [usage guide](../docs/usage.md#usage-with-bundlers-vite-webpack-etc) for details.

### 4. Compile a Document

```javascript
const result = await compiler.compile(latexSource, {
    engine: 'pdflatex',  // or 'xelatex', 'auto'
});

if (result.success) {
    // Display the PDF
    const blob = new Blob([result.pdf], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    document.getElementById('pdfViewer').src = url;
} else {
    console.error('Failed:', result.error);
    console.log('TeX log:', result.log);
}
```

### 5. Engine Detection

Auto-detect the best engine based on document content:

```javascript
import { detectEngine } from '@siglum/engine';

const engine = detectEngine(source);
// Returns 'xelatex' if fontspec/unicode detected, otherwise 'pdflatex'
```

### 6. Additional Files

Include custom `.sty`, `.cls`, or data files with your document:

```javascript
const result = await compiler.compile(source, {
    engine: 'pdflatex',
    additionalFiles: {
        // Text files as strings
        'mystyle.sty': `\\ProvidesPackage{mystyle} \\newcommand{\\hello}{Hello from mystyle!}`,

        // Binary files as Uint8Array
        'logo.png': await fetch('/logo.png')
            .then(r => r.arrayBuffer())
            .then(b => new Uint8Array(b)),
    },
});
```

The document can then use:
```latex
\usepackage{mystyle}
\hello
\includegraphics{logo.png}
```

### 7. Batched Logging

TeX generates thousands of log lines. Batch them to avoid UI lag:

```javascript
import { createBatchedLogger } from '@siglum/engine';

const log = createBatchedLogger((messages) => {
    // Called once per animation frame with all buffered messages
    logDiv.textContent += messages.join('\n') + '\n';
});

const compiler = new SiglumCompiler({
    onLog: log,
    // ...
});
```

### 8. Local vs CDN Mode

Use explicit local URLs with the development server. Hosted applications can
use `resolveRuntime()` to select a compatible immutable release automatically.
For manual downloads, the [latest engine release](https://github.com/SiglumProject/siglum/releases/latest)
and release history provide archives and manifests. See
[hosted runtime setup](../docs/usage.md#hosted-runtime-and-package-api) for discovery
routes and their rollout status.

```javascript
import { resolveRuntime } from '@siglum/engine';

// Local development
const localConfig = {
    bundlesUrl: 'http://localhost:8787/bundles',
    wasmUrl: 'http://localhost:8787/wasm/busytex.wasm',
    ctanProxyUrl: 'http://localhost:8787',
};

// Hosted discovery for this installed SDK
const cdnConfig = await resolveRuntime();
```

### 9. Cache Management

Clear cached bundles and compiled documents:

```javascript
await compiler.clearCache();
```

Get cache statistics:

```javascript
const stats = compiler.getStats();
console.log('Bundles cached:', stats.bundles.bundlesCached);
console.log('Bytes downloaded:', stats.bundles.bytesDownloaded);
console.log('CTAN fetches:', stats.ctan.fetchCount);
```

### 10. Keyboard Shortcuts

Add compile-on-keystroke:

```javascript
document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        compile();
    }
});
```

---

## Example Templates

The playground includes these examples:

| Example | Packages | Description |
|---------|----------|-------------|
| Hello World | — | Minimal document |
| Math | amsmath | Equations and formulas |
| Custom Style | xcolor, iftex | Using `additionalFiles` |
| TikZ | tikz | Vector graphics |

---

## Troubleshooting

**"SharedArrayBuffer is not defined"**
Check the server's COOP/COEP headers and use the matching engine worker. The
engine also supports complete bundle loading when SharedArrayBuffer is
unavailable.

**"Package not found" errors**
Make sure `ctanProxyUrl` is set and the proxy is running (`bun packages/ctan-proxy.ts`).

**Slow first compile**
The first compile loads the engine, bundles, and packages the document needs.
Later compiles reuse cached data. The selected runtime manifest records asset
sizes.

**xcolor driver errors**
Use `\RequirePackage[pdftex]{xcolor}` for pdfLaTeX or detect with `iftex`:
```latex
\RequirePackage{iftex}
\ifpdftex\PassOptionsToPackage{pdftex}{xcolor}\fi
\RequirePackage{xcolor}
```
