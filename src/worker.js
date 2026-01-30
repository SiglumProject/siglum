// BusyTeX Compilation Worker
// Uses VirtualFileSystem for unified file mounting

// ============ Virtual FileSystem (inlined for worker compatibility) ============

class VirtualFileSystem {
    constructor(FS, options = {}) {
        this.FS = FS;
        this.MEMFS = FS.filesystems.MEMFS;
        this.onLog = options.onLog || (() => {});
        this.mountedFiles = new Set();
        this.mountedDirs = new Set();
        this.pendingFontMaps = new Set();
        this.bundleCache = new Map();
        this.lazyEnabled = options.lazyEnabled || false;
        this.lazyMarkerSymbol = '__siglum_lazy__';
        this.deferredMarkerSymbol = '__siglum_deferred__';

        // Deferred bundle loading - for font bundles loaded on demand
        this.deferredBundles = new Map();  // bundleName -> {manifest entries}
        this.onBundleNeeded = options.onBundleNeeded || null;  // async callback

        // External cache for Range-fetched files (persists across VFS instances)
        this.fetchedFiles = options.fetchedFilesCache || new Map();
    }

    mount(path, content, trackFontMaps = true) {
        this._ensureDirectory(path);
        const data = typeof content === 'string' ? new TextEncoder().encode(content) : content;
        try {
            this.FS.writeFile(path, data);
            this.mountedFiles.add(path);
            if (trackFontMaps) this._trackFontFile(path);
        } catch (e) {
            this.onLog(`Failed to mount ${path}: ${e.message}`);
        }
    }

    mountLazy(path, bundleName, start, end, trackFontMaps = true) {
        this._ensureDirectory(path);
        const dirPath = path.substring(0, path.lastIndexOf('/'));
        const fileName = path.substring(path.lastIndexOf('/') + 1);
        try {
            const parentNode = this.FS.lookupPath(dirPath).node;
            if (parentNode.contents?.[fileName]) return;
            const node = this.MEMFS.createNode(parentNode, fileName, 33206, 0);
            node.contents = this._createLazyMarker(bundleName, start, end);
            node.usedBytes = end - start;
            this.mountedFiles.add(path);
            if (trackFontMaps) this._trackFontFile(path);
        } catch (e) {
            this.onLog(`Failed to mount lazy ${path}: ${e.message}`);
        }
    }

    /**
     * Register a bundle as deferred - files are marked but not loaded
     * When a deferred file is accessed, it triggers a bundle fetch request
     */
    mountDeferredBundle(bundleName, manifest, bundleMeta = null) {
        const bundleFiles = this._getBundleFiles(bundleName, manifest, bundleMeta);
        if (bundleFiles.length === 0) return 0;

        // Store manifest info for later loading
        this.deferredBundles.set(bundleName, { files: bundleFiles, manifest, meta: bundleMeta });

        // Create directory structure
        const dirs = new Set();
        for (const [path] of bundleFiles) {
            const dir = path.substring(0, path.lastIndexOf('/'));
            if (dir) dirs.add(dir);
        }
        for (const dir of dirs) this._ensureDirectoryPath(dir);

        // Mount files as deferred markers
        let mounted = 0;
        for (const [path, info] of bundleFiles) {
            if (this.mountedFiles.has(path)) continue;
            this._mountDeferredFile(path, bundleName, info.start, info.end);
            mounted++;
        }
        this.onLog(`Registered ${mounted} deferred files from bundle ${bundleName}`);
        return mounted;
    }

    _mountDeferredFile(path, bundleName, start, end) {
        this._ensureDirectory(path);
        const dirPath = path.substring(0, path.lastIndexOf('/'));
        const fileName = path.substring(path.lastIndexOf('/') + 1);
        try {
            const parentNode = this.FS.lookupPath(dirPath).node;
            if (parentNode.contents?.[fileName]) return;
            const node = this.MEMFS.createNode(parentNode, fileName, 33206, 0);
            node.contents = this._createDeferredMarker(bundleName, start, end);
            node.usedBytes = end - start;
            this.mountedFiles.add(path);
        } catch (e) {
            this.onLog(`Failed to mount deferred ${path}: ${e.message}`);
        }
    }

    _createDeferredMarker(bundleName, start, end) {
        return { [this.deferredMarkerSymbol]: true, bundleName, start, end, length: end - start, byteLength: end - start };
    }

    isDeferredMarker(obj) {
        return obj && typeof obj === 'object' && obj[this.deferredMarkerSymbol] === true;
    }

    _getBundleFiles(bundleName, manifest, bundleMeta) {
        // Use pre-indexed lookup if available (O(1) vs O(n))
        // Note: Returns cached array reference - callers must not modify!
        if (filesByBundle?.has(bundleName)) {
            return filesByBundle.get(bundleName);
        }

        // Fallback: scan manifest (for dynamically loaded bundles not in index)
        const bundleFiles = [];
        for (const [path, info] of Object.entries(manifest)) {
            if (info.bundle === bundleName) bundleFiles.push([path, info]);
        }

        // If no files found in manifest, use bundle-specific metadata
        if (bundleFiles.length === 0 && bundleMeta?.files) {
            for (const fileInfo of bundleMeta.files) {
                const fullPath = `${fileInfo.path}/${fileInfo.name}`;
                bundleFiles.push([fullPath, { start: fileInfo.start, end: fileInfo.end }]);
            }
        }

        return bundleFiles;
    }

    mountBundle(bundleName, bundleData, manifest, bundleMeta = null) {
        this.bundleCache.set(bundleName, bundleData);
        let mounted = 0;
        const bundleFiles = this._getBundleFiles(bundleName, manifest, bundleMeta);

        const dirs = new Set();
        for (const [path] of bundleFiles) {
            const dir = path.substring(0, path.lastIndexOf('/'));
            if (dir) dirs.add(dir);
        }
        for (const dir of dirs) this._ensureDirectoryPath(dir);

        // Track font files for later pdftex.map rewriting
        const isFontBundle = bundleName === 'cm-super' || bundleName.startsWith('fonts-');

        for (const [path, info] of bundleFiles) {
            if (this.mountedFiles.has(path)) continue;
            if (this.lazyEnabled && !this._shouldEagerLoad(path)) {
                this.mountLazy(path, bundleName, info.start, info.end, false);
            } else {
                const content = new Uint8Array(bundleData.slice(info.start, info.end));
                this.mount(path, content, false);
            }
            mounted++;

            // Track font files for pdftex.map rewriting
            if (isFontBundle && (path.endsWith('.pfb') || path.endsWith('.enc'))) {
                const filename = path.substring(path.lastIndexOf('/') + 1);
                this.fontFileLocations = this.fontFileLocations || new Map();
                this.fontFileLocations.set(filename, path);
            }
        }
        this.onLog(`Mounted ${mounted} files from bundle ${bundleName}`);
        return mounted;
    }

    mountCtanFiles(files, options = {}) {
        const { forceOverride = false } = options;
        const filesMap = files instanceof Map ? files : new Map(Object.entries(files));
        let mounted = 0;
        let overridden = 0;
        for (const [path, content] of filesMap) {
            const alreadyMounted = this.mountedFiles.has(path);
            if (alreadyMounted && !forceOverride) continue;

            const data = typeof content === 'string'
                ? (content.startsWith('base64:') ? this._decodeBase64(content.slice(7)) : new TextEncoder().encode(content))
                : content;
            this.mount(path, data, true);  // Track font maps for CTAN packages

            if (alreadyMounted) {
                overridden++;
            } else {
                mounted++;
            }
        }
        if (overridden > 0) {
            this.onLog(`Mounted ${mounted} CTAN files, overrode ${overridden} bundle files`);
        } else {
            this.onLog(`Mounted ${mounted} CTAN files`);
        }
        return mounted + overridden;
    }

    processFontMaps() {
        if (this.pendingFontMaps.size === 0) return;
        const PDFTEX_MAP_PATH = '/texlive/texmf-dist/texmf-var/fonts/map/pdftex/updmap/pdftex.map';
        let existingMap = '';
        try {
            existingMap = new TextDecoder().decode(this.FS.readFile(PDFTEX_MAP_PATH));
        } catch (e) {
            this._ensureDirectoryPath(PDFTEX_MAP_PATH.substring(0, PDFTEX_MAP_PATH.lastIndexOf('/')));
        }
        let appended = 0;
        for (const mapPath of this.pendingFontMaps) {
            try {
                const mapContent = new TextDecoder().decode(this.FS.readFile(mapPath));
                const rewrittenContent = this._rewriteMapPaths(mapContent, mapPath);
                existingMap += `\n% Added from ${mapPath}\n${rewrittenContent}\n`;
                appended++;
            } catch (e) {
                this.onLog(`Failed to process font map ${mapPath}: ${e.message}`);
            }
        }
        if (appended > 0) {
            this.FS.writeFile(PDFTEX_MAP_PATH, existingMap);
            this.onLog(`Processed ${appended} font maps`);
        }
        this.pendingFontMaps.clear();
    }

    _rewriteMapPaths(mapContent, mapFilePath) {
        const lines = mapContent.split('\n');
        const mapDir = mapFilePath.substring(0, mapFilePath.lastIndexOf('/'));
        const packageMatch = mapFilePath.match(/\/([^\/]+)\/[^\/]+\.map$/);
        const packageName = packageMatch ? packageMatch[1] : '';
        const searchPaths = {
            pfb: [`/texlive/texmf-dist/fonts/type1/public/${packageName}`, '/texlive/texmf-dist/fonts/type1/public/cm-super', mapDir],
            enc: [`/texlive/texmf-dist/fonts/enc/dvips/${packageName}`, '/texlive/texmf-dist/fonts/enc/dvips/cm-super', `/texlive/texmf-dist/fonts/type1/public/${packageName}`, mapDir]
        };
        return lines.map(line => {
            if (line.trim().startsWith('%') || line.trim() === '') return line;
            let rewritten = line;
            const fileRefPattern = /<<?([a-zA-Z0-9_-]+\.(pfb|enc))/g;
            let match;
            while ((match = fileRefPattern.exec(line)) !== null) {
                const [fullMatch, filename, ext] = match;
                const prefix = fullMatch.startsWith('<<') ? '<<' : '<';
                const paths = searchPaths[ext] || [];
                for (const searchDir of paths) {
                    const candidatePath = `${searchDir}/${filename}`;
                    try {
                        if (this.FS.analyzePath(candidatePath).exists) {
                            rewritten = rewritten.replace(fullMatch, `${prefix}${candidatePath}`);
                            break;
                        }
                    } catch (e) {}
                }
            }
            return rewritten;
        }).join('\n');
    }

