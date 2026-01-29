# CTAN Proxy

A caching proxy for fetching LaTeX packages from TexLive and CTAN. Extracts packages and serves them as JSON for browser-based LaTeX compilers.

## Architecture

```
packages/
├── ctan-core.ts           # Shared extraction logic
├── ctan-proxy.ts          # Production server (disk cache)
└── cache/                 # Disk cache directory

serve-local.ts             # Dev server (memory cache)
```

### `ctan-core.ts`

Shared extraction logic used by both servers:

- `LRUCache<T>` — Bounded memory cache with eviction
- `processZipData()` — Extract ZIP archives
- `processRawFileData()` — Handle single-file packages
- `processExtractedFiles()` — Process TAR/ZIP contents into virtual filesystem

### `serve-local.ts`

Development server on port 8787. Fetches packages from the local TexLive archive or CTAN mirrors. Memory cache only (cleared on restart).

### `ctan-proxy.ts`

Production server on port 8081. Adds disk caching (persists across restarts), request deduplication, and a file index for fast reverse lookups.

## Quick Start (Production)

```bash
bun packages/ctan-proxy.ts
```

The proxy runs on `http://localhost:8081` by default.

## How It Works

When a package is requested:

1. **Check cache** - Memory first, then disk
2. **Try TexLive** - Pre-built packages from TexLive 2025 archives
3. **Try CTAN** - Falls back to CTAN mirrors if not in TexLive
4. **Extract & cache** - Extracts `.sty`, `.cls`, fonts, etc. and caches to disk

Packages are cached permanently to disk. The memory cache is a bounded LRU cache to reduce disk reads.

```
Request → Memory Cache (LRU) → Disk Cache (permanent) → TexLive/CTAN
```

CTAN is only contacted once per package, ever. Subsequent requests are served from disk.

## API

### `GET /api/fetch/:package`

Download and extract a package. Returns JSON with file contents.

```bash
curl http://localhost:8081/api/fetch/enumitem
```

Response:
```json
{
  "name": "enumitem",
  "files": {
    "/texlive/texmf-dist/tex/latex/enumitem/enumitem.sty": {
      "path": "/texlive/texmf-dist/tex/latex/enumitem",
      "content": "\\ProvidesPackage{enumitem}..."
    }
  },
  "totalFiles": 1,
  "dependencies": ["keyval"],
  "source": "texlive"
}
```

### `GET /api/pkg/:package`

Get package metadata from CTAN (cached).

```bash
curl http://localhost:8081/api/pkg/enumitem
```

### `GET /api/deps/:package`

Get recursive dependencies for a package.

```bash
curl http://localhost:8081/api/deps/tikz
```

### `GET /api/stats`

Get current cache statistics.

```bash
curl http://localhost:8081/api/stats
```

Response:
```json
{
  "memory": {
    "packages": { "current": 23, "max": 100 },
    "info": { "current": 45, "max": 500 },
    "aliases": { "current": 12, "max": 1000 }
  },
  "disk": {
    "cacheDir": "./packages/cache",
    "packages": 87,
    "fileIndex": 156
  },
  "inFlight": 0
}
```

## Configuration

All settings are configurable via environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `CTAN_PROXY_PORT` | `8081` | Server port |
| `CTAN_PROXY_CACHE_DIR` | `./packages/cache` | Disk cache directory |
| `CTAN_PROXY_MEMORY_CACHE_SIZE` | `100` | Max packages in memory LRU cache |
| `CTAN_PROXY_INFO_CACHE_SIZE` | `500` | Max CTAN info entries in memory |
| `CTAN_PROXY_ALIAS_CACHE_SIZE` | `1000` | Max package aliases in memory |

Example with custom settings:

```bash
CTAN_PROXY_PORT=9000 \
CTAN_PROXY_MEMORY_CACHE_SIZE=500 \
CTAN_PROXY_CACHE_DIR=/var/cache/ctan \
bun packages/ctan-proxy.ts
```

