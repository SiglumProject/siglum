import { createToolRegistry, ProcessToolSession, PROCESS_TOOL_MAILBOX_BYTES } from './process-tools.js';
import { SYNC_IO_BYTES, respondSyncInput } from './checkpoint/sync-io.mjs';
/**
 * @module @siglum/engine/compiler
 * Main SiglumCompiler class - orchestrates LaTeX compilation in the browser.
 */

import { runAuxiliaryTool } from './auxiliary-tools.js';
import { normalizeProjectPath } from './project-paths.js';
import { BundleManager, detectEngine, extractPreamble, extractFontNames, getKomaExtendedSize, hashPreamble } from './bundles.js';
import { legacyTkzSource, loadLegacyTkzFiles, shouldRetryLegacyTkz, shouldRetryLegacyTkzFct } from './legacy-tkz.js';
import { translateLegacySiunitxOptions } from './legacy-siunitx.js';
import { enableLegacyKomaFonts } from './legacy-koma.js';
import { translateLegacyChemfig } from './legacy-chemfig.js';

const legacySourceRecoveries = [
    {
        name: 'siunitx',
        message: 'Retrying legacy siunitx option per=slash as per-mode=symbol',
        translate: translateLegacySiunitxOptions,
    },
    {
        name: 'KOMA-Script',
        message: 'Retrying legacy KOMA-Script font commands with enabledeprecatedfontcommands',
        translate: enableLegacyKomaFonts,
    },
    {
        name: 'Chemfig',
        message: 'Retrying legacy Chemfig atom spacing and Lewis commands',
        translate: translateLegacyChemfig,
    },
];

/**
 * @typedef {Object} SiglumCompilerOptions
 * @property {string} [bundlesUrl] - URL to bundles directory
 * @property {string} [wasmUrl] - URL to busytex.wasm
 * @property {'pdflatex'|'xelatex'} [initialEngine] - Startup/preload hint only; later compilations may select either engine.
 * @property {string} [jsUrl] - URL to busytex.js (derived from wasmUrl if not provided)
 * @property {{apiUrl:string, jsUrl:string, wasmUrl:string, identity:string, maximumBytes?:number, syncInputs?:boolean, engines?:Array<string>}} [checkpointRuntime] - Experimental runtime with native checkpoint exports; uses the normal resolver and worker
 * @property {string|null} [workerUrl] - URL to worker.js (required for bundlers like Vite/Webpack)
 * @property {string} [ctanProxyUrl] - CTAN proxy URL
 * @property {string} [xzwasmUrl] - XZ decompression WASM URL
 * @property {(msg: string) => void} [onLog] - Logging callback
 * @property {(stage: string, detail: string) => void} [onProgress] - Progress callback
 * @property {boolean} [enableCtan] - Enable CTAN fetching (default: true if ctanProxyUrl provided)
 * @property {boolean} [enableProjectFileDeltas] - Reuse unchanged project files in the active worker (default: true)
 * @property {boolean} [enableLazyFS] - Enable lazy filesystem (default: true)
 * @property {import('./process-tools.js').ToolProvider[]} [tools] - Explicit isolated tool providers
 * @property {Function} [toolRunner] - Optional isolated auxiliary-tool provider; invoked only for generated tool inputs
 * @property {string[]} [rangeFontBundles] - pdfLaTeX font bundles fetched on demand (default: Latin Modern Type 1, Computer Modern and CM-Super when supported)
 * @property {boolean} [enableDocCache] - Enable document cache (default: true)
 * @property {number} [maxRetries] - Max fetch retries per compile (default: 15)
 * @property {boolean} [verbose] - Log TeX stdout (default: false)
 * @property {string[]|Object<string, string[]>} [eagerBundles] - Bundles to load eagerly
 */

/**
 * @typedef {Object} CompileOptions
 * @property {{path:string, offsetUTF16?:number, line?:number}} [checkpointFocus] - Current editor location for automatic checkpoint placement
 * @property {string} [checkpointProject] - Stable identity for checkpoint ownership
 * @property {boolean} [forceFull] - Bypass native checkpoint reuse for this operation
 * @property {string} [projectId] - Stable local project identity for full build checkpoints
 * @property {string} [previewChapter] - Literal \include argument to preview using the last full build
 * @property {string} [engine] - 'pdflatex', 'xelatex', or 'lualatex'
 * @property {boolean} [useCache] - Use document cache
 * @property {boolean} [usePreambleCache] - Reuse or prepare serialized preambles; false uses full source. Default true.
 * @property {Object<string, string|Uint8Array>} [additionalFiles] - Files keyed by paths relative to the virtual project root, e.g. figures/plot.pdf
 * @property {string} [mainFile] - Main source path relative to the virtual project root, e.g. revision/main.tex.
 * TeX resolves relative inputs from this file's directory. Default document.tex.
 */

/**
 * @typedef {Object} CompileMetadata
 * @property {string|null} [syncTexData] - SyncTeX source mapping
 * @property {Object} [stats] - Compilation statistics
 * @property {string} [log] - Full TeX compilation log
 * @property {number} [exitCode] - TeX exit code
 * @property {boolean} [cached] - True for a cached PDF
 */
/**
 * @typedef {Object} CompileSuccess
 * @property {true} success
 * @property {Uint8Array<ArrayBuffer>} pdf - Compiled PDF bytes, directly usable as a BlobPart
 * @property {never} [error]
 */
/**
 * @typedef {Object} CompileFailure
 * @property {false} success
 * @property {string} error - Actionable compilation failure
 * @property {never} [pdf]
 */
/** @typedef {CompileMetadata & (CompileSuccess | CompileFailure)} CompileResult */
import { CTANFetcher } from './ctan.js';

// Module-level tracking to prevent multiple workers across all instances
let _globalActiveWorker = null;
let _globalWorkerId = 0;
import { fileSystem } from '@siglum/filesystem';
import {
    getAuxCache,
    getBundleFromCache,
    saveBundleToCache,
    saveAuxCache,
    getCachedPdf,
    saveCachedPdf,
    hashDocument,
    getFmtPath,
    clearCTANCache,
    saveWasmMemorySnapshot,
} from './storage.js';

// Base64 helpers for persisting small binary blobs (preamble side-effect files)
// in a JSON cache entry. Chunked to avoid call-stack limits on large inputs.
function bytesToBase64(bytes) {
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
}

function base64ToBytes(b64) {
    const binary = atob(b64);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
}

// Ensure fmt-cache mount exists
let fmtCacheMounted = false;
async function ensureFmtCacheMount() {
    if (fmtCacheMounted) return true;
    try {
        await fileSystem.mountAuto('/fmt-cache');
        fmtCacheMounted = true;
        return true;
    } catch (e) {
        console.warn('Failed to mount fmt-cache:', e);
        return false;
    }
}

/**
 * Browser-based LaTeX compiler using WebAssembly.
 * Handles bundle loading, CTAN fetching, and compilation orchestration.
 */
// IDs correlate jobs in this module; no secure-context-only UUID API is needed.
let nextCompilerRequestId = 0;
const MAX_PROJECT_SNAPSHOT_BYTES = 64 * 1024 * 1024;
const MAX_CTAN_SNAPSHOT_BYTES = 32 * 1024 * 1024;

async function buildStateDigest(content) {
    const data = typeof content === 'string' ? new TextEncoder().encode(content) : content;
    const bytes = await globalThis.crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}

function chapterPreviewSource(source, chapter, mainFile, current, cached) {
    if (!/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(chapter)) {
        throw new Error('Choose a chapter named by a literal \\include command.');
    }

    const begin = /^[ \t]*\\begin\{document\}/m.exec(source);
    const withoutComments = source.replace(/(?<!\\)%[^\r\n]*/g, '');
    const includes = [...withoutComments.matchAll(/\\include\s*\{([A-Za-z0-9_/-]+)\}/g)].map(match => match[1]);
    if (!begin || !includes.includes(chapter) || /\\includeonly\b/.test(withoutComments)) {
        throw new Error('Chapter preview requires a literal \\include and a full-build root without \\includeonly.');
    }

    const previous = cached?.checkpoint;
    const files = cached?.files;
    const directory = mainFile.slice(0, mainFile.lastIndexOf('/') + 1);
    const chapterPath = directory + chapter + '.tex';
    if (!files || previous?.main !== current.main || !Array.isArray(previous.files) || previous.files.length !== current.files.length ||
        !current.files.some(([path]) => path === chapterPath) ||
        current.files.some(([path, digest], index) =>
            path !== previous.files[index][0] || (path !== chapterPath && digest !== previous.files[index][1])) ||
        !includes.every(name => files['@/' + directory + name + '.aux']?.includes('\\@setckpt'))) {
        throw new Error('Run a successful full build before previewing this chapter.');
    }
    return source.slice(0, begin.index) + '\\includeonly{' + chapter + '}' + source.slice(begin.index);
}

function sameProjectFile(previous, next) {
    if (typeof next === 'string') return previous === next;
    if (!(previous instanceof Uint8Array) || previous.byteLength !== next.byteLength) return false;
    let i = 0;
    if (previous.byteOffset % 4 === 0 && next.byteOffset % 4 === 0) {
        const words = Math.floor(next.byteLength / 4);
        const left = new Uint32Array(previous.buffer, previous.byteOffset, words);
        const right = new Uint32Array(next.buffer, next.byteOffset, words);
        let word = 0;
        for (; word + 8 <= words; word += 8) {
            if ((left[word] ^ right[word]) | (left[word + 1] ^ right[word + 1]) |
                (left[word + 2] ^ right[word + 2]) | (left[word + 3] ^ right[word + 3]) |
                (left[word + 4] ^ right[word + 4]) | (left[word + 5] ^ right[word + 5]) |
                (left[word + 6] ^ right[word + 6]) | (left[word + 7] ^ right[word + 7])) return false;
        }
        for (; word < words; word++) {
            if (left[word] !== right[word]) return false;
        }
        i = words * 4;
    }
    for (; i < next.byteLength; i++) {
        if (previous[i] !== next[i]) return false;
    }
    return true;
}

function copyFileBytes(data) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice();
}