    generateLsR(basePath = '/texlive/texmf-dist') {
        const dirContents = new Map();
        dirContents.set(basePath, { files: [], subdirs: [] });
        const getDir = (dirPath) => {
            if (!dirContents.has(dirPath)) dirContents.set(dirPath, { files: [], subdirs: [] });
            return dirContents.get(dirPath);
        };
        for (const path of this.mountedFiles) {
            if (!path.startsWith(basePath)) continue;
            const lastSlash = path.lastIndexOf('/');
            if (lastSlash < 0) continue;
            const dirPath = path.substring(0, lastSlash);
            const fileName = path.substring(lastSlash + 1);
            let current = basePath;
            for (const part of dirPath.substring(basePath.length + 1).split('/').filter(p => p)) {
                const parent = getDir(current);
                current = `${current}/${part}`;
                if (!parent.subdirs.includes(part)) parent.subdirs.push(part);
                getDir(current);
            }
            getDir(dirPath).files.push(fileName);
        }
        const output = ['% ls-R -- filename database.', '% Created by Siglum VFS', ''];
        const outputDir = (dirPath) => {
            const contents = dirContents.get(dirPath);
            if (!contents) return;
            output.push(`${dirPath}:`);
            contents.files.sort().forEach(f => output.push(f));
            contents.subdirs.sort().forEach(d => output.push(d));
            output.push('');
            contents.subdirs.sort().forEach(subdir => outputDir(`${dirPath}/${subdir}`));
        };
        outputDir(basePath);
        const lsRContent = output.join('\n');
        this.FS.writeFile(`${basePath}/ls-R`, lsRContent);
        return lsRContent;
    }

    finalize() {
        this.processFontMaps();
        this.rewritePdftexMapPaths();
        this.generateLsR();
        this.onLog(`VFS finalized: ${this.mountedFiles.size} files`);
    }

    rewritePdftexMapPaths() {
        // Rewrite pdftex.map to use absolute paths for font files
        // This ensures pdfTeX can find fonts without relying on kpathsea search
        if (!this.fontFileLocations || this.fontFileLocations.size === 0) return;

        const PDFTEX_MAP_PATH = '/texlive/texmf-dist/texmf-var/fonts/map/pdftex/updmap/pdftex.map';
        try {
            const mapContent = new TextDecoder().decode(this.FS.readFile(PDFTEX_MAP_PATH));
            const lines = mapContent.split('\n');
            let modifiedCount = 0;

            const rewrittenLines = lines.map(line => {
                if (line.trim().startsWith('%') || line.trim() === '') return line;

                let rewritten = line;
                // Match font file references: <filename.pfb or <<filename.pfb or <filename.enc
                const fileRefPattern = /<<?([a-zA-Z0-9_-]+\.(pfb|enc))/g;
                let match;
                while ((match = fileRefPattern.exec(line)) !== null) {
                    const [fullMatch, filename] = match;
                    const absolutePath = this.fontFileLocations.get(filename);
                    if (absolutePath) {
                        const prefix = fullMatch.startsWith('<<') ? '<<' : '<';
                        rewritten = rewritten.replace(fullMatch, `${prefix}${absolutePath}`);
                        modifiedCount++;
                    }
                }
                return rewritten;
            });

            if (modifiedCount > 0) {
                const newMapContent = rewrittenLines.join('\n');
                this.FS.writeFile(PDFTEX_MAP_PATH, newMapContent);
                this.onLog(`Rewrote pdftex.map: ${modifiedCount} font paths resolved`);
            }
        } catch (e) {
            // pdftex.map might not exist yet, that's OK
        }
    }

    _createLazyMarker(bundleName, start, end) {
        return { [this.lazyMarkerSymbol]: true, bundleName, start, end, length: end - start, byteLength: end - start };
    }

    isLazyMarker(obj) {
        return obj && typeof obj === 'object' && obj[this.lazyMarkerSymbol] === true;
    }

    resolveLazy(marker) {
        const bundleData = this.bundleCache.get(marker.bundleName);
        if (!bundleData) {
            this.onLog(`ERROR: Bundle not in cache: ${marker.bundleName}`);
            return new Uint8Array(0);
        }
        return new Uint8Array(bundleData.slice(marker.start, marker.end));
    }

    /**
     * Resolve a deferred marker - returns data if bundle loaded, tracks request if not
     * For per-file loading: tracks individual files to fetch via Range requests
     */
    resolveDeferred(marker) {
        const bundleData = this.bundleCache.get(marker.bundleName);
        if (bundleData) {
            // Bundle is now loaded - return the actual data
            return new Uint8Array(bundleData.slice(marker.start, marker.end));
        }

        // Check if file was already fetched individually via Range request
        const fileKey = `${marker.bundleName}:${marker.start}:${marker.end}`;
        if (this.fetchedFiles.has(fileKey)) {
            return this.fetchedFiles.get(fileKey);
        }

        // Track individual file request for Range-based fetching (avoid duplicates)
        this.pendingDeferredFiles = this.pendingDeferredFiles || [];
        const alreadyPending = this.pendingDeferredFiles.some(
            f => f.bundleName === marker.bundleName && f.start === marker.start && f.end === marker.end
        );
        if (!alreadyPending) {
            this.pendingDeferredFiles.push({
                bundleName: marker.bundleName,
                start: marker.start,
                end: marker.end,
            });
        }

        // Return empty data - this will cause TeX to fail with a file not found error
        // The retry loop will detect this and fetch individual files via Range requests
        return new Uint8Array(0);
    }

    /**
     * Store fetched file data for later resolution
     * Uses LRU-style eviction when cache exceeds max entries
     */
    storeFetchedFile(bundleName, start, end, data) {
        const key = `${bundleName}:${start}:${end}`;
        // Evict oldest entries if cache is at limit (200 entries max)
        const maxEntries = 200;
        while (this.fetchedFiles.size >= maxEntries) {
            const oldestKey = this.fetchedFiles.keys().next().value;
            this.fetchedFiles.delete(oldestKey);
        }
        this.fetchedFiles.set(key, data);
    }

    /**
     * Get list of individual files that need to be fetched via Range requests
     */
    getPendingDeferredFiles() {
        const pending = this.pendingDeferredFiles || [];
        this.pendingDeferredFiles = [];
        return pending;
    }

    /**
     * Get list of deferred bundles (legacy fallback - not used with per-file loading)
     */
    getPendingDeferredBundles() {
        const pending = this.pendingDeferredBundles ? [...this.pendingDeferredBundles] : [];
        if (this.pendingDeferredBundles) this.pendingDeferredBundles.clear();
        return pending;
    }

    /**
     * Upgrade deferred markers to lazy markers when bundle is loaded
     * Call this after a deferred bundle's data is added to bundleCache
     */
    activateDeferredBundle(bundleName) {
        if (!this.bundleCache.has(bundleName)) {
            this.onLog(`Cannot activate deferred bundle ${bundleName}: not in cache`);
            return 0;
        }

        const bundleInfo = this.deferredBundles.get(bundleName);
        if (!bundleInfo) return 0;

        let activated = 0;
        for (const [path] of bundleInfo.files) {
            try {
                const node = this.FS.lookupPath(path).node;
                if (this.isDeferredMarker(node.contents)) {
                    // Convert deferred marker to lazy marker (same structure, different symbol)
                    const marker = node.contents;
                    node.contents = this._createLazyMarker(marker.bundleName, marker.start, marker.end);
                    activated++;
                }
            } catch (e) {}
        }

        this.deferredBundles.delete(bundleName);
        this.onLog(`Activated ${activated} files from deferred bundle ${bundleName}`);
        return activated;
    }

    patchForLazyLoading() {
        const vfs = this;
        const ensureResolved = (node) => {
            // Fast path: if already a Uint8Array, no resolution needed
            const contents = node.contents;
            if (contents instanceof Uint8Array) return;

            if (vfs.isLazyMarker(contents)) {
                const resolved = vfs.resolveLazy(contents);
                node.contents = resolved;
                node.usedBytes = resolved.length;
            } else if (vfs.isDeferredMarker(contents)) {
                const resolved = vfs.resolveDeferred(contents);
                // Always replace marker with resolved data (even if empty)
                // This is required because MEMFS.read expects node.contents to be a Uint8Array
                // The bundle tracking happens inside resolveDeferred() before returning empty
                node.contents = resolved;
                node.usedBytes = resolved.length;
            }
        };
        const originalRead = this.MEMFS.stream_ops.read;
        this.MEMFS.stream_ops.read = function(stream, buffer, offset, length, position) {
            ensureResolved(stream.node);
            return originalRead.call(this, stream, buffer, offset, length, position);
        };
        if (this.MEMFS.ops_table?.file?.stream?.read) {
            const originalTableRead = this.MEMFS.ops_table.file.stream.read;
            this.MEMFS.ops_table.file.stream.read = function(stream, buffer, offset, length, position) {
                ensureResolved(stream.node);
                return originalTableRead.call(this, stream, buffer, offset, length, position);
            };
        }
        if (this.MEMFS.stream_ops.mmap) {
            const originalMmap = this.MEMFS.stream_ops.mmap;
            this.MEMFS.stream_ops.mmap = function(stream, length, position, prot, flags) {
                ensureResolved(stream.node);
                return originalMmap.call(this, stream, length, position, prot, flags);
            };
        }
        this.lazyEnabled = true;
        this.onLog('VFS: Lazy loading enabled');
    }

    _ensureDirectory(filePath) {
        const dirPath = filePath.substring(0, filePath.lastIndexOf('/'));
        this._ensureDirectoryPath(dirPath);
    }

    _ensureDirectoryPath(dirPath) {
        if (this.mountedDirs.has(dirPath)) return;
        const parts = dirPath.split('/').filter(p => p);
        let current = '';
        for (const part of parts) {
            current += '/' + part;
            if (this.mountedDirs.has(current)) continue;
            try { this.FS.stat(current); } catch (e) { try { this.FS.mkdir(current); } catch (e2) {} }
            this.mountedDirs.add(current);
        }
    }

    _shouldEagerLoad(path) {
        // Eager load critical files that kpathsea needs to find
        return path.endsWith('.fmt') ||
               path.endsWith('texmf.cnf') ||
               path.endsWith('.map') ||
               path.endsWith('.pfb') ||  // Type1 fonts - needed by pdfTeX
               path.endsWith('.enc');    // Encoding files - needed by pdfTeX
    }

    _trackFontFile(path) {
        // Track font maps for later processing (append to pdftex.map)
        // Only called for CTAN packages - bundles pass trackFontMaps=false
        if (path.endsWith('.map') && !path.endsWith('pdftex.map')) {
            this.pendingFontMaps.add(path);
        }
    }

    _decodeBase64(base64) {
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return bytes;
    }
}

