/** Resolve a published runtime to immutable URLs for this installed SDK. */
import { ENGINE_VERSION } from './package-metadata.js';
import { TEXLIVE_YEAR } from './texlive.js';

/**
 * @typedef {Object} RuntimeDescriptor
 * @property {1} schemaVersion
 * @property {string} engineVersion
 * @property {string} releaseId
 * @property {string} baseUrl
 * @property {string} manifestUrl
 * @property {string} manifestSha256
 */

/**
 * @typedef {Object} ResolvedRuntime
 * @property {string} engineVersion
 * @property {string} releaseId
 * @property {number} texLiveYear
 * @property {string} baseUrl - Immutable runtime base URL
 * @property {string} manifestUrl
 * @property {string} manifestSha256
 * @property {string} wasmUrl
 * @property {string} jsUrl
 * @property {string} bundlesUrl
 * @property {string} ctanProxyUrl
 * @property {string} xzwasmUrl
 */

/**
 * @typedef {Object} ResolveRuntimeOptions
 * @property {string} [baseUrl] - Service base URL, defaults to https://packages.siglum.org
 * @property {typeof globalThis.fetch} [fetch] - Fetch implementation
 * @property {CacheStorage|null} [cacheStorage] - Persistent cache, or null to disable it
 */

const CACHE_NAME = 'siglum-runtime-resolutions-v1';
const SHA256 = /^[a-f0-9]{64}$/;

class RuntimeNetworkError extends Error {}

function serviceBaseUrl(value) {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
        throw new Error('Runtime service must use an HTTP(S) URL without credentials, query, or fragment');
    }
    return url.href.replace(/\/+$/, '');
}

/** @param {string} value */
async function sha256(value) {
    if (!globalThis.crypto?.subtle) throw new Error('Runtime verification requires Web Crypto in a secure browser context');
    const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

/** @param {RuntimeDescriptor} descriptor @param {string} service */
function validateDescriptor(descriptor, service) {
    if (!descriptor || descriptor.schemaVersion !== 1 || descriptor.engineVersion !== ENGINE_VERSION ||
        !/^tl\d{4}-[a-f0-9]{16}$/.test(descriptor.releaseId) ||
        !SHA256.test(descriptor.manifestSha256)) {
        throw new Error('Invalid runtime descriptor or incompatible engine version');
    }
    const base = `${service}/releases/${descriptor.releaseId}`;
    if (descriptor.baseUrl !== base || descriptor.manifestUrl !== `${base}/runtime.json`) {
        throw new Error('Runtime descriptor must reference an immutable release on the selected service');
    }
}

/** @param {RuntimeDescriptor} descriptor @param {string} manifestText @param {string} service @returns {Promise<ResolvedRuntime>} */
async function verifyRuntime(descriptor, manifestText, service) {
    validateDescriptor(descriptor, service);
    if (await sha256(manifestText) !== descriptor.manifestSha256) throw new Error('Runtime manifest SHA-256 mismatch');
    const manifest = JSON.parse(manifestText);
    if (manifest.releaseId !== descriptor.releaseId || manifest.engineVersion !== ENGINE_VERSION ||
        manifest.texLiveYear !== TEXLIVE_YEAR || !manifest.files || Array.isArray(manifest.files) ||
        typeof manifest.files !== 'object') {
        throw new Error('Runtime manifest identity does not match the installed engine');
    }
    for (const entry of Object.values(manifest.files)) {
        if (!entry || !Number.isSafeInteger(entry.size) || entry.size < 0 || !SHA256.test(entry.sha256)) {
            throw new Error('Invalid runtime manifest file metadata');
        }
    }
    for (const name of ['wasm/busytex.wasm', 'wasm/busytex.js', 'bundles.json', 'file-manifest.json', 'xzwasm.js']) {
        if (!Object.hasOwn(manifest.files, name)) throw new Error(`Runtime manifest is missing ${name}`);
    }
    const identity = { texLiveYear: manifest.texLiveYear, engineVersion: manifest.engineVersion, files: manifest.files };
    const releaseId = `tl${manifest.texLiveYear}-${(await sha256(JSON.stringify(identity))).slice(0, 16)}`;
    if (releaseId !== descriptor.releaseId) throw new Error('Runtime release ID does not match its manifest');
    const base = descriptor.baseUrl;
    return {
        engineVersion: ENGINE_VERSION,
        releaseId,
        texLiveYear: manifest.texLiveYear,
        baseUrl: base,
        manifestUrl: descriptor.manifestUrl,
        manifestSha256: descriptor.manifestSha256,
        wasmUrl: `${base}/wasm/busytex.wasm`,
        jsUrl: `${base}/wasm/busytex.js`,
        bundlesUrl: `${base}/bundles`,
        ctanProxyUrl: base,
        xzwasmUrl: `${base}/xzwasm.js`,
    };
}

/** @param {string} url @param {typeof globalThis.fetch} fetcher */
async function fetchText(url, fetcher) {
    let response;
    try {
        response = await fetcher(url, { cache: 'no-store', credentials: 'omit', redirect: 'error' });
    } catch (cause) {
        throw new RuntimeNetworkError(`Could not fetch runtime metadata from ${url}`, { cause });
    }
    if (!response.ok) {
        const message = `Runtime metadata request failed with HTTP ${response.status}: ${url}`;
        if (response.status >= 500 || response.status === 408 || response.status === 429) throw new RuntimeNetworkError(message);
        throw new Error(message);
    }
    try { return await response.text(); } catch (cause) {
        throw new RuntimeNetworkError(`Could not read runtime metadata from ${url}`, { cause });
    }
}

/**
 * Resolve once when creating a compiler, then retain its immutable URLs.
 * A verified descriptor and manifest are cached together for offline reopen.
 * Only network failures can reuse that same service/SDK cache entry.
 * @param {ResolveRuntimeOptions} [options]
 * @returns {Promise<ResolvedRuntime>}
 */
export async function resolveRuntime(options = {}) {
    const service = serviceBaseUrl(options.baseUrl ?? 'https://packages.siglum.org');
    const pointerUrl = `${service}/engines/${encodeURIComponent(ENGINE_VERSION)}/latest.json`;
    const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
    let cache = null;
    try {
        const storage = options.cacheStorage === undefined ? globalThis.caches : options.cacheStorage;
        if (storage) cache = await storage.open(CACHE_NAME);
    } catch { /* Cache Storage can be unavailable in private or restricted contexts. */ }

    try {
        const descriptor = JSON.parse(await fetchText(pointerUrl, fetcher));
        validateDescriptor(descriptor, service);
        const manifestText = await fetchText(descriptor.manifestUrl, fetcher);
        const result = await verifyRuntime(descriptor, manifestText, service);
        try {
            await cache?.put(pointerUrl, new Response(JSON.stringify({ descriptor, manifestText }), {
                headers: { 'Content-Type': 'application/json' },
            }));
        } catch { /* A cache failure does not invalidate a verified network response. */ }
        return result;
    } catch (error) {
        if (!(error instanceof RuntimeNetworkError)) throw error;
        let cached;
        try { cached = await cache?.match(pointerUrl); } catch { /* Storage access may have been revoked. */ }
        if (!cached) throw error;
        const pair = await cached.json();
        return verifyRuntime(pair.descriptor, pair.manifestText, service);
    }
}