export class SiglumCompiler {
    /**
     * @param {SiglumCompilerOptions} [options] - Compiler options
     */
    constructor(options = {}) {
        this.bundlesUrl = options.bundlesUrl || 'packages/bundles';
        this.wasmUrl = options.wasmUrl || 'busytex.wasm';
        this.initialEngine = options.initialEngine === 'xelatex' ? 'xelatex' : 'pdflatex';
        this.checkpointRuntime = options.checkpointRuntime || null;
        this.runtimeKey = this.wasmUrl.match(/\/releases\/(tl2026-[a-f0-9]{16})(?:\/|$)/)?.[1] || 'tl2026-r1';
        if (this.checkpointRuntime) this.runtimeKey += ':checkpoint:' + this.checkpointRuntime.identity;
        this.jsUrl = options.jsUrl || null; // Derived from wasmUrl if not provided
        this.workerUrl = options.workerUrl || null; // Will use embedded worker if not provided
        this.ctanProxyUrl = options.ctanProxyUrl || null;
        this.toolRunner = options.toolRunner || null;
        this.tools = createToolRegistry(options.tools);
        this.toolCommands = [...this.tools.values()].filter(tool => tool.kind === 'process').map(tool => tool.command);
        this.toolIdentity = [...this.tools.values()].map(({ command, kind, revision }) => ({ command, kind, revision }));
        this.auxiliaryToolCommands = [...this.tools.values()].filter(tool => tool.kind === 'auxiliary').map(tool => tool.command);
        if (this.tools.size || this.toolRunner) {
            const unversioned = this.toolRunner || [...this.tools.values()].some(tool => !tool.revision);
            const instance = unversioned ? (globalThis.crypto?.randomUUID?.() || Date.now() + '-' + Math.random()) : null;
            this.runtimeKey += ':tools:' + hashPreamble(JSON.stringify([this.toolIdentity, instance]));
        }
        // Compatibility for the earlier optional Biber runner; new providers register explicitly.
        if (this.toolRunner && !this.auxiliaryToolCommands.includes('biber')) this.auxiliaryToolCommands.push('biber');
        this.xzwasmUrl = options.xzwasmUrl || (this.ctanProxyUrl ? `${this.ctanProxyUrl}/xzwasm.js` : './src/xzwasm.js');

        this.bundleManager = new BundleManager({
            bundleBase: this.bundlesUrl,
            onLog: (msg) => this._log(msg),
        });

        this.ctanFetcher = new CTANFetcher({
            proxyUrl: this.ctanProxyUrl,
            xzwasmUrl: this.xzwasmUrl,
            onLog: (msg) => this._log(msg),
        });

        this.worker = null;
        this.workerReady = false;
        this.workerRangeFonts = false;
        this.workerCmMetrics = false;
        this.workerCmSuperRanges = false;
        this.wasmModule = null;
        this._initWorkerPromise = null;
        this._workerInitEpoch = 0;
        this._cancelWorkerInit = null;
        this._initPromise = null;
        this.pendingCompile = null;
        this._compileTask = null;
        this._projectSnapshot = null;
        this._ctanSnapshot = null;
        this._ctanCacheGeneration = 0;
        this.workerProjectFileDeltas = false;
        this.workerCtanFileDeltas = false;
        this.workerChapterPreview = false;
        this.workerLegacyTkz = false;
        this.workerFormatRequestIds = false;
        this.workerSourceAnalysis = false;
        this.pendingAnalysis = new Map();
        this.formatGenerationPromise = null;
        this.formatGenerationInput = null;
        this._formatEpoch = 0;

        this.onLog = options.onLog || (() => {});
        this.onProgress = options.onProgress || (() => {});

        // Options
        // Enable CTAN if explicitly set, otherwise default to true only if ctanProxyUrl is provided
        this.enableCtan = options.enableCtan ?? (this.ctanProxyUrl !== null);
        this.enableLazyFS = options.enableLazyFS !== false;
        this.enableProjectFileDeltas = options.enableProjectFileDeltas !== false;
        this.enableDocCache = options.enableDocCache !== false;
        this.maxRetries = options.maxRetries ?? 15;  // Max CTAN/bundle fetch retries per compile
        this.verbose = options.verbose ?? false;  // Log TeX stdout (adds ~4000 postMessage calls)

        // Eager bundle loading - bundles to load immediately instead of deferring
        // Can be an array (applies to all engines) or object keyed by engine
        // Example: ['cm-super'] or { pdflatex: ['cm-super'], xelatex: [] }
        this.eagerBundles = options.eagerBundles || {};
        this.useDefaultFontRanges = options.rangeFontBundles == null;
        this.useCmSuperRanges = this.useDefaultFontRanges || options.rangeFontBundles.includes('cm-super');
        this.rangeFontBundles = this.maxRetries >= 3
            ? (options.rangeFontBundles ?? ['fonts-lm-type1', 'fonts-cm', 'cm-super']).filter(name => name === 'fonts-lm-type1' || name === 'fonts-cm' || name === 'cm-super')
            : [];

        // Range request coalescing - batch nearby requests to reduce HTTP overhead
        this._pendingRangeRequests = new Map(); // bundleName -> [{requestId, start, end}]
        this._rangeRequestTimer = null;
        this._rangeRequestDebounceMs = 10; // Wait 10ms to batch requests
        this._rangeCoalesceGapBytes = 64 * 1024; // Coalesce ranges within 64KB of each other
    }

    _log(msg) {
        this.onLog(msg);
    }

    /**
     * Get eager bundles for a specific engine.
     * Eager bundles are loaded immediately instead of being deferred.
     * @param {string} engine - The engine (pdflatex, xelatex, lualatex)
     * @returns {string[]} List of bundle names to load eagerly
     */
    getEagerBundles(engine) {
        if (Array.isArray(this.eagerBundles)) {
            // Global list applies to all engines
            return this.eagerBundles;
        }
        // Per-engine configuration
        return this.eagerBundles[engine] || [];
    }

    _getEffectiveEagerBundles(engine) {
        const eager = this.getEagerBundles(engine);
        const available = this.bundleManager.bundleDeps?.deferred?.includes('cm-super') ||
            this.bundleManager.bundleRegistry?.has('cm-super');
        if (engine !== 'pdflatex' || !this.useCmSuperRanges || !available || eager.includes('cm-super')) {
            return eager;
        }
        const canDefer = this.enableLazyFS && this.workerRangeFonts && this.workerCmSuperRanges &&
            this.rangeFontBundles.includes('cm-super');
        return canDefer ? eager : [...eager, 'cm-super'];
    }

    _selectRangeFontBundles(engine, bundleNames) {
        if (engine !== 'pdflatex' || !this.enableLazyFS || !this.workerRangeFonts) return [];
        const eager = this.getEagerBundles(engine);
        return this.rangeFontBundles.filter(name => {
            if (eager.includes(name)) return false;
            if (name === 'cm-super') return this.workerCmSuperRanges &&
                (bundleNames.includes(name) || this.bundleManager.bundleDeps?.deferred?.includes(name));
            return bundleNames.includes(name) &&
                (name !== 'fonts-cm' || !this.useDefaultFontRanges || this.workerCmMetrics);
        });
    }

    /**
     * Preload bundles into memory cache.
     * Call this to eagerly load bundles before compilation.
     * Useful for loading large deferred bundles (like cm-super) in advance.
     *
     * @example
     * // Preload cm-super before first compile
     * await compiler.preloadBundles(['cm-super']);
     *
     * @param {string[]} bundleNames - Bundles to preload
     * @returns {Promise<{loaded: string[], failed: string[]}>}
     */
    async preloadBundles(bundleNames) {
        await this.bundleManager.loadManifest();

        const loaded = [];
        const failed = [];

        // Load bundles in parallel
        const promises = bundleNames.map(async (bundleName) => {
            try {
                if (!this.bundleManager.bundleExists(bundleName)) {
                    this._log(`Preload: bundle ${bundleName} does not exist`);
                    failed.push(bundleName);
                    return;
                }

                const data = await this.bundleManager.loadBundle(bundleName);
                if (data) {
                    this._log(`Preloaded bundle: ${bundleName} (${(data.byteLength / 1024 / 1024).toFixed(1)}MB)`);
                    loaded.push(bundleName);
                } else {
                    failed.push(bundleName);
                }
            } catch (e) {
                this._log(`Preload failed for ${bundleName}: ${e.message}`);
                failed.push(bundleName);
            }
        });

        await Promise.all(promises);
        return { loaded, failed };
    }

    /**
     * Pre-warm the compiler in the background.
     * Call this early (e.g., on page load) to eliminate cold start latency.
     * The promise resolves when initialization is complete, but you don't need to await it.
     *
     * @example
     * // On app mount, before user starts typing
     * const compiler = new BusyTeXCompiler(options);
     * compiler.prewarm(); // Fire and forget - init happens in background
     *
     * // Later, when user wants to compile:
     * await compiler.compile(source); // Already warmed up!
     *
     * @returns {Promise<void>} Resolves when initialization is complete
     */
    prewarm() {
        // Return existing init promise if already warming/initialized
        if (this._prewarmPromise) {
            return this._prewarmPromise;
        }

        const task = this.init().catch(e => {
            if (this._prewarmPromise === task) this._prewarmPromise = null;
            this._log('Prewarm failed: ' + e.message);
            throw e;
        });
        this._prewarmPromise = task;
        return task;
    }

    /**
     * Check if compiler is ready (initialized and warmed up)
     * @returns {boolean}
     */
    isReady() {
        return this.workerReady && this.wasmModule !== undefined;
    }

    /**
     * Initialize the compiler. Loads WASM, manifests, and prepares the worker.
     * @returns {Promise<void>}
     */
    init() {
        // Memoize so concurrent callers share one in-flight init (avoids a second
        // WASM fetch/compile + worker). Returns the same promise object until it
        // settles; on failure the memo is cleared so a later call can retry.
        if (!this._initPromise) {
            const task = this._doInit().catch(e => {
                if (this._initPromise === task) this._initPromise = null;
                throw e;
            });
            this._initPromise = task;
        }
        return this._initPromise;
    }

    async _doInit() {
        const epoch = this._workerInitEpoch;
        this._log('Initializing Siglum compiler...');

        // Load manifests + WASM in parallel
        await Promise.all([
            this._loadManifests(),
            this._loadWasm(),
        ]);

        if (epoch !== this._workerInitEpoch) throw new Error('Compiler worker terminated');
        await this._initWorker();

        this._log('Compiler initialized');
    }

    async _loadManifests() {
        await this.bundleManager.loadManifest();
        await this.bundleManager.loadBundleDeps();
    }

