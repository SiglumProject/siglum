# siglum-engine

The fastest browser-based LaTeX compiler. TeX Live 2025 running in WebAssembly, with lazy loading and on-demand package resolution.

- **~800KB initial download** — not 30MB like other solutions
- **~150ms cached compiles** — faster than server round-trips
- **Works offline** — after first load, no network needed
- **Any CTAN package** — fetched automatically when your document needs it

## Setup

```bash
npm install siglum-engine
```

```javascript
import { SiglumCompiler } from 'siglum-engine';

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

## How it works

On first use, siglum downloads a TeX engine and core LaTeX packages. Compilation runs in a Web Worker. After the engine and packages are cached, it works offline.

- Supported engines: pdfLaTeX and XeLaTeX.
- Common packages are bundled; others load from CTAN as needed.
- Custom fonts via fontspec (with XeLaTeX).

## Configuration

```javascript
const compiler = new SiglumCompiler({
    bundlesUrl: 'https://siglum-api.vtp-ips.workers.dev/bundles',
    wasmUrl: 'https://siglum-api.vtp-ips.workers.dev/wasm/busytex.wasm',
    ctanProxyUrl: 'https://siglum-api.vtp-ips.workers.dev',
    enableCtan: true,
    enableLazyFS: true,
    onLog: (msg) => console.log(msg),
    onProgress: (stage, detail) => console.log(`${stage}: ${detail}`),
});
```

## Compilation

```javascript
const result = await compiler.compile(source, {
    engine: 'pdflatex',  // 'pdflatex' | 'xelatex' | 'auto'
});

// result.success - boolean
// result.pdf     - Uint8Array (if successful)
// result.log     - LaTeX log output
// result.error   - error message (if failed)
```

## Custom files

Include `.sty`, `.cls`, `.bib`, images, or fonts:

```javascript
const additionalFiles = {
    'custom.sty': new TextEncoder().encode(`
        \\ProvidesPackage{custom}
        \\newcommand{\\hello}{Hello!}
    `),
};

const result = await compiler.compile(source, { additionalFiles });
```

## Custom fonts (XeLaTeX)

```latex
\documentclass{article}
\usepackage{fontspec}
\setmainfont[Path=./]{MyFont.otf}
\begin{document}
Hello with my custom font!
\end{document}
```

Upload the font file via `additionalFiles`, then reference it with `Path=./`.

## Bundle system

Bundles are pre-packaged collections of TeX files that load on demand:

| Bundle | Contents | Size |
|--------|----------|------|
| `core` | LaTeX kernel, base classes | ~750KB |
| `fmt-pdflatex` | pdflatex format file | ~1.7MB |
| `fmt-xelatex` | xelatex format file | ~4.6MB |
| `l3` | LaTeX3 packages | ~280KB |
| `amsmath` | AMS math packages | ~120KB |
| `fonts-lm` | Latin Modern fonts | ~2MB |
| `graphics` | graphicx, xcolor | ~300KB |
| `tikz` | TikZ/PGF graphics | ~5MB |

When a package isn't bundled, siglum fetches it from CTAN automatically.

## Engine support

| Engine | Status |
|--------|--------|
| pdfLaTeX | Full support, format caching |
| XeLaTeX | Full support, no format caching (native fonts) |
| LuaLaTeX | Not yet available |

## Compatibility shims

Some packages require workarounds to function in the WebAssembly environment. These shims are injected automatically at compile time.

| Shim | Packages | Description |
|------|----------|-------------|
| Microtype expansion | `microtype` | Disables font expansion (`expansion=false`) which is unsupported in the WASM build |
| Kernel tagging | `tcolorbox` | Stubs TL2026 PDF tagging commands (`\NewStructureName`, etc.) as no-ops |

**Microtype**: The microtype package's font expansion feature requires pdfTeX primitives that aren't fully supported. The shim disables expansion while keeping other microtype features (protrusion, tracking) functional.

**Kernel tagging**: LaTeX's PDF accessibility tagging infrastructure (for screen readers) was added in TL2026. Some packages like tcolorbox now use these commands. The shim defines them as no-ops, so documents compile but without accessibility metadata. Full tagging support will come with a future TeX Live upgrade.

## Performance

| Metric | Value |
|--------|-------|
| Initial download | ~800KB |
| First compile (cold) | ~2s |
| Cached compile | ~150ms |
| Full bundle cache | ~15MB |

## Acknowledgments

siglum builds on [BusyTeX](https://github.com/busytex/busytex), which first compiled TeX Live to WebAssembly.

We extended it with:

- **TeX Live 2025** — updated from TL2022 to the latest release
- **Lazy bundle system** — packages grouped into small bundles that load on demand
- **Deferred file loading** — individual files within bundles load only when TeX requests them
- **CTAN resolution** — packages not in bundles are fetched from CTAN automatically
- **Multi-engine builds** — unified WASM binary supporting pdfTeX and XeTeX
- **Browser caching** — WASM modules cached in IndexedDB, bundles in OPFS
- **Format file generation** — preamble caching for sub-second repeat compiles

## Local Development

### Quick Start

1. **Get WASM files** (not included in repo due to size):
   ```bash
   # Option A: Download from GitHub Releases
   curl -L -o busytex.wasm https://github.com/SiglumProject/siglum-engine/releases/latest/download/busytex.wasm
   curl -L -o busytex.js https://github.com/SiglumProject/siglum-engine/releases/latest/download/busytex.js

   # Option B: Build from source (requires emscripten)
   cd busytex && make
   ```

2. **Start local server**:
   ```bash
   bun dev
   ```

3. **Open demo** at http://localhost:8787

The demo page lets you edit LaTeX and compile in real-time. It uses the local server for bundles, WASM, and CTAN package fetching.

### Local Server Endpoints

| Endpoint | Source |
|----------|--------|
| `/` | `./demo.html` (interactive demo) |
| `/bundles/*` | `./packages/bundles/` |
| `/wasm/*` | `./busytex/build/wasm/` |
| `/src/*` | `./src/` (ES modules) |
| `/api/texlive/*` | `./busytex/source/texmfrepo/archive/` (TL2025) |
| `/api/ctan-pkg/*` | CTAN API proxy |

The local server uses the TL2025 archive for package fetching, so you get the same versions as production. It also sets the required `Cross-Origin-Opener-Policy` and `Cross-Origin-Embedder-Policy` headers for SharedArrayBuffer support.

## Project structure

```
.
├── src/                    # ES module source
│   ├── index.js            # Main exports
│   ├── compiler.js         # SiglumCompiler class
│   ├── bundles.js          # Bundle loading
│   ├── ctan.js             # CTAN package fetching
│   ├── storage.js          # OPFS/IndexedDB caching
│   └── worker.js           # Web Worker
├── busytex/                # Build toolchain (submodule)
├── packages/
│   └── bundles/            # Pre-built TeX bundles
└── serve-local.ts          # Local dev server
```

## License

MIT. TeX Live components use LPPL, GPL, and public-domain licenses.
