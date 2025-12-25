# Siglum

Browser-based LaTeX editor that compiles entirely in your browser.

## Structure

```
siglum/
├── app/        # Frontend React app (Cloudflare Pages)
├── worker/     # API worker (Cloudflare Workers + R2)
```

## Features

- Full LaTeX compilation in browser (pdfTeX, XeTeX)
- CodeMirror 6 editor with LaTeX syntax highlighting
- Live PDF preview
- GitHub sync (clone, pull, push, auto-sync)
- OPFS-based file storage
- Automatic package fetching from CTAN
- Preamble caching for faster compiles

## Development

```bash
# Install dependencies
bun install

# Start app dev server
bun run dev

# Start worker locally (optional, for API development)
bun run dev:worker
```

## Deployment

### First-time setup

```bash
# Login to Cloudflare
wrangler login

# Create Pages project
wrangler pages project create siglum

# Create R2 bucket (if not exists)
wrangler r2 bucket create siglum-bundles
```

### Deploy

```bash
# Deploy frontend to Cloudflare Pages
bun run deploy:pages

# Deploy API worker
bun run deploy:worker

# Upload bundles/WASM to R2 (from siglum-engine)
bun run upload:r2
# Or with custom path:
cd worker && ./upload-to-r2.sh /path/to/siglum-engine
```

## Dependencies

Uses these separate packages:
- [busytex-lazy](https://github.com/ArtifexSoftware/user-busytex-lazy) - LaTeX compiler (pdfTeX/XeTeX in WASM)
- [@siglum/git](https://github.com/SiglumProject/siglum-git) - Browser-based Git operations
- [@siglum/filesystem](https://github.com/SiglumProject/siglum-filesystem) - Filesystem abstraction

## Tech Stack

- React 18 + TypeScript + Vite
- CodeMirror 6 (editor)
- pdf.js (PDF rendering)
- Cloudflare Workers + R2 (API/storage)
- Cloudflare Pages (hosting)

## License

MIT