    async _loadWasm() {
        const useCheckpoint = !!this.checkpointRuntime && this.initialEngine === 'pdflatex';
        const loadingUrl = useCheckpoint ? this.checkpointRuntime.wasmUrl : this.wasmUrl;
        const cacheKey = useCheckpoint ? new URL(loadingUrl, window.location.href) : null;
        cacheKey?.searchParams.set('__siglum_runtime', this.checkpointRuntime.identity);
        const storageUrl = cacheKey?.href || loadingUrl;
        this._log('Loading WASM...');
        const startTime = performance.now();

        // Primary path: Cache API + compileStreaming()
        // V8 automatically caches compiled machine code when compileStreaming is used.
        // On subsequent loads, it deserializes native code instead of recompiling from bytes.
        if (typeof WebAssembly.compileStreaming === 'function' && typeof caches !== 'undefined') {
            try {
                const cache = await caches.open('siglum-wasm-tl2026-v2');
                let response = await cache.match(storageUrl);
                if (response) {
                    try {
                        this.wasmModule = await WebAssembly.compileStreaming(response);
                        const elapsed = (performance.now() - startTime).toFixed(0);
                        this._log(`WASM loaded from cache + compileStreaming in ${elapsed}ms`);
                        return;
                    } catch (e) {
                        // Cached response may be corrupt or stale — delete and fall through
                        this._log('Cached WASM compile failed, evicting: ' + e.message);
                        cache.delete(storageUrl).catch(() => {});
                    }
                }

                // Not cached (or cache evicted) — fetch from network
                response = await fetch(loadingUrl);
                if (response.ok) {
                    // Clone before consuming — only cache after compile succeeds
                    const responseToCache = response.clone();
                    this.wasmModule = await WebAssembly.compileStreaming(response);
                    cache.put(storageUrl, responseToCache).catch(() => {});
                    const elapsed = (performance.now() - startTime).toFixed(0);
                    this._log(`WASM fetched + compileStreaming in ${elapsed}ms`);
                    return;
                }
                // Non-ok response — fall through to fallback (don't re-fetch)
            } catch (e) {
                this._log('compileStreaming path failed, falling back: ' + e.message);
            }
        }

        // Fallback: fetch + compile (no V8 code caching, but works everywhere)
        try {
            const response = await fetch(loadingUrl);
            if (!response.ok) {
                throw new Error(`WASM fetch failed: ${response.status} ${response.statusText}`);
            }
            const wasmBytes = new Uint8Array(await response.arrayBuffer());
            const fetchElapsed = (performance.now() - startTime).toFixed(0);

            const compileStart = performance.now();
            this.wasmModule = await WebAssembly.compile(wasmBytes);
            const compileElapsed = (performance.now() - compileStart).toFixed(0);
            this._log(`WASM fetched in ${fetchElapsed}ms, compiled in ${compileElapsed}ms (fallback)`);
        } catch (e) {
            this._log('WASM load failed: ' + e.message);
            throw e;
        }
    }

    async _initWorker() {
        if (this._initWorkerPromise) {
            return this._initWorkerPromise;
        }
        if (this.workerReady) return;

        const task = this._doInitWorker(this._workerInitEpoch);
        this._initWorkerPromise = task;
        try {
            await task;
        } finally {
            if (this._initWorkerPromise === task) this._initWorkerPromise = null;
        }
    }

    async _doInitWorker(epoch) {
        const useSyncInput = this.checkpointRuntime?.syncInputs && globalThis.crossOriginIsolated
            && typeof SharedArrayBuffer !== 'undefined';
        const syncInputBuffer = useSyncInput ? new SharedArrayBuffer(SYNC_IO_BYTES) : null;
        const wasmUrlObj = new URL(this.wasmUrl, window.location.href);
        const busytexJsUrl = this.jsUrl
            ? new URL(this.jsUrl, window.location.href).href
            : new URL('busytex.js', wasmUrlObj.href).href;

        // Get worker code - use external URL or fetch from package
        let workerUrl = this.workerUrl;
        let generatedWorkerUrl = false;
        if (!workerUrl) {
            // Fetch worker.js and create blob URL
            const workerResponse = await fetch(new URL('./worker.js', import.meta.url));
            if (!workerResponse.ok) throw new Error('Failed to fetch compiler worker: ' + workerResponse.status);
            const workerCode = await workerResponse.text();
            if (epoch !== this._workerInitEpoch) throw new Error('Compiler worker terminated');
            const blob = new Blob([workerCode], { type: 'application/javascript' });
            workerUrl = URL.createObjectURL(blob);
            generatedWorkerUrl = true;
        }

        const workerId = ++_globalWorkerId;

        let worker;
        try {
            worker = new Worker(workerUrl);
        } catch (error) {
            if (generatedWorkerUrl) URL.revokeObjectURL(workerUrl);
            throw error;
        }
        // End the old owner's handshake or requests before replacing its worker.
        if (_globalActiveWorker && _globalActiveWorker.owner !== this) {
            console.warn('[SiglumCompiler] WARNING: Another worker already exists! Terminating old worker.');
            _globalActiveWorker.owner.terminate();
        }
        worker._workerId = workerId;
        this.worker = worker;
        _globalActiveWorker = { worker, owner: this };
        this._projectSnapshot = null;
        this._ctanSnapshot = null;

        // The combined runtime uses fresh heaps. The optional checkpoint runtime
        // supplies its own guarded continuation; legacy whole-heap snapshots stay off.
        const memorySnapshot = null;

        // Send init message
        return new Promise((resolve, reject) => {
            let settled = false;
            const finish = () => {
                if (settled) return false;
                settled = true;
                clearTimeout(timeout);
                if (this._cancelWorkerInit === fail) this._cancelWorkerInit = null;
                if (generatedWorkerUrl) URL.revokeObjectURL(workerUrl);
                return true;
            };
            const fail = (error) => {
                if (!finish()) return;
                worker.onmessage = null;
                worker.onerror = null;
                this._stopSyncInput(worker);
                worker.terminate();
                if (this.worker === worker) {
                    this.worker = null;
                    this.workerReady = false;
                }
                if (_globalActiveWorker?.worker === worker) _globalActiveWorker = null;
                reject(error);
            };
            const timeout = setTimeout(() => fail(new Error('Worker init timeout')), 30000);
            this._cancelWorkerInit = fail;
            worker.onerror = (e) => fail(new Error('Worker initialization failed: ' + (e.message || 'worker script error')));
            worker.__siglumSyncInput = syncInputBuffer;
            worker.__siglumSyncAcks = new Map();
            const handleMessage = (e) => {
                if (this.worker === worker) this._handleWorkerMessage(e);
            };
            worker.onmessage = (e) => {
                if (this.worker !== worker) return;
                if (e.data.type === 'ready') {
                    if (!finish()) return;
                    this.workerReady = true;
                    this.workerRangeFonts = e.data.rangeFonts === true;
                    this.workerProjectFileDeltas = e.data.projectFileDeltas === true;
                    this.workerCtanFileDeltas = e.data.ctanFileDeltas === true;
                    this.workerChapterPreview = e.data.chapterPreview === true;
                    this.workerLegacyTkz = e.data.legacyTkz === true;
                    this.workerFormatRequestIds = e.data.formatRequestIds === true;
                    this.workerSourceAnalysis = e.data.sourceAnalysis === true;
                    this.workerCmMetrics = e.data.cmMetrics === true;
                    this.workerCmSuperRanges = e.data.cmSuperRanges === true;
                    worker.onmessage = handleMessage;
                    worker.onerror = (error) => {
                        if (this.worker === worker) this._handleWorkerError(error);
                    };
                    resolve();
                    this._log('Worker ready');
                } else {
                    handleMessage(e);
                }
            };

            try {
                const initMsg = {
                    type: 'init',
                    workerId,
                    initialEngine: this.initialEngine,
                    syncInputBuffer,
                    syncInputCatalogUrl: useSyncInput ? this.bundlesUrl + '/file-to-package.json' : null,
                    wasmModule: this.checkpointRuntime && this.initialEngine === 'pdflatex' ? null : this.wasmModule,
                    wasmUrl: wasmUrlObj.href,
                    checkpointRuntime: this.checkpointRuntime ? {
                        ...this.checkpointRuntime, wasmModule: this.initialEngine === 'pdflatex' ? this.wasmModule : null,
                    } : null,
                    busytexJsUrl,
                    manifest: this.bundleManager.fileManifest,
                    packageMapData: this.bundleManager.packageMap,
                    bundleDepsData: this.bundleManager.bundleDeps,
                    nativeAssetsUrl: this.bundleManager.bundleDeps?.nativeResources?.length
                        ? new URL('./native-assets.js', import.meta.url).href : null,
                    bundleRegistryData: this.bundleManager.bundleRegistry ? [...this.bundleManager.bundleRegistry] : [],
                    verbose: this.verbose,
                    bundlesUrl: this.bundlesUrl,
                    rangeFontBundles: this.enableLazyFS
                        ? this.rangeFontBundles.filter(name => !this.getEagerBundles(this.initialEngine).includes(name))
                        : [],
                };
                if (memorySnapshot) {
                    initMsg.memorySnapshot = memorySnapshot;
                    worker.postMessage(initMsg, [memorySnapshot]);
                } else {
                    worker.postMessage(initMsg);
                }
            } catch (error) {
                fail(error);
            }
        });
    }

    _handleWorkerMessage(e) {
        const msg = e.data;

        switch (msg.type) {
            case 'log':
                this._log(msg.message);
                break;

            case 'progress':
                this.onProgress(msg.stage, msg.detail);
                break;

            case 'compile-response': {
                const pending = this.pendingCompile;
                if (pending && (msg.id === pending.id || (msg.id == null && !this.workerProjectFileDeltas))) {
                    this.pendingCompile = null;
                    pending.resolve(msg);
                }
                break;
            }

            case 'source-analysis-response': {
                const pending = this.pendingAnalysis.get(msg.id);
                if (pending) pending([1, 2, 3].includes(msg.passes) ? msg.passes : null);
                break;
            }

            case 'format-generate-response': {
                const pending = this.pendingFormat;
                if (pending && (msg.id === pending.id || (msg.id == null && !this.workerFormatRequestIds))) {
                    this.pendingFormat = null;
                    pending.resolve(msg);
                }
                break;
            }

            case 'sync-input-abort': {
                const acks = this.worker?.__siglumSyncAcks;
                for (const [key, resolve] of acks || []) if (key.startsWith(msg.sequence + ':')) resolve(false);
                break;
            }
            case 'sync-input-ack': {
                const key = msg.sequence + ':' + msg.frame;
                this.worker?.__siglumSyncAcks?.get(key)?.(true);
                break;
            }
            case 'sync-input-request':
                this._handleSyncInputRequest(msg);
                break;

            case 'process-tool-request':
                void this.pendingCompile?.processTools?.execute(msg);
                break;

            case 'process-tool-frame':
                this.pendingCompile?.processTools?.onMessage(msg);
                break;
            case 'process-tool-abort':
                if (this.pendingCompile?.id === msg.compileId) this.pendingCompile.toolController.abort();
                break;

            case 'auxiliary-tool-request':
                this._handleAuxiliaryToolRequest(msg);
                break;

            case 'ctan-fetch-request':
                this._handleCtanFetchRequest(msg);
                break;

            case 'bundle-fetch-request':
                this._handleBundleFetchRequest(msg);
                break;

            case 'file-range-batch-end':
                if (this._rangeRequestTimer) clearTimeout(this._rangeRequestTimer);
                this._processRangeRequestBatch().catch(error => this._log('Font range batch failed: ' + error.message));
                break;

            case 'file-range-fetch-request':
                this._queueRangeRequest(msg);
                break;

            case 'memory-snapshot':
                // Worker sent memory snapshot after first successful compile - save to IndexedDB
                this._handleMemorySnapshot(msg).catch(e => {
                    this._log('Failed to save memory snapshot: ' + e.message);
                });
                break;

            default:
                // Log unhandled message types for debugging
                if (msg.type && !['log', 'progress', 'compile-response', 'format-generate-response'].includes(msg.type)) {
                    console.log('[Compiler] Unhandled message type:', msg.type);
                }
        }
    }