function configureTexEnvironment(ENV) {
    ENV['TEXMFCNF'] = '/texlive/texmf-dist/web2c';
    ENV['TEXMFROOT'] = '/texlive';
    ENV['TEXMFDIST'] = '/texlive/texmf-dist';
    ENV['TEXMFVAR'] = '/texlive/texmf-dist/texmf-var';
    ENV['TEXMFSYSVAR'] = '/texlive/texmf-dist/texmf-var';
    ENV['TEXMFSYSCONFIG'] = '/texlive/texmf-dist';
    ENV['TEXMFLOCAL'] = '/texlive/texmf-dist';
    ENV['TEXMFHOME'] = '/texlive/texmf-dist';
    ENV['TEXMFCONFIG'] = '/texlive/texmf-dist';
    ENV['TEXMFAUXTREES'] = '';
    ENV['TEXMF'] = '/texlive/texmf-dist';
    ENV['TEXMFDOTDIR'] = '.';
    ENV['TEXINPUTS'] = '.:/texlive/texmf-dist/tex/latex//:/texlive/texmf-dist/tex/generic//:/texlive/texmf-dist/tex//:';
    ENV['T1FONTS'] = '.:/texlive/texmf-dist/fonts/type1//';
    ENV['ENCFONTS'] = '.:/texlive/texmf-dist/fonts/enc//';
    ENV['TFMFONTS'] = '.:/texlive/texmf-dist/fonts/tfm//';
    ENV['VFFONTS'] = '.:/texlive/texmf-dist/fonts/vf//';
    ENV['TEXFONTMAPS'] = '.:/texlive/texmf-dist/fonts/map/dvips//:/texlive/texmf-dist/fonts/map/pdftex//:/texlive/texmf-dist/texmf-var/fonts/map//';
    ENV['TEXPSHEADERS'] = '.:/texlive/texmf-dist/dvips//:/texlive/texmf-dist/fonts/enc//:/texlive/texmf-dist/fonts/type1//:/texlive/texmf-dist/fonts/type42//';
}

// ============ Worker Code ============

const BUNDLE_BASE = 'packages/bundles';

// Worker state
let cachedWasmModule = null;
let busytexJsUrl = null;
let fileManifest = null;
let packageMap = null;
let bundleDeps = null;
let bundleRegistry = null;
let verboseLogging = false; // When false, skip TeX stdout logging for performance

// Pre-indexed manifest: bundleName → [[path, info], ...]
// Allows O(1) lookup instead of O(n) scan per mountBundle call
let filesByBundle = null;

// Font file index: basename (e.g., "lmbx12.pfb") → bundle name
// Enables dynamic font bundle resolution for any font in any bundle
let fontFileToBundle = null;

/**
 * Index manifest by bundle name for fast lookup.
 * Also builds font file index for dynamic font resolution.
 * Called once at worker init.
 */
function ensureManifestIndexed(manifest) {
    if (filesByBundle || !manifest) return;

    filesByBundle = new Map();
    fontFileToBundle = new Map();

    for (const [path, info] of Object.entries(manifest)) {
        const bundle = info.bundle;
        if (!bundle) continue;
        if (!filesByBundle.has(bundle)) {
            filesByBundle.set(bundle, []);
        }
        filesByBundle.get(bundle).push([path, info]);

        // Index font files by basename for dynamic lookup
        if (path.endsWith('.pfb') || path.endsWith('.tfm')) {
            const basename = path.substring(path.lastIndexOf('/') + 1);
            // Only store first occurrence (some fonts may be in multiple bundles)
            if (!fontFileToBundle.has(basename)) {
                fontFileToBundle.set(basename, bundle);
            }
        }
    }
    workerLog(`Indexed manifest: ${filesByBundle.size} bundles, ${fontFileToBundle.size} font files`);
}

// SharedArrayBuffer support - check once at startup
const sharedArrayBufferAvailable = typeof SharedArrayBuffer !== 'undefined';

// Global Module instance - reused across compilations to avoid memory leaks
// Each initBusyTeX call creates a 512MB WASM heap; we want only ONE
let globalModule = null;
let globalModulePromise = null;

// Pending requests
const pendingCtanRequests = new Map();
const pendingBundleRequests = new Map();
const pendingFileRangeRequests = new Map();

// Global cache for Range-fetched files (persists across compiles)
const globalFetchedFilesCache = new Map();

// Operation queue to serialize compile and format-generate operations
// (async onmessage doesn't block new messages from being processed concurrently)
let operationQueue = Promise.resolve();

function workerLog(msg) {
    self.postMessage({ type: 'log', message: msg });
}

function workerProgress(stage, detail) {
    self.postMessage({ type: 'progress', stage, detail });
}

// ============ External Fetch Requests ============

// Supported TexLive years for version fallback (newest first)
const SUPPORTED_TL_YEARS = [2025, 2024, 2023];
const DEFAULT_TL_YEAR = 2025;

function requestCtanFetch(packageName, originalFileName = null, tlYear = null) {
    return new Promise((resolve, reject) => {
        const requestId = crypto.randomUUID();
        pendingCtanRequests.set(requestId, { resolve, reject });

        self.postMessage({
            type: 'ctan-fetch-request',
            requestId,
            packageName,
            fileName: originalFileName || packageName + '.sty',  // For file-to-package lookup
            tlYear,  // Optional: request specific TexLive year
        });

        setTimeout(() => {
            if (pendingCtanRequests.has(requestId)) {
                pendingCtanRequests.delete(requestId);
                reject(new Error('CTAN fetch timeout'));
            }
        }, 60000);
    });
}

function requestBundleFetch(bundleName) {
    return new Promise((resolve, reject) => {
        const requestId = crypto.randomUUID();
        pendingBundleRequests.set(requestId, { resolve, reject });

        self.postMessage({
            type: 'bundle-fetch-request',
            requestId,
            bundleName,
        });

        setTimeout(() => {
            if (pendingBundleRequests.has(requestId)) {
                pendingBundleRequests.delete(requestId);
                reject(new Error('Bundle fetch timeout'));
            }
        }, 60000);
    });
}

function requestFileRangeFetch(bundleName, start, end) {
    return new Promise((resolve, reject) => {
        const requestId = crypto.randomUUID();
        pendingFileRangeRequests.set(requestId, { resolve, reject });

        self.postMessage({
            type: 'file-range-fetch-request',
            requestId,
            bundleName,
            start,
            end,
        });

        setTimeout(() => {
            if (pendingFileRangeRequests.has(requestId)) {
                pendingFileRangeRequests.delete(requestId);
                reject(new Error('File range fetch timeout'));
            }
        }, 30000);
    });
}

// ============ Source Processing ============

function injectMicrotypeWorkaround(source) {
    if (!source.includes('microtype')) return source;
    const documentclassMatch = source.match(/\\documentclass/);
    if (!documentclassMatch) return source;
    const insertPos = documentclassMatch.index;
    const workaround = '% Siglum: Disable microtype font expansion\n\\PassOptionsToPackage{expansion=false}{microtype}\n';
    workerLog('Injecting microtype expansion=false workaround');
    return source.slice(0, insertPos) + workaround + source.slice(insertPos);
}

// Compatibility shims for package version issues
// These fix issues where CTAN packages expect features not in our kernel

function injectKernelCompatShim(source) {
    // Reserved for future use - version fallback system will handle compatibility
    return source;
}

// Patterns that indicate LaTeX3 tagging/accessibility features not in our kernel
// These are used to detect when a package needs version fallback or shimming
// Detection is pattern-based, not hardcoded to specific commands
const KERNEL_INCOMPATIBLE_PATTERNS = [
    /^tag(struct|mc|pdf)/i,           // tagstructbegin, tagmcend, tagpdfparaOff, etc.
    /Structure(Name|Role)/i,          // NewStructureName, AssignStructureRole, etc.
    /TaggingSocket/i,                 // NewTaggingSocket, UseTaggingSocket, etc.
    /DocumentMetadata/i,              // DocumentMetadata, DeclareDocumentMetadata
    /PDFManagement/i,                 // IfPDFManagementActiveTF
    /^socket_/i,                      // socket_new, socket_set, etc.
];

// Check if a command matches kernel incompatibility patterns
function isKernelIncompatibleCommand(cmd) {
    return KERNEL_INCOMPATIBLE_PATTERNS.some(pattern => pattern.test(cmd));
}

// Check if undefined commands indicate kernel incompatibility
// Returns list of packages that should be tried with older TL versions
function detectKernelIncompatibility(logContent, undefinedCommands) {
    const incompatiblePackages = new Set();

    // Check if any undefined commands match kernel incompatibility patterns
    for (const cmd of undefinedCommands.keys()) {
        if (isKernelIncompatibleCommand(cmd)) {
            workerLog(`[KERNEL] Detected kernel-incompatible command: \\${cmd}`);

            // Try to identify which package triggered this
            const pkgMatch = identifyPackageFromLog(logContent, cmd);
            if (pkgMatch) {
                incompatiblePackages.add(pkgMatch);
                workerLog(`[KERNEL] Command \\${cmd} is from package: ${pkgMatch}`);
            }
        }
    }

    return incompatiblePackages;
}

