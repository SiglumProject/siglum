# Siglum Engine Examples

Interactive playground for browser-based LaTeX compilation.

**Run locally:**
```bash
bun serve-local.ts
# Open http://localhost:8787
```

> **See also:** [CTAN Proxy Guide](../docs/CTAN_PROXY.md) for self-hosting the package proxy in production.

---

## Building a LaTeX Playground

This guide breaks down `playground.html` into its core components.

### 1. Required Headers

Siglum uses SharedArrayBuffer for WASM memory, which requires these HTTP headers:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

The dev server (`serve-local.ts`) adds these automatically.

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
| `ctanProxyUrl` | null | CTAN proxy for missing packages |
| `verbose` | false | Log TeX stdout (slower) |
| `eagerBundles` | {} | Bundles to preload (e.g., `['cm-super']`) |

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

Switch between local dev server and CDN-hosted assets:

```javascript
// Local development
const localConfig = {
    bundlesUrl: 'http://localhost:8787/bundles',
    wasmUrl: 'http://localhost:8787/wasm/busytex.wasm',
    ctanProxyUrl: 'http://localhost:8787',
};

// Production CDN
const cdnConfig = {
    bundlesUrl: 'https://cdn.siglum.org/tl2025/bundles',
    wasmUrl: 'https://cdn.siglum.org/tl2025/busytex.wasm',
    ctanProxyUrl: 'https://your-ctan-proxy.com',  // You need to host this
};
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
Your server isn't sending the required COOP/COEP headers. Use `serve-local.ts` or configure your server.

**"Package not found" errors**
Make sure `ctanProxyUrl` is set and the proxy is running (`bun packages/ctan-proxy.ts`).

**Slow first compile**
Initial compile downloads ~16MB of bundles. Subsequent compiles use cached data.

**xcolor driver errors**
Use `\RequirePackage[pdftex]{xcolor}` for pdfLaTeX or detect with `iftex`:
```latex
\RequirePackage{iftex}
\ifpdftex\PassOptionsToPackage{pdftex}{xcolor}\fi
\RequirePackage{xcolor}
```