    _handleWorkerError(e) {
        this._projectSnapshot = null;
        this._ctanSnapshot = null;
        this._log('Worker error: ' + e.message);
        if (this.pendingCompile) {
            this.pendingCompile.reject(new Error('Worker error: ' + e.message));
            this.pendingCompile = null;
        }
        this._rejectPendingFormat(new Error('Worker error: ' + e.message));
        this.workerReady = false;
        // Terminate the worker before clearing the reference to avoid memory leak
        if (this.worker) {
            this._stopSyncInput(this.worker);
            this.worker.terminate();
            // Clear global reference if this is the active worker
            if (_globalActiveWorker?.worker === this.worker) {
                _globalActiveWorker = null;
            }
        }
        this.worker = null;
        this._initPromise = null;
        this._prewarmPromise = null;
    }

    _stopSyncInput(worker) {
        const buffer = worker?.__siglumSyncInput;
        if (buffer) {
            const header = new Int32Array(buffer, 0, 8);
            Atomics.add(header, 1, 1);
            Atomics.store(header, 0, 3);
            Atomics.notify(header, 0);
            worker.__siglumSyncInput = null;
        }
        for (const resolve of worker?.__siglumSyncAcks?.values() || []) resolve(false);
        worker?.__siglumSyncAcks?.clear();
    }

    async _handleSyncInputRequest(msg) {
        const worker = this.worker, buffer = worker?.__siglumSyncInput;
        if (!buffer) return;
        const live = () => this.worker === worker;
        let files;
        try {
            if (msg.range) {
                const { bundleName, start, end, path } = msg.range;
                const entry = this.bundleManager.fileManifest?.[path];
                if (!entry || entry.bundle !== bundleName || entry.start !== start || entry.end !== end) throw new Error('Invalid runtime range');
                const prefix = this.bundleManager.cachePrefix + 'range-' + bundleName + '-' + this.bundleManager.getBundleHash(bundleName);
                const req = { start, end, cacheKey: `${prefix}-${start}-${end}` };
                let data = await getBundleFromCache(req.cacheKey);
                if (!data || data.byteLength !== end - start) {
                    data = await new Promise(resolve => {
                        req.resolve = resolve;
                        this._fetchCoalescedRange(bundleName, [req], worker);
                    });
                }
                if (data) files = new Map([[path, new Uint8Array(data)]]);
            } else if (this.enableCtan && typeof msg.fileName === 'string' && !msg.fileName.includes('/')) {
                const pkg = await this.ctanFetcher.lookupPackageForFile(msg.fileName);
                if (pkg) files = (await this.ctanFetcher.fetchPackage(pkg))?.files;
            }
        } catch (error) { this._log('[SyncIO] Provider failed: ' + error.message); }
        const waitAck = (sequence, frame) => new Promise(resolve => {
            const key = sequence + ':' + frame;
            const timer = setTimeout(() => { worker.__siglumSyncAcks.delete(key); resolve(false); }, 30000);
            worker.__siglumSyncAcks.set(key, value => {
                clearTimeout(timer); worker.__siglumSyncAcks.delete(key); resolve(value);
            });
        });
        await respondSyncInput({ buffer, sequence: msg.sequence, files, waitAck, live });
    }

    async _handleCtanFetchRequest(msg) {
        const { requestId, packageName, fileName, tlYear } = msg;
        const worker = this.worker;
        if (!worker) return;

        try {
            // Look up the correct package for this file (e.g., bbm.sty → bbm-macros)
            let actualPackage = packageName;
            if (fileName) {
                const mappedPackage = await this.ctanFetcher.lookupPackageForFile(fileName);
                if (mappedPackage && mappedPackage !== packageName) {
                    this._log(`[CTAN-REQ] ${fileName} maps to package "${mappedPackage}" (not "${packageName}")`);
                }
                // Unknown Babel options can be typos. Only fetch language
                // definitions whose exact filename appears in the index.
                actualPackage = mappedPackage || (fileName.endsWith('.ldf') ? null : packageName);
            }

            const yearLabel = tlYear ? ` (TL${tlYear})` : '';
            if (actualPackage) this._log(`[CTAN-REQ] Worker requested package: ${actualPackage}${yearLabel}`);
            const result = actualPackage ? await this.ctanFetcher.fetchPackage(actualPackage, { tlYear }) : null;
            if (result?.files && !tlYear) {
                // Resolve a bounded set of small, declared runtime dependencies
                // before starting TeX again. Historical packages keep their own
                // version graph and continue through the exact-file retry path.
                const deps = this.bundleManager.planArchivePrefetch?.([actualPackage]) || [];
                for (const dep of deps) {
                    if (this.bundleManager.bundleExists(this.bundleManager.packageMap?.[dep])) continue;
                    const child = await this.ctanFetcher.fetchPackage(dep);
                    if (child?.files) for (const [path, bytes] of child.files) {
                        if (!result.files.has(path)) result.files.set(path, bytes);
                    }
                }
            }
            if (this.worker !== worker) return;
            if (result) {
                this._log(`[CTAN-REQ] ${packageName}: got ${result.files?.size || 0} files`);
            }

            if (!result) {
                worker.postMessage({
                    type: 'ctan-fetch-response',
                    requestId,
                    packageName,
                    success: false,
                    error: 'Package not found',
                });
                return;
            }

            // Copy file buffers for transfer (original stays in cache)
            const files = {};
            const transferList = [];
            for (const [path, data] of result.files) {
                if (data && data.buffer) {
                    const copy = copyFileBytes(data);
                    files[path] = copy;
                    transferList.push(copy.buffer);
                }
            }
            worker.postMessage({
                type: 'ctan-fetch-response',
                requestId,
                packageName,
                success: true,
                files,
                dependencies: result.dependencies || [],
            }, transferList);
        } catch (e) {
            this._log('CTAN fetch error: ' + e.message);
            if (this.worker !== worker) return;
            worker.postMessage({
                type: 'ctan-fetch-response',
                requestId,
                packageName,
                success: false,
                error: e.message,
            });
        }
    }

    async _handleBundleFetchRequest(msg) {
        const { requestId, bundleName } = msg;

        try {
            this._log('Worker requested bundle: ' + bundleName);

            const bundleData = await this.bundleManager.loadBundle(bundleName);

            // Copy and transfer to worker (original stays in cache)
            // Note: SharedArrayBuffer intentionally not used - causes V8 memory leaks
            const copy = bundleData.slice(0);
            this.worker.postMessage({
                type: 'bundle-fetch-response',
                requestId,
                bundleName,
                success: true,
                bundleData: copy,
            }, [copy]);
        } catch (e) {
            this._log('Bundle fetch error: ' + e.message);
            this.worker.postMessage({
                type: 'bundle-fetch-response',
                requestId,
                bundleName,
                success: false,
                error: e.message,
            });
        }
    }

    /**
     * Queue a range request for batching. Requests are coalesced and fetched
     * together to reduce HTTP overhead.
     */
    _queueRangeRequest(msg) {
        const { requestId, bundleName, start, end, cacheOnly } = msg;

        // Add to pending queue for this bundle
        if (!this._pendingRangeRequests.has(bundleName)) {
            this._pendingRangeRequests.set(bundleName, []);
        }
        this._pendingRangeRequests.get(bundleName).push({ requestId, start, end, cacheOnly });

        // Reset debounce timer
        if (this._rangeRequestTimer) {
            clearTimeout(this._rangeRequestTimer);
        }

        this._rangeRequestTimer = setTimeout(() => {
            this._processRangeRequestBatch().catch(e => {
                console.error('[Compiler] Range batch processing error:', e);
                this._log('Error processing range batch: ' + e.message);
            });
        }, this._rangeRequestDebounceMs);
    }

    /**
     * Process all pending range requests, coalescing nearby ranges.
     */
    async _processRangeRequestBatch() {
        this._rangeRequestTimer = null;

        const batch = this._pendingRangeRequests;
        this._pendingRangeRequests = new Map();
        const worker = this.worker;

        await Promise.all([...batch].map(async ([bundleName, requests]) => {
            const prefix = this.bundleManager.cachePrefix + 'range-' + bundleName + '-'
                + this.bundleManager.getBundleHash(bundleName);
            const missing = (await Promise.all(requests.map(async req => {
                req.cacheKey = `${prefix}-${req.start}-${req.end}`;
                const cached = await getBundleFromCache(req.cacheKey);
                if (cached?.byteLength === req.end - req.start) {
                    this._replyRange(worker, req, new Uint8Array(cached));
                    return null;
                }
                if (req.cacheOnly) {
                    this._replyRange(worker, req, null, 'Font range is not cached');
                    return null;
                }
                return req;
            }))).filter(Boolean);
            if (this.worker !== worker) return;

            const groups = this._coalesceRanges(missing);
            if (groups.length) this._log(`Range coalescing: ${missing.length} requests -> ${groups.length} fetches for ${bundleName}`);
            await Promise.all(groups.map(group => this._fetchCoalescedRange(bundleName, group, worker)));
        }));
    }

    _replyRange(worker, req, data, error) {
        if (req.resolve) { req.resolve(data); return; }
        if (!worker || worker !== this.worker) return;
        worker.postMessage({
            type: 'file-range-fetch-response',
            requestId: req.requestId,
            success: !!data,
            data,
            error,
        }, data ? [data.buffer] : []);
    }

