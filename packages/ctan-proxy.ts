// CTAN proxy server with ZIP extraction and caching
// Run with: bun packages/ctan-proxy.ts

import { promisify } from 'util';
import { exec } from 'child_process';
import { writeFile, readFile, rm, readdir, mkdir } from 'fs/promises';
import { existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';

// Import shared extraction logic
import {
  LRUCache,
  processExtractedFiles,
  processRawFileData,
  processZipData,
  ctanDownloadUrls,
  textDecoder,
  isValidZip,
  type ProcessedPackage,
} from './ctan-core.ts';
import { resolveFontPackage } from './font-index.ts';
import { loadPrebuilt } from './prebuilt-cache.ts';

const execAsync = promisify(exec);

// ============================================================================
// Configuration
// ============================================================================

const PORT = parseInt(process.env.CTAN_PROXY_PORT || '8081', 10);
const CACHE_DIR = process.env.CTAN_PROXY_CACHE_DIR || join(dirname(import.meta.path), 'cache');
const MEMORY_CACHE_MAX_SIZE = parseInt(process.env.CTAN_PROXY_MEMORY_CACHE_SIZE || '100', 10);
const INFO_CACHE_MAX_SIZE = parseInt(process.env.CTAN_PROXY_INFO_CACHE_SIZE || '500', 10);
const ALIAS_CACHE_MAX_SIZE = parseInt(process.env.CTAN_PROXY_ALIAS_CACHE_SIZE || '1000', 10);

// Supported TexLive years for version fallback (newest first)
// Use older years when packages require kernel features not in our LaTeX build
const SUPPORTED_TL_YEARS = [2025, 2024, 2023] as const;
type TLYear = typeof SUPPORTED_TL_YEARS[number];
const DEFAULT_TL_YEAR: TLYear = 2025;

function getTexLiveUrl(pkgName: string, year: TLYear): string {
  return `https://ftp.tu-chemnitz.de/pub/tug/historic/systems/texlive/${year}/tlnet-final/archive/${pkgName}.tar.xz`;
}

// Ensure cache directory exists
if (!existsSync(CACHE_DIR)) {
  mkdirSync(CACHE_DIR, { recursive: true });
}

// ============================================================================
// Caches
// ============================================================================

const memoryCache = new LRUCache<ProcessedPackage>(MEMORY_CACHE_MAX_SIZE);
const pkgInfoCache = new LRUCache<any>(INFO_CACHE_MAX_SIZE);
const aliasCache = new LRUCache<string>(ALIAS_CACHE_MAX_SIZE);

// Reverse index: filename -> package name (for fast lookup when CTAN doesn't know a package)
const fileToPackageIndex = new Map<string, string>();

// In-flight request deduplication
const inFlightRequests = new Map<string, Promise<Response>>();

// Bootstrap aliases for edge cases where CTAN lookup fails
const bootstrapAliases: Record<string, string> = {
  'etex': 'etex-pkg',
  'tikz': 'pgf',
};

// ============================================================================
// HTTP helpers
// ============================================================================

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function jsonResponse(data: any, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

// ============================================================================
// Disk Cache (lazy loading)
// ============================================================================

async function loadFromDisk(pkgName: string): Promise<ProcessedPackage | null> {
  try {
    const data = await readFile(join(CACHE_DIR, `${pkgName}.json`), 'utf-8');
    return JSON.parse(data);
  } catch {
    return null;
  }
}

async function saveToDisk(pkgName: string, data: ProcessedPackage): Promise<void> {
  try {
    await writeFile(join(CACHE_DIR, `${pkgName}.json`), JSON.stringify(data));
  } catch (e) {
    console.warn(`Failed to save cache for ${pkgName}:`, e);
  }
}

async function loadAliasCache(): Promise<void> {
  try {
    const data = await readFile(join(CACHE_DIR, '_aliases.json'), 'utf-8');
    const aliases = JSON.parse(data);
    for (const [key, value] of Object.entries(aliases)) {
      aliasCache.set(key, value as string);
    }
    console.log(`Loaded ${aliasCache.size} aliases from disk`);
  } catch {
    // No alias cache yet
  }
}

async function loadFileIndex(): Promise<void> {
  try {
    const data = await readFile(join(CACHE_DIR, '_file_index.json'), 'utf-8');
    const index = JSON.parse(data);
    for (const [key, value] of Object.entries(index)) {
      fileToPackageIndex.set(key, value as string);
    }
    console.log(`Loaded ${fileToPackageIndex.size} file index entries from disk`);
  } catch {
    // No index yet
  }
}

async function saveAliasCache(): Promise<void> {
  try {
    const aliases: Record<string, string> = {};
    for (const [key, value] of aliasCache.entries()) {
      aliases[key] = value;
    }
    await writeFile(join(CACHE_DIR, '_aliases.json'), JSON.stringify(aliases, null, 2));
  } catch (e) {
    console.warn('Failed to save alias cache:', e);
  }
}

async function saveFileIndex(): Promise<void> {
  try {
    const index: Record<string, string> = {};
    for (const [key, value] of fileToPackageIndex.entries()) {
      index[key] = value;
    }
    await writeFile(join(CACHE_DIR, '_file_index.json'), JSON.stringify(index, null, 2));
  } catch (e) {
    console.warn('Failed to save file index:', e);
  }
}

// Load aliases and file index on startup (small files, ok to load eagerly)
loadAliasCache();
loadFileIndex();

async function countDiskPackages(): Promise<number> {
  try {
    const entries = await readdir(CACHE_DIR);
    return entries.filter(f => f.endsWith('.json') && !f.startsWith('_')).length;
  } catch {
    return 0;
  }
}

// ============================================================================
// Cache lookup with lazy disk loading
// ============================================================================

async function getCachedPackage(pkgName: string): Promise<ProcessedPackage | null> {
  // Check memory first
  if (memoryCache.has(pkgName)) {
    return memoryCache.get(pkgName)!;
  }

  // Normalized-artifact cache (plan §0): a committed, pre-normalized artifact for
  // a build-required package (acrotex/insdljs, …) is served verbatim — no docstrip
  // build in-request. Checked before the runtime disk cache; the loader memoizes,
  // so this is a constant-time lookup after the first hit.
  //
  // Prebuilt artifacts are keyed by bare package name (plan §9: docstrip output is
  // version-stable), so strip any @tl<year> suffix the runtime cache key carries —
  // otherwise a `?tlYear=2024` request would miss the cache and rebuild.
  const bareName = pkgName.replace(/@tl\d+$/, '');
  const prebuilt = await loadPrebuilt(bareName);
  if (prebuilt) {
    memoryCache.set(pkgName, prebuilt);
    return prebuilt;
  }

  // Try disk
  const diskData = await loadFromDisk(pkgName);
  if (diskData) {
    memoryCache.set(pkgName, diskData);
    return diskData;
  }

  return null;
}

async function cachePackage(pkgName: string, data: ProcessedPackage): Promise<void> {
  memoryCache.set(pkgName, data);

  // Build file index for fast reverse lookups
  const files = data.files || {};
  let indexUpdated = false;
  for (const filePath of Object.keys(files)) {
    const fileName = filePath.split('/').pop()?.replace(/\.(sty|tex|cls|def)$/, '') || '';
    if (fileName && !fileToPackageIndex.has(fileName)) {
      fileToPackageIndex.set(fileName, pkgName);
      indexUpdated = true;
    }
  }

  await saveToDisk(pkgName, data);
  if (indexUpdated) {
    await saveFileIndex();
  }
}

// ============================================================================
// Package fetching
// ============================================================================

async function fetchPackage(requestedPkg: string, tlYear: TLYear = DEFAULT_TL_YEAR): Promise<Response> {
  // Resolve aliases
  let pkgName = bootstrapAliases[requestedPkg] || aliasCache.get(requestedPkg) || requestedPkg;

  // For version-specific requests, use a year-suffixed cache key
  // This allows caching different versions of the same package
  const cacheKey = tlYear !== DEFAULT_TL_YEAR ? `${pkgName}@tl${tlYear}` : pkgName;

  // Check cache (memory + disk)
  const cached = await getCachedPackage(cacheKey);
  if (cached) {
    console.log(`Cache hit: ${requestedPkg}${pkgName !== requestedPkg ? ` (via ${pkgName})` : ''}${tlYear !== DEFAULT_TL_YEAR ? ` @TL${tlYear}` : ''}`);
    return jsonResponse(cached);
  }

  console.log(`Fetching package: ${requestedPkg}${pkgName !== requestedPkg ? ` (via ${pkgName})` : ''} from TL${tlYear}`);

  // Try TexLive archive first
  const tlUrl = getTexLiveUrl(pkgName, tlYear);
  console.log(`  Trying TexLive ${tlYear}: ${tlUrl}`);

  const tlResponse = await fetch(tlUrl, { redirect: 'follow' });
  if (tlResponse.ok) {
    const tarData = new Uint8Array(await tlResponse.arrayBuffer());
    return await processTexLiveTar(tarData, pkgName, tlYear);
  }

  // Not a package by that name — it may be a font file stem (phvr8t, ec-lmr10, …)
  // that TeX requested directly. Resolve it to the package that ships it (TLPDB
  // index, base-35 prefix fallback) and fetch that.
  const fontPkg = await resolveFontPackage(pkgName);
  if (fontPkg && fontPkg !== pkgName) {
    console.log(`  Font stem ${pkgName} resolves to package ${fontPkg}`);
    const famUrl = getTexLiveUrl(fontPkg, tlYear);
    const famResponse = await fetch(famUrl, { redirect: 'follow' });
    if (famResponse.ok) {
      aliasCache.set(requestedPkg, fontPkg);
      await saveAliasCache();
      const tarData = new Uint8Array(await famResponse.arrayBuffer());
      return await processTexLiveTar(tarData, fontPkg, tlYear);
    }
    console.log(`  Font package ${fontPkg} fetch failed (${famResponse.status}), falling through`);
  }

  // Query CTAN for package info
  console.log(`  TexLive not found, querying CTAN...`);
  const infoResponse = await fetch(`https://ctan.org/json/2.0/pkg/${pkgName}`);
  const info = await infoResponse.json();

  if (info.errors) {
    // Use file index for O(1) lookup instead of scanning all cached packages
    console.log(`  CTAN doesn't know ${pkgName}, checking file index...`);
    const cachedPkgName = fileToPackageIndex.get(pkgName);
    if (cachedPkgName) {
      const cachedData = await getCachedPackage(cachedPkgName);
      if (cachedData) {
        console.log(`  Found in cached package ${cachedPkgName}`);
        aliasCache.set(pkgName, cachedPkgName);
        await saveAliasCache();
        return jsonResponse(cachedData);
      }
    }
    console.log(`  ${pkgName} not found`);
    return jsonResponse({ error: 'Package not found' }, 404);
  }

  // Check if part of a different package
  const parentPkg = info.miktex || info.texlive;
  if (parentPkg && parentPkg !== pkgName) {
    console.log(`  CTAN says ${pkgName} is part of ${parentPkg}`);
    aliasCache.set(requestedPkg, parentPkg);
    if (pkgName !== requestedPkg) aliasCache.set(pkgName, parentPkg);
    await saveAliasCache();

    // For version-specific requests, use a year-suffixed cache key
    const parentCacheKey = tlYear !== DEFAULT_TL_YEAR ? `${parentPkg}@tl${tlYear}` : parentPkg;

    // Check cache for parent
    const parentCached = await getCachedPackage(parentCacheKey);
    if (parentCached) {
      console.log(`  Cache hit for parent: ${parentPkg}${tlYear !== DEFAULT_TL_YEAR ? ` @TL${tlYear}` : ''}`);
      return jsonResponse(parentCached);
    }

    // Try TexLive for parent
    const parentTlUrl = getTexLiveUrl(parentPkg, tlYear);
    console.log(`  Trying TexLive ${tlYear} for parent: ${parentTlUrl}`);
    const parentTlResponse = await fetch(parentTlUrl, { redirect: 'follow' });
    if (parentTlResponse.ok) {
      const tarData = new Uint8Array(await parentTlResponse.arrayBuffer());
      return await processTexLiveTar(tarData, parentPkg, tlYear);
    }

    pkgName = parentPkg;
  }

  // CTAN download
  console.log(`  Trying CTAN download...`);

  // Single file package - fetch raw
  if (info.ctan?.file === true && info.ctan?.path) {
    console.log(`  Single file, fetching raw: ${info.ctan.path}`);
    const rawResponse = await fetch(`https://mirrors.ctan.org${info.ctan.path}`, { redirect: 'follow' });
    if (rawResponse.ok) {
      const content = await rawResponse.text();
      const result = processRawFileData(info.ctan.path, content, pkgName);
      console.log(`  Processed raw file: ${info.ctan.path.split('/').pop()}, deps: ${result.dependencies.join(', ') || 'none'}`);
      await cachePackage(pkgName, result);
      return jsonResponse(result);
    }
    console.log(`  Raw file failed: ${rawResponse.status}`);
  }

  // Candidate ZIP URLs (in preference order) — shared with serve-local + the
  // offline prebuild so CTAN path conventions can't drift between them.
  const urlsToTry = ctanDownloadUrls(info, pkgName);
  if (urlsToTry.length === 0) {
    return jsonResponse({ error: 'No download URL available' }, 404);
  }

  let zipResponse: Response | null = null;
  let lastStatus = 0;
  for (const url of urlsToTry) {
    console.log(`  Downloading: ${url}`);
    const resp = await fetch(url, { redirect: 'follow' });
    console.log(`  Response: ${resp.status}`);
    lastStatus = resp.status;
    if (resp.ok) {
      zipResponse = resp;
      break;
    }
  }

  if (!zipResponse) {
    return jsonResponse({ error: `Download failed: ${lastStatus}` }, 500);
  }

  const zipData = new Uint8Array(await zipResponse.arrayBuffer());
  return await processZip(zipData, pkgName);
}

// ============================================================================
// Processing functions
// ============================================================================

async function processZip(zipData: Uint8Array, pkgName: string): Promise<Response> {
  // Validate ZIP magic bytes
  if (!isValidZip(zipData)) {
    const preview = textDecoder.decode(zipData.slice(0, 100));
    console.log(`  Not a ZIP: ${preview.slice(0, 60)}...`);
    return jsonResponse({ error: 'CTAN returned non-ZIP response' }, 404);
  }

  console.log(`  Extracting ZIP (${(zipData.length / 1024).toFixed(1)} KB)`);

  const result = await processZipData(zipData, pkgName);

  if ('error' in result) {
    if ('unbuildable' in result && result.unbuildable) {
      // Structured, actionable failure (Phase 3) — not a generic error/crash.
      console.log(`  Unbuildable (${result.provider}): ${result.reason}`);
      return jsonResponse(result, 422);
    }
    return jsonResponse(result, 404);
  }

  console.log(`  Extracted ${result.totalFiles} files via ${result.provider || 'prebuilt'}, deps: ${result.dependencies.join(', ') || 'none'}`);
  await cachePackage(pkgName, result);
  return jsonResponse(result);
}

async function processTexLiveTar(tarData: Uint8Array, pkgName: string, tlYear: TLYear = DEFAULT_TL_YEAR): Promise<Response> {
  const tmpDir = join(tmpdir(), `texlive-${Date.now()}-${Math.random().toString(36).slice(2)}`);

  try {
    await mkdir(tmpDir, { recursive: true });
    console.log(`  Extracting TexLive ${tlYear} tar.xz (${(tarData.length / 1024).toFixed(1)} KB)`);

    const tarPath = join(tmpDir, `${pkgName}.tar.xz`);
    await writeFile(tarPath, tarData);
    await execAsync(`tar xJf "${tarPath}" -C "${tmpDir}"`);

    // Walk directory and collect files
    const files: Record<string, Uint8Array> = {};
    await walkDirectory(tmpDir, tmpDir, files);

    const extraction = processExtractedFiles(files, pkgName);

    if (extraction.fileCount === 0) {
      return jsonResponse({ error: 'No usable files found' }, 404);
    }

    console.log(`  Extracted ${extraction.fileCount} files from TexLive ${tlYear}, deps: ${extraction.dependencies.join(', ') || 'none'}`);

    const result: ProcessedPackage = {
      name: pkgName,
      files: extraction.files,
      totalFiles: extraction.fileCount,
      dependencies: extraction.dependencies,
      source: `texlive-${tlYear}`
    };

    // Use year-suffixed cache key for non-default years
    const cacheKey = tlYear !== DEFAULT_TL_YEAR ? `${pkgName}@tl${tlYear}` : pkgName;
    await cachePackage(cacheKey, result);
    return jsonResponse(result);

  } finally {
    try { await rm(tmpDir, { recursive: true }); } catch {}
  }
}

async function walkDirectory(baseDir: string, currentDir: string, files: Record<string, Uint8Array>): Promise<void> {
  // Use withFileTypes to avoid separate stat() calls
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

// ============================================================================
// CTAN Info
// ============================================================================

async function getCTANPackageInfo(pkgName: string): Promise<any> {
  if (pkgInfoCache.has(pkgName)) {
    return pkgInfoCache.get(pkgName);
  }

  try {
    const response = await fetch(`https://ctan.org/json/2.0/pkg/${pkgName}`);
    if (!response.ok) return null;
    const info = await response.json();
    if (info.errors) return null;
    pkgInfoCache.set(pkgName, info);
    return info;
  } catch {
    return null;
  }
}

async function getPackageDependencies(pkgName: string, visited = new Set<string>()): Promise<string[]> {
  if (visited.has(pkgName)) return [];
  visited.add(pkgName);

  const info = await getCTANPackageInfo(pkgName);
  if (!info?.depends) return [];

  const deps: string[] = [];
  for (const dep of info.depends) {
    const name = typeof dep === 'string' ? dep : dep.name;
    if (name && !visited.has(name)) {
      deps.push(name);
      deps.push(...await getPackageDependencies(name, visited));
    }
  }

  return [...new Set(deps)];
}

// ============================================================================
// Server
// ============================================================================

Bun.serve({
  port: PORT,
  idleTimeout: 120,

  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (req.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    // /api/stats - Cache statistics
    if (path === '/api/stats') {
      const diskPackages = await countDiskPackages();
      return jsonResponse({
        memory: {
          packages: { current: memoryCache.size, max: MEMORY_CACHE_MAX_SIZE },
          info: { current: pkgInfoCache.size, max: INFO_CACHE_MAX_SIZE },
          aliases: { current: aliasCache.size, max: ALIAS_CACHE_MAX_SIZE },
        },
        disk: {
          cacheDir: CACHE_DIR,
          packages: diskPackages,
          fileIndex: fileToPackageIndex.size,
        },
        inFlight: inFlightRequests.size,
      });
    }

    // /api/pkg/:name - Get package info
    if (path.startsWith('/api/pkg/')) {
      const pkgName = path.slice(9);
      try {
        const info = await getCTANPackageInfo(pkgName);
        return jsonResponse(info || { error: 'Not found' });
      } catch (e: any) {
        return jsonResponse({ error: e.message }, 500);
      }
    }

    // /api/deps/:name - Get dependencies
    if (path.startsWith('/api/deps/')) {
      const pkgName = path.slice(10);
      try {
        const deps = await getPackageDependencies(pkgName);
        return jsonResponse({ package: pkgName, dependencies: deps });
      } catch (e: any) {
        return jsonResponse({ error: e.message }, 500);
      }
    }

    // /api/fetch/:name - Download and extract package
    // Supports ?tlYear=2024 query param for version fallback
    if (path.startsWith('/api/fetch/')) {
      const pkgName = path.slice(11);

      // Parse tlYear query parameter
      const tlYearParam = url.searchParams.get('tlYear');
      let tlYear: TLYear = DEFAULT_TL_YEAR;
      if (tlYearParam) {
        const year = parseInt(tlYearParam, 10);
        if (SUPPORTED_TL_YEARS.includes(year as TLYear)) {
          tlYear = year as TLYear;
        } else {
          return jsonResponse({ error: `Unsupported TexLive year: ${tlYearParam}. Supported: ${SUPPORTED_TL_YEARS.join(', ')}` }, 400);
        }
      }

      // Request deduplication - include year in the key
      const dedupeKey = tlYear !== DEFAULT_TL_YEAR ? `${pkgName}@tl${tlYear}` : pkgName;
      if (inFlightRequests.has(dedupeKey)) {
        console.log(`  Deduplicating request for: ${dedupeKey}`);
        return inFlightRequests.get(dedupeKey)!;
      }

      // Create and track the fetch promise
      const fetchPromise = fetchPackage(pkgName, tlYear)
        .catch(e => {
          console.error(`Error fetching ${pkgName}:`, e);
          return jsonResponse({ error: e.message }, 500);
        })
        .finally(() => {
          inFlightRequests.delete(dedupeKey);
        });

      inFlightRequests.set(dedupeKey, fetchPromise);
      return fetchPromise;
    }

    return new Response(
      'CTAN Proxy Server\n\n' +
      'Endpoints:\n' +
      '  /api/fetch/:name[?tlYear=YYYY] - Download and extract package (default: TL2025)\n' +
      '  /api/pkg/:name                 - Get CTAN package info\n' +
      '  /api/deps/:name                - Get dependencies\n' +
      '  /api/stats                     - Cache statistics\n' +
      `\nSupported TexLive years: ${SUPPORTED_TL_YEARS.join(', ')}\n`,
      { headers: CORS_HEADERS }
    );
  }
});

// Startup message (async to count disk packages)
(async () => {
  const diskPackages = await countDiskPackages();
  console.log(`CTAN Proxy running on http://localhost:${PORT}`);
  console.log(`  Cache: ${CACHE_DIR} (${diskPackages} packages)`);
  console.log(`  Loaded: ${aliasCache.size} aliases, ${fileToPackageIndex.size} file index entries`);
})();
