import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ENGINE_VERSION } from '../src/package-metadata.js';
import { resolveRuntime } from '../src/runtime.js';

const SERVICE = 'https://packages.siglum.org';
const pointerUrl = `${SERVICE}/engines/${encodeURIComponent(ENGINE_VERSION)}/latest.json`;
const releaseUrl = `https://api.github.com/repos/SiglumProject/siglum/releases/tags/v${encodeURIComponent(ENGINE_VERSION)}`;

function descriptorFor(manifestText, baseUrl) {
  const manifest = JSON.parse(manifestText);
  return {
    schemaVersion: 1,
    engineVersion: ENGINE_VERSION,
    releaseId: manifest.releaseId,
    baseUrl,
    manifestUrl: `${baseUrl}/runtime.json`,
    manifestSha256: createHash('sha256').update(manifestText).digest('hex'),
  };
}

/** Bridge older published releases which predate the per-SDK discovery route. */
export function createDemoRuntimeFetcher(fetchResource = globalThis.fetch) {
  let legacy;
  let manifest;
  return async (input, init) => {
    const url = String(input);
    if (manifest && url === manifest.url) return new Response(manifest.text);
    const response = await fetchResource(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(15000) });
    if (url !== pointerUrl || response.status !== 404) return response;
    if (!legacy) legacy = (async () => {
      const releaseResponse = await fetchResource(releaseUrl, { cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(15000) });
      if (!releaseResponse.ok) throw new Error(`Matching engine release is unavailable: HTTP ${releaseResponse.status}`);
      const release = await releaseResponse.json();
      if (release.tag_name !== `v${ENGINE_VERSION}` || release.draft !== false || typeof release.body !== 'string') throw new Error('Invalid matching engine release');
      const urls = [...new Set(release.body.match(/https:\/\/packages\.siglum\.org\/releases\/tl\d{4}-[a-f0-9]{16}\/runtime\.json(?=$|[\s)\]>"'`])/g) || [])];
      if (urls.length !== 1) throw new Error('Matching engine release must identify one immutable runtime manifest');
      const manifestResponse = await fetchResource(urls[0], { cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(15000) });
      if (!manifestResponse.ok) throw new Error(`Matching runtime manifest is unavailable: HTTP ${manifestResponse.status}`);
      manifest = { url: urls[0], text: await manifestResponse.text() };
      return descriptorFor(manifest.text, urls[0].slice(0, -'/runtime.json'.length));
    })();
    return new Response(JSON.stringify(await legacy), { headers: { 'Content-Type': 'application/json' } });
  };
}

/** Prefer a complete staged local runtime, otherwise resolve a matching hosted one. */
export async function resolveDemoRuntime({ directory, origin, hosted = false, fetchResource = globalThis.fetch }) {
  if (!hosted) {
    let current;
    try { current = JSON.parse(await readFile(resolve(directory, '.local-release/current.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (current) {
      let manifestText;
      try { manifestText = await readFile(resolve(current.directory, 'runtime.json'), 'utf8'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (manifestText) {
        const manifest = JSON.parse(manifestText);
        if (manifest.engineVersion === ENGINE_VERSION) {
          const baseUrl = `${origin}/releases/${manifest.releaseId}`;
          const descriptor = descriptorFor(manifestText, baseUrl);
          const config = await resolveRuntime({
            baseUrl: origin,
            cacheStorage: null,
            fetch: async url => {
              if (url === `${origin}/engines/${encodeURIComponent(ENGINE_VERSION)}/latest.json`) return new Response(JSON.stringify(descriptor));
              if (url === descriptor.manifestUrl) return new Response(manifestText);
              throw new Error('Unexpected local runtime metadata request');
            },
          });
          const complete = await Promise.all(Object.entries(manifest.files).map(async ([name, metadata]) => {
            const path = resolve(current.directory, name);
            if (!path.startsWith(resolve(current.directory) + '/')) return false;
            try { return (await stat(path)).size === metadata.size; }
            catch (error) { if (error.code === 'ENOENT') return false; throw error; }
          }));
          if (complete.every(Boolean)) return { config: { ...config, ctanProxyUrl: origin, mode: 'local' }, directory: current.directory, manifest };
        }
      }
    }
  }
  const config = await resolveRuntime({ fetch: createDemoRuntimeFetcher(fetchResource), cacheStorage: null });
  return { config: { ...config, mode: 'hosted' }, directory: null, manifest: null };
}
