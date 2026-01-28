# Siglum

A fast, efficient, browser-based LaTeX compiler. TeX Live 2025 running in WebAssembly, with lazy loading and on-demand package resolution.

On first compile, the engine downloads:
1. **WASM binary** (~15MB) — the TeX engine
2. **Core bundles** (~20MB) — LaTeX kernel, fonts, format files
3. **Additional packages** — fetched from CTAN as needed

Everything is cached in the browser (OPFS/IndexedDB).

## Install

```bash
npm install @siglum/engine
```

## Usage

```javascript
import { SiglumCompiler } from '@siglum/engine';

const compiler = new SiglumCompiler();
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

The compiler fetches the TeX engine and packages from the Siglum CDN automatically.

## API

### `new SiglumCompiler(options?)`

```javascript
const compiler = new SiglumCompiler({
    // All options are optional — defaults use Siglum CDN
    cdnUrl: 'https://cdn.siglum.org/tl2025',
    enableCtan: true,      // Fetch missing packages from CTAN
    enableLazyFS: true,    // Load files on-demand (faster startup)
    onLog: (msg) => {},    // Log callback
    onProgress: (stage, detail) => {},  // Progress callback
});
```

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

## Engines

| Engine | Status |
|--------|--------|
| pdfLaTeX | Full support, format caching |
| XeLaTeX | Full support, custom fonts via fontspec |
| LuaLaTeX | Not yet available |

Use `engine: 'auto'` to auto-detect based on document content.

## Custom Fonts (XeLaTeX)

```javascript
const fontData = await fetch('MyFont.otf').then(r => r.arrayBuffer());

const result = await compiler.compile(`
\\documentclass{article}
\\usepackage{fontspec}
\\setmainfont[Path=./]{MyFont.otf}
\\begin{document}
Hello with custom font!
\\end{document}
`, {
    engine: 'xelatex',
    additionalFiles: {
        'MyFont.otf': new Uint8Array(fontData),
    },
});
```

## Local Development

```bash
git clone https://github.com/SiglumProject/siglum-engine
cd siglum-engine
bun install
```

Download the WASM and bundle files from [GitHub Releases](https://github.com/SiglumProject/siglum-engine/releases):

```bash
# WASM files
mkdir -p busytex/build/wasm
curl -L -o busytex/build/wasm/busytex.wasm <release-url>/busytex.wasm
curl -L -o busytex/build/wasm/busytex.js <release-url>/busytex.js

# Bundle files (extract to packages/bundles/)
curl -L -o bundles.tar.gz <release-url>/bundles.tar.gz
tar -xzf bundles.tar.gz -C packages/
```

Start the dev server:

```bash
bun dev   # http://localhost:8787
```

Use localhost in your app:

```javascript
const compiler = new SiglumCompiler({
    cdnUrl: 'http://localhost:8787',
});
```

The dev server handles CORS and the required `Cross-Origin-Opener-Policy` / `Cross-Origin-Embedder-Policy` headers for SharedArrayBuffer.

## Self-Hosting

Download the release assets and host them with CORS headers:

```
Access-Control-Allow-Origin: *
Cross-Origin-Resource-Policy: cross-origin
```

Expected structure:

```
your-cdn.com/tl2025/
├── wasm/
│   ├── busytex.wasm
│   └── busytex.js
└── bundles/
    ├── manifest.json
    ├── core.data.gz
    ├── fmt-pdflatex.data.gz
    └── ...
```

Then configure:

```javascript
const compiler = new SiglumCompiler({
    cdnUrl: 'https://your-cdn.com/tl2025',
});
```

## Browser Requirements

- Modern browser with WebAssembly support
- SharedArrayBuffer (requires [COOP/COEP headers](https://web.dev/coop-coep/))
- ~500MB RAM for compilation

## Acknowledgments

Built on [BusyTeX](https://github.com/busytex/busytex) with TeX Live 2025.

## License

MIT
