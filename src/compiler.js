// Main BusyTeXCompiler class - orchestrates compilation

import { BundleManager, detectEngine, extractPreamble, hashPreamble } from './bundles.js';
import { CTANFetcher, getPackageFromFile } from './ctan.js';
import {
    getAuxCache,
    saveAuxCache,
    getCachedPdf,
    saveCachedPdf,
    hashDocument,
    getFmtPath,
    readFromOPFS,
    writeToOPFS,
    clearCTANCache,
    getCompiledWasmModule,
    saveWasmBytes,
    getWasmMemorySnapshot,
    saveWasmMemorySnapshot,
    clearWasmMemorySnapshot,
} from './storage.js';

export class BusyTeXCompiler {
    constructor(options = {}) {
        this.bundlesUrl = options.bundlesUrl || 'packages/bundles';
        this.wasmUrl = options.wasmUrl || 'busytex.wasm';
        this.workerUrl = options.workerUrl || null; // Will use embedded worker if not provided
        this.ctanProxyUrl = options.ctanProxyUrl || 'http://localhost:8081';
        this.xzwasmUrl = options.xzwasmUrl || './src/xzwasm.js';

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
        this.pendingCompile = null;
        this.formatCache = new Map();
        this.formatGenerationPromise = null;

        this.onLog = options.onLog || (() => {});
        this.onProgress = options.onProgress || (() => {});

        // Options
        this.enableCtan = options.enableCtan !== false;
        this.enableLazyFS = options.enableLazyFS !== false;
        this.enableDocCache = options.enableDocCache !== false;

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

        this._prewarmPromise = this.init().catch(e => {
            this._log('Prewarm failed: ' + e.message);
            // Reset so next prewarm/init can retry
            this._prewarmPromise = null;
            throw e;
        });

        return this._prewarmPromise;
    }

    /**
     * Check if compiler is ready (initialized and warmed up)
     * @returns {boolean}
     */
    isReady() {
        return this.workerReady && this.wasmModule !== undefined;
    }

    async init() {
        this._log('Initializing BusyTeX compiler...');

        // Load manifests + WASM in parallel
        await Promise.all([
            this._loadManifests(),
            this._loadWasm(),
        ]);

        // Worker init (required) + bundle preload (optional, don't fail if it errors)
        await Promise.all([
            this._initWorker(),
            this.bundleManager.preloadEngine('pdflatex').catch(e => {
                this._log('Bundle preload failed (will load on demand): ' + e.message);
            }),
        ]);

        this._log('Compiler initialized');
    }

    async _loadManifests() {
        await this.bundleManager.loadManifest();
        await this.bundleManager.loadBundleDeps();
    }

    async _loadWasm() {
        this._log('Loading WASM...');
        const startTime = performance.now();

        try {
            // Try loading cached compiled module first (skips fetch + compile)
            console.log('[WASM-CACHE] Attempting to load cached WASM module...');
            const cachedModule = await getCompiledWasmModule();
            if (cachedModule) {
                this.wasmModule = cachedModule;
                const elapsed = (performance.now() - startTime).toFixed(0);
                console.log(`[WASM-CACHE] ✅ Using cached module (${elapsed}ms)`);
                this._log('WASM loaded from cache in ' + elapsed + 'ms');
                return;
            }

            // Fetch WASM as bytes (not streaming compile - we need bytes for caching)
            console.log('[WASM-CACHE] ⬇️ Cache miss - fetching WASM from:', this.wasmUrl);
            const response = await fetch(this.wasmUrl);
            const wasmBytes = new Uint8Array(await response.arrayBuffer());
            const fetchElapsed = (performance.now() - startTime).toFixed(0);
            console.log(`[WASM-CACHE] Fetched ${(wasmBytes.length / 1024 / 1024).toFixed(1)}MB in ${fetchElapsed}ms`);

            // Compile from bytes
            const compileStart = performance.now();
            this.wasmModule = await WebAssembly.compile(wasmBytes);
            const compileElapsed = (performance.now() - compileStart).toFixed(0);
            console.log(`[WASM-CACHE] Compiled WASM (${compileElapsed}ms)`);
            this._log(`WASM fetched in ${fetchElapsed}ms, compiled in ${compileElapsed}ms`);

            // Cache the bytes for future loads (Module can't be serialized to IndexedDB)
            console.log('[WASM-CACHE] Saving bytes to cache...');
            saveWasmBytes(wasmBytes).catch(e => {
                console.log('[WASM-CACHE] Save error:', e.message);
                this._log('Failed to cache WASM bytes: ' + e.message);
            });
        } catch (e) {
            console.log('[WASM-CACHE] Load failed:', e.message);
            this._log('WASM load failed: ' + e.message);
            throw e;
        }
    }