// Try to identify which package is causing the undefined command
// Parses TeX log file loading structure to find the currently-loading file
function identifyPackageFromLog(logContent, cmd) {
    const errorIndex = logContent.indexOf(`\\${cmd}`);
    if (errorIndex === -1) return null;

    // Get context before the error
    let contextBefore = logContent.slice(Math.max(0, errorIndex - 10000), errorIndex);

    // Preprocess: Remove [TeX] and [TeX ERR] prefixes from each line
    contextBefore = contextBefore.replace(/^\[TeX( ERR)?\] /gm, '');

    // Preprocess: Join wrapped lines (TeX wraps at ~79 chars)
    contextBefore = contextBefore.replace(/([a-zA-Z0-9_.-])\n([a-zA-Z0-9_.-])/g, '$1$2');

    // Find all .sty and .cls file opens with their positions
    const fileOpens = [];
    const openRegex = /\(([^\s()"']*\/([^\/]+)\.(sty|cls))/gi;
    for (const match of contextBefore.matchAll(openRegex)) {
        fileOpens.push({
            pos: match.index,
            path: match[1],
            name: match[2]
        });
    }

    // For each file open (from last to first), check if it's still open
    // by counting ( and ) between the open position and end of context
    for (let i = fileOpens.length - 1; i >= 0; i--) {
        const file = fileOpens[i];
        const afterOpen = contextBefore.slice(file.pos);

        // Count parens in the text after this file open
        let depth = 0;
        for (const char of afterOpen) {
            if (char === '(') depth++;
            else if (char === ')') depth--;
            // If depth goes negative, this file has been closed
            if (depth < 0) break;
        }

        // If depth > 0, this file is still open at the error point
        // (depth=0 means balanced parens = file was closed)
        if (depth > 0) {
            workerLog(`[KERNEL] Found open package: ${file.name} (depth=${depth})`);
            return file.name;
        }
    }

    // Fallback: Try to match "Package foo" pattern in log messages
    workerLog(`[KERNEL] No open package found, trying Package pattern fallback`);
    const packageMatches = [...contextBefore.matchAll(/Package\s+([\w-]+)\s+(?:Info|Warning|Error)/g)];
    if (packageMatches.length > 0) {
        const fallbackPkg = packageMatches[packageMatches.length - 1][1];
        workerLog(`[KERNEL] Fallback found: ${fallbackPkg}`);
        return fallbackPkg;
    }

    return null;
}

// Extract undefined control sequences from TeX log with argument count detection
function extractUndefinedCommands(logContent) {
    const commands = new Map(); // cmd -> argCount
    // Pattern: "! Undefined control sequence." followed by lines with command and args
    // Log format (with [TeX] prefixes):
    //   [TeX] ! Undefined control sequence.
    //   [TeX] l.76 \NewStructureName
    //   [TeX]                       {tcb/box}
    // Or with multiple commands:
    //   [TeX] l.81   {\par\tagstructbegin
    //   [TeX]                            {tag=...}
    // The LAST command before the line break is the undefined one

    const errorPattern = /! Undefined control sequence\./g;
    let errorMatch;

    while ((errorMatch = errorPattern.exec(logContent)) !== null) {
        // Get the next ~500 chars to find the command and its arguments
        const context = logContent.slice(errorMatch.index, errorMatch.index + 500);

        // Find the line with "l.N" - this contains the undefined command
        const lineMatch = context.match(/l\.\d+[^\n]*/);
        if (!lineMatch) continue;

        const errorLine = lineMatch[0];

        // Find ALL commands on this line - the LAST one is the undefined one
        const cmdMatches = [...errorLine.matchAll(/\\([a-zA-Z]+)/g)];
        if (cmdMatches.length === 0) continue;

        // The undefined command is the last one on the line
        const lastMatch = cmdMatches[cmdMatches.length - 1];
        const cmd = lastMatch[1];
        if (cmd.length < 2 || cmd.length > 50) continue;

        // Get everything after this command to count arguments
        const afterCmd = context.slice(lineMatch.index + lastMatch.index + lastMatch[0].length);
        // Stop at next error, "==>" marker, or "Transcript"
        const endMatch = afterCmd.match(/!|==>|Transcript/);
        const argContext = endMatch ? afterCmd.slice(0, endMatch.index) : afterCmd;

        // Count opening braces
        const braceCount = (argContext.match(/\{/g) || []).length;
        const argCount = Math.min(braceCount, 9);

        if (!commands.has(cmd) || commands.get(cmd) < argCount) {
            commands.set(cmd, argCount);
        }
    }
    return commands;
}

// Inject auto-generated stubs for undefined commands
// undefinedCommands is a Map<commandName, argCount>
function injectAutoShims(source, undefinedCommands) {
    if (undefinedCommands.size === 0) return source;

    // Find the end of \documentclass[...]{...} to insert after it
    const documentclassMatch = source.match(/\\documentclass(\[[^\]]*\])?\{[^}]+\}/);
    if (!documentclassMatch) return source;

    // Generate stubs with detected argument counts
    const stubs = [];
    const cmdList = [];
    for (const [cmd, argCount] of undefinedCommands) {
        cmdList.push(`${cmd}[${argCount}]`);
        if (argCount === 0) {
            stubs.push(`\\providecommand{\\${cmd}}{}`);
        } else {
            stubs.push(`\\providecommand{\\${cmd}}[${argCount}]{}`);
        }
    }

    const insertPos = documentclassMatch.index + documentclassMatch[0].length;
    const shimBlock = `
% Siglum: Auto-generated stubs for undefined commands
${stubs.join('%\n')}%
`;
    workerLog(`Auto-shimming ${undefinedCommands.size} commands: ${cmdList.join(', ')}`);
    return source.slice(0, insertPos) + shimBlock + source.slice(insertPos);
}

function injectPdfMapFileCommands(source, mapFilePaths) {
    if (mapFilePaths.length === 0) return source;
    const newMaps = mapFilePaths.filter(p => !source.includes(p));
    if (newMaps.length === 0) return source;

    const mapCommands = newMaps.map(p => '\\pdfmapfile{+' + p + '}').join('\n');
    const documentclassMatch = source.match(/\\documentclass(\[[^\]]*\])?\{[^}]+\}/);

    if (documentclassMatch) {
        const insertPos = documentclassMatch.index + documentclassMatch[0].length;
        const preambleInsert = '\n% Font maps injected by Siglum\n' + mapCommands + '\n';
        workerLog('Injecting ' + newMaps.length + ' \\pdfmapfile commands');
        return source.slice(0, insertPos) + preambleInsert + source.slice(insertPos);
    }
    return source;
}

// ============ Missing File Detection ============

function extractMissingFile(logContent, alreadyFetched) {
    const files = extractAllMissingFiles(logContent, alreadyFetched);
    return files.length > 0 ? files[0] : null;
}

