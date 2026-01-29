// Simple local dev server for siglum-engine
// Serves bundles, WASM, and handles CTAN package fetching
// For production, use ctan-proxy.ts for shared disk caching

import { promisify } from 'util';
import { exec } from 'child_process';
import { readFile, rm, readdir, mkdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  LRUCache,
  processZipData,
  processRawFileData,
  processExtractedFiles,
  type ProcessedPackage,
} from './packages/ctan-core.ts';

const execAsync = promisify(exec);

const BUNDLES_DIR = './packages/bundles';
const DIST_DIR = './dist';
const TEXLIVE_ARCHIVE_DIR = './busytex/source/texmfrepo/archive';

// Memory-only cache for packages (no disk persistence)
const packageCache = new LRUCache<ProcessedPackage>(50);

// Request deduplication
const inFlightRequests = new Map<string, Promise<Response>>();

// CORS headers for all responses
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Cross-Origin-Resource-Policy': 'cross-origin',
};

function jsonResponse(data: any, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

// ============================================================================
// TexLive tar.xz extraction
// ============================================================================

async function walkDirectory(baseDir: string, currentDir: string, files: Record<string, Uint8Array>): Promise<void> {
  // Use withFileTypes to avoid separate stat() calls - significant perf improvement
  const entries = await readdir(currentDir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(currentDir, entry.name);
    if (entry.isDirectory()) {
      await walkDirectory(baseDir, fullPath, files);
    } else {
      const relPath = fullPath.replace(baseDir + '/', '');
      files[relPath] = new Uint8Array(await readFile(fullPath));
    }
  }
}

async function tryTexLiveArchive(pkgName: string): Promise<ProcessedPackage | null> {
  try {
    // Find the package file (format: packagename.r12345.tar.xz)
    const files = await Array.fromAsync(new Bun.Glob(`${pkgName}.r*.tar.xz`).scan(TEXLIVE_ARCHIVE_DIR));
    if (files.length === 0) return null;

    const filePath = join(TEXLIVE_ARCHIVE_DIR, files[0]);
    console.log(`[TEXLIVE] Extracting: ${filePath}`);

    const tmpDir = join(tmpdir(), `texlive-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    try {
      await mkdir(tmpDir, { recursive: true });
      await execAsync(`tar xJf "${filePath}" -C "${tmpDir}"`);

      const extractedFiles: Record<string, Uint8Array> = {};
      await walkDirectory(tmpDir, tmpDir, extractedFiles);

      const extraction = processExtractedFiles(extractedFiles, pkgName);
      if (extraction.fileCount === 0) return null;

      console.log(`[TEXLIVE] Extracted ${extraction.fileCount} files, deps: ${extraction.dependencies.join(', ') || 'none'}`);

      return {
        name: pkgName,
        files: extraction.files,
        totalFiles: extraction.fileCount,
        dependencies: extraction.dependencies,
        source: 'texlive'
      };
    } finally {
      try { await rm(tmpDir, { recursive: true }); } catch {}
    }
  } catch (e) {
    return null;
  }
}

// ============================================================================
// Package fetching (when ctan-proxy isn't running)
// ============================================================================

async function fetchAndExtractPackage(pkg: string): Promise<Response> {
  // Check memory cache first
  if (packageCache.has(pkg)) {
    console.log(`[CACHE] Cache hit: ${pkg}`);
    return jsonResponse(packageCache.get(pkg));
  }

  console.log(`[FETCH] Fetching package: ${pkg}`);

  // Try local TexLive archive first (has pre-built .sty files)
  const texliveResult = await tryTexLiveArchive(pkg);
  if (texliveResult) {
    packageCache.set(pkg, texliveResult);
    return jsonResponse(texliveResult);
  }

  // Query CTAN for package info
  const infoResponse = await fetch(`https://ctan.org/json/2.0/pkg/${pkg}`);
  const info = await infoResponse.json();

  if (info.errors) {
    console.log(`[CTAN] Package not found: ${pkg}`);
    return jsonResponse({ error: 'Package not found' }, 404);
  }

  // Handle parent package redirect
  let pkgName = pkg;
  const parentPkg = info.miktex || info.texlive;
  if (parentPkg && parentPkg !== pkg) {
    console.log(`[CTAN] ${pkg} is part of ${parentPkg}`);

    // Try TexLive for parent package
    const parentTexlive = await tryTexLiveArchive(parentPkg);
    if (parentTexlive) {
      packageCache.set(pkg, parentTexlive);
      packageCache.set(parentPkg, parentTexlive);
      return jsonResponse(parentTexlive);
    }

    // Check if parent is cached
    if (packageCache.has(parentPkg)) {
      const cached = packageCache.get(parentPkg)!;
      packageCache.set(pkg, cached); // Cache under both names
      return jsonResponse(cached);
    }
    pkgName = parentPkg;
  }

  // Single file package - fetch raw
  // Only treat as single file if path has an extension (CTAN sometimes returns file:true for directories)
  const pathHasExt = info.ctan?.path && /\.[a-z]{2,4}$/i.test(info.ctan.path);
  if (info.ctan?.file === true && pathHasExt) {
    console.log(`[CTAN] Single file: ${info.ctan.path}`);
    const rawResponse = await fetch(`https://mirrors.ctan.org${info.ctan.path}`, { redirect: 'follow' });
    if (rawResponse.ok) {
      const content = await rawResponse.text();
      const result = processRawFileData(info.ctan.path, content, pkgName);
      packageCache.set(pkg, result);
      if (pkgName !== pkg) packageCache.set(pkgName, result);
      return jsonResponse(result);
    }
  }

  // Build list of URLs to try (in order of preference)
  const urlsToTry: string[] = [];
  let ctanPath = info.ctan?.path || '';
  // Only strip filename if path has an actual file extension (CTAN sometimes returns file:true for directories)
  if (info.ctan?.file === true && /\.[a-z]{2,4}$/i.test(ctanPath)) {
    ctanPath = ctanPath.substring(0, ctanPath.lastIndexOf('/'));
  }

  if (info.install) {
    urlsToTry.push(`https://mirrors.ctan.org/install${info.install}`);
  }
  if (ctanPath) {
    urlsToTry.push(`https://mirrors.ctan.org${ctanPath}.zip`);
    urlsToTry.push(`https://mirrors.ctan.org${ctanPath}/${pkgName}.zip`);
    urlsToTry.push(`https://mirrors.ctan.org${ctanPath}.tds.zip`);
  }

  if (urlsToTry.length === 0) {
    return jsonResponse({ error: 'No download URL available' }, 404);
  }

  // Try each URL until we get usable files
  let result: ProcessedPackage | { error: string } = { error: 'No URLs to try' };

  for (const downloadUrl of urlsToTry) {
    console.log(`[CTAN] Trying: ${downloadUrl}`);
    const zipResponse = await fetch(downloadUrl, { redirect: 'follow' });

    if (!zipResponse.ok) continue;

    const zipData = new Uint8Array(await zipResponse.arrayBuffer());
    console.log(`[CTAN] Extracting ZIP (${(zipData.length / 1024).toFixed(1)} KB)`);

    result = await processZipData(zipData, pkgName);

    // If we got usable files, we're done
    if (!('error' in result) && result.totalFiles > 0) {
      break;
    }
    console.log(`[CTAN] No usable files, trying next URL...`);
  }

  if ('error' in result) {
    return jsonResponse(result, 404);
  }

  console.log(`[CTAN] Extracted ${result.totalFiles} files, deps: ${result.dependencies.join(', ') || 'none'}`);

  // Cache under both requested name and resolved name
  packageCache.set(pkg, result);
  if (pkgName !== pkg) packageCache.set(pkgName, result);

  return jsonResponse(result);
}

// ============================================================================
// Server
// ============================================================================

Bun.serve({
  port: 8787,
  hostname: '0.0.0.0', // Listen on all interfaces for network access
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    // No-cache headers for development source files only
    const noCacheHeaders = {
      ...corsHeaders,
      'Cache-Control': 'no-store',
    };

    // Cache headers for static assets (bundles, WASM) - 1 hour browser cache
    const cacheHeaders = {
      ...corsHeaders,
      'Cache-Control': 'public, max-age=3600',
    };

    // Log all requests
    console.log(`[${req.method}] ${path}`);

    if (req.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // /bundles/* - serve from packages/bundles
    if (path.startsWith('/bundles/')) {
      let file = path.slice(9); // remove '/bundles/'
      let filePath = `${BUNDLES_DIR}/${file}`;

      let bunFile = Bun.file(filePath);

      // Fallback: if .data or .raw doesn't exist, try .data.gz
      if (!await bunFile.exists()) {
        if (file.endsWith('.data')) {
          filePath = `${BUNDLES_DIR}/${file}.gz`;
          bunFile = Bun.file(filePath);
          file = file + '.gz';
        } else if (file.endsWith('.raw')) {
          // .raw requests are for uncompressed data - serve from .data.gz after decompressing
          const gzPath = `${BUNDLES_DIR}/${file.replace('.raw', '.data.gz')}`;
          bunFile = Bun.file(gzPath);
          file = file.replace('.raw', '.data.gz');
        }
      }

      if (await bunFile.exists()) {
        const contentType = file.endsWith('.json') ? 'application/json'
          : file.endsWith('.gz') ? 'application/gzip'
          : 'application/octet-stream';

        // Handle Range requests for deferred loading
        const rangeHeader = req.headers.get('Range');
        if (rangeHeader && file.endsWith('.gz')) {
          const match = rangeHeader.match(/bytes=(\d+)-(\d+)?/);
          if (match) {
            const start = parseInt(match[1], 10);
            const end = match[2] ? parseInt(match[2], 10) : undefined;

            // For .gz files, we need to decompress, slice, then return
            const compressed = await bunFile.arrayBuffer();
            const decompressed = Bun.gunzipSync(new Uint8Array(compressed));
            const sliceEnd = end !== undefined ? end + 1 : decompressed.length;
            const slice = decompressed.slice(start, sliceEnd);

            return new Response(slice, {
              status: 206,
              headers: {
                ...cacheHeaders,
                'Content-Type': 'application/octet-stream',
                'Content-Range': `bytes ${start}-${sliceEnd - 1}/${decompressed.length}`,
                'Content-Length': String(slice.length),
              },
            });
          }
        }

        return new Response(bunFile, {
          headers: { ...cacheHeaders, 'Content-Type': contentType },
        });
      }
      return new Response('Not found: ' + filePath, { status: 404, headers: cacheHeaders });
    }

    // /wasm/* - serve from busytex/build/wasm/
    if (path.startsWith('/wasm/')) {
      const file = path.slice(6);
      const filePath = `./busytex/build/wasm/${file}`;

      const bunFile = Bun.file(filePath);
      if (await bunFile.exists()) {
        const contentType = file.endsWith('.wasm') ? 'application/wasm'
          : file.endsWith('.js') ? 'application/javascript'
          : 'application/octet-stream';
        return new Response(bunFile, {
          headers: { ...cacheHeaders, 'Content-Type': contentType },
        });
      }
      return new Response('Not found: ' + filePath, { status: 404, headers: cacheHeaders });
    }

    // /api/texlive/* - serve from local TL2025 archive
    // This is preferred over CTAN because TexLive has pre-built .sty files
    if (path.startsWith('/api/texlive/')) {
      const pkg = path.slice(13);
      const archiveDir = './busytex/source/texmfrepo/archive';

      console.log(`[TEXLIVE] Serving package: ${pkg}`);
      try {
        // Find the package file (format: packagename.r12345.tar.xz)
        const files = await Array.fromAsync(new Bun.Glob(`${pkg}.r*.tar.xz`).scan(archiveDir));
        if (files.length === 0) {
          console.log(`[TEXLIVE] 404: ${pkg} not found in archive`);
          return jsonResponse({ error: 'Package not found in TexLive' }, 404);
        }
        // Use the first match (should only be one per package)
        const filePath = `${archiveDir}/${files[0]}`;
        console.log(`[TEXLIVE] Serving file: ${filePath}`);
        const file = Bun.file(filePath);
        if (!await file.exists()) {
          return jsonResponse({ error: 'Package file not found' }, 404);
        }
        return new Response(file, {
          headers: { ...corsHeaders, 'Content-Type': 'application/x-xz' },
        });
      } catch (e: any) {
        console.error(`TexLive serve error: ${e.message}`);
        return jsonResponse({ error: e.message }, 500);
      }
    }

    // /api/ctan-pkg/* - proxy to ctan-proxy or fall back to direct CTAN
    if (path.startsWith('/api/ctan-pkg/')) {
      const pkg = path.slice(14);

      // Try local ctan-proxy first (has caching)
      try {
        const response = await fetch(`http://localhost:8081/api/pkg/${pkg}`);
        if (response.ok) {
          console.log(`[CTAN] pkg info via ctan-proxy: ${pkg}`);
          const body = await response.text();
          return new Response(body, {
            status: response.status,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
      } catch {
        // ctan-proxy not running, fall back to direct
      }

      // Fall back to direct CTAN
      console.log(`[CTAN] pkg info direct: ${pkg}`);
      try {
        const response = await fetch(`https://ctan.org/json/2.0/pkg/${pkg}`);
        const body = await response.text();
        return new Response(body, {
          status: response.status,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      } catch (e: any) {
        return jsonResponse({ error: e.message }, 502);
      }
    }

    // /api/fetch/* - fetch and extract package
    // Tries ctan-proxy first (disk cache), falls back to local extraction (memory cache)
    if (path.startsWith('/api/fetch/')) {
      const pkg = path.slice(11);

      // Request deduplication
      if (inFlightRequests.has(pkg)) {
        console.log(`[CTAN] Deduplicating request: ${pkg}`);
        return inFlightRequests.get(pkg)!;
      }

      // Try local ctan-proxy first (has disk caching)
      try {
        const response = await fetch(`http://localhost:8081/api/fetch/${pkg}`);
        if (response.ok) {
          console.log(`[CTAN] fetch via ctan-proxy: ${pkg}`);
          const data = await response.json();
          packageCache.set(pkg, data); // Also cache locally
          return jsonResponse(data);
        }
      } catch {
        // ctan-proxy not running, handle locally
      }

      // Fetch and extract locally (memory cache only)
      const fetchPromise = fetchAndExtractPackage(pkg)
        .catch(e => {
          console.error(`[CTAN] Error fetching ${pkg}:`, e);
          return jsonResponse({ error: e.message }, 500);
        })
        .finally(() => {
          inFlightRequests.delete(pkg);
        });

      inFlightRequests.set(pkg, fetchPromise);
      return fetchPromise;
    }

    // /src/* - serve source files (for local development, no caching)
    if (path.startsWith('/src/')) {
      const file = path.slice(5);
      const bunFile = Bun.file(`./src/${file}`);
      if (await bunFile.exists()) {
        const contentType = file.endsWith('.js') ? 'application/javascript' : 'text/plain';
        return new Response(bunFile, {
          headers: { ...noCacheHeaders, 'Content-Type': contentType },
        });
      }
      return new Response('Not found: ./src/' + file, { status: 404, headers: noCacheHeaders });
    }

    // Serve node_modules for import map resolution
    if (path.startsWith('/node_modules/')) {
      const file = path.slice(14);
      const bunFile = Bun.file(`./node_modules/${file}`);
      if (await bunFile.exists()) {
        const contentType = file.endsWith('.js') ? 'application/javascript'
          : file.endsWith('.json') ? 'application/json'
          : 'application/octet-stream';
        return new Response(bunFile, {
          headers: { ...noCacheHeaders, 'Content-Type': contentType },
        });
      }
      return new Response('Not found: ./node_modules/' + file, { status: 404, headers: noCacheHeaders });
    }

    // /xzwasm.js - serve from dist/src (or node_modules fallback)
    if (path === '/xzwasm.js') {
      // Try dist/src first (built), then node_modules (development)
      const paths = [
        `${DIST_DIR}/src/xzwasm.js`,
        './node_modules/xzwasm/dist/package/xzwasm.js'
      ];
      for (const p of paths) {
        const bunFile = Bun.file(p);
        if (await bunFile.exists()) {
          return new Response(bunFile, {
            headers: { ...cacheHeaders, 'Content-Type': 'application/javascript' },
          });
        }
      }
    }

    // Demo page (with SharedArrayBuffer headers)
    if (path === '/' || path === '/demo.html') {
      const bunFile = Bun.file('./demo.html');
      if (await bunFile.exists()) {
        return new Response(bunFile, {
          headers: {
            ...corsHeaders,
            'Content-Type': 'text/html',
            'Cross-Origin-Opener-Policy': 'same-origin',
            'Cross-Origin-Embedder-Policy': 'require-corp',
          },
        });
      }
    }

    // Health check
    if (path === '/health') {
      return jsonResponse({
        status: 'ok',
        service: 'siglum-local-dev',
        packageCache: packageCache.size,
        dirs: { bundles: BUNDLES_DIR, dist: DIST_DIR }
      });
    }

    return new Response('Not found', { status: 404, headers: corsHeaders });
  },
});

console.log('Local dev server: http://localhost:8787');
console.log('  /bundles/*    -> ./packages/bundles/');
console.log('  /wasm/*       -> ./busytex/build/wasm/');
console.log('  /src/*        -> ./src/');
console.log('  /api/texlive/ -> Local TL2025 archive');
console.log('  /api/fetch/   -> ctan-proxy (if running) or direct CTAN with extraction');
console.log('');
console.log('Package fetching works without ctan-proxy (memory cache only).');
console.log('For disk caching, run: bun packages/ctan-proxy.ts');