    async _initWorker() {
        if (this.worker) return;

        // Get worker code - use external URL or read from src/worker.js
        let workerUrl = this.workerUrl;
        if (!workerUrl) {
            // Fetch worker.js and create blob URL
            const workerResponse = await fetch(new URL('./worker.js', import.meta.url));
            const workerCode = await workerResponse.text();
            const blob = new Blob([workerCode], { type: 'application/javascript' });
            workerUrl = URL.createObjectURL(blob);
        }

        this.worker = new Worker(workerUrl);
        this.worker.onmessage = (e) => this._handleWorkerMessage(e);
        this.worker.onerror = (e) => this._handleWorkerError(e);

        // Get absolute URL for busytex.js - derive from wasmUrl
        const wasmUrlObj = new URL(this.wasmUrl, window.location.href);
        const busytexJsUrl = new URL('busytex.js', wasmUrlObj.href).href;

        // Try to load cached memory snapshot for instant restore
        let memorySnapshot = null;
        try {
            const cached = await getWasmMemorySnapshot();
            if (cached?.snapshot) {
                memorySnapshot = cached.snapshot.buffer;
                this._log(`Loaded memory snapshot from cache (${(cached.byteLength / 1024 / 1024).toFixed(1)}MB)`);
            }
        } catch (e) {
            this._log('Failed to load memory snapshot: ' + e.message);
        }

        // Send init message
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Worker init timeout')), 30000);

            const originalHandler = this.worker.onmessage;
            this.worker.onmessage = (e) => {
                if (e.data.type === 'ready') {
                    clearTimeout(timeout);
                    this.workerReady = true;
                    this.worker.onmessage = originalHandler;
                    this._log('Worker ready');
                    resolve();
                } else {
                    originalHandler(e);
                }
            };

            const initMsg = {
                type: 'init',
                wasmModule: this.wasmModule,
                busytexJsUrl,
                manifest: this.bundleManager.fileManifest,
                packageMapData: this.bundleManager.packageMap,
                bundleDepsData: this.bundleManager.bundleDeps,
                bundleRegistryData: this.bundleManager.bundleRegistry ? [...this.bundleManager.bundleRegistry] : [],
            };

            // Include memory snapshot if available (transfer for efficiency)
            if (memorySnapshot) {
                initMsg.memorySnapshot = memorySnapshot;
                this.worker.postMessage(initMsg, [memorySnapshot]);
            } else {
                this.worker.postMessage(initMsg);
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

            case 'compile-response':
                if (this.pendingCompile) {
                    this.pendingCompile.resolve(msg);
                    this.pendingCompile = null;
                }
                break;

            case 'format-generate-response':
                if (this.pendingFormat) {
                    this.pendingFormat.resolve(msg);
                    this.pendingFormat = null;
                }
                break;

            case 'ctan-fetch-request':
                this._handleCtanFetchRequest(msg);
                break;

            case 'bundle-fetch-request':
                this._handleBundleFetchRequest(msg);
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
        this._log('Worker error: ' + e.message);
        if (this.pendingCompile) {
            this.pendingCompile.reject(new Error('Worker error: ' + e.message));
            this.pendingCompile = null;
        }
        this.workerReady = false;
        this.worker = null;
    }

    async _handleCtanFetchRequest(msg) {
        const { requestId, packageName } = msg;

        try {
            this._log('Worker requested CTAN package: ' + packageName);
            // Only fetch this specific package, not dependencies
            // Dependencies are resolved by the worker's retry loop - if a dependency
            // is missing, the worker will request it specifically
            const result = await this.ctanFetcher.fetchPackage(packageName);

            if (!result) {
                this.worker.postMessage({
                    type: 'ctan-fetch-response',
                    requestId,
                    packageName,
                    success: false,
                    error: 'Package not found',
                });
                return;
            }

            this.worker.postMessage({
                type: 'ctan-fetch-response',
                requestId,
                packageName,
                success: true,
                files: Object.fromEntries(result.files),
                dependencies: result.dependencies || [],
            });
        } catch (e) {
            this._log('CTAN fetch error: ' + e.message);
            this.worker.postMessage({
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

            // Load bundle data and metadata in parallel
            const [bundleData, metaResponse] = await Promise.all([
                this.bundleManager.loadBundle(bundleName),
                fetch(`${this.bundlesUrl}/${bundleName}.meta.json`).catch(() => null),
            ]);

            // Parse metadata if available
            let bundleMeta = null;
            if (metaResponse?.ok) {
                try {
                    bundleMeta = await metaResponse.json();
                } catch (e) {
                    this._log('Failed to parse bundle metadata: ' + e.message);
                }
            }

            // Copy bundleData before transfer so original stays valid in cache
            const bundleDataCopy = bundleData.slice(0);
            this.worker.postMessage({
                type: 'bundle-fetch-response',
                requestId,
                bundleName,
                success: true,
                bundleData: bundleDataCopy,
                bundleMeta,
            }, [bundleDataCopy]);
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
        const { requestId, bundleName, start, end } = msg;

        // Add to pending queue for this bundle
        if (!this._pendingRangeRequests.has(bundleName)) {
            this._pendingRangeRequests.set(bundleName, []);
        }
        this._pendingRangeRequests.get(bundleName).push({ requestId, start, end });

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

        // Process each bundle's requests
        for (const [bundleName, requests] of this._pendingRangeRequests.entries()) {
            if (requests.length === 0) continue;

            // Coalesce ranges
            const coalesced = this._coalesceRanges(requests);

            this._log(`Range coalescing: ${requests.length} requests -> ${coalesced.length} fetches for ${bundleName}`);

            // Fetch each coalesced range
            for (const group of coalesced) {
                await this._fetchCoalescedRange(bundleName, group);
            }
        }

        // Clear processed requests
        this._pendingRangeRequests.clear();
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
    async _fetchCoalescedRange(bundleName, group) {
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

            const fullData = new Uint8Array(await response.arrayBuffer());
            this._log(`Fetched coalesced range [${fetchStart}:${fetchEnd}] = ${fullData.length} bytes`);

            // Distribute data to each original requester
            for (const req of group) {
                const offset = req.start - fetchStart;
                const length = req.end - req.start;
                const data = fullData.slice(offset, offset + length);

                this.worker.postMessage({
                    type: 'file-range-fetch-response',
                    requestId: req.requestId,
                    bundleName,
                    start: req.start,
                    end: req.end,
                    success: true,
                    data,
                }, [data.buffer]);
            }
        } catch (e) {
            this._log('Coalesced range fetch error: ' + e.message);

            // Send error to all requesters in this group
            for (const req of group) {
                this.worker.postMessage({
                    type: 'file-range-fetch-response',
                    requestId: req.requestId,
                    bundleName,
                    start: req.start,
                    end: req.end,
                    success: false,
                    error: e.message,
                });
            }
        }
    }

    async _handleMemorySnapshot(msg) {
        // Save memory snapshot to persistent storage for future instant restore
        const { snapshot, byteLength } = msg;
        if (!snapshot || byteLength === 0) {
            this._log('Memory snapshot is empty, skipping save');
            return;
        }

        // snapshot is a transferred ArrayBuffer - wrap in Uint8Array for saveWasmMemorySnapshot
        // Pass directly to avoid unnecessary copies (the function accepts Uint8Array)
        const snapshotArray = new Uint8Array(snapshot);
        this._log(`Saving memory snapshot to cache (${(byteLength / 1024 / 1024).toFixed(1)}MB)...`);

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

    async compile(source, options = {}) {
        // Wait for any pending format generation to complete before checking cache
        // This ensures the format is available in OPFS for the current compile
        if (this.formatGenerationPromise) {
            this._log('Waiting for format generation to complete...');
            await this.formatGenerationPromise.catch(() => {});
        }

        const engine = options.engine || detectEngine(source);
        const useCache = this.enableDocCache && options.useCache !== false;

        // Check document cache
        if (useCache) {
            const docHash = hashDocument(source);
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
            await this._initWorker();
        }

        // Determine required bundles
        const { bundles } = this.bundleManager.checkPackages(source, engine);
        this._log('Required bundles: ' + bundles.join(', '));

        // Load bundle data and transfer to worker
        // Worker VFS resets each compile, so bundles must be sent every time
        // Use transfer (not clone) to avoid duplication - copies are made from cache
        this.onProgress('loading', 'Loading bundles...');
        const loadedBundles = await this.bundleManager.loadBundles(bundles);

        let bundleData = {};
        let transferList = [];
        let totalBytes = 0;

        for (const [name, data] of Object.entries(loadedBundles)) {
            if (data) {
                // Create copy for transfer (original stays in bundleManager cache)
                const copy = data.slice(0);
                bundleData[name] = copy;
                transferList.push(copy);
                totalBytes += copy.byteLength;
            }
        }
        this._log(`Transferring ${Object.keys(bundleData).length} bundles (${(totalBytes/1024/1024).toFixed(1)}MB)`);

        // Get CTAN files from memory cache (populated by previous fetches)
        const ctanFiles = this.ctanFetcher.getCachedFiles();

        // Merge in any additional files provided by the user
        const additionalFiles = options.additionalFiles || {};
        for (const [filename, content] of Object.entries(additionalFiles)) {
            // Convert string content to Uint8Array
            const data = typeof content === 'string'
                ? new TextEncoder().encode(content)
                : content;
            // Mount in current directory (will be found by TeX)
            ctanFiles['/' + filename] = data;
        }

        // Check for cached format (in-memory first, then OPFS)
        let cachedFormat = null;
        const preamble = extractPreamble(source);
        const preambleHash = hashPreamble(preamble);
        const fmtKey = preambleHash + '_' + engine;

        // Check in-memory cache first (fast path)
        if (this._fmtMemCache?.key === fmtKey && this._fmtMemCache?.data?.buffer?.byteLength > 0) {
            cachedFormat = { fmtName: fmtKey, fmtData: this._fmtMemCache.data };
            this._log('Using cached format (memory)');
        } else {
            // Fall back to OPFS - path is deterministic from fmtKey
            const fmtPath = getFmtPath(fmtKey);
            const fmtData = await readFromOPFS(fmtPath);
            if (fmtData && fmtData.buffer.byteLength > 0) {
                // Cache in memory for subsequent compiles
                this._fmtMemCache = { key: fmtKey, data: fmtData.slice() };
                cachedFormat = { fmtName: fmtKey, fmtData: this._fmtMemCache.data };
                this._log('Using cached format (OPFS)');
            }
        }

        // Check for cached aux files (include format state in key to avoid mismatch)
        const auxCacheKey = cachedFormat ? preambleHash + '_fmt' : preambleHash;
        const auxCache = await getAuxCache(auxCacheKey);

        // Send compile request
        this.onProgress('compiling', 'Compiling...');
        const compileId = crypto.randomUUID();

        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                if (this.pendingCompile) {
                    this.pendingCompile = null;
                    reject(new Error('Compilation timeout'));
                }
            }, 120000);

            this.pendingCompile = {
                resolve: async (result) => {
                    clearTimeout(timeout);

                    if (result.success) {
                        // Create Uint8Array view - works for both SharedArrayBuffer and ArrayBuffer
                        // Both are zero-copy views, just pointing to different backing memory
                        const pdfData = result.pdfData ? new Uint8Array(result.pdfData) : null;

                        // Cache the PDF (IndexedDB requires regular ArrayBuffer, not SharedArrayBuffer)
                        if (useCache && pdfData) {
                            const docHash = hashDocument(source);
                            const cacheBuffer = result.pdfDataIsShared
                                ? result.pdfData.slice(0)  // Copy SharedArrayBuffer to regular ArrayBuffer
                                : result.pdfData;          // Already regular ArrayBuffer
                            await saveCachedPdf(docHash, engine, cacheBuffer);
                        }

                        // Cache aux files (use same key that includes format state)
                        if (result.auxFilesToCache) {
                            await saveAuxCache(auxCacheKey, result.auxFilesToCache);
                        }

                        // Auto-generate format cache if no cached format was used
                        // Do this in background to not block the compile result
                        if (!cachedFormat && preamble) {
                            this.generateFormat(source, { engine }).then(async () => {
                                // Populate memory cache from the newly generated format
                                const data = await readFromOPFS(getFmtPath(fmtKey));
                                if (data) this._fmtMemCache = { key: fmtKey, data: data.slice() };
                            }).catch(() => {}); // Silent fail for background task
                        }

                        resolve({
                            success: true,
                            pdf: pdfData,
                            pdfIsShared: result.pdfDataIsShared || false, // Pass flag to consumer
                            stats: result.stats,
                            log: result.log,
                        });
                    } else {
                        resolve({
                            success: false,
                            error: result.error,
                            exitCode: result.exitCode,
                            log: result.log,
                        });
                    }
                },
                reject: (error) => {
                    clearTimeout(timeout);
                    reject(error);
                },
            };

            this.worker.postMessage({
                type: 'compile',
                id: compileId,
                source,
                engine,
                options: {
                    enableLazyFS: this.enableLazyFS,
                    enableCtan: this.enableCtan,
                },
                bundleData,
                ctanFiles,
                cachedFormat,
                cachedAuxFiles: auxCache?.files || null,
                deferredBundleNames: this.bundleManager.bundleDeps?.deferred || [],
            }, transferList);
        });
    }

    async generateFormat(source, options = {}) {
        const engine = options.engine || 'pdflatex';
        const preamble = extractPreamble(source);

        if (!preamble) {
            throw new Error('No preamble found in source');
        }

        // Check cache - path is deterministic from fmtKey
        const preambleHash = hashPreamble(preamble);
        const fmtKey = preambleHash + '_' + engine;
        const fmtPath = getFmtPath(fmtKey);
        const existingFmt = await readFromOPFS(fmtPath);
        if (existingFmt && existingFmt.buffer.byteLength > 0) {
            this._log('Format already cached');
            return new Uint8Array(existingFmt);
        }

        // Ensure worker is ready
        if (!this.workerReady) {
            await this._initWorker();
        }

        // Determine required bundles
        const { bundles } = this.bundleManager.checkPackages(source, engine);
        const bundleData = await this.bundleManager.loadBundles(bundles);

        // Get CTAN files from memory cache
        const ctanFiles = this.ctanFetcher.getCachedFiles();

        this._log('Generating format file...');
        this.onProgress('format', 'Generating format...');

        // Track this promise so compile() can wait for it
        this.formatGenerationPromise = new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                if (this.pendingFormat) {
                    this.pendingFormat = null;
                    reject(new Error('Format generation timeout'));
                }
            }, 300000); // 5 minute timeout