    /**
     * Coalesce nearby ranges to reduce HTTP requests.
     * Returns groups of original requests that can be satisfied by a single fetch.
     */
    _coalesceRanges(requests) {
        if (requests.length === 0) return [];
        if (requests.length === 1) return [[requests[0]]];

        // Sort by start position
        const sorted = [...requests].sort((a, b) => a.start - b.start);

        const groups = [];
        let currentGroup = [sorted[0]];
        let groupEnd = sorted[0].end;

        for (let i = 1; i < sorted.length; i++) {
            const req = sorted[i];

            // If this range is within the gap threshold of the current group, merge
            if (req.start <= groupEnd + this._rangeCoalesceGapBytes) {
                currentGroup.push(req);
                groupEnd = Math.max(groupEnd, req.end);
            } else {
                // Start a new group
                groups.push(currentGroup);
                currentGroup = [req];
                groupEnd = req.end;
            }
        }

        groups.push(currentGroup);
        return groups;
    }

    /**
     * Fetch a coalesced range and distribute data to original requesters.
     */
    async _fetchCoalescedRange(bundleName, group, worker) {
        // Calculate the overall range to fetch
        const fetchStart = Math.min(...group.map(r => r.start));
        const fetchEnd = Math.max(...group.map(r => r.end));

        try {
            const url = `${this.bundlesUrl}/${bundleName}.raw`;
            const response = await fetch(url, {
                headers: {
                    'Range': `bytes=${fetchStart}-${fetchEnd - 1}`,
                },
            });

            if (response.status !== 206 && response.status !== 200) {
                throw new Error(`Range request failed with status ${response.status}`);
            }

            if (response.status === 206) {
                const contentRange = response.headers.get('Content-Range');
                if (contentRange && !contentRange.startsWith(`bytes ${fetchStart}-${fetchEnd - 1}/`)) {
                    throw new Error(`Unexpected range response for ${bundleName}`);
                }
            }
            const fullData = new Uint8Array(await response.arrayBuffer());
            if (response.status === 206 ? fullData.length !== fetchEnd - fetchStart : fullData.length < fetchEnd) {
                throw new Error(`Incomplete range response for ${bundleName}`);
            }
            this._log(`Fetched coalesced range [${fetchStart}:${fetchEnd}] = ${fullData.length} bytes`);

            await Promise.all(group.map(async req => {
                const offset = response.status === 200 ? req.start : req.start - fetchStart;
                const data = fullData.slice(offset, offset + req.end - req.start);
                await saveBundleToCache(req.cacheKey, data.buffer);
                this._replyRange(worker, req, data);
            }));
        } catch (e) {
            this._log('Coalesced range fetch error: ' + e.message);
            for (const req of group) this._replyRange(worker, req, null, e.message);
        }
    }

    async _handleMemorySnapshot(msg) {
        // Save memory snapshot to persistent storage for future instant restore
        const { snapshot, byteLength, isShared } = msg;
        if (!snapshot || byteLength === 0) {
            this._log('Memory snapshot is empty, skipping save');
            return;
        }

        // For SharedArrayBuffer: create a regular copy for IndexedDB (can't store SAB)
        // For transferred ArrayBuffer: wrap in Uint8Array view
        let snapshotArray;
        if (isShared) {
            // Copy from SharedArrayBuffer to regular ArrayBuffer for IndexedDB
            snapshotArray = new Uint8Array(byteLength);
            snapshotArray.set(new Uint8Array(snapshot));
            this._log(`Saving memory snapshot to cache (${(byteLength / 1024 / 1024).toFixed(1)}MB, from shared)...`);
        } else {
            snapshotArray = new Uint8Array(snapshot);
            this._log(`Saving memory snapshot to cache (${(byteLength / 1024 / 1024).toFixed(1)}MB)...`);
        }

        const success = await saveWasmMemorySnapshot(snapshotArray, {
            savedAt: Date.now(),
            byteLength,
        });

        if (success) {
            this._log('Memory snapshot saved');
        } else {
            this._log('Failed to save memory snapshot');
        }
    }

    _prepareProjectFiles(projectFiles, transferList, revision) {
        if (!this.enableProjectFileDeltas || !this.workerProjectFileDeltas) return null;
        const files = new Map(projectFiles.map(([path, content]) => ['/' + path, content]));
        const previous = this._projectSnapshot;
        if (!files.size && !previous) return null;

        let bytes = 0;
        for (const content of files.values()) {
            if (typeof content === 'string') bytes += content.length * 3;
            else if (content instanceof Uint8Array) bytes += content.byteLength;
            else return null;
            if (bytes > MAX_PROJECT_SNAPSHOT_BYTES) return null;
        }

        const changed = Object.create(null);
        const snapshot = new Map();
        const worker = this.worker;
        const base = previous?.worker === worker ? previous : null;
        for (const [path, content] of files) {
            const prior = base?.files.get(path);
            if (sameProjectFile(prior, content)) {
                snapshot.set(path, prior);
                continue;
            }
            const saved = typeof content === 'string' ? content : new Uint8Array(content);
            snapshot.set(path, saved);
            const data = typeof saved === 'string' ? new TextEncoder().encode(saved) : saved.slice();
            changed[path] = data;
            transferList.push(data.buffer);
        }

        return {
            payload: { baseRevision: base?.revision ?? null, paths: [...files.keys()], changed },
            snapshot: { worker, revision, files: snapshot },
        };
    }

    _prepareCtanFiles(transferList, revision) {
        const started = performance.now();
        const entries = Object.entries(this.ctanFetcher.getCachedFiles()).filter(([, data]) => data?.buffer);
        const legacyFiles = Object.create(null);
        const worker = this.worker;
        const generation = this._ctanCacheGeneration;
        const base = this._ctanSnapshot?.worker === worker ? this._ctanSnapshot : null;
        let delta;
        let snapshot;
        let sentCount = 0;
        let sentBytes = 0;
        const send = (target, path, bytes) => {
            const copy = copyFileBytes(bytes);
            target[path] = copy;
            transferList.push(copy.buffer);
            sentCount++;
            sentBytes += copy.byteLength;
        };

        const canRetain = this.workerCtanFileDeltas && entries.length > 0 &&
            entries.every(([, data]) => data instanceof Uint8Array) &&
            entries.reduce((bytes, [, data]) => bytes + data.byteLength, 0) <= MAX_CTAN_SNAPSHOT_BYTES;
        if (canRetain) {
            const changed = Object.create(null);
            const files = new Map();
            const previousPaths = base?.files.keys();
            let sameOrder = base?.files.size === entries.length;
            for (const [path, data] of entries) {
                if (sameOrder && previousPaths.next().value !== path) sameOrder = false;
                const previous = base?.files.get(path);
                if (sameProjectFile(previous, data)) {
                    files.set(path, previous);
                } else {
                    // Cached arrays may be exposed by CTANFetcher. Keep a private
                    // comparison copy so in-place writes cannot hide a change.
                    const saved = copyFileBytes(data);
                    files.set(path, saved);
                    send(changed, path, saved);
                }
            }
            if (sameOrder && sentCount === 0) {
                delta = { baseRevision: base.revision };
                snapshot = base;
            } else {
                delta = { baseRevision: base?.revision ?? null, paths: [...files.keys()], changed };
                snapshot = { worker, generation, revision, files };
            }
        } else {
            for (const [path, data] of entries) send(legacyFiles, path, data);
        }

        if (entries.length > 0) {
            const copyMs = (performance.now() - started).toFixed(1);
            this._log('Passing ' + sentCount + ' cached CTAN files to worker (' + sentBytes +
                ' bytes, ' + copyMs + 'ms to prepare), ' + (entries.length - sentCount) + ' retained');
        }
        return { legacyFiles, delta, snapshot };
    }

    /**
     * Compile LaTeX source to PDF.
     * @param {string} source - LaTeX source code
     * @param {CompileOptions} [options] - Compilation options
     * @returns {Promise<CompileResult>} Compilation result with PDF or error
     */
    async compile(source, options = {}) {
        const previous = this._compileTask;
        const task = (async () => {
            await previous?.catch(() => {});
            const legacyCandidate = options.previewChapter === undefined && source.includes('\\usetkzobj');
            const legacyPaths = legacyCandidate ? Object.keys(options.additionalFiles || {}).map(normalizeProjectPath) : [];
            const legacySource = legacyCandidate ? legacyTkzSource(source, legacyPaths) : null;
            const run = async (legacyFiles = null, compileSource = source) => {
                const compileOptions = compileSource === source ? options : { ...options, useCache: false };
                const result = await this._compile(compileSource, compileOptions, legacySource, legacyFiles);
                return result.projectFilesNeedReset || result.ctanFilesNeedReset
                    ? this._compile(compileSource, compileOptions, legacySource, legacyFiles) : result;
            };
            const result = await run();
            if (result.success || options.previewChapter !== undefined) return result;

            // Choose a single compatibility recovery from the first TeX failure.
            const useLegacyFct = this.workerLegacyTkz && shouldRetryLegacyTkzFct(legacySource, result.log, legacyPaths);
            if (!this.workerLegacyTkz || (!useLegacyFct && !shouldRetryLegacyTkz(legacySource, result.log))) {
                if (!/siunitx|KOMA-Script|chemfig/.test(result.log || '')) return result;
                const paths = Object.keys(options.additionalFiles || {}).map(normalizeProjectPath);
                for (const { name, message, translate } of legacySourceRecoveries) {
                    const revisedSource = translate(source, paths, result.log);
                    if (!revisedSource) continue;
                    this._log(message);
                    try {
                        const revised = await run(null, revisedSource);
                        if (revised.success) return revised;
                        this._log('Legacy ' + name + ' retry did not compile: ' + revised.error);
                    } catch (error) {
                        this._log('Legacy ' + name + ' retry unavailable: ' + error.message);
                    }
                    break;
                }
                return result;
            }

            try {
                if (useLegacyFct) this._log('Retrying legacy tkz-fct for the historical package load order.');
                const legacyFiles = await loadLegacyTkzFiles(useLegacyFct);
                const legacy = await run(legacyFiles);
                if (legacy.success) return legacy;
                this._log('Legacy tkz retry did not compile: ' + legacy.error);
            } catch (error) {
                this._log('Legacy tkz retry unavailable: ' + error.message);
            }
            return result;
        })();
        this._compileTask = task;
        try {
            const result = await task;
            if (result.projectFilesNeedReset || result.ctanFilesNeedReset) {
                return { success: false, error: result.error, log: result.log };
            }
            return result;
        } finally {
            if (this._compileTask === task) this._compileTask = null;
        }
    }