// Extract ALL missing files from log (for parallel fetching)
function extractAllMissingFiles(logContent, alreadyFetched) {
    const patterns = [
        /! LaTeX Error: File `([^']+)' not found/g,
        /! I can't find file `([^']+)'/g,
        /LaTeX Warning:.*File `([^']+)' not found/g,
        /Package .* Error:.*`([^']+)' not found/g,
        /! Font [^=]+=([a-z0-9-]+) at .* not loadable: Metric \(TFM\) file/g,
        /!pdfTeX error:.*\(file ([a-z0-9-]+)\): Font .* not found/g,
        /! Font ([a-z0-9-]+) at [0-9]+ not found/g,
        // Generic PGF/TeX: "I looked for files named X.code.tex" (captures first filename)
        /I looked for files named ([a-z0-9_-]+\.code\.tex)/gi,
        // xdvipdfmx: Could not locate a virtual/physical font for TFM "ec-lmbx12"
        /xdvipdfmx.*Could not locate.*TFM "([a-z0-9_-]+)"/gi,
        // xdvipdfmx: This font is mapped to a physical font "lmbx12.pfb"
        /xdvipdfmx.*mapped to.*"([a-z0-9_-]+\.pfb)"/gi,
    ];
    const fetchedSet = alreadyFetched || new Set();
    const missingFiles = [];
    const seenPkgs = new Set();

    for (const pattern of patterns) {
        let match;
        while ((match = pattern.exec(logContent)) !== null) {
            const missingFile = match[1];
            const pkgName = getPackageFromFile(missingFile);
            if (!fetchedSet.has(pkgName) && !seenPkgs.has(pkgName)) {
                seenPkgs.add(pkgName);
                missingFiles.push(missingFile);
            }
        }
    }
    return missingFiles;
}

function getFontPackage(fontName) {
    if (!fontName) return null;

    // Strip font extension if present
    const baseName = fontName.replace(/\.(pfb|tfm)$/i, '');

    // Dynamic lookup: check font file index first (covers ALL fonts in bundles)
    if (fontFileToBundle) {
        // Try as .pfb file (physical font)
        let bundle = fontFileToBundle.get(baseName + '.pfb');
        if (bundle) return bundle;

        // Try as .tfm file (TFM name like "ec-lmbx12")
        bundle = fontFileToBundle.get(baseName + '.tfm');
        if (bundle) return bundle;
    }

    // Fallback: Latin Modern patterns for CTAN fetch (when not in local bundles)
    if (/^(rm|cs|ec|ts|qx|t5|l7x)-?lm/.test(baseName)) return 'lm';
    if (/^lm[a-z]{1,4}\d+$/.test(baseName)) return 'lm';

    return null;
}

function getPackageFromFile(filename) {
    const fontPkg = getFontPackage(filename);
    if (fontPkg) return fontPkg;

    // Strip extension - the file-to-package index handles the mapping
    return filename.replace(/\.(sty|cls|def|clo|fd|cfg|tex|code\.tex)$/, '');
}

// ============ Aux File Handling ============

function collectAuxFiles(FS) {
    const auxExtensions = ['.aux', '.toc', '.lof', '.lot', '.out', '.nav', '.snm', '.bbl', '.blg'];
    const files = {};
    for (const ext of auxExtensions) {
        const path = '/document' + ext;
        try {
            files[ext] = FS.readFile(path, { encoding: 'utf8' });
        } catch (e) {}
    }
    return files;
}

function restoreAuxFiles(FS, auxFiles) {
    let restored = 0;
    for (const [ext, content] of Object.entries(auxFiles)) {
        try {
            FS.writeFile('/document' + ext, content);
            restored++;
        } catch (e) {}
    }
    return restored;
}

// ============ WASM Initialization ============

// Track if busytex.js has been loaded
let busytexScriptLoaded = false;

async function initBusyTeX(wasmModule, jsUrl, memorySnapshot = null) {
    const startTime = performance.now();

    // Only load busytex.js once - it defines the global `busytex` function
    // Use fetch + Blob URL to support cross-origin CDN loading (importScripts has stricter CORS)
    if (!busytexScriptLoaded) {
        const response = await fetch(jsUrl);
        if (!response.ok) throw new Error(`Failed to fetch busytex.js: ${response.status}`);
        const code = await response.text();
        const blob = new Blob([code], { type: 'application/javascript' });
        importScripts(URL.createObjectURL(blob));
        busytexScriptLoaded = true;
    }

    // Output capture for stdout/stderr - accessible by print/printErr callbacks via closure
    // Use arrays for O(n) performance instead of string concat O(n²)
    const outputCapture = { stdout: [], stderr: [] };

    const moduleConfig = {
        thisProgram: '/bin/busytex',
        noInitialRun: true,
        noExitRuntime: true,
        instantiateWasm: (imports, successCallback) => {
            WebAssembly.instantiate(wasmModule, imports).then(instance => {
                // Restore memory from snapshot if available (skips ~3s TeX initialization)
                if (memorySnapshot) {
                    try {
                        const memory = instance.exports.memory;
                        const snapshotView = memorySnapshot instanceof Uint8Array
                            ? memorySnapshot
                            : new Uint8Array(memorySnapshot);
                        const memoryView = new Uint8Array(memory.buffer);

                        // Only restore if snapshot fits in current memory
                        if (snapshotView.byteLength <= memoryView.byteLength) {
                            memoryView.set(snapshotView);
                            workerLog(`Restored memory snapshot (${(snapshotView.byteLength / 1024 / 1024).toFixed(1)}MB)`);
                        } else {
                            // Need to grow memory to fit snapshot
                            const currentPages = memory.buffer.byteLength / 65536;
                            const neededPages = Math.ceil(snapshotView.byteLength / 65536);
                            const pagesToGrow = neededPages - currentPages;
                            if (pagesToGrow > 0) {
                                memory.grow(pagesToGrow);
                                const grownView = new Uint8Array(memory.buffer);
                                grownView.set(snapshotView);
                                workerLog(`Restored memory snapshot (${(snapshotView.byteLength / 1024 / 1024).toFixed(1)}MB) after growing memory`);
                            } else {
                                workerLog('Memory snapshot size mismatch, skipping restore');
                            }
                        }
                    } catch (e) {
                        workerLog('Failed to restore memory snapshot: ' + e.message);
                    }
                }
                successCallback(instance);
            });
            return {};
        },
        print: (text) => {
            // Suppress noisy font map warnings
            if (text.includes('ambiguous entry') ||
                text.includes('duplicates ignored') ||
                text.includes('will be treated as font file not present') ||
                text.includes('font file present but not included') ||
                text.includes('invalid entry for') ||
                text.includes('SlantFont/ExtendFont')) return;
            // Only log TeX stdout in verbose mode (saves ~4000 postMessage calls)
            if (verboseLogging) workerLog('[TeX] ' + text);
            // Capture stdout for error detection
            outputCapture.stdout.push(text);
        },
        printErr: (text) => {
            // Suppress font generation attempts (not supported in WASM)
            if (text.includes('mktexpk') || text.includes('kpathsea: fork')) return;
            // Always log errors regardless of verbose mode
            workerLog('[TeX ERR] ' + text);
            // Capture stderr for error detection
            outputCapture.stderr.push(text);
        },
        locateFile: (path) => path,
        preRun: [function() {
            moduleConfig.ENV = moduleConfig.ENV || {};
            configureTexEnvironment(moduleConfig.ENV);
        }],
    };

    const Module = await busytex(moduleConfig);
    const FS = Module.FS;
    try { FS.mkdir('/bin'); } catch (e) {}
    try { FS.writeFile('/bin/busytex', ''); } catch (e) {}

    Module.setPrefix = function(prefix) {
        Module.thisProgram = '/bin/' + prefix;
    };

    Module.callMainWithRedirects = function(args = [], print = false) {
        Module.do_print = print;
        // Reset output capture before each call
        outputCapture.stdout.length = 0;
        outputCapture.stderr.length = 0;
        if (args.length > 0) Module.setPrefix(args[0]);
        const exit_code = Module.callMain(args);
        Module._flush_streams();
        // Join arrays into strings for return (single O(n) operation)
        return { exit_code, stdout: outputCapture.stdout.join('\n'), stderr: outputCapture.stderr.join('\n') };
    };

    const elapsed = (performance.now() - startTime).toFixed(0);
    workerLog(`WASM ready in ${elapsed}ms`);
    return Module;
}

/**
 * Create a fresh Module instance for each operation.
 *
 * We create fresh each time because pdfTeX has internal C globals
 * (glyph_unicode_tree, etc.) that don't reset between invocations,
 * causing assertion failures and memory issues.
 *
 * With memory snapshot, fresh Module creation is fast (~300ms vs ~3s).
 */
async function getOrCreateModule() {
    // NOTE: Memory snapshots are DISABLED
    // pdfTeX has internal C globals (glyph_unicode_tree) that cause assertion failures
    // when restored from a post-compilation snapshot. Fast recompiles come from
    // format caching (.fmt files) instead, which properly handles TeX state.
    return await initBusyTeX(cachedWasmModule, busytexJsUrl, null);
}

/**
 * Reset the filesystem for a fresh compilation
 * Removes all files except core TeX directories
 */
function resetFS(FS) {
    // Remove /texlive entirely and recreate structure
    try {
        // Remove dynamically created directories
        const dirsToClean = ['/texlive', '/document.pdf', '/document.log', '/document.aux'];
        for (const path of dirsToClean) {
            try {
                const stat = FS.stat(path);
                if (FS.isDir(stat.mode)) {
                    // Recursively remove directory
                    const removeDir = (dirPath) => {
                        try {
                            const contents = FS.readdir(dirPath);
                            for (const name of contents) {
                                if (name === '.' || name === '..') continue;
                                const fullPath = dirPath + '/' + name;
                                const s = FS.stat(fullPath);
                                if (FS.isDir(s.mode)) {
                                    removeDir(fullPath);
                                } else {
                                    FS.unlink(fullPath);
                                }
                            }
                            FS.rmdir(dirPath);
                        } catch (e) {}
                    };
                    removeDir(path);
                } else {
                    FS.unlink(path);
                }
            } catch (e) {}
        }
    } catch (e) {
        workerLog('FS reset warning: ' + e.message);
    }
}

// ============ Pass Prediction ============

// Pre-compiled regexes for pass prediction (avoid recreating on each call)
// Features requiring 3 passes (ToC, index)
const MULTIPASS_3_REGEX = /\\(?:tableofcontents|listoffigures|listoftables|printindex|makeindex)\b/;
// Features requiring 2+ passes (refs, cites, labels, bibliography)
const MULTIPASS_2_REGEX = /\\(?:ref\{|pageref\{|eqref\{|autoref\{|cite[pt]?\{|citep\{|citet\{|autocite\{|textcite\{|label\{|bibliography\{|printbibliography|addbibresource)/;

/**
 * Predict minimum passes needed based on source analysis.
 * Returns 1 for simple docs, 2-3 for docs with cross-references.
 * Uses pre-compiled regexes and early exit for efficiency.
 */
function predictRequiredPasses(source) {
    if (!source) return 1;

    // Check for 3-pass features first (ToC, index)
    if (MULTIPASS_3_REGEX.test(source)) {
        return 3;
    }

    // Check for 2-pass features (refs, cites, labels, bib)
    if (MULTIPASS_2_REGEX.test(source)) {
        return 2;
    }

    // No cross-reference features → single pass sufficient
    return 1;
}

// ============ Aux File Hashing ============

/**
 * Fast DJB2 hash for aux file comparison.
 * Faster than string comparison for large files.
 */
function quickHash(content) {
    let hash = 5381 >>> 0;
    const len = content.length;
    for (let i = 0; i < len; i++) {
        hash = ((hash * 33) ^ content.charCodeAt(i)) >>> 0;
    }
    return hash;
}

// Aux file extensions in fixed order for consistent hashing
const AUX_EXTENSIONS = ['.aux', '.bbl', '.blg', '.lof', '.lot', '.nav', '.out', '.snm', '.toc'];

/**
 * Hash all aux files into a single combined hash.
 * Used to detect changes between compilation passes.
 * Uses fixed extension order to avoid sort() allocation.
 */
function hashAuxFiles(auxFiles) {
    if (!auxFiles) return 0;

    let combined = 0;
    for (const ext of AUX_EXTENSIONS) {
        const content = auxFiles[ext];
        if (content) {
            combined ^= quickHash(content);
        }
    }
    return combined;
}

// ============ Compilation ============

async function handleCompile(request) {
    const { id, source, engine, options, bundleData, bundleNames, ctanFiles, cachedFormat, cachedAuxFiles, deferredBundleNames } = request;

    // Allow runtime verbose toggle via compile options
    if (options?.verbose !== undefined) {
        verboseLogging = options.verbose;
    }

    workerLog('=== Compilation Started ===');
    const totalStart = performance.now();

    // Fallback to bundleDeps.deferred if not passed in message (for older compilers)
    const effectiveDeferredBundles = deferredBundleNames || bundleDeps?.deferred || [];
    workerLog(`deferredBundleNames: ${JSON.stringify(effectiveDeferredBundles)}`);

    if (!fileManifest) throw new Error('fileManifest not set');

    // Track accumulated resources across retries
    const bundleDataMap = bundleData instanceof Map ? bundleData : new Map(Object.entries(bundleData || {}));
    const bundleMetaMap = new Map(); // Store bundle metadata for dynamically loaded bundles
    const accumulatedCtanFiles = new Map();

    // Bundles to load on-demand (e.g., font bundles like cm-super)
    const deferredBundles = new Set(effectiveDeferredBundles);

    // Add CTAN files from current request
    if (ctanFiles) {
        const ctanFilesMap = ctanFiles instanceof Map ? ctanFiles : new Map(Object.entries(ctanFiles));
        for (const [path, content] of ctanFilesMap) accumulatedCtanFiles.set(path, content);
    }

    let pdfData = null;
    let syncTexData = null;  // SyncTeX data for source/PDF synchronization
    let compileSuccess = false;
    let retryCount = 0;
    const maxRetries = options.maxRetries ?? 15;  // Configurable, default 15
    const fetchedPackages = new Set();
    // Use global cache for Range-fetched files (persists across compiles)
    let lastExitCode = -1;
    let Module = null;
    let FS = null;

    // Auto-rerun tracking for cross-references/TOC
    // Predict passes needed based on source analysis
    const predictedPasses = predictRequiredPasses(source);
    let rerunPass = 0;
    const maxRerunPasses = predictedPasses - 1;  // 1 initial + N reruns

    if (predictedPasses === 1) {
        workerLog('Single-pass mode: no cross-references detected');
    }

    // Auto-shim tracking for undefined control sequences
    // Map<commandName, argCount>
    const shimmedCommands = new Map();

    // Version fallback tracking for packages with kernel incompatibility
    // Map<packageName, tlYear> - which TL year to use for each package
    const packageTLVersions = new Map();

    while (!compileSuccess && retryCount < maxRetries) {
        if (retryCount > 0) {
            workerLog(`Retry #${retryCount}...`);
        }

        try {
            // Get or create global WASM instance (reused to avoid memory leaks)
            Module = await getOrCreateModule();
            FS = Module.FS;

            // Reset filesystem for clean compilation
            resetFS(FS);

            // Create VFS with unified mount handling
            const vfs = new VirtualFileSystem(FS, {
                onLog: workerLog,
                lazyEnabled: options.enableLazyFS,
                fetchedFilesCache: globalFetchedFilesCache  // Persist across compiles
            });

            // Only patch for lazy loading once (on first use)
            if (options.enableLazyFS && !Module._lazyPatchApplied) {
                vfs.patchForLazyLoading();
                Module._lazyPatchApplied = true;
            }

            // Mount all bundles (regular and deferred)
            workerProgress('mount', 'Mounting files...');
            for (const [bundleName, data] of bundleDataMap) {
                const meta = bundleMetaMap.get(bundleName) || null;
                vfs.mountBundle(bundleName, data, fileManifest, meta);
            }

            // Mount deferred bundles (file markers without data - loaded on demand)
            for (const bundleName of deferredBundles) {
                if (!bundleDataMap.has(bundleName)) {
                    const count = vfs.mountDeferredBundle(bundleName, fileManifest, null);
                    workerLog(`Deferred bundle ${bundleName}: mounted ${count} file markers`);
                }
            }

            // Mount CTAN files
            // Use forceOverride when we have version fallback packages to override bundle files
            if (accumulatedCtanFiles.size > 0) {
                const hasVersionFallback = packageTLVersions.size > 0;
                vfs.mountCtanFiles(accumulatedCtanFiles, { forceOverride: hasVersionFallback });
            }

            // Restore aux files
            if (cachedAuxFiles && Object.keys(cachedAuxFiles).length > 0) {
                const restored = restoreAuxFiles(FS, cachedAuxFiles);
                if (restored > 0) workerLog(`Restored ${restored} aux files`);
            }

            // Finalize VFS - processes font maps, generates ls-R
            vfs.finalize();

            // Prepare document source
            let docSource = source;
            let fmtPath = engine === 'pdflatex'
                ? '/texlive/texmf-dist/texmf-var/web2c/pdftex/pdflatex.fmt'
                : '/texlive/texmf-dist/texmf-var/web2c/xetex/xelatex.fmt';

            if (cachedFormat && engine === 'pdflatex' && cachedFormat.fmtData) {
                // Verify buffer isn't detached before using
                if (cachedFormat.fmtData.buffer && cachedFormat.fmtData.buffer.byteLength > 0) {
                    FS.writeFile('/custom.fmt', cachedFormat.fmtData);
                    fmtPath = '/custom.fmt';
                    workerLog('Using custom format');
                    const beginDocIdx = source.indexOf('\\begin{document}');
                    if (beginDocIdx !== -1) docSource = source.substring(beginDocIdx);
                } else {
                    workerLog('Custom format buffer is detached, using default format');
                }
            }

            if (engine === 'pdflatex' && !cachedFormat) {
                docSource = injectMicrotypeWorkaround(docSource);
            }

            // Inject kernel compatibility shim for packages using TL2026+ tagging features
            docSource = injectKernelCompatShim(docSource);

            // Inject auto-shims for undefined commands from previous attempts
            if (shimmedCommands.size > 0) {
                docSource = injectAutoShims(docSource, shimmedCommands);
            }

            // Font maps are now handled by VFS.processFontMaps() - no need to inject \pdfmapfile commands

            FS.writeFile('/document.tex', docSource);

            // Run compilation
            workerProgress('compile', `Running ${engine}...`);
            let result;

            if (engine === 'pdflatex') {
                result = Module.callMainWithRedirects([
                    'pdflatex', '--no-shell-escape', '--interaction=nonstopmode',
                    '--halt-on-error', '--synctex=-1', '--fmt=' + fmtPath, '/document.tex'
                ]);
            } else {
                result = Module.callMainWithRedirects([
                    'xelatex', '--no-shell-escape', '--interaction=nonstopmode',
                    '--halt-on-error', '--synctex=-1', '--no-pdf',
                    '--fmt=/texlive/texmf-dist/texmf-var/web2c/xetex/xelatex.fmt',
                    '/document.tex'
                ]);
                if (result.exit_code === 0) {
                    result = Module.callMainWithRedirects([
                        'xdvipdfmx', '-o', '/document.pdf', '/document.xdv'
                    ]);
                }
            }

            lastExitCode = result.exit_code;

            if (result.exit_code === 0) {
                try {
                    pdfData = FS.readFile('/document.pdf');
                    compileSuccess = true;
                    workerLog('Compilation successful!');

                    // Read SyncTeX data for source/PDF synchronization
                    // --synctex=-1 generates uncompressed .synctex file
                    try {
                        const syncTexBytes = FS.readFile('/document.synctex');
                        syncTexData = new TextDecoder().decode(syncTexBytes);
                        workerLog(`SyncTeX data: ${(syncTexBytes.byteLength / 1024).toFixed(1)}KB`);
                    } catch (e) {
                        workerLog('No SyncTeX file generated');
                    }

                    // Auto-rerun loop for cross-references/TOC
                    // LaTeX needs multiple passes to resolve forward references
                    // Regex for rerun detection (single pass through log, case-insensitive)
                    const rerunPattern = /Rerun to get|Label\(s\) may have changed|There were undefined references|Rerun LaTeX/i;

                    // Track aux files via hash for faster comparison
                    let prevAuxHash = cachedAuxFiles ? hashAuxFiles(cachedAuxFiles) : 0;
                    let prevAuxFiles = cachedAuxFiles || {};

                    while (rerunPass < maxRerunPasses) {
                        // Check if log suggests rerun is needed
                        let logSaysRerun = false;
                        try {
                            const logContent = FS.readFile('/document.log', { encoding: 'utf8' });
                            logSaysRerun = rerunPattern.test(logContent);
                        } catch (e) {}

                        if (!logSaysRerun) break;

                        // Collect current aux files and compare hash with previous pass
                        // If hash is identical, the "Rerun" warning is a false positive
                        const currentAuxFiles = collectAuxFiles(FS);
                        const currentAuxHash = hashAuxFiles(currentAuxFiles);

                        if (currentAuxHash === prevAuxHash) {
                            workerLog('Aux hash unchanged, skipping unnecessary rerun');
                            break;
                        }

                        prevAuxHash = currentAuxHash;

                        prevAuxFiles = currentAuxFiles;

                        rerunPass++;
                        workerLog(`Auto-rerun pass ${rerunPass}/${maxRerunPasses}: resolving cross-references...`);
                        workerProgress('compile', `Rerun ${rerunPass}/${maxRerunPasses}...`);

                        // IMPORTANT: pdfTeX has internal C globals (glyph_unicode_tree, etc.) that
                        // don't reset between invocations, causing assertion failures. We MUST
                        // create a fresh WASM module for each rerun pass.

                        // Use aux files we already collected for comparison
                        const rerunAuxFiles = prevAuxFiles;

                        // Create fresh WASM module
                        Module = await getOrCreateModule();
                        FS = Module.FS;
                        resetFS(FS);

                        // Recreate VFS with same configuration
                        const rerunVfs = new VirtualFileSystem(FS, {
                            onLog: workerLog,
                            lazyEnabled: options.enableLazyFS,
                            fetchedFilesCache: globalFetchedFilesCache
                        });

                        if (options.enableLazyFS && !Module._lazyPatchApplied) {
                            rerunVfs.patchForLazyLoading();
                            Module._lazyPatchApplied = true;
                        }

                        // Remount all bundles
                        for (const [bundleName, data] of bundleDataMap) {
                            const meta = bundleMetaMap.get(bundleName) || null;
                            rerunVfs.mountBundle(bundleName, data, fileManifest, meta);
                        }

                        // Remount deferred bundles
                        for (const bundleName of deferredBundles) {
                            if (!bundleDataMap.has(bundleName)) {
                                rerunVfs.mountDeferredBundle(bundleName, fileManifest, null);
                            }
                        }

                        // Remount CTAN files (with override for version fallback)
                        if (accumulatedCtanFiles.size > 0) {
                            const hasVersionFallback = packageTLVersions.size > 0;
                            rerunVfs.mountCtanFiles(accumulatedCtanFiles, { forceOverride: hasVersionFallback });
                        }

                        // Restore aux files from previous pass (critical for TOC/refs)
                        restoreAuxFiles(FS, rerunAuxFiles);

                        // Finalize VFS
                        rerunVfs.finalize();

                        // Rewrite document source
                        FS.writeFile('/document.tex', docSource);

                        // Mount custom format if used
                        if (fmtPath === '/custom.fmt' && cachedFormat?.fmtData?.buffer?.byteLength > 0) {
                            FS.writeFile('/custom.fmt', cachedFormat.fmtData);
                        }

                        // Run compilation (use same format path as initial compilation)
                        let rerunResult;
                        if (engine === 'pdflatex') {
                            rerunResult = Module.callMainWithRedirects([
                                'pdflatex', '--no-shell-escape', '--interaction=nonstopmode',
                                '--halt-on-error', '--synctex=-1', '--fmt=' + fmtPath, '/document.tex'
                            ]);
                        } else {
                            // XeLaTeX: two-step process (xelatex -> xdvipdfmx)
                            rerunResult = Module.callMainWithRedirects([
                                'xelatex', '--no-shell-escape', '--interaction=nonstopmode',
                                '--halt-on-error', '--synctex=-1', '--no-pdf',
                                '--fmt=' + fmtPath, '/document.tex'
                            ]);
                            if (rerunResult.exit_code === 0) {
                                rerunResult = Module.callMainWithRedirects([
                                    'xdvipdfmx', '-o', '/document.pdf', '/document.xdv'
                                ]);
                            }
                        }

                        if (rerunResult.exit_code === 0) {
                            pdfData = FS.readFile('/document.pdf');
                            workerLog(`Rerun ${rerunPass} successful`);
                            // Update SyncTeX data
                            try {
                                const syncTexBytes = FS.readFile('/document.synctex');
                                syncTexData = new TextDecoder().decode(syncTexBytes);
                            } catch (e) {}
                        } else {
                            workerLog(`Rerun ${rerunPass} failed, keeping previous PDF`);
                            break;
                        }
                    }

                    // Log summary if reruns occurred
                    if (rerunPass > 0) {
                        workerLog(`Completed ${rerunPass + 1} passes (1 initial + ${rerunPass} reruns)`);
                    }
                } catch (e) {
                    workerLog('Failed to read PDF: ' + e.message);
                }
            }

            // Handle missing files and deferred bundles
            if (!compileSuccess) {
                // Check for individual file Range requests from deferred bundles
                const pendingFiles = vfs.getPendingDeferredFiles();
                if (pendingFiles.length > 0) {
                    // Group pending files by bundle
                    const filesByBundle = new Map();
                    for (const f of pendingFiles) {
                        if (!filesByBundle.has(f.bundleName)) filesByBundle.set(f.bundleName, []);
                        filesByBundle.get(f.bundleName).push(f);
                    }

                    let fetchedAny = false;

                    // For each bundle with pending files, decide: full bundle fetch or Range requests
                    for (const [bundleName, files] of filesByBundle) {
                        // If bundle is deferred (not yet loaded), consider loading the whole thing
                        // This is more efficient when many files are needed from the same bundle
                        if (deferredBundles.has(bundleName) && !bundleDataMap.has(bundleName)) {
                            workerLog(`Deferred ${bundleName}: ${files.length} files requested - loading full bundle`);
                            try {
                                const bundleResult = await requestBundleFetch(bundleName);
                                if (bundleResult.success) {
                                    bundleDataMap.set(bundleName, bundleResult.bundleData);
                                    if (bundleResult.bundleMeta) {
                                        bundleMetaMap.set(bundleName, bundleResult.bundleMeta);
                                    }
                                    deferredBundles.delete(bundleName);
                                    workerLog(`Loaded full ${bundleName} bundle (${(bundleResult.bundleData.byteLength / 1024 / 1024).toFixed(1)}MB)`);
                                    fetchedAny = true;
                                    continue; // Skip Range requests for this bundle
                                }
                            } catch (e) {
                                workerLog(`Failed to load ${bundleName} bundle: ${e.message}, trying Range requests`);
                            }
                        }

                        // Use parallel Range requests for files from already-loaded bundles or if full fetch failed
                        workerLog(`Fetching ${files.length} files from ${bundleName} via parallel Range requests...`);
                        const rangePromises = files.map(async (fileReq) => {
                            try {
                                const fileResult = await requestFileRangeFetch(fileReq.bundleName, fileReq.start, fileReq.end);
                                if (fileResult.success) {
                                    vfs.storeFetchedFile(fileReq.bundleName, fileReq.start, fileReq.end, fileResult.data);
                                    return true;
                                }
                            } catch (e) {
                                workerLog(`Failed to fetch file range [${fileReq.start}:${fileReq.end}]: ${e.message}`);
                            }
                            return false;
                        });
                        const results = await Promise.all(rangePromises);
                        const successCount = results.filter(Boolean).length;
                        if (successCount > 0) {
                            workerLog(`Loaded ${successCount}/${files.length} files from ${bundleName}`);
                            fetchedAny = true;
                        }
                    }

                    if (fetchedAny) {
                        retryCount++;
                        continue;
                    }
                }

                // Fallback: check if any deferred bundles were accessed but not loaded
                const pendingDeferred = vfs.getPendingDeferredBundles();
                workerLog(`Checking pending deferred bundles: ${pendingDeferred.length > 0 ? pendingDeferred.join(', ') : 'none'}`);
                if (pendingDeferred.length > 0) {
                    workerLog(`Deferred bundles needed: ${pendingDeferred.join(', ')}`);
                    let fetchedAny = false;
                    for (const bundleName of pendingDeferred) {
                        if (bundleDataMap.has(bundleName)) continue;
                        try {
                            const bundleResult = await requestBundleFetch(bundleName);
                            if (bundleResult.success) {
                                bundleDataMap.set(bundleName, bundleResult.bundleData);
                                if (bundleResult.bundleMeta) {
                                    bundleMetaMap.set(bundleName, bundleResult.bundleMeta);
                                }
                                // Remove from deferred set since it's now loaded
                                deferredBundles.delete(bundleName);
                                fetchedAny = true;
                                workerLog(`Loaded deferred bundle: ${bundleName}`);
                            }
                        } catch (e) {
                            workerLog(`Failed to load deferred bundle ${bundleName}: ${e.message}`);
                        }
                    }
                    if (fetchedAny) {
                        retryCount++;
                        continue;
                    }
                }

                // Then check for missing files via log parsing (CTAN fallback)
                workerLog(`[RETRY] enableCtan=${options.enableCtan}`);
                if (options.enableCtan) {
                    let logContent = '';
                    try { logContent = new TextDecoder().decode(FS.readFile('/document.log')); } catch (e) {}
                    const allOutput = logContent + ' ' + (result.stdout || '') + ' ' + (result.stderr || '');

                    // Extract ALL missing files for parallel fetching
                    const missingFiles = extractAllMissingFiles(allOutput, fetchedPackages);
                    workerLog(`[RETRY] missingFiles=${missingFiles.length > 0 ? missingFiles.join(', ') : 'none'}`);

                    if (missingFiles.length > 0) {
                        // Categorize packages: bundles vs CTAN
                        const bundlesToFetch = [];
                        const ctanToFetch = [];

                        for (const missingFile of missingFiles) {
                            const pkgName = getPackageFromFile(missingFile);

                            // Check if pkgName is already a bundle name (from font index lookup)
                            // or if it maps to a bundle via packageMap
                            let bundleName = bundleRegistry?.has(pkgName) ? pkgName : packageMap?.[pkgName];

                            if (bundleName && !bundleDataMap.has(bundleName)) {
                                bundlesToFetch.push({ missingFile, pkgName, bundleName });
                            } else if (!bundleName) {
                                ctanToFetch.push({ missingFile, pkgName });
                            }
                        }

                        workerLog(`[RETRY] Fetching ${bundlesToFetch.length} bundles, ${ctanToFetch.length} CTAN packages in parallel`);

                        // Fetch all bundles in parallel
                        const bundlePromises = bundlesToFetch.map(async ({ missingFile, pkgName, bundleName }) => {
                            workerLog(`Missing: ${missingFile}, loading bundle ${bundleName}...`);
                            try {
                                const bundleResult = await requestBundleFetch(bundleName);
                                if (bundleResult.success) {
                                    return { type: 'bundle', pkgName, bundleName, data: bundleResult };
                                }
                            } catch (e) {
                                workerLog(`Bundle fetch failed for ${bundleName}: ${e.message}`);
                            }
                            return null;
                        });

                        // Fetch all CTAN packages in parallel
                        // Use version preference if set (for kernel incompatibility fallback)
                        const ctanPromises = ctanToFetch.map(async ({ missingFile, pkgName }) => {
                            const tlYear = packageTLVersions.get(pkgName) || null;
                            const yearLabel = tlYear ? ` (TL${tlYear})` : '';
                            workerLog(`Missing: ${missingFile}, fetching ${pkgName}${yearLabel} from CTAN...`);
                            try {
                                const ctanData = await requestCtanFetch(pkgName, missingFile, tlYear);
                                if (ctanData.success) {
                                    return { type: 'ctan', pkgName, data: ctanData };
                                }
                            } catch (e) {
                                workerLog(`CTAN fetch failed for ${pkgName}: ${e.message}`);
                            }
                            return null;
                        });

                        // Wait for all fetches to complete
                        const allResults = await Promise.all([...bundlePromises, ...ctanPromises]);
                        let fetchedAny = false;

                        for (const result of allResults) {
                            if (!result) continue;
                            fetchedAny = true;

                            if (result.type === 'bundle') {
                                fetchedPackages.add(result.pkgName);
                                bundleDataMap.set(result.bundleName, result.data.bundleData);
                                if (result.data.bundleMeta) {
                                    bundleMetaMap.set(result.bundleName, result.data.bundleMeta);
                                }
                            } else if (result.type === 'ctan') {
                                fetchedPackages.add(result.pkgName);
                                const files = result.data.files instanceof Map
                                    ? result.data.files
                                    : new Map(Object.entries(result.data.files));
                                for (const [path, content] of files) {
                                    accumulatedCtanFiles.set(path, content);
                                }
                            }
                        }

                        if (fetchedAny) {
                            retryCount++;
                            continue;
                        }
                    }

                    // Check for undefined control sequences
                    const undefinedCmds = extractUndefinedCommands(allOutput);

                    // FIRST: Check for kernel incompatibility - try older package versions
                    // Version fallback works for ALL packages, including bundle packages
                    // (CTAN fetch with older version will override the bundle version)
                    if (undefinedCmds.size > 0) {
                        const incompatiblePkgs = detectKernelIncompatibility(allOutput, undefinedCmds);

                        if (incompatiblePkgs.size > 0) {
                            let needsVersionFallback = false;

                            for (const pkgName of incompatiblePkgs) {
                                // Get current TL year for this package (default to 2025)
                                const currentYear = packageTLVersions.get(pkgName) || DEFAULT_TL_YEAR;
                                const yearIndex = SUPPORTED_TL_YEARS.indexOf(currentYear);

                                // Try next older year if available
                                if (yearIndex < SUPPORTED_TL_YEARS.length - 1) {
                                    const olderYear = SUPPORTED_TL_YEARS[yearIndex + 1];
                                    packageTLVersions.set(pkgName, olderYear);

                                    // Note if this is a bundle package - CTAN fetch will override it
                                    const bundleName = packageMap?.[pkgName];
                                    if (bundleName) {
                                        workerLog(`[VERSION FALLBACK] ${pkgName}: in bundle "${bundleName}", fetching TL${olderYear} from CTAN to override`);
                                    } else {
                                        workerLog(`[VERSION FALLBACK] ${pkgName}: trying TL${olderYear} instead of TL${currentYear}`);
                                    }
                                    needsVersionFallback = true;

                                    // Remove the package from fetched so it gets re-fetched with older version
                                    fetchedPackages.delete(pkgName);

                                    // Remove any files from this package from accumulatedCtanFiles
                                    for (const [path, _] of accumulatedCtanFiles) {
                                        if (path.includes(`/${pkgName}/`) || path.includes(`/${pkgName}.`)) {
                                            accumulatedCtanFiles.delete(path);
                                        }
                                    }
                                } else {
                                    workerLog(`[VERSION FALLBACK] ${pkgName}: exhausted all TL versions (2025→2024→2023), will auto-shim`);
                                }
                            }

                            if (needsVersionFallback) {
                                // Actively fetch older versions for packages that need them
                                // This is needed because bundle packages already have files mounted
                                const versionFetchPromises = [];
                                for (const pkgName of incompatiblePkgs) {
                                    const tlYear = packageTLVersions.get(pkgName);
                                    if (tlYear && tlYear !== DEFAULT_TL_YEAR) {
                                        workerLog(`[VERSION FALLBACK] Fetching ${pkgName} from TL${tlYear}...`);
                                        versionFetchPromises.push(
                                            requestCtanFetch(pkgName, `${pkgName}.sty`, tlYear)
                                                .then(ctanData => {
                                                    if (ctanData.success) {
                                                        fetchedPackages.add(pkgName);
                                                        const files = ctanData.files instanceof Map
                                                            ? ctanData.files
                                                            : new Map(Object.entries(ctanData.files));
                                                        for (const [path, content] of files) {
                                                            accumulatedCtanFiles.set(path, content);
                                                        }
                                                        workerLog(`[VERSION FALLBACK] Got ${files.size} files for ${pkgName} from TL${tlYear}`);
                                                        return true;
                                                    }
                                                    return false;
                                                })
                                                .catch(e => {
                                                    workerLog(`[VERSION FALLBACK] Failed to fetch ${pkgName} from TL${tlYear}: ${e.message}`);
                                                    return false;
                                                })
                                        );
                                    }
                                }

                                if (versionFetchPromises.length > 0) {
                                    await Promise.all(versionFetchPromises);
                                }

                                retryCount++;
                                continue;
                            }
                        }
                    }

                    // SECOND: Auto-shim any remaining undefined commands
                    let foundNew = false;
                    for (const [cmd, argCount] of undefinedCmds) {
                        // Add if new, or update if we found more args than before
                        if (!shimmedCommands.has(cmd) || shimmedCommands.get(cmd) < argCount) {
                            shimmedCommands.set(cmd, argCount);
                            foundNew = true;
                        }
                    }
                    if (foundNew) {
                        const cmdList = [...undefinedCmds.entries()].map(([c, n]) => `${c}[${n}]`);
                        workerLog(`[RETRY] Found undefined commands: ${cmdList.join(', ')}`);
                        retryCount++;
                        continue;
                    }
                }
            }

            // No more retries possible
            if (!compileSuccess) break;

        } catch (e) {
            workerLog(`Error: ${e.message}`);
            break;
        }
    }

    const auxFiles = compileSuccess ? collectAuxFiles(FS) : null;
    const totalTime = performance.now() - totalStart;
    workerLog(`Total time: ${totalTime.toFixed(0)}ms`);

    // NOTE: Memory snapshot capture is DISABLED
    // pdfTeX's internal C globals (glyph_unicode_tree) cause assertion failures when
    // we try to restore a post-compilation snapshot. Fast recompiles come from format
    // caching (.fmt files with pre-compiled preambles) instead.

    // Help GC by clearing references we no longer need
    // The Module/FS will be recreated on next compile anyway
    Module = null;
    FS = null;

    // Build response message once, share between paths
    const stats = { compileTimeMs: totalTime, bundlesUsed: [...bundleDataMap.keys()] };

    // Use SharedArrayBuffer for zero-copy PDF transfer when available
    // SharedArrayBuffer: allows main thread to access PDF data directly without serialization
    // ArrayBuffer transfer: efficient but transfers ownership (receiver gets the buffer)
    if (pdfData && sharedArrayBufferAvailable) {
        const sharedBuffer = new SharedArrayBuffer(pdfData.byteLength);
        new Uint8Array(sharedBuffer).set(pdfData);

        self.postMessage({
            type: 'compile-response',
            id,
            success: compileSuccess,
            pdfData: sharedBuffer,
            pdfDataIsShared: true,
            syncTexData,
            exitCode: lastExitCode,
            auxFilesToCache: auxFiles,
            stats
        });
    } else {
        // Fallback to transferable ArrayBuffer
        self.postMessage({
            type: 'compile-response',
            id,
            success: compileSuccess,
            pdfData: pdfData ? pdfData.buffer : null,
            pdfDataIsShared: false,
            syncTexData,
            exitCode: lastExitCode,
            auxFilesToCache: auxFiles,
            stats
        }, pdfData ? [pdfData.buffer] : []);
    }
}

// ============ Format Generation ============

async function handleFormatGenerate(request) {
    const { id, preambleContent, engine, manifest, packageMapData, bundleDepsData, bundleRegistryData, bundleData, ctanFiles, maxRetries: maxRetriesOption } = request;

    workerLog('=== Format Generation Started ===');
    const startTime = performance.now();

    fileManifest = manifest;
    packageMap = packageMapData;
    bundleDeps = bundleDepsData;
    bundleRegistry = new Set(bundleRegistryData);

    const bundleDataMap = bundleData instanceof Map ? bundleData : new Map(Object.entries(bundleData));
    const bundleMetaMap = new Map(); // Store bundle metadata for dynamically loaded bundles
    const accumulatedCtanFiles = new Map();

    if (ctanFiles) {
        const ctanFilesMap = ctanFiles instanceof Map ? ctanFiles : new Map(Object.entries(ctanFiles));
        for (const [path, content] of ctanFilesMap) accumulatedCtanFiles.set(path, content);
    }

    let retryCount = 0;
    const maxRetries = maxRetriesOption ?? 15;  // Configurable, default 15
    const fetchedPackages = new Set();

    while (retryCount < maxRetries) {
        try {
            const Module = await getOrCreateModule();
            const FS = Module.FS;

            // Reset filesystem for clean format generation
            resetFS(FS);

            const vfs = new VirtualFileSystem(FS, { onLog: workerLog });

            for (const [bundleName, data] of bundleDataMap) {
                const meta = bundleMetaMap.get(bundleName) || null;
                vfs.mountBundle(bundleName, data, fileManifest, meta);
            }

            if (accumulatedCtanFiles.size > 0) {
                vfs.mountCtanFiles(accumulatedCtanFiles);
            }

            vfs.finalize();

            // Apply kernel compat shim for format generation too
            const shimmedPreamble = injectKernelCompatShim(preambleContent);
            FS.writeFile('/myformat.ini', shimmedPreamble + '\n\\dump\n');

            // Use the correct engine for format generation
            let formatArgs;
            if (engine === 'xelatex') {
                formatArgs = [
                    'xelatex', '-ini', '-jobname=myformat', '-interaction=nonstopmode',
                    '&/texlive/texmf-dist/texmf-var/web2c/xetex/xelatex', '/myformat.ini'
                ];
            } else {
                // Default to pdflatex
                formatArgs = [
                    'pdflatex', '-ini', '-jobname=myformat', '-interaction=nonstopmode',
                    '&/texlive/texmf-dist/texmf-var/web2c/pdftex/pdflatex', '/myformat.ini'
                ];
            }
            workerLog(`Generating format with engine: ${engine}`);
            const result = Module.callMainWithRedirects(formatArgs);

            if (result.exit_code === 0) {
                const formatData = FS.readFile('/myformat.fmt');
                workerLog(`Format generated: ${(formatData.byteLength / 1024 / 1024).toFixed(1)}MB in ${(performance.now() - startTime).toFixed(0)}ms`);

                self.postMessage({
                    type: 'format-generate-response', id, success: true, formatData: formatData.buffer
                }, [formatData.buffer]);
                return;
            }

            // Check for missing packages - extract ALL and fetch in parallel
            let logContent = '';
            try { logContent = new TextDecoder().decode(FS.readFile('/myformat.log')); } catch (e) {}
            const allOutput = logContent + ' ' + (result.stdout || '') + ' ' + (result.stderr || '');
            const missingFiles = extractAllMissingFiles(allOutput, fetchedPackages);

            if (missingFiles.length > 0) {
                workerLog(`[FORMAT] Missing ${missingFiles.length} packages: ${missingFiles.join(', ')}`);

                // Categorize packages: bundles vs CTAN
                const bundlesToFetch = [];
                const ctanToFetch = [];

                for (const missingFile of missingFiles) {
                    const pkgName = getPackageFromFile(missingFile);
                    const bundleName = packageMap?.[pkgName];

                    if (bundleName && !bundleDataMap.has(bundleName)) {
                        bundlesToFetch.push({ missingFile, pkgName, bundleName });
                    } else if (!bundleName) {
                        ctanToFetch.push({ missingFile, pkgName });
                    }
                }

                // Fetch all in parallel
                const bundlePromises = bundlesToFetch.map(async ({ missingFile, pkgName, bundleName }) => {
                    workerLog(`Format missing: ${missingFile}, loading bundle ${bundleName}...`);
                    try {
                        const bundleResult = await requestBundleFetch(bundleName);
                        if (bundleResult.success) {
                            return { type: 'bundle', pkgName, bundleName, data: bundleResult };
                        }
                    } catch (e) {
                        workerLog(`Bundle fetch failed for ${bundleName}: ${e.message}`);
                    }
                    return null;
                });

                const ctanPromises = ctanToFetch.map(async ({ missingFile, pkgName }) => {
                    workerLog(`Format missing: ${missingFile}, fetching ${pkgName} from CTAN...`);
                    try {
                        const ctanData = await requestCtanFetch(pkgName, missingFile);
                        if (ctanData.success) {
                            return { type: 'ctan', pkgName, data: ctanData };
                        }
                    } catch (e) {
                        workerLog(`CTAN fetch failed for ${pkgName}: ${e.message}`);
                    }
                    return null;
                });

                const allResults = await Promise.all([...bundlePromises, ...ctanPromises]);
                let fetchedAny = false;

                for (const result of allResults) {
                    if (!result) continue;
                    fetchedAny = true;

                    if (result.type === 'bundle') {
                        fetchedPackages.add(result.pkgName);
                        bundleDataMap.set(result.bundleName, result.data.bundleData);
                        if (result.data.bundleMeta) {
                            bundleMetaMap.set(result.bundleName, result.data.bundleMeta);
                        }
                    } else if (result.type === 'ctan') {
                        fetchedPackages.add(result.pkgName);
                        const files = result.data.files instanceof Map
                            ? result.data.files
                            : new Map(Object.entries(result.data.files));
                        for (const [path, content] of files) {
                            accumulatedCtanFiles.set(path, content);
                        }
                    }
                }

                if (fetchedAny) {
                    retryCount++;
                    continue;
                }
            }

            throw new Error(`Format generation failed with exit code ${result.exit_code}`);

        } catch (e) {
            if (retryCount >= maxRetries - 1) {
                workerLog(`Format generation error: ${e.message}`);
                self.postMessage({ type: 'format-generate-response', id, success: false, error: e.message });
                return;
            }
            retryCount++;
        }
    }

    workerLog(`Format generation failed after ${maxRetries} retries`);
    self.postMessage({ type: 'format-generate-response', id, success: false, error: 'Max retries exceeded' });
}

// ============ Message Handler ============

self.onmessage = async function(e) {
    const msg = e.data;

    switch (msg.type) {
        case 'init':
            busytexJsUrl = msg.busytexJsUrl;
            verboseLogging = msg.verbose ?? false;
            if (msg.manifest) {
                fileManifest = msg.manifest;
                packageMap = msg.packageMapData;
                bundleDeps = msg.bundleDepsData;
                bundleRegistry = new Set(msg.bundleRegistryData || []);
                // Pre-index manifest by bundle for O(1) lookup
                ensureManifestIndexed(fileManifest);
            }
            cachedWasmModule = msg.wasmModule;
            self.postMessage({ type: 'ready' });
            break;

        case 'compile':
            // Queue compile operations to prevent concurrent execution
            operationQueue = operationQueue.then(() => handleCompile(msg)).catch(e => {
                workerLog(`Compile queue error: ${e.message}`);
                // IMPORTANT: Send error response so main thread doesn't hang
                self.postMessage({
                    type: 'compile-response',
                    id: msg.id,
                    success: false,
                    error: e.message,
                });
            });
            break;

        case 'generate-format':
            // Queue format operations to prevent concurrent execution
            operationQueue = operationQueue.then(() => handleFormatGenerate(msg)).catch(e => {
                workerLog(`Format queue error: ${e.message}`);
                // IMPORTANT: Send error response so main thread doesn't hang
                self.postMessage({
                    type: 'format-generate-response',
                    id: msg.id,
                    success: false,
                    error: e.message,
                });
            });
            break;

        case 'ctan-fetch-response':
            const pending = pendingCtanRequests.get(msg.requestId);
            if (pending) {
                pendingCtanRequests.delete(msg.requestId);
                if (msg.success) pending.resolve(msg);
                else pending.reject(new Error(msg.error || 'CTAN fetch failed'));
            }
            break;

        case 'bundle-fetch-response':
            const pendingBundle = pendingBundleRequests.get(msg.requestId);
            if (pendingBundle) {
                pendingBundleRequests.delete(msg.requestId);
                if (msg.success) pendingBundle.resolve(msg);
                else pendingBundle.reject(new Error(msg.error || 'Bundle fetch failed'));
            }
            break;

        case 'file-range-fetch-response':
            const pendingFileRange = pendingFileRangeRequests.get(msg.requestId);
            if (pendingFileRange) {
                pendingFileRangeRequests.delete(msg.requestId);
                if (msg.success) pendingFileRange.resolve(msg);
                else pendingFileRange.reject(new Error(msg.error || 'File range fetch failed'));
            }
            break;
    }
};

self.onerror = function(e) {
    self.postMessage({ type: 'log', message: 'Worker error: ' + e.message });
};