            this.pendingFormat = {
                resolve: async (result) => {
                    clearTimeout(timeout);

                    if (result.success) {
                        const fmtData = new Uint8Array(result.formatData);

                        // Cache to OPFS - path is deterministic, no metadata needed
                        await writeToOPFS(fmtPath, fmtData);

                        this._log('Format generated and cached');
                        resolve(fmtData);
                    } else {
                        reject(new Error(result.error || 'Format generation failed'));
                    }
                },
                reject: (error) => {
                    clearTimeout(timeout);
                    reject(error);
                },
            };

            this.worker.postMessage({
                type: 'generate-format',
                id: crypto.randomUUID(),
                preambleContent: preamble,
                engine,
                manifest: this.bundleManager.fileManifest,
                packageMapData: this.bundleManager.packageMap,
                bundleDepsData: this.bundleManager.bundleDeps,
                bundleRegistryData: [...this.bundleManager.bundleRegistry],
                bundleData,
                ctanFiles,
            });
        }).finally(() => {
            this.formatGenerationPromise = null;
        });

        return this.formatGenerationPromise;
    }

    async clearCache() {
        this._log('Clearing CTAN cache...');
        await clearCTANCache();
        this.ctanFetcher.clearMountedFiles();
        this._log('Cache cleared');
    }

    getStats() {
        return {
            bundles: this.bundleManager.getStats(),
            ctan: this.ctanFetcher.getStats(),
        };
    }

    terminate() {
        if (this.worker) {
            this.worker.terminate();
            this.worker = null;
            this.workerReady = false;
        }
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

        // Clear format cache
        this.formatCache.clear();

        // Reset init state so next compile will reinitialize
        this.initPromise = null;

        this._log('Compiler unloaded');
    }

    /**
     * Check if compiler is currently loaded
     */
    isLoaded() {
        return this.worker !== null;
    }
}