### Memory Tuning

The memory cache prevents repeated disk reads. For production with many concurrent users:

- **Small memory** (default 100): Lower RAM, more disk reads
- **Large memory** (500-1000): Higher RAM, fewer disk reads

CTAN has ~6000 packages. If your users access a wide variety, increase the cache size. If most users compile similar documents (academic papers, resumes), the default is fine.

The disk cache is unlimited and permanent. Packages are never evicted from disk.

## Caching Architecture

### Disk Cache

Located in `CTAN_PROXY_CACHE_DIR` (default: `packages/cache/`):

```
packages/cache/
├── enumitem.json      # Extracted package data
├── geometry.json
├── tikz.json
├── _aliases.json      # Package name aliases (e.g., tikz → pgf)
└── _file_index.json   # Reverse index: filename → package
```

The disk cache is permanent. To clear it, delete the cache directory.

### Memory Cache

Three LRU caches in memory:

1. **Package cache** - Extracted package data (largest)
2. **Info cache** - CTAN metadata responses
3. **Alias cache** - Package name mappings

All are bounded and evict least-recently-used entries when full.

### Request Deduplication

Concurrent requests for the same package share a single fetch. If 10 users request `tikz` simultaneously, only one CTAN request is made.

## Package Resolution

The proxy handles several edge cases:

### Parent Packages

Some packages are distributed as part of larger packages. For example, `pgfkeys` is part of `pgf`. The proxy:

1. Queries CTAN for package info
2. Detects `texlive` or `miktex` field pointing to parent
3. Fetches the parent package instead
4. Caches an alias for future requests

### Single-File Packages

Some CTAN packages are single `.sty` files (not archives). The proxy detects `ctan.file === true` and fetches the raw file directly.

### File Index

When CTAN doesn't recognize a package name (e.g., `pgfkeys`), the proxy searches its file index to find which cached package contains that file.

## Deployment

### Docker

```dockerfile
FROM oven/bun:1
WORKDIR /app

# Copy package files and install dependencies
COPY package.json bun.lock* ./
RUN bun install --production

# Copy proxy files
COPY packages/ctan-core.ts packages/
COPY packages/ctan-proxy.ts packages/

RUN mkdir -p /var/cache/ctan
ENV CTAN_PROXY_CACHE_DIR=/var/cache/ctan
ENV CTAN_PROXY_MEMORY_CACHE_SIZE=500
EXPOSE 8081
CMD ["bun", "packages/ctan-proxy.ts"]
```

### Cloudflare Workers

The proxy is designed to work in Cloudflare Workers with modifications:

- Replace disk cache with KV or R2 storage
- Replace `exec` (tar extraction) with pure JS/WASM decompression

### Systemd

```ini
[Unit]
Description=CTAN Proxy
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/opt/siglum-engine
Environment=CTAN_PROXY_CACHE_DIR=/var/cache/ctan
Environment=CTAN_PROXY_MEMORY_CACHE_SIZE=500
ExecStart=/usr/local/bin/bun packages/ctan-proxy.ts
Restart=always

[Install]
WantedBy=multi-user.target
```

**Note:** The working directory must contain both `packages/ctan-proxy.ts` and `packages/ctan-core.ts`, plus `node_modules` with dependencies (`fflate`).

## Troubleshooting

### Package not found

If a package isn't found:

1. Check if it exists on CTAN: `https://ctan.org/pkg/PACKAGENAME`
2. Check if it's part of a parent package (e.g., `pgfkeys` → `pgf`)
3. Some packages are in TexLive but not CTAN (or vice versa)

### Slow first fetch

First fetch for a package may take 2-5 seconds (network latency to TexLive/CTAN mirrors). Subsequent requests are instant from cache.

### Cache corruption

If you see errors, try clearing the cache:

```bash
rm -rf packages/cache/*
```
