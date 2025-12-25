// Cloudflare Worker for siglum.org subdomains
// Routes based on hostname:
//   packages.siglum.org - R2 bundle/WASM serving
//   ctan-proxy.siglum.org - CTAN package proxy (JSON processed)
//   + /api/texlive/{pkg} - Raw TexLive .tar.xz proxy (client decompresses)

import { unzipSync } from 'fflate';

// TexLive 2023 archive base URL (has compatible package versions)
const TEXLIVE_ARCHIVE_BASE = 'https://ftp.tu-chemnitz.de/pub/tug/historic/systems/texlive/2023/tlnet-final/archive';

interface Env {
  BUNDLES: R2Bucket;
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// Bump this to invalidate edge cache for all files
const CACHE_VERSION = 'v22';

// Bump this to invalidate CTAN cache in R2 (when path mapping changes)
const CTAN_CACHE_VERSION = 'v5';

// Bootstrap aliases for packages where CTAN lookup fails
const bootstrapAliases: Record<string, string> = {
  'etex': 'etex-pkg',
  'tikz': 'pgf',
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const hostname = url.hostname;

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    // Route based on hostname
    if (hostname === 'packages.siglum.org' || hostname.includes('packages')) {
      return handlePackagesHost(url, env, request, ctx);
    }

    if (hostname === 'ctan-proxy.siglum.org' || hostname.includes('ctan')) {
      return handleCtanProxyHost(url, env);
    }

    // Default: use path-based routing (for workers.dev domain during dev)
    return handlePathBasedRouting(url, env, request, ctx);
  },
};

// packages.siglum.org - serve R2 files directly at root
async function handlePackagesHost(url: URL, env: Env, request: Request, ctx: ExecutionContext): Promise<Response> {
  const key = url.pathname.slice(1);

  if (!key || key === '' || key === 'health') {
    return jsonResponse({ status: 'ok', service: 'packages.siglum.org' });
  }

  return handleR2Request(key, env, request, ctx);
}

// ctan-proxy.siglum.org - CTAN package fetching
async function handleCtanProxyHost(url: URL, env: Env): Promise<Response> {
  let packageName = url.pathname.slice(1);

  if (packageName.startsWith('fetch/')) {
    packageName = packageName.slice(6);
  }

  if (!packageName || packageName === '' || packageName === 'health') {
    return jsonResponse({ status: 'ok', service: 'ctan-proxy.siglum.org' });
  }

  return handleCtanFetch(packageName, env);
}