    async _handleAuxiliaryToolRequest(msg) {
        const worker = this.worker;
        const pending = this.pendingCompile;
        if (!pending || pending.id !== msg.compileId) return;
        const registered = this.tools.get(msg.tool);
        const runner = registered?.kind === 'auxiliary' ? registered.run : this.toolRunner;
        if (!runner || !this.auxiliaryToolCommands.includes(msg.tool)) return;
        try {
            const result = await runAuxiliaryTool(runner, msg, pending.toolFiles, pending.toolMainFile, pending.toolController.signal);
            if (this.worker !== worker || this.pendingCompile !== pending) return;
            worker.postMessage({ type: 'auxiliary-tool-response', requestId: msg.requestId,
                success: true, bytes: result.bytes, log: result.log }, [result.bytes.buffer]);
        } catch (error) {
            if (this.worker !== worker || this.pendingCompile !== pending) return;
            worker.postMessage({ type: 'auxiliary-tool-response', requestId: msg.requestId,
                success: false, error: error.message });
        }
    }

    async _compile(source, options, legacySource, legacyFiles) {
        // Wait for any pending format generation to complete before checking cache
        // This ensures the format is available in cache for the current compile
        if (this.formatGenerationPromise) {
            this._log('Waiting for format generation to complete...');
            await this.formatGenerationPromise.catch(() => {});
        }

        const mainFile = normalizeProjectPath(options.mainFile || 'document.tex');
        const projectFiles = Object.entries(options.additionalFiles || {}).map(([path, content]) => [normalizeProjectPath(path), content]);
        const engine = options.engine || detectEngine(source);
        const chapterPreview = options.previewChapter !== undefined;
        const extendedKomaSize = getKomaExtendedSize(source);
        // The existing cache key only covers main source. Dependencies must compile afresh.
        // A missing optional .clo can change a KOMA document even when its source is identical.
        const useCache = !this.checkpointRuntime && !extendedKomaSize && !legacyFiles && !options.projectId && !chapterPreview && this.enableDocCache && options.useCache !== false
            && Object.keys(options.additionalFiles || {}).length === 0;

        // Check document cache
        if (useCache) {
            const docHash = hashDocument(JSON.stringify([this.runtimeKey, mainFile, source]));
            const cached = await getCachedPdf(docHash, engine);
            if (cached) {
                this._log('Using cached PDF');
                return {
                    success: true,
                    pdf: new Uint8Array(cached),
                    cached: true,
                };
            }
        }

        // Ensure worker is ready
        if (!this.workerReady) {
            await (this._initPromise ?? this._initWorker());
        }

        // Determine required bundles from the main source.
        const { bundles } = this.bundleManager.checkPackages(source, engine);

        // Add eager bundles for this engine (these get loaded immediately instead of deferred)
        const eagerBundles = this._getEffectiveEagerBundles(engine);

        // Resolve bundled project dependencies even with the CTAN proxy disabled.
        const additionalFilesMap = options.additionalFiles || {};
        const { ctanPackages, additionalBundles: depBundles = [] } = this.bundleManager.prescanForCtanPackages(
            source, engine, additionalFilesMap, mainFile, bundles);
        if (this.enableCtan) {
            // Resolve fontspec named fonts (\setmainfont{EB Garamond}, etc.) to
            // their TeX Live packages so fontconfig can find them at runtime.
            // Only relevant for engines that use fontconfig (xelatex/lualatex).
            if (engine === 'xelatex' || engine === 'lualatex') {
                const fontNames = extractFontNames(source, additionalFilesMap);
                if (fontNames.length > 0) {
                    const { packages, unresolved } = await this.ctanFetcher.resolveFontPackages(fontNames);
                    if (packages.length > 0) {
                        this._log(`Fonts: ${fontNames.length} named, resolved to packages: ${packages.join(', ')}`);
                        for (const pkg of packages) {
                            if (!ctanPackages.includes(pkg)) ctanPackages.push(pkg);
                        }
                    }
                    if (unresolved.length > 0) {
                        this._log(`Fonts: unresolved (relying on bundled/system fonts): ${unresolved.join(', ')}`);
                    }
                }
            }

            if (ctanPackages.length > 0) {
                this._log(`Pre-scan: ${ctanPackages.length} potential CTAN packages`);
                const prescanStart = performance.now();

                const { fetched, failed, skipped } = await this.ctanFetcher.batchFetchPackages(ctanPackages);

                const elapsed = (performance.now() - prescanStart).toFixed(0);
                if (fetched.length > 0 || skipped.length > 0) {
                    this._log(`Pre-fetch: ${fetched.length} new, ${skipped.length} cached, ${failed.length} not found (${elapsed}ms)`);
                }
            }
        }

        // Combine all bundles: direct packages + eager + dependency bundles
        const allBundles = [...new Set([...bundles, ...eagerBundles, ...depBundles])];

        // Log required bundles with optional extras
        const extras = [];
        if (eagerBundles.length > 0) extras.push('eager: ' + eagerBundles.join(', '));
        if (depBundles.length > 0) extras.push('deps: ' + depBundles.join(', '));
        if (extras.length > 0) {
            this._log('Required bundles: ' + bundles.join(', ') + ' (+ ' + extras.join(', ') + ')');
        } else {
            this._log('Required bundles: ' + bundles.join(', '));
        }

        // Worker-direct bundle loading: send names only, worker loads from OPFS/network
        // This eliminates main thread memory usage for bundle data (300MB+ savings)
        this.onProgress('loading', 'Preparing compilation...');

        const rangeFontBundles = this._selectRangeFontBundles(engine, allBundles);
        const bundleNames = allBundles.filter(name => !rangeFontBundles.includes(name));
        const transferList = [];

        this._log(`Bundles: ${bundleNames.join(', ')} (worker-direct loading)`);

        // Check for cached format (in-memory first, then filesystem)
        let cachedFormat = null;
        let preamblePreparationMs = 0;
        const preamble = extractPreamble(source);
        const preambleHash = hashPreamble(preamble);
        const fmtKey = this._formatKey(preamble, engine, mainFile);

        // Files the preamble writes as a side effect during format precompilation
        // (e.g. insdljs' .djs, written via \openout and read back at
        // \begin{document}). A cached format skips the preamble on reuse, so these
        // must be captured at format-build time and restored here, or they go
        // missing. Loaded alongside the format below and shipped to the worker.
        let formatSideEffectFiles = null;

        // Check in-memory cache first (fast path)
        // Run the preamble for old tkz sources so the log identifies which version failed.
        const canUseFormat = !!preamble && options.usePreambleCache !== false && !extendedKomaSize && !legacySource && !legacyFiles && projectFiles.length === 0 && !mainFile.includes('/');
        if (canUseFormat && this._fmtMemCache?.key === fmtKey && this._fmtMemCache?.data?.buffer?.byteLength > 0) {
            // Copy format data for transfer (original stays in memory cache)
            const fmtCopy = this._fmtMemCache.data.buffer.slice(0);
            cachedFormat = { fmtName: fmtKey, fmtData: new Uint8Array(fmtCopy), preambleLength: preamble.length };
            transferList.push(fmtCopy);
            formatSideEffectFiles = this._fmtMemCache.sideEffectFiles || null;
            this._log('Using cached format (memory)');
        } else if (canUseFormat) {
            // Fall back to filesystem cache - path is deterministic from fmtKey
            const fmtPath = '/' + getFmtPath(fmtKey);
            await ensureFmtCacheMount();
            const fmtData = await fileSystem.readBinary(fmtPath).catch(() => null);
            if (fmtData && fmtData.byteLength > 0) {
                // Normalize to Uint8Array if needed (readBinary may return ArrayBuffer or Uint8Array)
                const fmtArray = fmtData instanceof Uint8Array ? fmtData : new Uint8Array(fmtData);
                formatSideEffectFiles = await this._loadFormatSideEffects(fmtKey);
                // Cache in memory for subsequent compiles
                this._fmtMemCache = { key: fmtKey, data: new Uint8Array(fmtArray), sideEffectFiles: formatSideEffectFiles };
                // Copy ArrayBuffer for transfer (must be ArrayBuffer, not Uint8Array)
                const fmtCopy = fmtArray.buffer.slice(fmtArray.byteOffset, fmtArray.byteOffset + fmtArray.byteLength);
                cachedFormat = { fmtName: fmtKey, fmtData: new Uint8Array(fmtCopy), preambleLength: preamble.length };
                transferList.push(fmtCopy);
                this._log('Using cached format (filesystem)');
            }
        }

        // Native checkpoints retain the preamble directly. Do not run the
        // combined engine to serialize a second copy before the first PDF.
        // Existing serialized formats and explicit generateFormat() still work.

        // Attach captured preamble side-effect files to the format payload so the
        // worker can restore them after loading the cached format.
        if (cachedFormat && formatSideEffectFiles && Object.keys(formatSideEffectFiles).length > 0) {
            const restored = {};
            for (const [name, b64] of Object.entries(formatSideEffectFiles)) {
                const bytes = base64ToBytes(b64);
                const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
                restored[name] = new Uint8Array(copy);
                transferList.push(copy);
            }
            cachedFormat.sideEffectFiles = restored;
            this._log(`Restoring ${Object.keys(restored).length} preamble side-effect file(s) with cached format`);
        }

        // The chapter preview borrows only a verified full-build checkpoint.
        // Keep preview aux/PDF writes out of that checkpoint.
        let checkpoint = null;
        let sourceForWorker = source;
        let auxCacheKey = this.runtimeKey + ':' + mainFile + ':' + preambleHash;
        const auxCacheEligible = !options.projectId || !!globalThis.crypto?.subtle;
        if (!legacyFiles && options.projectId && globalThis.crypto?.subtle) {
            auxCacheKey = 'project-v2-' + await buildStateDigest(JSON.stringify([
                this.runtimeKey, this.wasmUrl, this.bundlesUrl, options.projectId, engine, mainFile, preamble,
            ]));
            checkpoint = {
                main: await buildStateDigest(source),
                files: await Promise.all(projectFiles.map(async ([path, data]) => [path, await buildStateDigest(data)])),
            };
        }
        let auxCache = legacyFiles || !auxCacheEligible ? null : await getAuxCache(auxCacheKey);
        // Preamble serialization changes execution setup, not document labels.
        // Preserve converged aux across that transition. Older formatted caches
        // remain readable; publish future results under the canonical key.
        if (!auxCache && !legacyFiles && !options.projectId && cachedFormat && projectFiles.length === 0) {
            auxCache = await getAuxCache(auxCacheKey + '_fmt');
        }
        if (chapterPreview) {
            if (!checkpoint || engine !== 'pdflatex' || !this.workerChapterPreview) {
                return { success: false, error: 'Chapter preview requires a supported pdfLaTeX worker and a local project ID.' };
            }
            try {
                sourceForWorker = chapterPreviewSource(source, options.previewChapter, mainFile, checkpoint, auxCache);
            } catch (error) {
                return { success: false, error: error.message };
            }
        }

        // Send compile request
        this.onProgress('compiling', 'Compiling...');
        const compileId = String(++nextCompilerRequestId);
        const ctanTransfer = this._prepareCtanFiles(transferList, compileId);
        const ctanFiles = ctanTransfer.legacyFiles;
        const legacyPayload = legacyFiles && Object.fromEntries(legacyFiles.map(([path, bytes]) => {
            const copy = bytes.slice();
            transferList.push(copy.buffer);
            return [path, copy];
        }));
        const projectTransfer = this._prepareProjectFiles(projectFiles, transferList, compileId);
        if (!projectTransfer) {
            this._projectSnapshot = null;
            // Older workers expect project files to be merged into CTAN files.
            for (const [path, content] of projectFiles) {
                const data = typeof content === 'string'
                    ? new TextEncoder().encode(content) : new Uint8Array(content);
                ctanFiles['/' + path] = data;
                transferList.push(data.buffer);
            }
        }


        return new Promise((resolve, reject) => {
            const toolController = new AbortController();
            const toolMailbox = this.toolCommands.length && typeof SharedArrayBuffer === 'function' ? (this.worker.__siglumToolMailbox ||= new SharedArrayBuffer(PROCESS_TOOL_MAILBOX_BYTES)) : null;
            const timeout = setTimeout(() => {
                if (this.pendingCompile?.id === compileId) {
                    this.pendingCompile = null;
                    this._projectSnapshot = null;
                    this._ctanSnapshot = null;
                    toolController.abort();
                    reject(new Error('Compilation timeout'));
                }
            }, 120000);

            this.pendingCompile = {
                id: compileId,
                // Retain caller-owned inputs, never the copies transferred to the worker.
                toolFiles: this.tools.size || this.toolRunner ? new Map(projectFiles) : null,
                toolMainFile: mainFile,
                toolController,
                toolMailbox,
                resolve: async (result) => {
                    clearTimeout(timeout);
                    toolController.abort();
                    const snapshot = projectTransfer?.snapshot;
                    this._projectSnapshot = snapshot && result.success &&
                        result.projectFileRevision === compileId && snapshot.worker === this.worker
                        ? snapshot : null;
                    const ctan = ctanTransfer.snapshot;
                    this._ctanSnapshot = ctan && result.ctanFileRevision === ctan.revision &&
                        ctan.worker === this.worker && ctan.generation === this._ctanCacheGeneration
                        ? ctan : null;
                    if (result.projectFilesNeedReset && projectTransfer?.payload.baseRevision != null) {
                        resolve({ projectFilesNeedReset: true, success: false, error: result.error });
                        return;
                    }
                    if (result.ctanFilesNeedReset && ctanTransfer.delta?.baseRevision != null) {
                        resolve({ ctanFilesNeedReset: true, success: false, error: result.error });
                        return;
                    }

                    if (result.success && result.pdfData) {
                        // A transferred ArrayBuffer already belongs to this caller.
                        // Copy any legacy shared response before exposing it.
                        const view = new Uint8Array(result.pdfData);
                        const pdfData = result.pdfData instanceof ArrayBuffer ? view : view.slice();

                        // Cache the PDF
                        if (useCache && pdfData) {
                            const docHash = hashDocument(JSON.stringify([this.runtimeKey, mainFile, source]));
                            // A caller may transfer its PDF and detach its buffer.
                            await saveCachedPdf(docHash, engine, pdfData.slice());
                        }

                        // Cache converged document aux independently of format serialization.
                        if (auxCacheEligible && !legacyFiles && !chapterPreview && result.auxFilesToCache) {
                            if (checkpoint) {
                                const unsettled = /Rerun to get|Label\(s\) may have changed|undefined references|Rerun LaTeX/i.test(result.log || '');
                                await saveAuxCache(auxCacheKey, result.auxFilesToCache, unsettled ? null : checkpoint, result.fontRanges);
                            } else {
                                await saveAuxCache(auxCacheKey, result.auxFilesToCache, undefined, result.fontRanges);
                            }
                        }

                        // Auto-generate format cache if no cached format was used
                        // Do this in background to not block the compile result
                        // Skip for xelatex - XeTeX can't dump formats with native fonts
                        const checkpointState = result.stats?.checkpoint;
                        const nativePreambleRetained = !!this.checkpointRuntime
                            && (typeof checkpointState?.retained === 'boolean' ? checkpointState.retained
                                : ['prepared', 'reuse'].includes(checkpointState?.mode));
                        if (canUseFormat && !cachedFormat && preamble && engine !== 'xelatex' && !nativePreambleRetained) {
                            this.generateFormat(source, { engine, mainFile }).then(async () => {
                                // Populate memory cache from the newly generated format,
                                // including any captured preamble side-effect files so the
                                // next compile restores them with the format.
                                await ensureFmtCacheMount();
                                const data = await fileSystem.readBinary('/' + getFmtPath(fmtKey)).catch(() => null);
                                if (data) {
                                    const sideEffectFiles = await this._loadFormatSideEffects(fmtKey);
                                    this._fmtMemCache = { key: fmtKey, data: new Uint8Array(data), sideEffectFiles };
                                }
                            }).catch(() => {}); // Silent fail for background task
                        }

                        resolve({
                            success: true,
                            pdf: pdfData,
                            syncTexData: result.syncTexData || null, // SyncTeX data for source/PDF synchronization
                            stats: { ...result.stats, ...(preamblePreparationMs ? { preamblePreparationMs } : {}), ...(chapterPreview ? { chapterPreview: options.previewChapter } : {}) },
                            log: result.log,
                        });
                    } else {
                        resolve({
                            success: false,
                            error: result.error || (result.success ? 'Compilation produced no PDF' : `TeX compilation failed (exit code ${result.exitCode ?? 'unknown'})`),
                            exitCode: result.exitCode,
                            log: result.log,
                        });
                    }
                },
                reject: (error) => {
                    clearTimeout(timeout);
                    toolController.abort();
                    reject(error);
                },
            };

            if (toolMailbox) {
                const pending = this.pendingCompile, worker = this.worker;
                pending.processTools = new ProcessToolSession({ worker, buffer: toolMailbox,
                    compileId, registry: this.tools, projectFiles: pending.toolFiles,
                    mainFile, signal: toolController.signal,
                    current: () => this.worker === worker && this.pendingCompile === pending });
            }

            try {
                this.worker.postMessage({
                    type: 'compile',
                    id: compileId,
                    source: sourceForWorker,
                    auxiliaryTools: this.auxiliaryToolCommands,
                    toolCommands: this.toolCommands, toolMailbox, toolIdentity: this.toolIdentity,
                    engine,
                    mainFile,
                    checkpointFocus: options.checkpointFocus,
                    checkpointProject: options.checkpointProject,
                    forceFull: options.forceFull === true,
                    ...(chapterPreview ? { chapterPreview: true } : {}),
                    options: {
                        enableLazyFS: this.enableLazyFS,
                        enableCtan: this.enableCtan,
                        maxRetries: this.maxRetries,
                        verbose: this.verbose,
                    },
                    bundleNames,         // Worker-direct: send names only
                    bundlesUrl: this.bundlesUrl,  // Worker loads from OPFS/network
                    ctanFiles,
                    ...(ctanTransfer.delta ? { ctanFilesDelta: ctanTransfer.delta } : {}),
                    ...(projectTransfer ? { projectFiles: projectTransfer.payload } : {}),
                    ...(legacyPayload ? { legacyTkzFiles: legacyPayload } : {}),
                    cachedFormat,
                    cachedAuxFiles: auxCache?.files || null,
                    cachedFontRanges: auxCache?.fontRanges,
                    // Deferred bundles minus any that are eagerly loaded
                    rangeFontBundles,
                    deferredBundleNames: [...new Set([...(this.bundleManager.bundleDeps?.deferred || []), ...rangeFontBundles])]
                        .filter(b => !eagerBundles.includes(b)),
                }, transferList);
            } catch (e) {
                this._log('Failed to post compile message to worker: ' + e.message);
                toolController.abort();
                this.pendingCompile = null;
                this._projectSnapshot = null;
                this._ctanSnapshot = null;
                clearTimeout(timeout);
                reject(e);
                return;
            }
        });
    }

