// Simple local dev server for siglum-engine
// Serves bundles, WASM, and proxies CTAN requests

const BUNDLES_DIR = './packages/bundles';
const DIST_DIR = './dist';

Bun.serve({
  port: 8787,
  hostname: '0.0.0.0', // Listen on all interfaces for network access
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    // CORS headers for all responses
    // Cross-Origin-Resource-Policy: cross-origin is needed for COEP on the main page
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Zotero-API-Key',
      'Cross-Origin-Resource-Policy': 'cross-origin',
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
                ...corsHeaders,
                'Content-Type': 'application/octet-stream',
                'Content-Range': `bytes ${start}-${sliceEnd - 1}/${decompressed.length}`,
                'Content-Length': String(slice.length),
              },
            });
          }
        }

        return new Response(bunFile, {
          headers: { ...corsHeaders, 'Content-Type': contentType },
        });
      }
      return new Response('Not found: ' + filePath, { status: 404, headers: corsHeaders });
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
          headers: { ...corsHeaders, 'Content-Type': contentType },
        });
      }
      return new Response('Not found: ' + filePath, { status: 404, headers: corsHeaders });
    }

    // /api/texlive/* - proxy to TexLive archive (raw .tar.xz)
    // This is preferred over CTAN because TexLive has pre-built .sty files
    if (path.startsWith('/api/texlive/')) {
      const pkg = path.slice(13);
      const texliveUrl = `https://siglum-api.vtp-ips.workers.dev/api/texlive/${pkg}`;

      console.log(`Proxying TexLive request: ${pkg}`);
      try {
        const response = await fetch(texliveUrl);
        if (!response.ok) {
          return new Response(JSON.stringify({ error: 'Package not found in TexLive' }), {
            status: response.status,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
        const body = await response.arrayBuffer();
        return new Response(body, {
          status: response.status,
          headers: { ...corsHeaders, 'Content-Type': 'application/x-xz' },
        });
      } catch (e: any) {
        console.error(`TexLive proxy error: ${e.message}`);
        return new Response(JSON.stringify({ error: e.message }), {
          status: 502,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
    }

    // /api/ctan-pkg/* - proxy to CTAN package info API
    if (path.startsWith('/api/ctan-pkg/')) {
      const pkg = path.slice(14);
      const ctanPkgUrl = `https://siglum-api.vtp-ips.workers.dev/api/ctan-pkg/${pkg}`;

      console.log(`Proxying CTAN pkg info request: ${pkg}`);
      const response = await fetch(ctanPkgUrl);
      const body = await response.text();

      return new Response(body, {
        status: response.status,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // /api/fetch/* - proxy to CTAN (or use cached)
    if (path.startsWith('/api/fetch/')) {
      const pkg = path.slice(11);
      const ctanUrl = `https://siglum-api.vtp-ips.workers.dev/api/fetch/${pkg}`;

      console.log(`Proxying CTAN request: ${pkg}`);
      const response = await fetch(ctanUrl);
      const body = await response.text();

      return new Response(body, {
        status: response.status,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // /api/zotero/* - proxy to Zotero API (CORS workaround)
    if (path.startsWith('/api/zotero/')) {
      const zoteroPath = path.slice(12);
      const zoteroUrl = `https://api.zotero.org/${zoteroPath}${url.search}`;

      // Forward the API key from request headers
      const apiKey = req.headers.get('Zotero-API-Key');
      const headers: Record<string, string> = {
        'Zotero-API-Version': '3',
      };
      if (apiKey) {
        headers['Zotero-API-Key'] = apiKey;
      }

      console.log(`Proxying Zotero request: ${zoteroPath}`);
      const response = await fetch(zoteroUrl, { headers });
      const body = await response.text();

      // Forward relevant headers from Zotero
      const responseHeaders = { ...corsHeaders, 'Content-Type': 'application/json' };
      const totalResults = response.headers.get('Total-Results');
      if (totalResults) {
        responseHeaders['Total-Results'] = totalResults;
      }

      return new Response(body, {
        status: response.status,
        headers: responseHeaders,
      });
    }

    // /src/* - serve source files (for local development)
    if (path.startsWith('/src/')) {
      const file = path.slice(5);
      const bunFile = Bun.file(`./src/${file}`);
      if (await bunFile.exists()) {
        const contentType = file.endsWith('.js') ? 'application/javascript' : 'text/plain';
        return new Response(bunFile, {
          headers: { ...corsHeaders, 'Content-Type': contentType },
        });
      }
      return new Response('Not found: ./src/' + file, { status: 404, headers: corsHeaders });
    }

    // /xzwasm.js - serve from dist
    if (path === '/xzwasm.js') {
      const bunFile = Bun.file(`${DIST_DIR}/xzwasm.js`);
      if (await bunFile.exists()) {
        return new Response(bunFile, {
          headers: { ...corsHeaders, 'Content-Type': 'application/javascript' },
        });
      }
    }

    // Health check
    if (path === '/' || path === '/health') {
      return new Response(JSON.stringify({
        status: 'ok',
        service: 'siglum-local-dev',
        dirs: { bundles: BUNDLES_DIR, dist: DIST_DIR }
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    return new Response('Not found', { status: 404, headers: corsHeaders });
  },
});

console.log('Local dev server: http://localhost:8787');
console.log('  /bundles/*    -> ./packages/bundles/');
console.log('  /wasm/*       -> ./busytex/build/wasm/');
console.log('  /src/*        -> ./src/');
console.log('  /api/texlive/ -> TexLive archive proxy (pre-built packages)');
console.log('  /api/ctan-pkg/-> CTAN package info proxy');
console.log('  /api/fetch/   -> CTAN package proxy');
console.log('  /api/zotero/  -> Zotero API proxy');