// Path-based routing for workers.dev domain
async function handlePathBasedRouting(url: URL, env: Env, request: Request, ctx: ExecutionContext): Promise<Response> {
  if (url.pathname.startsWith('/bundles/')) {
    return handleR2Request(url.pathname.slice(9), env, request, ctx);
  }

  if (url.pathname.startsWith('/wasm/')) {
    return handleR2Request('wasm/' + url.pathname.slice(6), env, request, ctx);
  }

  const ctanMatch = url.pathname.match(/^\/api\/fetch\/(.+)$/);
  if (ctanMatch) {
    return handleCtanFetch(ctanMatch[1], env);
  }

  // TexLive archive proxy - returns raw .tar.xz for client-side decompression
  const texliveMatch = url.pathname.match(/^\/api\/texlive\/(.+)$/);
  if (texliveMatch) {
    return handleTexLiveProxy(texliveMatch[1], env);
  }

  // CTAN package info proxy - returns package metadata including contained_in
  const ctanPkgMatch = url.pathname.match(/^\/api\/ctan-pkg\/(.+)$/);
  if (ctanPkgMatch) {
    return handleCtanPkgInfo(ctanPkgMatch[1]);
  }

  // Serve xzwasm.js from R2 (brotli compressed)
  if (url.pathname === '/xzwasm.js') {
    const object = await env.BUNDLES.get('xzwasm.js.br');
    if (!object) {
      return new Response('Not found', { status: 404, headers: CORS_HEADERS });
    }
    return new Response(object.body, {
      headers: {
        ...CORS_HEADERS,
        'Content-Type': 'application/javascript',
        'Content-Encoding': 'br',
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    });
  }

  if (url.pathname === '/' || url.pathname === '/health') {
    return jsonResponse({
      status: 'ok',
      service: 'siglum-api',
      endpoints: {
        packages: 'packages.siglum.org or /bundles/*',
        ctan: 'ctan-proxy.siglum.org or /api/fetch/*',
      }
    });
  }

  return new Response('Not found', { status: 404, headers: CORS_HEADERS });
}

async function handleR2Request(key: string, env: Env, request: Request, ctx: ExecutionContext): Promise<Response> {
  // Use Cloudflare edge cache for R2 objects
  const cacheUrl = new URL(request.url);
  cacheUrl.searchParams.set('_cv', CACHE_VERSION); // Add version to cache key
  const cacheKey = new Request(cacheUrl.toString(), { method: 'GET' });
  const cache = caches.default;

  // Check edge cache first
  let response = await cache.match(cacheKey);
  if (response) {
    // Add header to indicate cache hit
    const headers = new Headers(response.headers);
    headers.set('X-Cache', 'HIT');
    return new Response(response.body, { headers });
  }

  try {
    // Try Brotli-compressed version first for WASM and bundle data files
    let object: R2ObjectBody | null = null;
    let isBrotli = false;

    // Check for Brotli version of WASM or bundle data files
    if (key.endsWith('.wasm') || key.endsWith('.data.gz')) {
      // For .data.gz, try .data.br instead
      const brKey = key.endsWith('.data.gz')
        ? key.replace('.data.gz', '.data.br')
        : key + '.br';
      object = await env.BUNDLES.get(brKey);
      if (object) {
        isBrotli = true;
      }
    }

    if (!object) {
      object = await env.BUNDLES.get(key);
    }

    if (!object) {
      return new Response('Not found', { status: 404, headers: CORS_HEADERS });
    }

    const headers: Record<string, string> = {
      ...CORS_HEADERS,
      'X-Cache': 'MISS',
    };

    // Config files: short cache, data files: long cache
    if (key.endsWith('.json')) {
      headers['Content-Type'] = 'application/json';
      headers['Cache-Control'] = 'public, max-age=300'; // 5 minutes for config
    } else {
      headers['Cache-Control'] = 'public, max-age=31536000, immutable'; // 1 year for data
    }

    if (key.endsWith('.gz')) {
      headers['Content-Type'] = 'application/gzip';
    } else if (key.endsWith('.br')) {
      // Brotli-compressed bundle data - serve raw, client decompresses
      headers['Content-Type'] = 'application/octet-stream';
      // NOTE: Do NOT set Content-Encoding: br here - Cloudflare would decompress it
      // Client will decompress using brotli-wasm library
    } else if (key.endsWith('.wasm')) {
      headers['Content-Type'] = 'application/wasm';
    } else if (key.endsWith('.js')) {
      headers['Content-Type'] = 'application/javascript';
    }

    // Set Content-Length from R2 object size (critical for browser progress/reliability)
    if (object.size) {
      headers['Content-Length'] = object.size.toString();
    }

    // Set Content-Encoding for Brotli-compressed files
    if (isBrotli) {
      headers['Content-Encoding'] = 'br';
    } else if (object.httpMetadata?.contentEncoding) {
      headers['Content-Encoding'] = object.httpMetadata.contentEncoding;
    }

    response = new Response(object.body, { headers });

    // Store in edge cache using waitUntil to ensure it completes
    ctx.waitUntil(cache.put(cacheKey, response.clone()));

    return response;
  } catch (e) {
    return new Response('Error fetching from R2: ' + (e as Error).message, {
      status: 500,
      headers: CORS_HEADERS,
    });
  }
}

// TexLive archive proxy - returns raw .tar.xz for client-side decompression
// Client uses xzwasm to decompress and parse TAR
async function handleTexLiveProxy(pkgName: string, env: Env): Promise<Response> {
  try {
    // Validate package name
    if (!pkgName || pkgName.length < 2 || pkgName.length > 50) {
      return jsonResponse({ error: 'Invalid package name' }, 400);
    }
    if (/[^a-zA-Z0-9_-]/.test(pkgName)) {
      return jsonResponse({ error: 'Invalid package name characters' }, 400);
    }

    const cacheKey = `texlive-cache/${pkgName}.tar.xz`;

    // Check R2 cache first
    const cached = await env.BUNDLES.get(cacheKey);
    if (cached) {
      console.log(`TexLive cache hit for ${pkgName}`);
      return new Response(cached.body, {
        headers: {
          'Content-Type': 'application/x-xz',
          'Content-Length': cached.size.toString(),
          'X-Cache': 'HIT',
          ...CORS_HEADERS,
        },
      });
    }

    // Fetch from TexLive archive
    const url = `${TEXLIVE_ARCHIVE_BASE}/${pkgName}.tar.xz`;
    console.log(`Fetching TexLive: ${url}`);

    const response = await fetch(url, {
      headers: { 'User-Agent': 'busytex-lazy/1.0' },
    });

    if (!response.ok) {
      if (response.status === 404) {
        return jsonResponse({ error: 'Package not found in TexLive 2023' }, 404);
      }
      return jsonResponse({ error: `TexLive fetch failed: ${response.status}` }, 502);
    }

    // Get the body as ArrayBuffer for caching
    const body = await response.arrayBuffer();

    // Cache in R2
    await env.BUNDLES.put(cacheKey, body, {
      httpMetadata: { contentType: 'application/x-xz' },
    });
    console.log(`Cached ${pkgName}.tar.xz to R2 (${(body.byteLength / 1024).toFixed(1)} KB)`);

    return new Response(body, {
      headers: {
        'Content-Type': 'application/x-xz',
        'Content-Length': body.byteLength.toString(),
        'X-Cache': 'MISS',
        ...CORS_HEADERS,
      },
    });
  } catch (e) {
    console.error('TexLive proxy error:', e);
    return jsonResponse({ error: 'TexLive proxy error: ' + (e as Error).message }, 500);
  }
}

// CTAN package info - returns metadata including contained_in for package lookup
async function handleCtanPkgInfo(pkgName: string): Promise<Response> {
  try {
    // Validate package name
    if (!pkgName || pkgName.length < 2 || pkgName.length > 50) {
      return jsonResponse({ error: 'Invalid package name' }, 400);
    }
    if (/[^a-zA-Z0-9_-]/.test(pkgName)) {
      return jsonResponse({ error: 'Invalid package name characters' }, 400);
    }

    // Query CTAN API
    const response = await fetch(`https://ctan.org/json/2.0/pkg/${pkgName}`, {
      headers: { 'User-Agent': 'busytex-lazy/1.0' },
    });

    if (!response.ok) {
      return jsonResponse({ error: 'Package not found' }, 404);
    }

    const data = await response.json() as any;
    if (data.errors) {
      return jsonResponse({ error: 'Package not found' }, 404);
    }

    // Return relevant fields for package lookup
    return jsonResponse({
      name: data.name || pkgName,
      contained_in: data.texlive || data.miktex || null,
      ctan_path: data.ctan?.path || null,
    });
  } catch (e) {
    console.error('CTAN pkg info error:', e);
    return jsonResponse({ error: 'CTAN lookup error: ' + (e as Error).message }, 500);
  }
}

// Full CTAN proxy - checks R2 cache first, then tries CTAN
async function handleCtanFetch(requestedPkg: string, env: Env): Promise<Response> {
  try {
    // Validate package name
    if (!requestedPkg || requestedPkg.length < 2 || requestedPkg.length > 50) {
      return jsonResponse({ error: 'Invalid package name' }, 400);
    }
    if (/[^a-zA-Z0-9_-]/.test(requestedPkg)) {
      return jsonResponse({ error: 'Invalid package name characters' }, 400);
    }

    const cacheKey = `ctan-cache/${CTAN_CACHE_VERSION}/${requestedPkg}.json`;

    // Check R2 cache first
    const cached = await env.BUNDLES.get(cacheKey);
    if (cached) {
      console.log(`Cache hit for ${requestedPkg}`);
      const cachedData = await cached.text();
      return new Response(cachedData, {
        headers: {
          'Content-Type': 'application/json',
          'X-Cache': 'HIT',
          ...CORS_HEADERS,
        },
      });
    }

    console.log(`Cache miss for ${requestedPkg}, fetching from CTAN...`);

    // Check bootstrap aliases
    let pkgName = bootstrapAliases[requestedPkg] || requestedPkg;

    console.log(`Fetching package: ${requestedPkg}${pkgName !== requestedPkg ? ` (via ${pkgName})` : ''}`);

    // Query CTAN to find the parent package (miktex or texlive field)
    const infoResponse = await fetch(`https://ctan.org/json/2.0/pkg/${pkgName}`, {
      headers: { 'User-Agent': 'busytex-lazy/1.0' },
    });

    let parentPkg = pkgName;
    if (infoResponse.ok) {
      const info = await infoResponse.json() as any;
      if (!info.errors) {
        parentPkg = info.miktex || info.texlive || pkgName;
        console.log(`CTAN says ${pkgName} is part of ${parentPkg}`);
      }
    }

    // Try CTAN TDS zip (processed server-side)
    // For packages needing older versions, client should use /api/texlive/{pkg} directly
    const ctanResult = await tryCtanTdsZip(parentPkg);
    if (ctanResult) {
      const jsonData = JSON.stringify(ctanResult);
      await env.BUNDLES.put(cacheKey, jsonData, {
        httpMetadata: { contentType: 'application/json' },
      });
      console.log(`Cached ${requestedPkg} from CTAN to R2 (${(jsonData.length / 1024).toFixed(1)} KB)`);
      return new Response(jsonData, {
        headers: {
          'Content-Type': 'application/json',
          'X-Cache': 'MISS',
          'X-Source': 'ctan',
          ...CORS_HEADERS,
        },
      });
    }

    // Try alternate: source zip from CTAN path
    const altResult = await tryCtanSourceZip(pkgName);
    if (altResult) {
      const jsonData = JSON.stringify(altResult);
      await env.BUNDLES.put(cacheKey, jsonData, {
        httpMetadata: { contentType: 'application/json' },
      });
      console.log(`Cached ${requestedPkg} from CTAN source to R2 (${(jsonData.length / 1024).toFixed(1)} KB)`);
      return new Response(jsonData, {
        headers: {
          'Content-Type': 'application/json',
          'X-Cache': 'MISS',
          'X-Source': 'ctan-source',
          ...CORS_HEADERS,
        },
      });
    }

    return jsonResponse({ error: 'Package not found' }, 404);
  } catch (e) {
    console.error('CTAN fetch error:', e);
    return jsonResponse({ error: 'CTAN fetch error: ' + (e as Error).message }, 500);
  }
}

// Try CTAN TDS (TeX Directory Structure) zip
async function tryCtanTdsZip(pkgName: string): Promise<any | null> {
  try {
    // Get package info to find install path
    const infoResp = await fetch(`https://ctan.org/json/2.0/pkg/${pkgName}`, {
      headers: { 'User-Agent': 'busytex-lazy/1.0' },
    });

    if (!infoResp.ok) return null;

    const info = await infoResp.json() as any;
    if (info.errors) return null;

    let downloadUrl: string | null = null;

    // Try install path first (TDS zip)
    if (info.install) {
      downloadUrl = `https://mirrors.ctan.org/install${info.install}`;
    } else if (info.ctan?.path) {
      // Try TDS zip from ctan path
      downloadUrl = `https://mirrors.ctan.org${info.ctan.path}.tds.zip`;
    }

    if (!downloadUrl) return null;

    console.log(`Trying CTAN TDS: ${downloadUrl}`);
    const response = await fetch(downloadUrl, {
      headers: { 'User-Agent': 'busytex-lazy/1.0' },
      redirect: 'follow',
    });

    if (!response.ok) {
      // Try alternate TDS location
      if (info.ctan?.path && !downloadUrl.includes('.tds.zip')) {
        const altUrl = `https://mirrors.ctan.org${info.ctan.path}.tds.zip`;
        const altResp = await fetch(altUrl, {
          headers: { 'User-Agent': 'busytex-lazy/1.0' },
          redirect: 'follow',
        });
        if (altResp.ok) {
          return processZip(await altResp.arrayBuffer(), pkgName);
        }
      }
      return null;
    }

    return processZip(await response.arrayBuffer(), pkgName);
  } catch (e) {
    console.log(`TDS zip failed for ${pkgName}:`, e);
    return null;
  }
}

// Try CTAN source zip
async function tryCtanSourceZip(pkgName: string): Promise<any | null> {
  try {
    const infoResp = await fetch(`https://ctan.org/json/2.0/pkg/${pkgName}`, {
      headers: { 'User-Agent': 'busytex-lazy/1.0' },
    });

    if (!infoResp.ok) return null;

    const info = await infoResp.json() as any;
    if (info.errors || !info.ctan?.path) return null;

    const downloadUrl = `https://mirrors.ctan.org${info.ctan.path}.zip`;
    console.log(`Trying CTAN source: ${downloadUrl}`);

    const response = await fetch(downloadUrl, {
      headers: { 'User-Agent': 'busytex-lazy/1.0' },
      redirect: 'follow',
    });

    if (!response.ok) return null;

    return processZip(await response.arrayBuffer(), pkgName);
  } catch (e) {
    console.log(`Source zip failed for ${pkgName}:`, e);
    return null;
  }
}

// Process a ZIP file and extract relevant TeX files
function processZip(zipBuffer: ArrayBuffer, pkgName: string): any {
  const zipData = new Uint8Array(zipBuffer);
  console.log(`Extracting ZIP (${(zipData.length / 1024).toFixed(1)} KB)`);

  const files = unzipSync(zipData);
  const result: Record<string, { content: string; encoding: string }> = {};

  const texExtensions = ['.sty', '.cls', '.def', '.cfg', '.tex', '.fd', '.clo', '.ltx'];
  const fontExtensions = ['.pfb', '.pfm', '.afm', '.tfm', '.vf', '.map', '.enc'];
  const detectedDeps = new Set<string>();

  for (const [filePath, content] of Object.entries(files)) {
    const ext = filePath.substring(filePath.lastIndexOf('.')).toLowerCase();
    const fileName = filePath.split('/').pop() || '';

    // Skip docs and source directories (paths may or may not have leading slash)
    if (filePath.includes('/doc/') || filePath.startsWith('doc/') ||
        filePath.includes('/source/') || filePath.startsWith('source/')) continue;

    if (texExtensions.includes(ext)) {
      // Determine target path - preserve TDS structure
      let targetDir = `/texlive/texmf-dist/tex/latex/${pkgName}`;

      if (filePath.includes('/tex/latex/')) {
        const match = filePath.match(/\/tex\/latex\/([^/]+)/);
        if (match) targetDir = `/texlive/texmf-dist/tex/latex/${match[1]}`;
      } else if (filePath.includes('/tex/generic/')) {
        const match = filePath.match(/\/tex\/generic\/([^/]+)/);
        if (match) targetDir = `/texlive/texmf-dist/tex/generic/${match[1]}`;
      }

      const textContent = new TextDecoder().decode(content);
      result[`${targetDir}/${fileName}`] = {
        content: textContent,
        encoding: 'text',
      };

      // Scan for \RequirePackage dependencies
      const reqMatches = textContent.matchAll(/\\RequirePackage(?:\[[^\]]*\])?\{([^}]+)\}/g);
      for (const match of reqMatches) {
        const deps = match[1].split(',').map(d => d.trim());
        deps.filter(d => /^[a-zA-Z][a-zA-Z0-9-]*$/.test(d)).forEach(d => detectedDeps.add(d));
      }
    } else if (fontExtensions.includes(ext)) {
      // Font files - preserve TDS structure
      // Match paths like "fonts/type1/public/pkg/..." or "pkg/fonts/tfm/..."
      const fontsMatch = filePath.match(/(?:^|\/)fonts\/(type1|tfm|vf|afm|enc|map|opentype|truetype)(\/[^/]+)*\/([^/]+)$/);
      let targetDir: string;

      if (fontsMatch) {
        // Extract the fonts/... portion of the path
        const fontsIdx = filePath.indexOf('fonts/');
        const fontsPath = filePath.substring(fontsIdx, filePath.lastIndexOf('/'));
        targetDir = `/texlive/texmf-dist/${fontsPath}`;
      } else {
        // Fallback: place by extension in appropriate TDS location
        const extToDir: Record<string, string> = {
          '.pfb': 'fonts/type1/public',
          '.pfm': 'fonts/type1/public',
          '.afm': 'fonts/afm/public',
          '.tfm': 'fonts/tfm/public',
          '.vf': 'fonts/vf/public',
          '.map': 'fonts/map/dvips',
          '.enc': 'fonts/enc/dvips',
        };
        const baseDir = extToDir[ext] || 'fonts/type1/public';
        targetDir = `/texlive/texmf-dist/${baseDir}/${pkgName}`;
      }

      // Encode binary fonts as base64
      const base64Content = arrayBufferToBase64(content);
      result[`${targetDir}/${fileName}`] = {
        content: base64Content,
        encoding: 'base64',
      };
    }
  }

  const fileCount = Object.keys(result).length;
  const dependencies = [...detectedDeps].filter(d => d !== pkgName);
  console.log(`Extracted ${fileCount} files, deps: ${dependencies.join(', ') || 'none'}`);

  if (fileCount === 0) {
    return null;
  }

  return {
    name: pkgName,
    files: result,
    totalFiles: fileCount,
    dependencies,
  };
}

function arrayBufferToBase64(buffer: Uint8Array): string {
  let binary = '';
  const len = buffer.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(buffer[i]);
  }
  return btoa(binary);
}

function jsonResponse(data: any, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...CORS_HEADERS,
    },
  });
}