    /**
     * Pre-generate a format file for faster subsequent compilations.
     * @param {string} source - LaTeX source with preamble to cache
     * @param {{engine?: string, mainFile?: string, additionalFiles?: Object<string, string|Uint8Array>}} [options] - Options. Project dependencies disable format caching.
     * @returns {Promise<Uint8Array|null>} Format data or null if not supported
     */
    _sourcePassCount(source) {
        if (!this.workerSourceAnalysis || !this.workerReady) return Promise.resolve(null);
        return new Promise((resolve, reject) => {
            const id = 'analysis-' + (++nextCompilerRequestId);
            const done = (value, error) => {
                clearTimeout(timer);
                this.pendingAnalysis.delete(id);
                if (error) reject(error); else resolve(value);
            };
            const timer = setTimeout(() => done(null), 2000);
            this.pendingAnalysis.set(id, done);
            try { this.worker.postMessage({ type: 'analyze-source', id, source }); }
            catch (error) { done(null, error); }
        });
    }

    _formatKey(preamble, engine, mainFile = 'document.tex') {
        return this.runtimeKey + '_' + hashPreamble(JSON.stringify([
            'prepared-preamble-v2', normalizeProjectPath(mainFile), preamble,
        ])) + '_' + engine;
    }

    async generateFormat(source, options = {}) {
        // The format key covers only the main preamble. Do not return or build a
        // format that can become stale when a project dependency changes.
        if (Object.keys(options.additionalFiles || {}).length > 0 || normalizeProjectPath(options.mainFile || 'document.tex').includes('/')) {
            this._log('Format caching disabled for multi-file or nested projects');
            return null;
        }
        if (getKomaExtendedSize(source)) {
            this._log('Format caching disabled for KOMA-Script extended class sizes');
            return null;
        }
        const engine = options.engine || 'pdflatex';

        // XeTeX can't dump formats with native fonts (fontspec)
        if (engine === 'xelatex') {
            this._log('Format caching not supported for XeLaTeX (native fonts)');
            return null;
        }

        const preamble = extractPreamble(source);

        if (!preamble) {
            throw new Error('No preamble found in source');
        }

        const epoch = this._formatEpoch;
        const mainFile = normalizeProjectPath(options.mainFile || 'document.tex');
        const data = await this._getOrGenerateFormat(source, preamble, engine, epoch, mainFile);
        // A completed worker reply can still be saving its cache files when
        // the worker terminates. Finish those writes before another job starts,
        // but reject the result for the terminated generation.
        if (epoch !== this._formatEpoch) throw new Error('Compiler worker terminated');
        // Each caller owns its returned bytes, including if one transfers them.
        return data?.slice() ?? null;
    }

    _getOrGenerateFormat(source, preamble, engine, epoch, mainFile = 'document.tex') {
        if (epoch !== this._formatEpoch) throw new Error('Compiler worker terminated');
        const running = this.formatGenerationPromise;
        if (running) {
            const input = this.formatGenerationInput;
            if (input.engine === engine && input.preamble === preamble && input.epoch === epoch && input.mainFile === mainFile) {
                return running;
            }
            return running.catch(() => {}).then(() => this._getOrGenerateFormat(source, preamble, engine, epoch, mainFile));
        }

        this.formatGenerationInput = { preamble, engine, epoch, mainFile };
        const task = Promise.resolve().then(() => this._generateFormat(source, preamble, engine, epoch, mainFile)).finally(() => {
            this.formatGenerationPromise = null;
            this.formatGenerationInput = null;
        });
        this.formatGenerationPromise = task;
        return task;
    }

    async _generateFormat(source, preamble, engine, epoch, mainFile = 'document.tex') {
        // Check cache - path is deterministic from fmtKey
        const preambleHash = hashPreamble(preamble);
        const fmtKey = this._formatKey(preamble, engine, mainFile);
        const fmtPath = '/' + getFmtPath(fmtKey);
        await ensureFmtCacheMount();
        const existingFmt = await fileSystem.readBinary(fmtPath).catch(() => null);
        if (epoch !== this._formatEpoch) throw new Error('Compiler worker terminated');
        if (existingFmt && existingFmt.byteLength > 0) {
            this._log('Format already cached');
            return new Uint8Array(existingFmt);
        }

        // Ensure worker is ready
        if (!this.workerReady) {
            await (this._initPromise ?? this._initWorker());
        }
        if (epoch !== this._formatEpoch) throw new Error('Compiler worker terminated');

        // Determine required bundles (same logic as compile)
        const { bundles } = this.bundleManager.checkPackages(source, engine);

        const { additionalBundles: depBundles = [] } = this.bundleManager.prescanForCtanPackages(
            source, engine, {}, undefined, bundles);

        // Worker-direct bundle loading: send names only
        const allBundles = [...new Set([...bundles, ...this._getEffectiveEagerBundles(engine), ...depBundles])];
        const rangeFontBundles = this._selectRangeFontBundles(engine, allBundles);
        const bundleNames = allBundles.filter(name => !rangeFontBundles.includes(name));
        const transferList = [];

        // Get CTAN files from memory cache - copy for transfer
        const ctanFilesRaw = this.ctanFetcher.getCachedFiles();
        const ctanFiles = {};
        for (const [path, data] of Object.entries(ctanFilesRaw)) {
            if (data && data.buffer) {
                const copy = copyFileBytes(data);
                ctanFiles[path] = copy;
                transferList.push(copy.buffer);
            }
        }

        this._log('Generating format file...');
        this.onProgress('format', 'Generating format...');

        return new Promise((resolve, reject) => {
            const id = String(++nextCompilerRequestId);
            const timeout = setTimeout(() => {
                if (this.pendingFormat?.id === id) {
                    this.pendingFormat = null;
                    reject(new Error('Format generation timeout'));
                }
            }, 300000); // 5 minute timeout

            this.pendingFormat = {
                id,
                resolve: (result) => {
                    clearTimeout(timeout);

                    if (result.success) {
                        const fmtData = new Uint8Array(result.formatData);

                        // Files the preamble wrote during the dump run (observed by
                        // the worker, not guessed) — persist alongside the format so
                        // they can be restored whenever this format is reused.
                        const sideEffects = result.sideEffectFiles || {};
                        const sideEffectsB64 = {};
                        for (const [name, buf] of Object.entries(sideEffects)) {
                            sideEffectsB64[name] = bytesToBase64(new Uint8Array(buf));
                        }

                        // Cache to filesystem, then resolve
                        ensureFmtCacheMount().then(async () => {
                            // Readers look for .fmt first. Publish it only after the sidecar write succeeds.
                            await this._saveFormatSideEffects(fmtKey, sideEffectsB64);
                            await fileSystem.writeBinary(fmtPath, fmtData, { createParents: true });
                        }).then(() => {
                            const n = Object.keys(sideEffectsB64).length;
                            this._log(`Format generated and cached${n ? ` (+${n} preamble side-effect file(s))` : ''}`);
                            resolve(fmtData);
                        }).catch(e => {
                            // Cache failed but format is still valid
                            this._log('Warning: Failed to cache format: ' + e.message);
                            resolve(fmtData);
                        });
                    } else {
                        reject(new Error(result.error || 'Format generation failed'));
                    }
                },
                reject: (error) => {
                    clearTimeout(timeout);
                    reject(error);
                },
            };

            try {
                this.worker.postMessage({
                    type: 'generate-format',
                    id,
                    preambleContent: preamble,
                    mainFile,
                    engine,
                    manifest: this.bundleManager.fileManifest,
                    packageMapData: this.bundleManager.packageMap,
                    bundleDepsData: this.bundleManager.bundleDeps,
                    bundleRegistryData: [...this.bundleManager.bundleRegistry],
                    bundleNames,           // Worker-direct: send names only
                    rangeFontBundles,
                    bundlesUrl: this.bundlesUrl,  // Worker loads from OPFS/network
                    ctanFiles,
                    maxRetries: this.maxRetries,
                }, transferList);
            } catch (error) {
                this.pendingFormat = null;
                clearTimeout(timeout);
                reject(error);
            }
        });
    }

    _rejectPendingFormat(error) {
        this._formatEpoch++;
        for (const done of this.pendingAnalysis.values()) done(null, error);
        this.pendingAnalysis.clear();
        const pending = this.pendingFormat;
        this.pendingFormat = null;
        pending?.reject(error);
    }

    /**
     * Persist the preamble side-effect files captured during format generation,
     * before publishing the cached format. An empty map replaces an orphan from a failed write.
     * @param {string} fmtKey
     * @param {Object<string,string>} sideEffectsB64
     */
    async _saveFormatSideEffects(fmtKey, sideEffectsB64) {
        const path = '/' + getFmtPath(fmtKey) + '.side.json';
        const json = new TextEncoder().encode(JSON.stringify(sideEffectsB64));
        await fileSystem.writeBinary(path, json, { createParents: true });
    }

    /**
     * Load the preamble side-effect files persisted next to a cached format.
     * @param {string} fmtKey
     * @returns {Promise<Object<string,string>|null>} filename → base64, or null
     */
    async _loadFormatSideEffects(fmtKey) {
        const path = '/' + getFmtPath(fmtKey) + '.side.json';
        try {
            const data = await fileSystem.readBinary(path).catch(() => null);
            if (!data || data.byteLength === 0) return null;
            const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
            return JSON.parse(new TextDecoder().decode(bytes));
        } catch {
            return null;
        }
    }

    /**
     * Clear all caches (CTAN packages, mounted files).
     * @returns {Promise<void>}
     */
    async clearCache() {
        this._log('Clearing CTAN cache...');
        await clearCTANCache();
        this.ctanFetcher.clearMountedFiles();
        this._ctanSnapshot = null;
        this._ctanCacheGeneration++;
        if (this.workerCtanFileDeltas) this.worker?.postMessage({ type: 'ctan-files-clear' });
        this._log('Cache cleared');
    }

    /**
     * Clear bundle memory cache to free RAM.
     * Bundles are still cached on disk (OPFS) and will reload quickly.
     * Call this after compile to reduce main thread memory usage.
     */
    clearBundleMemoryCache() {
        this.bundleManager.clearCache();
    }

    /**
     * Get compiler statistics.
     * @returns {{bundles: Object, ctan: Object}} Statistics from bundle manager and CTAN fetcher
     */
    getStats() {
        return {
            bundles: this.bundleManager.getStats(),
            ctan: this.ctanFetcher.getStats(),
        };
    }

    /**
     * Terminate the worker. Call unload() for full cleanup.
     */
    terminate() {
        this._workerInitEpoch++;
        this._cancelWorkerInit?.(new Error('Compiler worker terminated'));
        this._initWorkerPromise = null;
        this._projectSnapshot = null;
        this._ctanSnapshot = null;
        if (this.pendingCompile) {
            this.pendingCompile.reject(new Error('Compiler worker terminated'));
            this.pendingCompile = null;
        }
        this._rejectPendingFormat(new Error('Compiler worker terminated'));
        if (this.worker) {
            this._stopSyncInput(this.worker);
            this.worker.terminate();
            // Clear global reference if this is the active worker
            if (_globalActiveWorker?.worker === this.worker) {
                _globalActiveWorker = null;
            }
            this.worker = null;
            this.workerReady = false;
        }
        clearTimeout(this._rangeRequestTimer);
        this._rangeRequestTimer = null;
        this._pendingRangeRequests.clear();
        // Clear the memoized init so a subsequent init() re-runs from scratch.
        this._initPromise = null;
        this._prewarmPromise = null;
    }

    /**
     * Unload compiler to free memory. Clears RAM caches but keeps disk caches.
     * Call init() again to reinitialize.
     */
    unload() {
        this._log('Unloading compiler to free memory...');

        // Terminate worker (frees WASM module, heap, worker bundle cache)
        this.terminate();

        // Clear main thread caches
        this.bundleManager.clearCache();
        this.ctanFetcher.clearMountedFiles();

        this._log('Compiler unloaded');
    }

    /**
     * Check if compiler is currently loaded.
     * @returns {boolean}
     */
    isLoaded() {
        return this.worker !== null;
    }
}

/**
 * Backwards-compatible alias for SiglumCompiler.
 * @type {typeof SiglumCompiler}
 */
export const BusyTeXCompiler = SiglumCompiler;
