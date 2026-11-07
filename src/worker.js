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
        this.onDeferredRead = options.onDeferredRead;
    }

    mount(path, content, trackFontMaps = true, owned = false) {
        this._ensureDirectory(path);
        const data = typeof content === 'string' ? new TextEncoder().encode(content) : content;
        try {
            if (owned) this.FS.writeFile(path, data, { canOwn: true });
            else this.FS.writeFile(path, data);
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
    mountDeferredBundle(bundleName, manifest, bundleMeta = null, trackFontPaths = false) {
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
            if (trackFontPaths && (path.endsWith('.pfb') || path.endsWith('.enc'))) {
                const filename = path.substring(path.lastIndexOf('/') + 1);
                this.fontFileLocations = this.fontFileLocations || new Map();
                this.fontFileLocations.set(filename, path);
            }
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

        // Detect font bundles dynamically: any bundle containing .pfb, .enc, or font .map files
        const isFontBundle = bundleFiles.some(([p]) =>
            p.endsWith('.pfb') || p.endsWith('.enc') || (p.includes('/fonts/map/') && p.endsWith('.map'))
        );

        for (const [path, info] of bundleFiles) {
            if (this.mountedFiles.has(path)) continue;
            if (this.lazyEnabled && !this._shouldEagerLoad(path)) {
                this.mountLazy(path, bundleName, info.start, info.end, false);
            } else {
                const content = this._copyFromBundle(bundleData, info.start, info.end);
                this.mount(path, content, false, true);
            }
            mounted++;

            // Track font files for pdftex.map rewriting
            if (isFontBundle && (path.endsWith('.pfb') || path.endsWith('.enc'))) {
                const filename = path.substring(path.lastIndexOf('/') + 1);
                this.fontFileLocations = this.fontFileLocations || new Map();
                this.fontFileLocations.set(filename, path);
            }
            // Track font map files from external font bundles (e.g. cm-super) that
            // aren't already aggregated into updmap's pdftex.map by the core bundle.
            // These need to be appended during processFontMaps().
            if (isFontBundle && bundleName !== 'core'
                && path.includes('/fonts/map/dvips/') && path.endsWith('.map')) {
                this.pendingFontMaps.add(path);
            }
        }
        this.onLog(`Mounted ${mounted} files from bundle ${bundleName}`);
        return mounted;
    }

    mountCtanFiles(files, options = {}) {
        const start = performance.now();
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
            this._mirrorCustomFontForFontconfig(path, data);

            if (alreadyMounted) {
                overridden++;
            } else {
                mounted++;
            }
        }
        const elapsed = (performance.now() - start).toFixed(1);
        if (overridden > 0) {
            this.onLog(`Mounted ${mounted} CTAN files, overrode ${overridden} bundle files (${elapsed}ms)`);
        } else {
            this.onLog(`Mounted ${mounted} CTAN files (${elapsed}ms)`);
        }
        return mounted + overridden;
    }

    /**
     * Mirror a user-supplied font into a fontconfig-scanned dir.
     *
     * additionalFiles (custom fonts) land at the VFS root, which fontconfig does
     * not scan (FONTS_CONF only covers the texmf opentype/truetype/type1 trees).
     * So `\setmainfont{Family Name}` can't find them — only filename/Path-based
     * references work. We copy any root-level font into the matching texmf font
     * dir so fontconfig indexes it by its internal name table, exactly like an
     * installed font. The original path stays put for filename references.
     */
    _mirrorCustomFontForFontconfig(path, data) {
        // CTAN/bundle fonts already live under .../fonts/...; only mirror fonts
        // that don't (i.e. user files dropped at the VFS root).
        if (path.includes('/fonts/')) return;
        const ext = path.toLowerCase().match(/\.(otf|ttf|ttc|pfb)$/);
        if (!ext) return;
        const subdir = ext[1] === 'otf' ? 'opentype' : ext[1] === 'pfb' ? 'type1' : 'truetype';
        const fileName = path.split('/').pop();
        const dest = `/texlive/texmf-dist/fonts/${subdir}/custom/${fileName}`;
        if (this.mountedFiles.has(dest)) return;
        this.mount(dest, data, false);
        this.onLog(`Custom font ${fileName} mirrored to ${subdir} tree for fontconfig name lookup`);
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
        const knownPaths = new Map();
        for (const mapPath of this.pendingFontMaps) {
            try {
                const mapContent = new TextDecoder().decode(this.FS.readFile(mapPath));
                const rewrittenContent = this._rewriteMapPaths(mapContent, mapPath, knownPaths);
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

    _rewriteMapPaths(mapContent, mapFilePath, knownPaths) {
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
                    if (!knownPaths.has(candidatePath)) {
                        let exists = false;
                        try { exists = this.FS.analyzePath(candidatePath).exists; } catch {}
                        knownPaths.set(candidatePath, exists);
                    }
                    if (knownPaths.get(candidatePath)) {
                        rewritten = rewritten.replace(fullMatch, `${prefix}${candidatePath}`);
                        break;
                    }
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
        this.writeFontconfig();
        this.onLog(`VFS finalized: ${this.mountedFiles.size} files`);
    }

    // Write the fontconfig config into /texlive AFTER bundles are mounted there,
    // so it isn't shadowed by the texmf mount. fontconfig (FONTCONFIG_FILE) reads
    // this at XeTeX startup; without it the engine falls back to a built-in config
    // that doesn't point at the texmf font tree, so no font is ever found.
    writeFontconfig() {
        try {
            // A deferred marker is a promise of bytes, not an installed font.
            // Scanning the whole texmf tree would hydrate every marker while
            // fontconfig inventories names. Index only materialized fonts via
            // symlinks: no copied font bytes, unchanged source/search paths.
            const directory = '/texlive/fontconfig-fonts';
            this.FS.mkdirTree(directory);
            for (const name of this.FS.readdir(directory)) {
                if (name !== '.' && name !== '..') this.FS.unlink(directory + '/' + name);
            }
            let count = 0;
            for (const path of this.mountedFiles) {
                if (!/\.(?:otf|ttf|ttc|pfb)$/i.test(path)) continue;
                let node;
                try { node = this.FS.lookupPath(path).node; } catch { continue; }
                if (this.isDeferredMarker(node.contents)) {
                    const marker = node.contents;
                    const key = marker.bundleName + ':' + marker.start + ':' + marker.end;
                    if (!this.bundleCache.has(marker.bundleName) && !this.fetchedFiles.has(key)) continue;
                } else if (this.isLazyMarker(node.contents) && !this.bundleCache.has(node.contents.bundleName)) continue;
                this.FS.symlink(path, directory + '/' + count++ + '-' + path.slice(path.lastIndexOf('/') + 1));
            }
            this.FS.writeFile('/texlive/fonts.conf', FONTS_CONF);
        } catch (e) {
            this.onLog(`[fontconfig] failed to write fonts.conf: ${e.message}`);
        }
    }

    // Paths produced/modified by finalize(). Their final contents are deterministic
    // for a given mounted bundle set, so they can be cached and replayed (see 4A).
    static get PDFTEX_MAP_PATH() {
        return '/texlive/texmf-dist/texmf-var/fonts/map/pdftex/updmap/pdftex.map';
    }
    static get LSR_PATH() {
        return '/texlive/texmf-dist/ls-R';
    }

    /**
     * Snapshot the (JS-heap-owned) bytes of the two files finalize() produces.
     * Copies out of MEMFS so the result survives the WASM module being destroyed.
     */
    captureFinalizeOutput() {
        const out = { pdftexMap: null, lsR: null };
        try { out.pdftexMap = new Uint8Array(this.FS.readFile(VirtualFileSystem.PDFTEX_MAP_PATH)); } catch (e) {}
        try { out.lsR = new Uint8Array(this.FS.readFile(VirtualFileSystem.LSR_PATH)); } catch (e) {}
        return out;
    }

    /**
     * Replay a cached finalize() output instead of recomputing it. This skips
     * processFontMaps() — ~200ms of deterministic FS.analyzePath font probing —
     * plus the pdftex.map rewrite and ls-R generation.
     */
    applyFinalizeOutput(cached) {
        // Avoid a later accidental processFontMaps() re-appending to the map.
        this.pendingFontMaps.clear();
        if (cached.pdftexMap) {
            const dir = VirtualFileSystem.PDFTEX_MAP_PATH.substring(0, VirtualFileSystem.PDFTEX_MAP_PATH.lastIndexOf('/'));
            this._ensureDirectoryPath(dir);
            this.FS.writeFile(VirtualFileSystem.PDFTEX_MAP_PATH, cached.pdftexMap);
        }
        if (cached.lsR) {
            this.FS.writeFile(VirtualFileSystem.LSR_PATH, cached.lsR);
        }
        this.writeFontconfig();
        this.onLog(`VFS finalized (cached): ${this.mountedFiles.size} files`);
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

    /**
     * Copy a byte range from bundle data into a new independent Uint8Array.
     * Must be a copy (not a view) because the result is stored as FSNode.contents
     * and a view would pin the entire bundle ArrayBuffer in memory.
     * Handles both ArrayBuffer and Uint8Array (legacy main-thread path).
     */
    _copyFromBundle(bundleData, start, end) {
        if (bundleData instanceof ArrayBuffer) {
            return new Uint8Array(bundleData.slice(start, end));
        }
        // TypedArray — slice() copies into a new buffer
        return bundleData.slice(start, end);
    }

    // Fulfil a resolver-owned placeholder once. A mounted, real file retains
    // precedence; demand loading cannot overwrite its bytes.
    materializeKnownFile(path, data) {
        let node;
        try { node = this.FS.lookupPath(path).node; } catch { return false; }
        const marker = node.contents;
        if (!this.isLazyMarker(marker) && !this.isDeferredMarker(marker)) return false;
        if (data.byteLength !== marker.end - marker.start) throw new Error('Resolved file range length mismatch');
        node.contents = data;
        node.usedBytes = data.byteLength;
        return true;
    }

    resolveLazy(marker) {
        this.onDeferredRead?.(marker);
        const bundleData = this.bundleCache.get(marker.bundleName);
        if (!bundleData) {
            this.onLog(`ERROR: Bundle not in cache: ${marker.bundleName}`);
            return new Uint8Array(0);
        }
        return this._copyFromBundle(bundleData, marker.start, marker.end);
    }

    /**
     * Resolve a deferred marker - returns data if bundle loaded, tracks request if not
     * For per-file loading: tracks individual files to fetch via Range requests
     */
    resolveDeferred(marker) {
        this.onDeferredRead?.(marker);
        const bundleData = this.bundleCache.get(marker.bundleName);
        if (bundleData) {
            return this._copyFromBundle(bundleData, marker.start, marker.end);
        }

        // Check if file was already fetched individually via Range request
        const fileKey = `${marker.bundleName}:${marker.start}:${marker.end}`;
        if (this.fetchedFiles.has(fileKey)) {
            return this.fetchedFiles.get(fileKey);
        }

        const synchronous = this.syncInput?.range(marker);
        if (synchronous?.byteLength === marker.end - marker.start) {
            this.storeFetchedFile(marker.bundleName, marker.start, marker.end, synchronous);
            return synchronous;
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
    getPendingDeferredFiles(bundleNames) {
        const pending = this.pendingDeferredFiles || [];
        if (!bundleNames) {
            this.pendingDeferredFiles = [];
            return pending;
        }
        const selected = [];
        this.pendingDeferredFiles = pending.filter(file => {
            if (!bundleNames.has(file.bundleName)) return true;
            selected.push(file);
            return false;
        });
        return selected;
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
        // MEMORY SAFETY: MEMFS is a singleton shared across Module instances.
        // Closures on stream_ops capture VFS → FS → Module scope → Wasm Memory.
        // We use an indirection pattern: a mutable holder on MEMFS stores the
        // current VFS reference. The wrapper closure captures only the holder
        // (a tiny object), not the VFS itself. destroyModule nulls the holder
        // to break the retention chain. Each new compile updates the holder.
        if (!this.MEMFS._lazyVfs) {
            this.MEMFS._lazyVfs = { vfs: null };
            const holder = this.MEMFS._lazyVfs;

            // Inline MEMFS read logic — avoids capturing the original read closure
            // (which lives in the Emscripten module scope and pins wasmMemory).
            // This is the standard Emscripten MEMFS.stream_ops.read implementation.
            const resolve = (node) => {
                const v = holder.vfs;
                if (!v) return;
                const contents = node.contents;
                if (contents instanceof Uint8Array) return;
                if (v.isLazyMarker(contents)) {
                    const resolved = v.resolveLazy(contents);
                    node.contents = resolved;
                    node.usedBytes = resolved.length;
                } else if (v.isDeferredMarker(contents)) {
                    const resolved = v.resolveDeferred(contents);
                    node.contents = resolved;
                    node.usedBytes = resolved.length;
                }
            };

            this.MEMFS.stream_ops.read = function(stream, buffer, offset, length, position) {
                resolve(stream.node);
                var contents = stream.node.contents;
                if (position >= stream.node.usedBytes) return 0;
                var size = Math.min(stream.node.usedBytes - position, length);
                if (size > 8 && contents.subarray) {
                    buffer.set(contents.subarray(position, position + size), offset);
                } else {
                    for (var i = 0; i < size; i++) buffer[offset + i] = contents[position + i];
                }
                return size;
            };

            if (this.MEMFS.ops_table?.file?.stream?.read) {
                this.MEMFS.ops_table.file.stream.read = this.MEMFS.stream_ops.read;
            }

            // mmap delegates to stream_ops.read internally, so our read patch
            // handles lazy resolution. No need to patch mmap separately.
        }

        // Update the holder to point to the current VFS instance.
        // Previous VFS becomes unreachable → old FS → old Module scope can be GC'd.
        this.MEMFS._lazyVfs.vfs = this;

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
    ENV['BIBINPUTS'] = '.:/texlive/texmf-dist/bibtex/bib//:';
    ENV['BSTINPUTS'] = '.:/texlive/texmf-dist/bibtex/bst//:';
    ENV['TEXINPUTS'] = '.:/texlive/texmf-dist/tex/latex//:/texlive/texmf-dist/tex/generic//:/texlive/texmf-dist/tex//:';
    ENV['T1FONTS'] = '.:/texlive/texmf-dist/fonts/type1//';
    ENV['ENCFONTS'] = '.:/texlive/texmf-dist/fonts/enc//';
    ENV['TFMFONTS'] = '.:/texlive/texmf-dist/fonts/tfm//';
    ENV['VFFONTS'] = '.:/texlive/texmf-dist/fonts/vf//';
    ENV['TEXFONTMAPS'] = '.:/texlive/texmf-dist/fonts/map/dvips//:/texlive/texmf-dist/fonts/map/pdftex//:/texlive/texmf-dist/texmf-var/fonts/map//';
    ENV['TEXPSHEADERS'] = '.:/texlive/texmf-dist/dvips//:/texlive/texmf-dist/fonts/enc//:/texlive/texmf-dist/fonts/type1//:/texlive/texmf-dist/fonts/type42//';

    // fontconfig: XeTeX/LuaTeX resolve fonts requested by name (\setmainfont{...})
    // through fontconfig. Without a config it aborts during font-DB init
    // ("Cannot load default config file"). FONTCONFIG_PATH is the directory
    // holding fonts.conf (written into the VFS by setupFontconfig).
    ENV['FONTCONFIG_PATH'] = '/texlive';
    ENV['FONTCONFIG_FILE'] = '/texlive/fonts.conf';

    // Reproducible PDF output: pin the timestamp pdfTeX/xdvipdfmx embed in the PDF
    // /CreationDate, /ModDate and /ID so identical input yields byte-identical output.
    // This enables safe output caching and stable hashing. We deliberately do NOT set
    // FORCE_SOURCE_DATE, so \today / \year still reflect the real date in the document.
    ENV['SOURCE_DATE_EPOCH'] = '1577836800'; // 2020-01-01T00:00:00Z — fixed reference
}

// Fontconfig inventories only materialized fonts. The source texmf tree also
// contains deferred markers, which must remain demand-loaded rather than
// becoming downloads simply because fontconfig enumerates a directory.
const FONTS_CONF = `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <dir>/texlive/fontconfig-fonts</dir>
</fontconfig>
`;


// ============ Worker Code ============

const BUNDLE_BASE = 'packages/bundles';

// Worker state
let cachedWasmModule = null;
let normalWasmUrl = null;
let checkpointRuntimeConfig = null;
let checkpointDriver = null;
let checkpointBoot = null;
let checkpointNativeBoot = null;
let checkpointFactory = null;
let syncInputBuffer = null;
let syncInputNames = new Set();
let createSyncInputReceiver = null;
let activeRuntimeKind = 'combined';
// Count observed native memory allocations without retaining their owners.
// This is a conservative worker-retirement budget, not retained browser RSS.
const observedWasmMemories = new WeakMap();
let observedWasmAllocatedBytes = 0, observedWasmAllocationCount = 0;
let wasmAllocationMeasurementsComplete = true, wasmAllocationWorkerId = null;
function observeWasmMemory(memory) {
    if (!(memory instanceof WebAssembly.Memory)) return false;
    const bytes = memory.buffer.byteLength;
    const previous = observedWasmMemories.get(memory) || 0;
    if (bytes > previous) {
        observedWasmAllocatedBytes += bytes - previous;
        observedWasmMemories.set(memory, bytes);
        if (!previous) observedWasmAllocationCount++;
    }
    return true;
}
function observeModuleMemory(module) {
    try { if (module && !observeWasmMemory(module.__siglumObservedMemory ?? module.asm?.memory ?? module.wasmMemory)) wasmAllocationMeasurementsComplete = false; }
    catch { wasmAllocationMeasurementsComplete = false; }
}
function wasmAllocationStats(module) {
    observeModuleMemory(module);
    return { workerId: wasmAllocationWorkerId, wasmAllocatedBytes: observedWasmAllocatedBytes,
        wasmAllocationCount: observedWasmAllocationCount,
        wasmAllocationComplete: wasmAllocationMeasurementsComplete && observedWasmAllocationCount > 0 };
}
// End native allocation accounting.
let engineInstanceSequence = 0;
const toolProjects = new Set();

async function fetchCheckpointAsset(url) {
    let cache;
    const key = new URL(url, self.location?.href || 'http://localhost/');
    key.searchParams.set('__siglum_runtime', checkpointRuntimeConfig.identity);
    try { cache = await caches.open('siglum-checkpoint-assets-v1'); } catch {}
    const saved = await cache?.match(key.href).catch(() => null);
    if (saved?.ok) return saved;
    const response = await fetch(url);
    if (!response.ok) throw new Error('Checkpoint asset unavailable: ' + response.status);
    try { await cache?.put(key.href, response.clone()); } catch (error) {
        workerLog('Could not persist checkpoint asset: ' + error.message);
    }
    return response;
}

async function importCheckpointApi(url) {
    const response = await fetchCheckpointAsset(url);
    const blob = URL.createObjectURL(new Blob([await response.text()], { type: 'text/javascript' }));
    try { return await import(/* @vite-ignore */ blob); } finally { URL.revokeObjectURL(blob); }
}
async function loadCheckpointApi() {
    const api = await importCheckpointApi(checkpointRuntimeConfig.apiUrl);
    createSyncInputReceiver = api.createSyncInputReceiver;
    checkpointDriver = api.createCheckpointDriver({ log: workerLog,
        maximumBytes: checkpointRuntimeConfig.maximumBytes || 48 * 1024 * 1024 });
}
async function loadCheckpointRuntime() {
    const [response, wasm] = await Promise.all([
        fetchCheckpointAsset(checkpointRuntimeConfig.jsUrl),
        checkpointRuntimeConfig.wasmModule || (async () => {
            const response = await fetchCheckpointAsset(checkpointRuntimeConfig.wasmUrl);
            return await WebAssembly.compile(await response.arrayBuffer());
        })(),
    ]);
    const blob = URL.createObjectURL(new Blob([await response.text()], { type: 'text/javascript' }));
    try { importScripts(blob); } finally { URL.revokeObjectURL(blob); }
    if (typeof pdftex !== 'function') throw new Error('Checkpoint glue has no pdftex factory');
    checkpointFactory = pdftex;
    checkpointRuntimeConfig.wasmModule = wasm;
}
async function ensureCheckpointRuntime() {
    if (!checkpointDriver) return;
    if (!checkpointNativeBoot) checkpointNativeBoot = loadCheckpointRuntime().catch(error => {
        checkpointDriver?.drop(); checkpointDriver = null; checkpointFactory = null;
        activeRuntimeKind = 'combined';
        workerLog('Native checkpoint unavailable; using normal runtime: ' + error.message);
    });
    await checkpointNativeBoot;
}
async function loadCombinedModule() {
    if (cachedWasmModule) return cachedWasmModule;
    const cache = typeof caches !== 'undefined' ? await caches.open('siglum-wasm-tl2026-v2').catch(() => null) : null;
    let response = await cache?.match(normalWasmUrl);
    if (!response) {
        response = await fetch(normalWasmUrl);
        if (!response.ok) throw new Error('Combined runtime unavailable: ' + response.status);
        await cache?.put(normalWasmUrl, response.clone()).catch(() => {});
    }
    cachedWasmModule = await WebAssembly.compile(await response.arrayBuffer());
    return cachedWasmModule;
}

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

// Document-file index: basename (e.g., "pdftex.def") → bundle name.
// Authoritative for routing a missing .sty/.cls/.def/etc. to the bundle that
// actually ships it. Needed because getPackageFromFile() only strips the
// extension to guess a package name, which is wrong for files whose basename
// differs from their package (e.g. pdftex.def lives in package graphics-def,
// bundle "graphics", not package "pdftex").
let docFileToBundle = null;
const DOC_FILE_EXT = /\.(sty|cls|def|clo|fd|cfg|ldf)$/;

/**
 * Index manifest by bundle name for fast lookup.
 * Also builds font file index for dynamic font resolution.
 * Called once at worker init.
 */
function ensureManifestIndexed(manifest) {
    if (filesByBundle || !manifest) return;

    filesByBundle = new Map();
    fontFileToBundle = new Map();
    docFileToBundle = new Map();

    for (const [path, info] of Object.entries(manifest)) {
        const bundle = info.bundle;
        if (!bundle) continue;
        if (!filesByBundle.has(bundle)) {
            filesByBundle.set(bundle, []);
        }
        filesByBundle.get(bundle).push([path, info]);

        const basename = path.substring(path.lastIndexOf('/') + 1);
        // Index font files by basename for dynamic lookup
        if (path.endsWith('.pfb') || path.endsWith('.tfm') || /\.\d{2,4}pk$/.test(basename)) {
            // Only store first occurrence (some fonts may be in multiple bundles)
            if (!fontFileToBundle.has(basename)) {
                fontFileToBundle.set(basename, bundle);
            }
        } else if (DOC_FILE_EXT.test(basename)) {
            // Index .sty/.cls/.def/etc. by basename so a missing file routes to
            // the bundle that actually ships it (first occurrence wins).
            if (!docFileToBundle.has(basename)) {
                docFileToBundle.set(basename, bundle);
            }
        }
    }
    workerLog(`Indexed manifest: ${filesByBundle.size} bundles, ${fontFileToBundle.size} font files, ${docFileToBundle.size} doc files`);
}

// Note: SharedArrayBuffer intentionally NOT used - causes memory leaks in V8
// (SABs become "strong roots" that persist even after worker termination)

// Global Module instance - track for cleanup before creating new one
let nativeAssetStore = null, nativeAssetBoot = null, nativeAssetConfig = null;
async function mountNativeResources(module, kind) {
    if (kind !== 'combined' || !nativeAssetConfig?.descriptors?.length) return;
    if (!nativeAssetBoot) nativeAssetBoot = (async () => {
        if (!self.SiglumNativeAssetStore) {
            if (!nativeAssetConfig.url) throw new Error('Native resource loader URL is missing');
            const response = await fetch(nativeAssetConfig.url);
            if (!response.ok) throw new Error('Native resource loader could not be loaded');
            const blobUrl = URL.createObjectURL(new Blob([await response.text()], { type: 'application/javascript' }));
            try { importScripts(blobUrl); } finally { URL.revokeObjectURL(blobUrl); }
        }
        nativeAssetStore = new self.SiglumNativeAssetStore(nativeAssetConfig.base, nativeAssetConfig.descriptors, workerLog);
        return nativeAssetStore;
    })();
    let store;
    try { store = await nativeAssetBoot; } catch (error) { nativeAssetBoot = null; throw error; }
    await store.mount(module, kind);
}
let globalModule = null;
let globalModulePromise = null;
// Track whether the current globalModule has been used for a compile.
// When false, getOrCreateModule() reuses it instead of destroying+recreating.
// This allows eager pre-instantiation during init to speed up the first compile.
let globalModuleUsed = false;

/**
 * Properly destroy an Emscripten Module to free WASM memory.
 * Must be called before creating a new Module to prevent memory accumulation.
 *
 * @param {Object} module - The Emscripten Module to destroy
 */
function destroyModule(module) {
    if (!module) return;
    observeModuleMemory(module);
    module.__siglumDisconnectProcessTool?.();

    self.postMessage({ type: 'log', message: '[MEMORY] destroyModule called' });

    // 1. Terminate any pthread workers (prevents GC blocking)
    if (module.PThread) {
        try { module.PThread.terminateAllThreads(); } catch (e) {}
    }

    // 2. Clear the filesystem to release file data from memory
    // Must happen BEFORE nulling MEMFS stream_ops (unmount needs them)
    if (module.FS) {
        try {
            const root = module.FS.root;
            if (root && root.mount && root.mount.mounts) {
                for (const mount of [...root.mount.mounts]) {
                    try { module.FS.unmount(mount.mountpoint); } catch (e) {}
                }
            }
        } catch (e) {}
    }

    // 3. Null the lazy VFS holder to break the closure chain:
    //    stream_ops.read closure → holder.vfs → old VFS → old FS → old Module scope → Wasm Memory
    // The wrapper closure remains on stream_ops (it only captures the holder object,
    // not the VFS directly), so stream_ops.read stays functional for the next Module.
    try {
        const memfs = module.FS?.filesystems?.MEMFS;
        if (memfs?._lazyVfs) {
            memfs._lazyVfs.vfs = null;
        }
    } catch (e) {}

    // 4. Null out HEAP typed array views — these reference the Wasm Memory buffer
    // and keep it alive even after the Module object is otherwise unreachable.
    // Explicit list ensures non-enumerable Emscripten internals are covered.
    const heapKeys = ['HEAPU8', 'HEAPU16', 'HEAPU32', 'HEAP8', 'HEAP16', 'HEAP32',
                      'HEAPF32', 'HEAPF64', 'buffer', 'wasmMemory', 'wasmExports', 'asm'];
    for (const key of heapKeys) {
        try { module[key] = null; } catch (e) {}
    }

    // 5. Delete ALL remaining properties to break reference chains
    for (const key of Object.keys(module)) {
        try {
            module[key] = null;
            delete module[key];
        } catch (e) {}
    }

    // 6. Clear prototype chain references
    try { Object.setPrototypeOf(module, null); } catch (e) {}

    self.postMessage({ type: 'log', message: '[MEMORY] Module destroyed successfully' });
}

// Pending requests
const pendingCtanRequests = new Map();
const pendingToolRequests = new Map();
const pendingBundleRequests = new Map();
const pendingFileRangeRequests = new Map();

// Global cache for Range-fetched files (persists across compiles)
const globalFetchedFilesCache = new Map();
let cmMetricLoad = null;
let cmSuperMetadataLoad = null;

// Caches finalize() output (pdftex.map + ls-R bytes) keyed by the mounted-bundle
// signature. finalize()'s processFontMaps() does ~200ms of FS.analyzePath font
// probing that is fully deterministic for a given bundle set, so we compute it once
// and replay the bytes on warm recompiles (4A). Cleared on hot-swap / cache clear.
const globalFinalizeCache = new Map();
const MAX_FINALIZE_CACHE_ENTRIES = 8;
const mapByteDecoder = new TextDecoder('latin1');

/**
 * Finalize a VFS, using the deterministic-output cache when a signature is given.
 * On a cache hit we skip the heavy font-map processing entirely; on a miss we run
 * the real finalize() and store its output for next time.
 */
function finalizeVfsCached(vfs, signature) {
    if (signature && globalFinalizeCache.has(signature)) {
        vfs.applyFinalizeOutput(globalFinalizeCache.get(signature));
        return;
    }
    vfs.finalize();
    if (signature) {
        if (globalFinalizeCache.size >= MAX_FINALIZE_CACHE_ENTRIES) {
            globalFinalizeCache.delete(globalFinalizeCache.keys().next().value);
        }
        globalFinalizeCache.set(signature, vfs.captureFinalizeOutput());
    }
}

// Operation queue to serialize compile and format-generate operations
// (async onmessage doesn't block new messages from being processed concurrently)
let operationQueue = Promise.resolve();

const MAX_PROJECT_SNAPSHOT_BYTES = 64 * 1024 * 1024;
const MAX_CTAN_SNAPSHOT_BYTES = 32 * 1024 * 1024;
let projectFileSnapshot = null;
let ctanFileSnapshot = null;

function resolveFileSnapshot(delta, revision, previous, maxBytes, validatePath) {
    const { baseRevision, paths, changed } = delta;
    if ((baseRevision !== null && typeof baseRevision !== 'string') || !Array.isArray(paths) ||
        !changed || typeof changed !== 'object' || Array.isArray(changed)) return null;

    const base = baseRevision === null ? null : previous;
    if (baseRevision !== null && base?.revision !== baseRevision) return null;

    const remainingChanges = new Map(Object.entries(changed));
    const files = new Map();
    const buffers = new Set();
    let bytes = 0;
    for (const path of paths) {
        if (typeof path !== 'string' || files.has(path) || (validatePath && !validatePath(path))) return null;
        const data = remainingChanges.has(path) ? remainingChanges.get(path) : base?.files.get(path);
        if (!(data instanceof Uint8Array)) return null;
        remainingChanges.delete(path);
        files.set(path, data);
        if (!buffers.has(data.buffer)) {
            buffers.add(data.buffer);
            bytes += data.buffer.byteLength;
        }
    }
    if (remainingChanges.size) return null;

    return { revision: bytes <= maxBytes ? revision : null, files };
}

function isProjectFilePath(path) {
    return path.length >= 2 && path.startsWith('/') && !path.endsWith('/') && !path.includes('//') &&
        !/(?:^|\/)\.{1,2}(?:\/|$)|[\\\0\r\n]/.test(path);
}

function resolveProjectFiles(delta, revision) {
    const next = resolveFileSnapshot(delta, revision, projectFileSnapshot, MAX_PROJECT_SNAPSHOT_BYTES, isProjectFilePath);
    if (!next) return null;
    // A large project still compiles but won't be retained between requests.
    projectFileSnapshot = next.revision === null ? null : next;
    return next.files;
}

function resolveCtanFiles(delta, revision) {
    if (delta.paths === undefined && delta.changed === undefined) {
        return typeof delta.baseRevision === 'string' && delta.baseRevision === ctanFileSnapshot?.revision
            ? ctanFileSnapshot : null;
    }
    return resolveFileSnapshot(delta, revision, ctanFileSnapshot, MAX_CTAN_SNAPSHOT_BYTES);
}


function workerLog(msg) {
    self.postMessage({ type: 'log', message: msg });
}

function workerProgress(stage, detail) {
    self.postMessage({ type: 'progress', stage, detail });
}

// ============ Worker-Direct OPFS Bundle Loading ============

// OPFS bundle cache path (matches storage.js)
const BUNDLE_CACHE_PATH = 'bundle-cache/bundles';

// Capability flag (set during init)
let canUseWorkerOPFS = false;

// Cached bundlesUrl from init
let workerBundlesUrl = null;

// Worker-level memory cache for bundles (persists across compiles)
// This avoids re-reading from OPFS on every compile
// NOT evicted automatically — bundle set is bounded by the document's dependencies.
// Use the 'cleanup' message to release explicitly when idle.
const workerBundleCache = new Map();
const pendingBundleLoads = new Map();
const pendingBundleWrites = new Map();
let workerOPFSReady;

/**
 * Load bundle from OPFS cache directly (bypasses main thread)
 * @param {string} bundleName
 * @returns {Promise<ArrayBuffer|null>}
 */
async function loadBundleFromOPFS(bundleName, baseUrl) {
    if (!canUseWorkerOPFS) return null;

    try {
        const root = await navigator.storage.getDirectory();

        // Navigate to bundle-cache/bundles directory
        const bundleCacheDir = await root.getDirectoryHandle('bundle-cache', { create: false });
        const bundlesDir = await bundleCacheDir.getDirectoryHandle('bundles', { create: false });
        const fileHandle = await bundlesDir.getFileHandle(`${(baseUrl?.match(/\/releases\/(tl2026-[a-f0-9]{16})(?:\/|$)/)?.[1] || 'tl2026-r1')}-${bundleName}.data`, { create: false });

        // Read file content
        const file = await fileHandle.getFile();
        const data = await file.arrayBuffer();

        if (data && data.byteLength > 0) {
            workerLog(`  From OPFS: ${bundleName} (${(data.byteLength / 1024 / 1024).toFixed(1)}MB)`);
            return data;
        }
    } catch (e) {
        // Not cached or OPFS error - fall through to network
    }
    return null;
}

/**
 * Fetch bundle from network, save to OPFS
 * @param {string} bundleName
 * @param {string} bundlesUrl
 * @returns {Promise<ArrayBuffer>}
 */
async function fetchBundleFromNetwork(bundleName, bundlesUrl) {
    const url = `${bundlesUrl}/${bundleName}.data.gz`;
    workerLog(`  Fetching: ${bundleName}`);

    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const compressed = await response.arrayBuffer();

    // Decompress - only skip if Brotli (browser already decompressed)
    // Note: Content-Encoding: gzip means transport compression, not file format
    const encoding = response.headers.get('Content-Encoding');
    let decompressed;
    if (encoding === 'br') {
        // Brotli: browser already decompressed the gzip content
        decompressed = compressed;
    } else {
        // Decompress gzip (file is .data.gz)
        const ds = new DecompressionStream('gzip');
        const stream = new Blob([compressed]).stream().pipeThrough(ds);
        decompressed = await new Response(stream).arrayBuffer();
    }

    workerLog(`  Fetched: ${bundleName} (${(decompressed.byteLength / 1024 / 1024).toFixed(1)}MB)`);

    // Cache to OPFS (fire-and-forget)
    if (canUseWorkerOPFS) {
        const write = saveBundleToOPFS(bundleName, decompressed, bundlesUrl).finally(() => {
            if (pendingBundleWrites.get(bundleName) === write) pendingBundleWrites.delete(bundleName);
        });
        pendingBundleWrites.set(bundleName, write);
    }

    return decompressed;
}

/**
 * Save bundle to OPFS cache
 * @param {string} bundleName
 * @param {ArrayBuffer} data
 */
async function saveBundleToOPFS(bundleName, data, baseUrl) {
    try {
        const root = await navigator.storage.getDirectory();

        // Create directories if needed
        const bundleCacheDir = await root.getDirectoryHandle('bundle-cache', { create: true });
        const bundlesDir = await bundleCacheDir.getDirectoryHandle('bundles', { create: true });
        const fileHandle = await bundlesDir.getFileHandle(`${(baseUrl?.match(/\/releases\/(tl2026-[a-f0-9]{16})(?:\/|$)/)?.[1] || 'tl2026-r1')}-${bundleName}.data`, { create: true });

        // Write using writable stream
        const writable = await fileHandle.createWritable();
        await writable.write(new Uint8Array(data));
        await writable.close();

        workerLog(`  Cached to OPFS: ${bundleName}`);
    } catch (e) {
        // Ignore caching errors - data still usable
    }
}

/**
 * Load bundle: memory cache first, then OPFS, then network, then main thread fallback
 * @param {string} bundleName
 * @param {string} bundlesUrl
 * @returns {Promise<ArrayBuffer>}
 */
async function loadBundleInWorker(bundleName, bundlesUrl) {
    const cached = workerBundleCache.get(bundleName);
    if (cached) {
        workerLog(`  From memory: ${bundleName}`);
        return cached;
    }

    let load = pendingBundleLoads.get(bundleName);
    if (!load) {
        load = readBundleInWorker(bundleName, bundlesUrl);
        pendingBundleLoads.set(bundleName, load);
    }

    try {
        const data = await load;
        if (pendingBundleLoads.get(bundleName) === load) {
            workerBundleCache.set(bundleName, data);
        }
        return data;
    } finally {
        if (pendingBundleLoads.get(bundleName) === load) {
            pendingBundleLoads.delete(bundleName);
        }
    }
}

async function readBundleInWorker(bundleName, bundlesUrl) {
    await workerOPFSReady;
    if (!canUseWorkerOPFS) {
        // The main thread can cache through IndexedDB where worker OPFS is unavailable.
        try {
            return (await requestBundleFetch(bundleName)).bundleData;
        } catch (e) {
            workerLog(`  Main-thread bundle fetch failed for ${bundleName}: ${e.message}`);
            return fetchBundleFromNetwork(bundleName, bundlesUrl);
        }
    }
    const cached = await loadBundleFromOPFS(bundleName, bundlesUrl);
    if (cached) return cached;

    try {
        return await fetchBundleFromNetwork(bundleName, bundlesUrl);
    } catch (e) {
        workerLog(`  Network failed for ${bundleName}: ${e.message}`);
    }

    // Keep the main-thread cache and fetch path available as a fallback.
    return (await requestBundleFetch(bundleName)).bundleData;
}

async function preloadDefaultBundles(rangeFontBundles = [], engine = 'pdflatex') {
    const required = bundleDeps?.engines?.[engine]?.required?.filter(name => !rangeFontBundles.includes(name));
    if (!workerBundlesUrl || !required?.length) return;

    workerLog(`Preloading ${engine} bundles...`);
    const results = await Promise.allSettled(
        required.map(name => loadBundleInWorker(name, workerBundlesUrl))
    );
    const loaded = results.filter(result => result.status === 'fulfilled').length;
    if (loaded === required.length) {
        workerLog(`Preload complete: ${loaded} bundles loaded`);
    } else {
        workerLog(`Preload loaded ${loaded}/${required.length} bundles; failed bundles will retry on compile`);
    }
}

/**
 * Detect if worker can use OPFS directly
 * The worker needs both directory access and async file writes to persist bundles.
 */
async function detectWorkerOPFS() {
    try {
        // Check if OPFS is available
        if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory ||
            typeof globalThis.FileSystemFileHandle?.prototype.createWritable !== 'function') {
            return false;
        }

        // Try to access OPFS root
        const root = await navigator.storage.getDirectory();
        if (!root) return false;

        return true;
    } catch (e) {
        return false;
    }
}

// ============ External Fetch Requests ============

// Supported TexLive years for version fallback (newest first)
const SUPPORTED_TL_YEARS = [2026, 2025, 2024, 2023];
const DEFAULT_TL_YEAR = 2026;

// Request IDs only correlate messages within this worker, including on HTTP LAN origins.
let nextFetchRequestId = 0;

function requestAuxiliaryTool(compileId, tool, input, checkpointContext = null) {
    // Tool inputs can be read outside TeX (for example a bibliography database).
    // A TeX-only checkpoint does not prove those derived outputs are current.
    // Keep the small runtime, but require the ordinary full-build pipeline.
    if (checkpointContext) checkpointContext.captureDisabled = true;
    checkpointDriver?.drop('Auxiliary tool dependencies require a full build');
    return new Promise((resolve, reject) => {
        const requestId = String(++nextFetchRequestId);
        const timeout = setTimeout(() => {
            pendingToolRequests.delete(requestId);
            reject(new Error(tool + ' timed out.'));
        }, 60000);
        pendingToolRequests.set(requestId, { resolve, reject, timeout });
        self.postMessage({ type: 'auxiliary-tool-request', requestId, compileId, tool, input }, [input.buffer]);
    });
}

function requestCtanFetch(packageName, originalFileName = null, tlYear = null) {
    return new Promise((resolve, reject) => {
        const requestId = String(++nextFetchRequestId);
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
        const requestId = String(++nextFetchRequestId);
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

function requestFileRangeFetch(bundleName, start, end, timeoutMs = 30000, cacheOnly = false) {
    return new Promise((resolve, reject) => {
        const requestId = String(++nextFetchRequestId);
        pendingFileRangeRequests.set(requestId, { resolve, reject });

        self.postMessage({
            type: 'file-range-fetch-request',
            requestId,
            bundleName,
            start,
            end,
            cacheOnly,
        });

        setTimeout(() => {
            if (pendingFileRangeRequests.has(requestId)) {
                pendingFileRangeRequests.delete(requestId);
                reject(new Error('File range fetch timeout'));
            }
        }, timeoutMs);
    });
}

// ============ Source Processing ============

function injectMicrotypeWorkaround(source) {
    if (!source.includes('microtype')) return source;
    const documentclassMatch = source.match(/\\documentclass/);
    if (!documentclassMatch) return source;
    // Insert on same line as \documentclass to preserve line numbers
    const insertPos = documentclassMatch.index;
    workerLog('Injecting microtype expansion=false workaround');
    return source.slice(0, insertPos) + '\\PassOptionsToPackage{expansion=false}{microtype}' + source.slice(insertPos);
}

function injectKernelCompatShim(source) {
    if (!/\\usetkzobj\s*\{all\}/.test(source)) return source;
    const insertAt = source.search(/^[ \t]*\\(?:documentclass\b|begin\s*\{document\})/m);
    if (insertAt < 0) return source;

    // tkz-euclide 5.13c loads all the ordinary objects itself. Its old
    // {all} selector has nothing to load. Leave the mini edition, other
    // versions and user definitions alone. Keep source line numbers intact.
    const shim = String.raw`\AddToHook{package/tkz-euclide/after}{
        \IfPackageAtLeastT{tkz-euclide}{2026/01/25}{
            \IfPackageAtLeastF{tkz-euclide}{2026/01/26}{
                \IfPackageLoadedWithOptionsF{tkz-euclide}{mini}{
                    \ProvideDocumentCommand\usetkzobj{m}{
                        \begingroup\def\SiglumTkzAll{all}\def\SiglumTkzSelected{#1}
                        \ifx\SiglumTkzAll\SiglumTkzSelected\else
                            \PackageError{siglum}{Unsupported legacy tkz-euclide object selection}{Use the objects provided by tkz-euclide.}
                        \fi\endgroup
                    }
                }
            }
        }
    }`.replace(/\n[ \t]*/g, '');
    return source.slice(0, insertAt) + shim + source.slice(insertAt);
}

// The mounted source and checkpoint guard must see identical prepared bytes.
// Padding preserves source/PDF line numbers when a precompiled preamble is used.
function prepareCompileSource(source, engine, cachedFormat) {
    let prepared = source;
    const formatted = engine === 'pdflatex' && cachedFormat?.fmtData?.buffer?.byteLength > 0;
    if (formatted) {
        const begin = Number.isSafeInteger(cachedFormat.preambleLength) && cachedFormat.preambleLength >= 0
            && cachedFormat.preambleLength <= source.length ? cachedFormat.preambleLength : source.indexOf('\\begin{document}');
        if (begin !== -1) {
            let lines = 0;
            for (let i = 0; i < begin; i++) if (source.charCodeAt(i) === 10) lines++;
            prepared = '%\n'.repeat(lines) + source.slice(begin);
        }
    } else if (engine === 'pdflatex') {
        prepared = injectMicrotypeWorkaround(prepared);
    }
    return injectKernelCompatShim(prepared);
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

// ============ Missing File Detection ============

// Exact TeX Live 2026 runfiles omitted from the general file-to-package index.
const PINNED_FILE_PACKAGES = new Map([
    ['kvmacros.tex', 'karnaugh'],
]);

function extractMissingFile(logContent, alreadyFetched) {
    const files = extractAllMissingFiles(logContent, alreadyFetched);
    return files.length > 0 ? files[0] : null;
}

// Extract ALL missing files from log (for parallel fetching)
function extractAllMissingFiles(logContent, alreadyFetched) {
    const patterns = [
        /LaTeX Warning:.*File [`'\u2018]([^'\u2019]+)['\u2019] not found/g,
        /Package .* Error:.*[`'\u2018]([^'\u2019]+)['\u2019] not found/g,
        /! Font [^=]+=([a-z0-9-]+) at .* not loadable: Metric \(TFM\) file/g,
        /!pdfTeX error:.*\(file ([a-z0-9-]+)\): Font .* not found/g,
        /! Font ([a-z0-9-]+) at [0-9]+ not found/g,
        // Generic PGF/TeX: "I looked for files named X.code.tex" (captures first filename)
        /I looked for files named ([a-z0-9_.+-]+\.code\.tex)/gi,
        // xdvipdfmx: Could not locate a virtual/physical font for TFM "ec-lmbx12"
        /xdvipdfmx.*Could not locate.*TFM "([a-z0-9_-]+)"/gi,
        // xdvipdfmx: This font is mapped to a physical font "lmbx12.pfb"
        /xdvipdfmx.*mapped to.*"([a-z0-9_-]+\.pfb)"/gi,
    ];
    const fetchedSet = alreadyFetched || new Set();
    const missingFiles = [];
    const seenPkgs = new Set();
    const bitmapStems = new Set();
    const addFile = (missingFile) => {
        if (bitmapStems.has(missingFile)) return;
        const pkgName = getPackageFromFile(missingFile);
        if (!fetchedSet.has(pkgName) && !seenPkgs.has(pkgName)) {
            seenPkgs.add(pkgName);
            missingFiles.push(missingFile);
        }
    };

    // File-line-error prefixes can push the diagnostic across TeX's print
    // column, leaving the :line: on its own line without the filename.
    // Final font output can also report a file prefix without a line number.
    for (const [, diagnostic] of logContent.matchAll(/(?:!|^[^\r\n]*?:(?:\d+(?:\r?\n)?:)?)[ \t]*(?=([^\r\n]*(?:\r?\n[^\r\n]*){0,3}))/gm)) {
        const message = diagnostic.replace(/\r?\n/g, '');
        const bitmap = message.match(/^(?:pdfTeX error:.*?\(file [a-z0-9_-]{1,64}\):\s*)?Font\s+([a-z0-9_-]{1,64})\s+at\s+([0-9]{2,4})\s+not\s*found/i);
        if (bitmap) {
            const name = `${bitmap[1]}.${bitmap[2]}pk`;
            if (fontFileToBundle?.has(name)) {
                bitmapStems.add(bitmap[1]);
                addFile(name);
            } else {
                // A missing bitmap may have a scalable outline in another package.
                addFile(bitmap[1] + '.pfb');
            }
        }
        const missing = message.match(/^LaTeX\s*Error:\s*File\s*[`'\u2018]([^'\u2019]+)['\u2019]\s*not\s*found/)
            || message.match(/^I\s*can't\s*find\s*file\s*[`'\u2018]([^'\u2019]+)['\u2019]/)
            || message.match(/^Font\s+[^=]+=([A-Za-z0-9_.+-]+)\s+at\s+\S+\s+not\s*loadable:\s*Metric\s*\(TFM\)\s*file/);
        if (missing) addFile(missing[1]);
        const packageFile = message.match(/^Package\s+[^:]+Error:\s*Package\s+file\s+([A-Za-z0-9_.+-]+\.(?:sty|cls|def|cfg|tex))\s+not\s*found\b/);
        if (packageFile) addFile(packageFile[1]);
        const outline = message.match(/^pdfTeX\s*error:[^(]*\(file\s+([a-z0-9_.+-]+\.pfb)\):\s*cannot\s*open\s*Type\s*1\s*font\s*file\b/i)?.[1];
        if (outline) {
            addFile(outline);
        }
    }

    for (const pattern of patterns) {
        let match;
        while ((match = pattern.exec(logContent)) !== null) {
            addFile(match[1]);
        }
    }

    // Babel reports a missing language definition as an unknown option.
    // TeX can wrap the message in the middle of a word.
    for (const [, message] of logContent.matchAll(/\bPackage babel Error:(?=([^\r\n]*(?:\r?\n[^\r\n]*)?))/g)) {
        const language = message.replace(/\r?\n/g, '')
            .match(/^\s*Unknown\s*option\s*[`'\u2018]([A-Za-z][A-Za-z0-9-]{0,49})['\u2019]/)?.[1];
        if (language) {
            // Babel's historical option name points to russianb.ldf.
            addFile((language === 'russian' ? 'russianb' : language) + '.ldf');
        }
    }
    return missingFiles;
}

function getFontPackage(fontName) {
    if (!fontName) return null;
    if (/\.\d{2,4}pk$/.test(fontName)) return fontFileToBundle?.get(fontName) || null;

    // An explicit resource must not inherit another extension's bundle.
    if (/\.(?:tfm|vf|pfb|pfm|afm|otf|ttf|ttc|map|enc)$/i.test(fontName)) {
        return fontFileToBundle?.get(fontName) || null;
    }

    // Bare stems may still select a known bundled resource.
    const baseName = fontName;

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
    const exactPackage = PINNED_FILE_PACKAGES.get(filename);
    if (exactPackage) return exactPackage;
    const fontPkg = getFontPackage(filename);
    if (fontPkg) return fontPkg;

    // Strip extension - the file-to-package index handles the mapping
    return filename.replace(/\.(sty|cls|def|clo|fd|cfg|ldf|tex|code\.tex)$/, '');
}

function getMissingFileBundle(filename, packageName) {
    const basename = filename.substring(filename.lastIndexOf('/') + 1);
    const exactBundle = docFileToBundle?.get(basename) || fontFileToBundle?.get(filename);
    // A bundle can contain the package's macros without the requested
    // runfile, such as a Babel definition or a Utopia outline.
    if (exactBundle || basename.endsWith('.ldf') || /\.(?:tfm|vf|pfb|pfm|afm|otf|ttf|ttc|map|enc|[0-9]+pk)$/i.test(basename) || PINNED_FILE_PACKAGES.has(filename)) return exactBundle;
    return bundleRegistry?.has(packageName) ? packageName : packageMap?.[packageName];
}

// ============ Aux File Handling ============

// Main document base path on the VFS (no extension). Set per-compile from
// options.mainFile so on-disk files and TeX log/error messages use the real
// name. Defaults to '/document' to preserve legacy behavior.
let docBase = '/document';

// Top-level VFS dirs to skip when snapshotting the working tree for preamble
// side-effect detection: the mounted texmf tree (huge, not document output) and
// the Emscripten system dirs. Everything else is document/package output.
const SNAPSHOT_PRUNE_DIRS = new Set(['texlive', 'bin', 'dev', 'proc', 'tmp', 'home', 'sys', 'lib', 'etc']);

// Set of absolute file paths in the working tree, excluding the pruned dirs.
// Recursive so files a preamble writes into subdirectories are seen too.
function snapshotWorkTree(FS) {
    const files = new Set();
    const walk = (dir) => {
        let entries;
        try { entries = FS.readdir(dir); } catch (e) { return; }
        for (const name of entries) {
            if (name === '.' || name === '..') continue;
            if (dir === '/' && SNAPSHOT_PRUNE_DIRS.has(name)) continue;
            const path = dir === '/' ? '/' + name : dir + '/' + name;
            // Immutable runtime resources belong to the engine, not the
            // document's preamble outputs. Do not enumerate/hydrate their tree.
            if (FS.__siglumNativeResourceRoots?.has(path)) continue;
            let mode;
            try { mode = FS.stat(path).mode; } catch (e) { continue; }
            if (FS.isDir(mode)) walk(path);
            else files.add(path);
        }
    };
    walk('/');
    return files;
}

// Restore captured preamble side-effect files (keyed by absolute path) into the
// VFS, creating parent directories as needed. Used on cached-format reuse.
function restoreSideEffectFiles(FS, sideEffectFiles) {
    if (!sideEffectFiles) return 0;
    let n = 0;
    for (const [path, data] of Object.entries(sideEffectFiles)) {
        try {
            const slash = path.lastIndexOf('/');
            if (slash > 0) {
                let cur = '';
                for (const part of path.slice(0, slash).split('/').filter(Boolean)) {
                    cur += '/' + part;
                    try { FS.mkdir(cur); } catch (e) { /* exists */ }
                }
            }
            FS.writeFile(path, data instanceof Uint8Array ? data : new Uint8Array(data));
            n++;
        } catch (e) { workerLog(`Failed to restore side-effect file ${path}: ${e.message}`); }
    }
    return n;
}

const AUXILIARY_EXTENSIONS = ['.aux', '.toc', '.lof', '.lot', '.out', '.nav', '.snm', '.bbl', '.blg', '-blx.bib'];

// A missing generated file is not runtime package demand. Exact manifest
// ownership wins even when a document happens to have the same basename.
function nativeFontMemoryStats(module) {
    try {
        const prefix = typeof module?._siglum_xetex_font_memory_capacity === 'function' && activeRuntimeKind === 'combined'
            ? '_siglum_xetex_font_memory_' : '_siglum_font_memory_';
        if (typeof module?.[prefix + 'capacity'] !== 'function') return {};
        return {
            fontInfoCapacityWords: module[prefix + 'capacity'](),
            fontInfoLimitWords: module[prefix + 'limit'](),
            fontInfoGrowths: module[prefix + 'growth_count'](),
        };
    } catch { return {}; }
}

function shouldResolveRuntimeInput(name, runtimeNames, projectStems, catalogNames = new Set()) {
    if (runtimeNames.has(name)) return true;
    return catalogNames.has(name) && !AUXILIARY_EXTENSIONS.some(suffix => name.endsWith(suffix)
        && projectStems.has(name.slice(0, -suffix.length)));
}

function collectAuxFiles(FS) {
    const auxExtensions = AUXILIARY_EXTENSIONS;
    const files = {};
    for (const ext of auxExtensions) {
        const path = docBase + ext;
        try {
            files[ext] = FS.readFile(path, { encoding: 'utf8' });
        } catch (e) {}
    }
    // Included chapters have their own aux files; BibTeX follows \@input entries.
    for (const path of snapshotWorkTree(FS)) {
        if (path.endsWith('.aux') && path !== docBase + '.aux') {
            try { files['@' + path] = FS.readFile(path, { encoding: 'utf8' }); } catch {}
        }
    }
    return files;
}

function restoreAuxFiles(FS, auxFiles) {
    let restored = 0;
    for (const [ext, content] of Object.entries(auxFiles)) {
        try {
            const path = ext.startsWith('@/') ? ext.slice(1) : docBase + ext;
            FS.mkdirTree(path.slice(0, path.lastIndexOf('/')) || '/');
            FS.writeFile(path, content);
            restored++;
        } catch (e) {}
    }
    return restored;
}

async function loadDocIndexStyle(FS, suppliedFiles, texLog, source, cachedFormat) {
    const indexPath = docBase + '.idx';
    if (suppliedFiles.has(docBase + '.ind') || !FS.analyzePath(indexPath).exists) return null;
    const usesDoc = /\(\/texlive\/texmf-dist\/tex\/latex\/base\/doc\.sty(?=\s|\)|$)/.test(texLog)
        || (cachedFormat && /\\(?:CodelineIndex|PageIndex)\b/.test(source));
    // doc.sty uses "=" as the actual delimiter and "!" to quote its
    // generated macro names. Ordinary MakeIndex syntax uses "@" instead.
    if (!usesDoc || !/^\\indexentry\{[^\r\n]*=\\verb!\*/m.test(FS.readFile(indexPath, { encoding: 'utf8' }))) {
        return null;
    }

    const bundledPath = '/texlive/texmf-dist/makeindex/latex/gind.ist';
    for (const path of ['./gind.ist', bundledPath]) {
        if (FS.analyzePath(path).exists) return { path, data: FS.readFile(path) };
    }
    const file = fileManifest[bundledPath];
    if (!file) throw new Error('Could not find the doc package MakeIndex style (gind.ist).');
    const { data } = await requestFileRangeFetch(file.bundle, file.start, file.end);
    if (data?.byteLength !== file.end - file.start) throw new Error('Incomplete MakeIndex style (gind.ist).');
    return { path: bundledPath, data: new Uint8Array(data) };
}

function readMakeIndexJobs(FS, suppliedFiles, aux, docIndexStyle) {
    const jobs = new Map();
    const name = docBase.slice(docBase.lastIndexOf('/') + 1);
    const add = (inputExt, outputExt, logExt, style, flags = []) => {
        const inputPath = docBase + '.' + inputExt;
        const outputPath = docBase + '.' + outputExt;
        if (suppliedFiles.has(outputPath) || !FS.analyzePath(inputPath).exists) return;
        const input = FS.readFile(inputPath);
        if (!input.length) return;
        const logPath = docBase + '.' + logExt;
        const args = style
            ? ['makeindex', ...flags, '-s', style.path, '-t', './' + name + '.' + logExt,
                '-o', './' + name + '.' + outputExt, './' + name + '.' + inputExt]
            : ['makeindex', './' + name + '.' + inputExt];
        jobs.set(outputPath, { inputPath, logPath, input, style, args });
    };
    add('idx', 'ind', 'ilg', docIndexStyle);

    // The default glossaries backend stores the MakeIndex recipe in the aux.
    // Custom command options and xindy need their own drivers.
    const styleName = aux.match(/\\@istfilename\s*\{([^}]+)\}/)?.[1]
        ?.replace(/^"(.*)"\.ist$/, '$1.ist');
    const stylePath = docBase + '.ist';
    if (styleName !== name + '.ist' || /\\@gls@extramakeindexopts\{[^}]+\}/.test(aux)
        || !FS.analyzePath(stylePath).exists) return jobs;
    const style = { path: './' + name + '.ist', data: FS.readFile(stylePath) };
    const flags = /\\@glsorder\s*\{letter\}/.test(aux) ? ['-l'] : [];
    for (const [, log, output, input] of aux.matchAll(
        /\\@newglossary\s*\{[^}]+\}\{([A-Za-z][A-Za-z0-9]{0,15})\}\{([A-Za-z][A-Za-z0-9]{0,15})\}\{([A-Za-z][A-Za-z0-9]{0,15})\}/g
    )) {
        // Keep generated files away from TeX sources and ordinary aux output.
        if (!['glo', 'acn', 'slo'].includes(input) || !['gls', 'acr', 'sls'].includes(output)
            || !['glg', 'alg', 'slg'].includes(log)) continue;
        add(input, output, log, style, flags);
    }
    return jobs;
}

function sameIndexBytes(left, right) {
    return left && right
        ? left.length === right.length && left.every((byte, i) => byte === right[i])
        : left === right;
}

function sameMakeIndexJob(left, right) {
    return left && right
        ? sameIndexBytes(left.input, right.input) && sameIndexBytes(left.style?.data, right.style?.data)
            && left.args.join('\0') === right.args.join('\0')
        : left === right;
}

// ============ WASM Initialization ============

// Track if busytex.js has been loaded
let busytexScriptLoaded = false;

// Generic virtual process boundary. Program protocols belong to registered providers.
// Pass capabilities through TeX's native configuration: Emscripten may have
// materialized C environ before a late Module.ENV assignment would be visible.
function toolFailureMessage(failures) {
    return failures.map(({ command, status }) => `External program ${command} exited with status ${status}.`).join(' ')
        + ' No partial tool output was accepted.';
}

function texProcessArguments(module, commands = []) {
    if (typeof module.siglumRunTool !== 'function') return ['--no-shell-escape'];
    if (!Array.isArray(commands) || !commands.length || commands.some(command => typeof command !== 'string'
        || !/^[A-Za-z0-9_][A-Za-z0-9_.+-]{0,63}$/.test(command))) {
        throw new Error('Invalid native process tool allowlist.');
    }
    return ['--shell-restricted', '--cnf-line=shell_escape_commands=' + commands.join(',')];
}

function parseToolCommand(command) {
    if (typeof command !== 'string' || command.length > 32768) throw new Error('Invalid tool command.');
    const args = [];
    let word = '', quote = null, started = false;
    for (let i = 0; i < command.length; i++) {
        const ch = command[i];
        if (/[\0\r\n]/.test(ch)) throw new Error('Invalid tool command.');
        if (quote) {
            if (ch === quote) quote = null;
            else if (ch === '\\' && quote === '"' && i + 1 < command.length) word += command[++i];
            else word += ch;
        } else if (ch === '"' || ch === "'") { quote = ch; started = true; }
        else if (/\s/.test(ch)) {
            if (started) { args.push(word); word = ''; started = false; }
        } else {
            if (/[|;&<>`$]/.test(ch)) throw new Error('Shell expressions are not supported.');
            word += ch; started = true;
        }
    }
    if (quote) throw new Error('Unclosed tool argument.');
    if (started) args.push(word);
    if (args.length > 129 || args.some(arg => arg.length > 4096)) throw new Error('Tool argument limit exceeded.');
    return args;
}

function toolInputPath(directory, path) {
    if (typeof path !== 'string' || !path || path.length > 4096 || path.startsWith('/') || /[\\\0\r\n:]/.test(path)) {
        throw new Error('Tools require a relative input path.');
    }
    const parts = directory.split('/').filter(Boolean);
    for (const part of path.split('/')) {
        if (!part || part === '.') continue;
        if (part === '..') {
            if (!parts.length) throw new Error('Tool path escapes the project.');
            parts.pop();
        } else parts.push(part);
    }
    if (!parts.length) throw new Error('Tool path must name a file.');
    return '/' + parts.join('/');
}

function createToolFileAccess(module, directory, sourcePath, projectFiles, written, generated) {
    const FS = module.FS;
    const inputs = new Set([sourcePath, ...(projectFiles?.keys() || [])]);
    if (!module.__siglumProcessFiles) {
        const original = FS.open;
        const tracker = { onWrite: null };
        FS.open = function(...args) {
            const stream = original.apply(this, args);
            if ((stream.flags & 3) !== 0) tracker.onWrite?.(stream.path || FS.getPath(stream.node));
            return stream;
        };
        module.__siglumProcessFiles = tracker;
    }
    const tracker = module.__siglumProcessFiles;
    const onWrite = path => { if (typeof path === 'string' && path.startsWith('/')) written.add(path); };
    tracker.onWrite = onWrite;
    const existing = path => { try { return FS.lookupPath(path).node; } catch { return null; } };
    const owned = path => written.has(path) || generated.has(path);
    const parent = path => path.slice(0, path.lastIndexOf('/')) || '/';
    function permittedDirectories() {
        const dirs = new Set([directory]);
        for (const path of [...inputs, ...written, ...generated.keys()]) {
            let value = parent(path);
            while (value === directory || value.startsWith(directory === '/' ? '/' : directory + '/')) {
                dirs.add(value);
                if (value === directory) break;
                value = parent(value);
            }
        }
        return dirs;
    }
    function outputPath(path) {
        if (typeof path !== 'string' || /[\\\0\r\n:]/.test(path)
            || path.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Invalid tool output path.');
        const full = toolInputPath(directory, path);
        if (inputs.has(full)) throw new Error('Tool cannot overwrite project inputs.');
        const node = existing(full);
        if (node && (!owned(full) || FS.isDir(node.mode))) throw new Error('Tool cannot overwrite immutable compiler files.');
        const permitted = permittedDirectories();
        let value = parent(full);
        while (value !== directory) {
            if (existing(value) && !permitted.has(value)) throw new Error('Tool output enters an immutable compiler directory.');
            value = parent(value);
        }
        return full;
    }
    return {
        read(path) {
            const full = toolInputPath(directory, path);
            if (!inputs.has(full) && !owned(full)) throw new Error('Tool input is outside this project and build outputs.');
            const data = FS.readFile(full);
            if (!(data instanceof Uint8Array) || data.byteLength > 16 * 1024 * 1024) throw new Error('Tool input exceeds the byte limit.');
            return data;
        },
        prepare(manifest) {
            if (!manifest || !Array.isArray(manifest.files) || !Array.isArray(manifest.removed)
                || manifest.files.length + manifest.removed.length > 128) throw new Error('Invalid tool output manifest.');
            const seen = new Set(), files = [], removed = [];
            let total = 0;
            for (const file of manifest.files) {
                const path = outputPath(file.path);
                if (seen.has(path) || !Number.isSafeInteger(file.size) || file.size < 0 || (total += file.size) > 16 * 1024 * 1024) {
                    throw new Error('Invalid tool output size or duplicate path.');
                }
                seen.add(path); files.push({ path, bytes: new Uint8Array(file.size) });
            }
            for (const item of manifest.removed) {
                const path = outputPath(item);
                if (seen.has(path) || !owned(path)) throw new Error('Tool cannot remove an unowned file.');
                seen.add(path); removed.push(path);
            }
            return { files, removed, total, received: 0 };
        },
        apply(result) {
            if (result.received !== result.total) throw new Error('Incomplete tool output.');
            const backups = new Map(), createdDirs = [];
            let backupBytes = 0;
            for (const path of [...result.files.map(file => file.path), ...result.removed]) {
                const data = existing(path) ? FS.readFile(path) : null;
                if (data && (backupBytes += data.byteLength) > 16 * 1024 * 1024) throw new Error('Tool rollback budget exceeded.');
                backups.set(path, data);
            }
            const observing = tracker.onWrite;
            tracker.onWrite = null;
            try {
                for (const file of result.files) {
                    const missing = [];
                    for (let value = parent(file.path); !existing(value); value = parent(value)) missing.push(value);
                    FS.mkdirTree(parent(file.path)); createdDirs.push(...missing.reverse());
                    FS.writeFile(file.path, file.bytes);
                }
                for (const path of result.removed) if (existing(path)) FS.unlink(path);
            } catch (error) {
                let rollbackFailed = false;
                for (const [path, data] of backups) {
                    try { if (data) FS.writeFile(path, data); else if (existing(path)) FS.unlink(path); }
                    catch { rollbackFailed = true; }
                }
                for (const path of createdDirs.reverse()) { try { FS.rmdir(path); } catch {} }
                if (rollbackFailed) throw new Error('Tool output rollback failed; discard this compiler instance.');
                throw error;
            } finally { tracker.onWrite = observing; }
            // Commit ownership and convergence state only after every filesystem write succeeds.
            for (const file of result.files) { written.add(file.path); generated.set(file.path, file.bytes); }
            for (const path of result.removed) { written.delete(path); generated.delete(path); }
        },
        disconnect() { if (tracker.onWrite === onWrite) tracker.onWrite = null; },
    };
}

function receiveToolProcess({ buffer, compileId, command, args, files, postMessage, log, timeoutMs = 45000 }) {
    const header = new Int32Array(buffer, 0, 8), area = new Uint8Array(buffer, 32);
    const sequence = (Atomics.add(header, 1, 1) + 1) | 0;
    Atomics.store(header, 0, 0);
    postMessage({ type: 'process-tool-request', compileId, sequence, command, args });
    const deadline = performance.now() + timeoutMs;
    let output = null, frame = 0;
    try {
        for (;;) {
            const remaining = deadline - performance.now();
            if (remaining <= 0) throw new Error('Tool timed out.');
            const state = Atomics.load(header, 0);
            if (state === 0) {
                if (Atomics.wait(header, 0, 0, remaining) === 'timed-out') throw new Error('Tool timed out.');
                continue;
            }
            if (Atomics.load(header, 1) !== sequence) throw new Error('Tool response belongs to another compile.');
            if (state === 5) throw new Error('Tool session cancelled.');
            const length = Atomics.load(header, 2);
            if (length < 0 || length > area.length) throw new Error('Invalid tool frame.');
            if (state === 1) {
                const response = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(area.slice(0, length)));
                if (!Number.isInteger(response.exitCode) || response.exitCode < 0 || response.exitCode > 255) throw new Error('Invalid tool exit code.');
                if (response.error) { log(response.log || response.error); return response.exitCode || 1; }
                if (response.exitCode !== 0) {
                    if (response.log) log(response.log);
                    return response.exitCode;
                }
                if (!output) throw new Error('Missing tool output manifest.');
                files.apply(output);
                if (response.log) log(response.log);
                return response.exitCode;
            }
            const number = Atomics.load(header, 3);
            if (number !== ++frame) throw new Error('Out-of-order tool frame.');
            const reply = { type: 'process-tool-frame', compileId, sequence, frame: number };
            try {
                if (state === 2) {
                    const request = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(area.slice(0, length)));
                    reply.bytes = files.read(request.path);
                } else if (state === 3) {
                    if (output) throw new Error('Duplicate tool output manifest.');
                    output = files.prepare(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(area.slice(0, length))));
                } else if (state === 4) {
                    if (!output || Atomics.load(header, 4) !== output.received || output.received + length > output.total) throw new Error('Out-of-order tool output bytes.');
                    let base = 0, position = 0;
                    for (const file of output.files) {
                        const start = Math.max(0, output.received - base);
                        if (start < file.bytes.length && position < length) {
                            const count = Math.min(file.bytes.length - start, length - position);
                            file.bytes.set(area.subarray(position, position + count), start); position += count;
                        }
                        base += file.bytes.length;
                    }
                    if (position !== length) throw new Error('Incomplete tool output chunk.');
                    output.received += length;
                } else throw new Error('Unknown tool frame.');
            } catch (error) { reply.error = error.message; }
            Atomics.store(header, 0, 0);
            postMessage(reply, reply.bytes ? [reply.bytes.buffer] : []);
        }
    } catch (error) {
        log('Tool failed: ' + error.message);
        Atomics.store(header, 0, 5); Atomics.notify(header, 0);
        postMessage({ type: 'process-tool-abort', compileId, sequence });
        return 125;
    }
}

function installToolSystemImport(imports, owner) {
    let installed = false;
    for (const namespace of Object.values(imports)) {
        if (!namespace || typeof namespace.system !== 'function') continue;
        namespace.system = pointer => {
            const module = owner();
            const callback = module?.siglumRunTool;
            if (!pointer) return typeof callback === 'function' ? 1 : 0;
            if (typeof callback !== 'function') return -1;
            const status = callback(module.UTF8ToString(pointer)) | 0;
            // system() returns a wait status, not a raw process exit code.
            return status < 0 ? status : (status & 255) << 8;
        };
        installed = true;
    }
    return installed;
}

async function initBusyTeX(wasmModule, jsUrl, memorySnapshot = null, kind = 'combined') {
    const startTime = performance.now();

    // Only load busytex.js once - it defines the global `busytex` function
    // Use fetch + Blob URL to support cross-origin CDN loading (importScripts has stricter CORS)
    if (kind === 'combined' && !busytexScriptLoaded) {
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
    let toolOwner = null, toolImportInstalled = false, observedNativeMemory = null;

    const moduleConfig = {
        thisProgram: kind === 'checkpoint' ? '/bin/pdflatex' : '/bin/busytex',
        noInitialRun: true,
        noExitRuntime: true,
        instantiateWasm: (imports, successCallback) => {
            toolImportInstalled = installToolSystemImport(imports, () => toolOwner);
            WebAssembly.instantiate(wasmModule, imports).then(instance => {
                observedNativeMemory = instance.exports.memory;
                if (!observeWasmMemory(observedNativeMemory)) wasmAllocationMeasurementsComplete = false;
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

    const Module = await (kind === 'checkpoint' ? checkpointFactory : busytex)(moduleConfig);
    toolOwner = Module;
    Module.siglumToolImport = toolImportInstalled;
    Module.__siglumKind = kind;
    Module.__siglumInstanceId = ++engineInstanceSequence;
    Module.__siglumObservedMemory = observedNativeMemory;
    observeModuleMemory(Module);
    if (kind === 'checkpoint') configureTexEnvironment(Module.ENV);
    Module.__siglumOutput = () => ({ stdout: outputCapture.stdout.join('\n'), stderr: outputCapture.stderr.join('\n') });
    Module.__siglumResetOutput = () => { outputCapture.stdout.length = 0; outputCapture.stderr.length = 0; };
    const FS = Module.FS;
    await mountNativeResources(Module, kind);
    try { FS.mkdir('/bin'); } catch (e) {}
    try { FS.writeFile('/bin/busytex', ''); } catch (e) {}
    if (kind === 'checkpoint') FS.writeFile(moduleConfig.thisProgram, '');

    Module.setPrefix = function(prefix) {
        Module.thisProgram = '/bin/' + prefix;
    };

    Module.callMainWithRedirects = function(args = [], print = false) {
        Module.do_print = print;
        // Reset output capture before each call
        outputCapture.stdout.length = 0;
        outputCapture.stderr.length = 0;
        if (args.length > 0) Module.setPrefix(args[0]);
        const exit_code = callTexMain(Module, args);
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
 */
async function getOrCreateModule() {
    if (globalModulePromise) {
        await globalModulePromise;
        globalModulePromise = null;
    }
    if (globalModule && (globalModuleUsed || globalModule.__siglumKind !== activeRuntimeKind)) {
        checkpointDriver?.drop();
        destroyModule(globalModule);
        globalModule = null;
    }
    if (!globalModule) {
        if (activeRuntimeKind === 'checkpoint') {
            await checkpointBoot;
            await ensureCheckpointRuntime();
            if (!checkpointDriver) activeRuntimeKind = 'combined';
        }
        const wasm = activeRuntimeKind === 'checkpoint'
            ? checkpointRuntimeConfig.wasmModule : await loadCombinedModule();
        globalModule = await initBusyTeX(wasm, busytexJsUrl, null, activeRuntimeKind);
    }
    globalModuleUsed = true;
    return globalModule;
}

/**
 * Reset the filesystem for a fresh compilation
 * Removes all files except core TeX directories
 */
function resetFS(FS) {
    // Remove /texlive entirely and recreate structure
    try {
        // Remove dynamically created directories
        const dirsToClean = ['/texlive', docBase + '.pdf', docBase + '.log', docBase + '.aux'];
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

// ============ Aux File Comparison ============

function sameAuxFiles(left, right) {
    const paths = Object.keys(left);
    if (paths.length !== Object.keys(right).length) return false;
    return paths.every(path =>
        Object.prototype.hasOwnProperty.call(right, path) && left[path] === right[path]
    );
}

function loadCmMetricFiles() {
    cmMetricLoad ??= fetchCmMetricFiles();
    return cmMetricLoad;
}

async function fetchCmMetricFiles() {
    const name = 'fonts-cm';
    const metrics = filesByBundle?.get(name)
        ?.filter(([path]) => path.endsWith('.tfm'))
        .sort((a, b) => a[1].start - b[1].start);
    if (!metrics?.length) return null;

    // The current bundle packs all CM metrics together. Keep discovery-based
    // loading if a future manifest scatters them or grows this span.
    const start = metrics[0][1].start;
    const end = metrics[metrics.length - 1][1].end;
    if (end - start > 256 * 1024 || metrics.some(([, file], i) =>
        file.end <= file.start || (i > 0 && file.start !== metrics[i - 1][1].end)
    )) return null;

    const result = await requestFileRangeFetch(name, start, end);
    if (!result.success || result.data?.byteLength !== end - start) {
        throw new Error('Incomplete CM metric range');
    }
    workerLog(`Loaded ${metrics.length} CM font metrics via one range`);
    return metrics.map(([path, file]) => [
        path, result.data.subarray(file.start - start, file.end - start),
    ]);
}

async function preloadCmMetrics(rangeFontBundles, deferredBundles, bundleDataMap, bundlesUrl) {
    const name = 'fonts-cm';
    if (!rangeFontBundles.has(name) || !deferredBundles.has(name) || bundleDataMap.has(name)) return null;

    try {
        return await loadCmMetricFiles();
    } catch (error) {
        cmMetricLoad = null;
        workerLog(`CM metric range fetch failed: ${error.message}`);
    }

    // A runtime or CDN without range support can still use an existing offline
    // bundle or the ordinary compressed full-bundle path.
    workerLog(`Loading full font bundle ${name}`);
    const bundle = await loadBundleInWorker(name, bundlesUrl || workerBundlesUrl);
    bundleDataMap.set(name, bundle);
    deferredBundles.delete(name);
    return null;
}

function loadCmSuperMetadata() {
    cmSuperMetadataLoad ??= fetchCmSuperMetadata();
    return cmSuperMetadataLoad;
}

async function fetchCmSuperMetadata() {
    const name = 'cm-super';
    const metadata = filesByBundle?.get(name)
        ?.filter(([path]) => /\.(?:enc|map|sty)$/.test(path))
        .sort((a, b) => a[1].start - b[1].start);
    if (!metadata?.some(([path]) => path.endsWith('.map')) ||
        !metadata.some(([path]) => path.endsWith('.enc')) ||
        !metadata.some(([path]) => path.endsWith('/type1ec.sty'))) {
        throw new Error('CM-Super font metadata is unavailable');
    }

    const groups = [];
    let bytes = 0;
    for (const entry of metadata) {
        const [, file] = entry;
        const prior = groups.at(-1);
        if (file.start < 0 || file.end <= file.start || (prior && file.start < prior.end)) {
            throw new Error('Invalid CM-Super metadata offsets');
        }
        bytes += file.end - file.start;
        if (prior?.end === file.start) {
            prior.files.push(entry);
            prior.end = file.end;
        } else {
            groups.push({ start: file.start, end: file.end, files: [entry] });
        }
    }
    if (bytes > 256 * 1024 || groups.length > 4) throw new Error('Unexpected CM-Super metadata layout');

    return (await Promise.all(groups.map(async ({ start, end, files }) => {
        const result = await requestFileRangeFetch(name, start, end);
        if (!result.success || result.data?.byteLength !== end - start) {
            throw new Error('Incomplete CM-Super metadata range');
        }
        return files.map(([path, file]) => [
            path, result.data.subarray(file.start - start, file.end - start),
        ]);
    }))).flat();
}

async function preloadCmSuperMetadata(rangeFontBundles, deferredBundles, bundleDataMap, bundlesUrl) {
    const name = 'cm-super';
    if (!rangeFontBundles.has(name) || !deferredBundles.has(name) || bundleDataMap.has(name)) return null;
    try {
        return await loadCmSuperMetadata();
    } catch (error) {
        cmSuperMetadataLoad = null;
        workerLog(`CM-Super metadata range fetch failed: ${error.message}`);
    }
    workerLog(`Loading full font bundle ${name}`);
    const data = await loadBundleInWorker(name, bundlesUrl || workerBundlesUrl);
    bundleDataMap.set(name, data);
    deferredBundles.delete(name);
    return null;
}

async function prefetchTikzOutlines(source, engine, rangeFontBundles, deferredBundles, bundleNames) {
    const bundle = 'fonts-cm';
    if (engine !== 'pdflatex' || !rangeFontBundles?.includes(bundle) ||
        !deferredBundles.includes(bundle) || bundleNames?.includes(bundle) ||
        workerBundleCache.has(bundle)) return [];

    const packageNames = new Set([...source.matchAll(/\\usepackage\s*(?:\[[^\]]*\]\s*)?\{([^}]+)\}/g)]
        .flatMap(([, names]) => names.split(',').map(name => name.trim())));
    const surfacePlot = packageNames.has('pgfplots') && /\\documentclass\s*\{standalone\}/.test(source)
        && /\\addplot3\s*\[[^\]]*\bsurf\b/.test(source) && /\bsamples\s*=\s*(?:[5-9]\d|\d{3,})\b/.test(source)
        && !['fontenc', 'lmodern', 'fontspec'].some(name => packageNames.has(name))
        && !/\\(?:setmainfont|fontencoding|fontfamily|font)\b/.test(source);
    if (!packageNames.has('tikz') && !surfacePlot) return [];

    // Default Beamer uses CM sans text and italic for its math labels.
    // Theme, size, and encoding changes still use normal discovery.
    const beamer = source.match(/\\documentclass\s*(?:\[([^\]]*)\]\s*)?\{beamer\}/);
    const size = beamer?.[1]?.split(',').map(option => option.trim()).find(option => /^\d+pt$/.test(option));
    const defaultBeamer = beamer && (!size || size === '11pt')
        && !/\\(?:usetheme|usefonttheme|setsansfont|setmainfont|fontencoding)\b|\{(?:fontenc|lmodern)\}/.test(source);
    const batchPlot = defaultBeamer && packageNames.has('pgfplots') && packageNames.has('preview')
        && packageNames.has('multido') && /\\multido\b/.test(source);
    const outlines = ['cmr10'];
    if (defaultBeamer) {
        outlines.push('cmss10');
        if (/[$]|\\[([]/.test(source)) outlines.push('cmssi10');
        if (batchPlot) outlines.push('cmmi10', 'cmsy10');
    } else if (surfacePlot) {
        // PDF output discovers the axis fonts after TeX has evaluated the surface.
        outlines.push('cmr7', 'cmmi10', 'cmsy10', 'cmsy7');
    }

    return (await Promise.all(outlines.map(async name => {
        const file = fileManifest['/texlive/texmf-dist/fonts/type1/public/amsfonts/cm/' + name + '.pfb'];
        if (file?.bundle !== bundle || file.end <= file.start || file.end - file.start > 64 * 1024 ||
            globalFetchedFilesCache.has(`${bundle}:${file.start}:${file.end}`)) return null;
        try {
            const result = await requestFileRangeFetch(bundle, file.start, file.end, batchPlot || surfacePlot ? 600 : 150);
            if (result.success && result.data?.byteLength === file.end - file.start) {
                return { bundle, start: file.start, end: file.end, data: result.data };
            }
        } catch {
            // A slow speculative request falls back to normal discovery.
        }
        return null;
    }))).filter(Boolean);
}

const MAX_FONT_PLAN_RANGES = 64;
const MAX_FONT_PLAN_BYTES = 512 * 1024;

async function loadCachedFontRanges(plan, rangeBundles, deferredBundles, bundleNames) {
    if (!Array.isArray(plan) || !plan.length) return [];
    const pending = [];
    let bytes = 0;
    const seen = new Set();
    for (const range of plan.slice(0, MAX_FONT_PLAN_RANGES)) {
        if (!Array.isArray(range)) continue;
        const [bundle, start, end] = range;
        if (!rangeBundles?.includes(bundle) || !deferredBundles.includes(bundle) ||
            bundleNames?.includes(bundle) || workerBundleCache.has(bundle)) continue;
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start) continue;
        const key = `${bundle}:${start}:${end}`;
        if (seen.has(key) || globalFetchedFilesCache.has(key) || bytes + end - start > MAX_FONT_PLAN_BYTES) continue;
        if (!filesByBundle?.get(bundle)?.some(([path, file]) =>
            /\.(?:pfb|tfm|enc|vf)$/i.test(path) && file.start === start && file.end === end)) continue;
        seen.add(key);
        bytes += end - start;
        pending.push(requestFileRangeFetch(bundle, start, end, 150, true).then(result => {
            if (result.success && result.data?.byteLength === end - start) return { bundle, start, end, data: result.data };
            return null;
        }).catch(() => null));
    }
    return (await Promise.all(pending)).filter(Boolean);
}

function mountDeferredFonts(vfs, deferredBundles, bundleDataMap, rangeFontBundles, cmMetrics, cmSuperMetadata) {
    for (const name of deferredBundles) {
        if (bundleDataMap.has(name)) continue;
        if (name === 'fonts-cm' && cmMetrics) {
            for (const [path, data] of cmMetrics) vfs.mount(path, data, false);
        }
        if (name === 'cm-super' && cmSuperMetadata) {
            for (const [path, data] of cmSuperMetadata) {
                if (vfs.mountedFiles.has(path)) continue;
                vfs.mount(path, data, true);
                if (path.endsWith('.enc')) {
                    vfs.fontFileLocations ??= new Map();
                    vfs.fontFileLocations.set(path.slice(path.lastIndexOf('/') + 1), path);
                }
            }
        }
        vfs.mountDeferredBundle(name, fileManifest, null, rangeFontBundles.has(name));
    }
}

function createFontRangeLoader(rangeFontBundles, bundleDataMap, deferredBundles, bundlesUrl, maxRetries) {
    const rangeProgress = new Map();

    // A prior attempt already needed the full bundle. Keep it mounted for
    // later edits and format generation without repeating range discovery.
    for (const bundleName of rangeFontBundles) {
        const fullBundle = workerBundleCache.get(bundleName);
        if (fullBundle) {
            bundleDataMap.set(bundleName, fullBundle);
            deferredBundles.delete(bundleName);
        }
    }

    return async function fetchPendingFonts(vfs, retryCount, completePlans = null) {
        if (rangeFontBundles.size === 0) return false;

        const pending = vfs.getPendingDeferredFiles(rangeFontBundles);
        if (pending.length === 0) return false;
        if (retryCount + 1 >= maxRetries) {
            throw new Error('TeX ran out of retries while loading fonts.');
        }

        for (const bundleName of rangeFontBundles) {
            const files = pending.filter(file => file.bundleName === bundleName);
            if (files.length === 0) continue;
            const previous = rangeProgress.get(bundleName) || { rounds: 0, bytes: 0 };
            const bytes = previous.bytes + files.reduce((total, file) => total + file.end - file.start, 0);
            const complete = completePlans?.get(bundleName);
            if (complete?.mode === 'ranges' || !complete && previous.rounds < 2 && bytes <= 512 * 1024 && retryCount + 2 < maxRetries) {
                rangeProgress.set(bundleName, { rounds: previous.rounds + 1, bytes });
                const fetched = await Promise.all(files.map(async file => {
                    try {
                        const result = await requestFileRangeFetch(bundleName, file.start, file.end);
                        if (result.success && result.data?.byteLength === file.end - file.start) {
                            vfs.storeFetchedFile(bundleName, file.start, file.end, result.data);
                            return true;
                        }
                    } catch (error) {
                        workerLog(`Font range fetch failed for ${bundleName}: ${error.message}`);
                    }
                    return false;
                }));
                if (fetched.every(Boolean)) {
                    workerLog(`Loaded ${files.length} font files from ${bundleName} via ranges`);
                    continue;
                }
            }

            // Reuse full bundles already stored offline, or fetch them if range
            // support is unavailable or another discovery pass is too expensive.
            workerLog(`Loading full font bundle ${bundleName}`);
            const data = await loadBundleInWorker(bundleName, bundlesUrl || workerBundlesUrl);
            bundleDataMap.set(bundleName, data);
            deferredBundles.delete(bundleName);
        }
        return true;
    };
}

const pinnedBeamerRunfile = '/texlive/texmf-dist/tex/latex/beamer/beamerbasemisc.sty';
const pinnedBeamerRunfileHash = '55c5ed95880e452caf786ad4882fb0b839ef902395dcc1b613bc2caa332cf838';
const starredGraphicsError = /^(?:!|[^\r\n]*:\d+:)[ \t]*LaTeX Error:[ \t]*(?:File|Fil\r?\ne) `\*' not found\.$/m;
const userBeamerFile = /(?:^|\/)beamer(?:\.cls|base(?:misc|overlay)\.sty)$/i;
const authoredStarredGraphics = /(?:^|[^\\])(?:\\\\)*\\includegraphics(?:<[\d<>,+@|.: -]+>)?\*/m;
const beamerGraphicsReplacement = String.raw`    \renewcommand<>\includegraphics{%
      \@ifstar{\beamer@readgraphics{#1}{*}}{\beamer@readgraphics{#1}{}}%
    }
    \def\beamer@readgraphics#1#2{%
      \@ifnextchar[%]
        {\beamer@includegraphics{#1}{#2}}
        {\beamer@@@includegraphics{#1}{#2}{}}%
    }
    \long\def\beamer@includegraphics#1#2[#3]{%
      \@ifnextchar[%]
        {\beamer@@includegraphics{#1}{#2}{#3}}
        {\beamer@@@includegraphics{#1}{#2}{#3}}%
    }
    \long\def\beamer@@includegraphics#1#2#3[#4]#5{%
      \only#1{\beameroriginal\includegraphics#2[{#3}][{#4}]{#5}}%
    }
    \long\def\beamer@@@includegraphics#1#2#3#4{%
      \only#1{\beameroriginal\includegraphics#2[{#3}]{#4}}%
    }`;

async function beamerStarRecoveryFiles(FS, source, projectFiles, log) {
    if (!projectFiles?.size || !globalThis.crypto?.subtle || !starredGraphicsError.test(log)
        || !/^Document Class: beamer 2026\/01\/22 v3\.77\b/m.test(log)
        || !log.includes('(' + pinnedBeamerRunfile + ')')) return null;
    const decoder = new TextDecoder();
    const hasStar = text => authoredStarredGraphics.test(text.replace(/(^|[^\\])((?:\\\\)*)%[^\r\n]*/g, '$1$2'));
    let starred = hasStar(source);
    for (const [path, content] of projectFiles) {
        if (userBeamerFile.test(path)) return null;
        if (!starred && /\.tex$/i.test(path)) starred = hasStar(decoder.decode(content));
    }
    if (!starred) return null;

    // Verify the actual bytes from the canonical mounted path. Keep them in
    // the original VFS and both snapshots, and return only a per-job overlay.
    try {
        const bytes = FS.readFile(pinnedBeamerRunfile).slice();
        const hash = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
        const digest = Array.from(hash, byte => byte.toString(16).padStart(2, '0')).join('');
        if (digest !== pinnedBeamerRunfileHash) return null;
        const text = decoder.decode(bytes);
        const start = text.indexOf(String.raw`    \renewcommand<>\includegraphics{%`);
        const end = text.indexOf('\n  \\fi\n', start);
        if (start < 0 || end < start) return null;
        const patched = new TextEncoder().encode(text.slice(0, start) + beamerGraphicsReplacement + text.slice(end));
        return { original: bytes, patched };
    } catch {
        return null;
    }
}

function mountVerifiedBeamerRecovery(FS, recovery, changedOwner) {
    if (changedOwner) throw new Error('Beamer package version changed during starred graphics recovery');
    const mounted = FS.readFile(pinnedBeamerRunfile);
    if (mounted.length !== recovery.original.length || mounted.some((byte, index) => byte !== recovery.original[index])) {
        throw new Error('Pinned Beamer runfile changed during starred graphics recovery');
    }
    // Normal mounting already registered this exact path. The replacement stays
    // in this rebuilt filesystem and never enters the package snapshots.
    FS.writeFile(pinnedBeamerRunfile, recovery.patched);
}

// ============ Compilation ============

function hasCompletePdf(data) {
    return data?.length >= 16 && new TextDecoder().decode(data.subarray(0, 5)) === '%PDF-'
        && /%%EOF[\r\n\t ]*$/.test(new TextDecoder().decode(data.subarray(Math.max(0, data.length - 128))));
}

function callNativeEntry(callback) {
    try { return callback(); }
    catch (error) {
        // Standalone pdfTeX uses Emscripten's ExitStatus exception for TeX
        // errors. Preserve the exit code so the ordinary resolver can inspect
        // the log and retry; runtime traps still propagate as real failures.
        if (error?.name === 'ExitStatus' && Number.isInteger(error.status)) return error.status;
        throw error;
    }
}

function callTexMain(module, args) {
    return callNativeEntry(() => module.callMain(args));
}

async function finishNativeFonts(module, vfs, status, fetchPendingFonts, bundleDataMap) {
    // callMain exits with status 0 at this cooperative handoff; resumed
    // execution can return status 3. The native state is authoritative.
    if (!module._siglum_finalize_paused?.()) return status;
    const count = module._siglum_finalize_request_count();
    const flags = module._siglum_finalize_request_overflow() || module._siglum_finalize_unsupported_count();
    if (!Number.isInteger(count) || count < 0 || count > 2048) throw new Error('Invalid native font-resource count');
    const demanded = [], bundleNames = new Set();
    const pins = checkpointDriver?.pinFonts(vfs);
    const synchronousInput = vfs.syncInput;
    // Post-layout font discovery already batches/coalesces asynchronous ranges.
    // Keep it batched; synchronous demand is only needed inside native execution.
    vfs.syncInput = null;
    try {
        if (!flags) for (let index = 0; index < count; index++) {
            const pointer = module._siglum_finalize_request_name(index);
            const name = module.UTF8ToString(pointer);
            const path = name.startsWith('/') ? name : vfs.fontFileLocations?.get(name) || name;
            try {
                const node = module.FS.lookupPath(path).node;
                const marker = node.contents;
                if (vfs.isDeferredMarker(marker)) {
                    const cached = vfs.resolveDeferred(marker);
                    pins?.hold(node, marker, cached);
                    if (!cached.byteLength) bundleNames.add(marker.bundleName);
                }
                demanded.push(node);
            } catch { /* The normal missing-file diagnostic remains authoritative. */ }
        }
        let completePlans = null;
        if (!flags && bundleNames.size && checkpointDriver?.planFontRanges) {
            const metadata = new Map();
            for (const name of bundleNames) {
                const entries = filesByBundle?.get(name) || [];
                let rawBytes = 0;
                for (const [, file] of entries) rawBytes = Math.max(rawBytes, file.end);
                metadata.set(name, { rawBytes });
            }
            const decision = checkpointDriver.planFontRanges((vfs.pendingDeferredFiles || [])
                .filter(file => bundleNames.has(file.bundleName)), metadata);
            if (decision.valid) {
                // Check exact cached bytes before considering a whole bundle.
                // This keeps fresh offline consumers independent of heuristics.
                const large = new Set(decision.plans.filter(plan => plan.mode === 'bundle').map(plan => plan.bundleName));
                if (large.size) {
                    const hits = new Set();
                    const probes = (vfs.pendingDeferredFiles || []).filter(file => large.has(file.bundleName)).map(async file => {
                        try {
                            const hit = await requestFileRangeFetch(file.bundleName, file.start, file.end, 30000, true);
                            if (hit.success && hit.data?.byteLength === file.end - file.start) {
                                vfs.storeFetchedFile(file.bundleName, file.start, file.end, hit.data);
                                hits.add(file.bundleName + ':' + file.start + ':' + file.end);
                            }
                        } catch { /* Cache miss: the ordinary fetch path remains available. */ }
                    });
                    await Promise.all(probes);
                    vfs.pendingDeferredFiles = (vfs.pendingDeferredFiles || []).filter(file =>
                        !hits.has(file.bundleName + ':' + file.start + ':' + file.end));
                }
                const remaining = checkpointDriver.planFontRanges((vfs.pendingDeferredFiles || [])
                    .filter(file => bundleNames.has(file.bundleName)), metadata);
                if (remaining.valid) completePlans = new Map(remaining.plans.map(plan => [plan.bundleName, plan]));
            }
        }
        await fetchPendingFonts(vfs, 0, completePlans);
        for (const [name, data] of bundleDataMap) vfs.bundleCache.set(name, data);
        for (const node of demanded) {
            const value = node.contents;
            if (vfs.isDeferredMarker(value)) {
                const data = vfs.resolveDeferred(value);
                if (data.byteLength) { node.contents = data; node.usedBytes = data.byteLength; }
            } else if (vfs.isLazyMarker(value)) {
                const data = vfs.resolveLazy(value);
                node.contents = data; node.usedBytes = data.byteLength;
            }
        }
        workerLog(`[FONT] Resolved ${count} native font resources before finishing the same TeX pass`);
        const result = callNativeEntry(() => module._siglum_finalize_resume());
        module._flush_streams?.();
        return result;
    } finally { vfs.syncInput = synchronousInput; pins?.release(); }

}

async function handleCompile(request) {
    const processCleanups = new Set();
    try { return await compileWithProcessTools(request, processCleanups); }
    finally { for (const cleanup of processCleanups) cleanup(); }
}

async function compileWithProcessTools(request, processCleanups) {
    const requestStarted = performance.now();
    const { id, source, engine, options, bundleData, bundleNames, bundlesUrl, ctanFiles, cachedFormat, cachedAuxFiles: previousAuxFiles, deferredBundleNames, rangeFontBundles: selectedFontBundles, mainFile, chapterPreview } = request;
    let cachedAuxFiles = previousAuxFiles;
    let completedResumePasses = 0;
    let resumeConvergenceMs = 0;

    const nextCtanSnapshot = request.ctanFilesDelta ? resolveCtanFiles(request.ctanFilesDelta, id) : null;
    if (request.ctanFilesDelta && !nextCtanSnapshot) {
        self.postMessage({
            type: 'compile-response', id, success: false, ctanFilesNeedReset: true,
            error: 'CTAN file snapshot is out of sync.',
        });
        return;
    }

    let projectFiles = null;
    let projectFileRevision;
    if (request.projectFiles) {
        projectFiles = resolveProjectFiles(request.projectFiles, id);
        if (!projectFiles) {
            self.postMessage({
                type: 'compile-response', id, success: false, projectFilesNeedReset: true,
                error: 'Project file snapshot is out of sync.',
            });
            return;
        }
        projectFileRevision = projectFileSnapshot?.revision;
    } else {
        projectFileSnapshot = null;
    }
    ctanFileSnapshot = nextCtanSnapshot?.revision ? nextCtanSnapshot : null;
    // Both transport forms describe the same resolved asset set. Large caches
    // deliberately use the legacy transfer when they exceed the delta budget.
    // Resolve once before checkpoint guards and normal VFS setup diverge.
    const resolvedCtanFiles = new Map(nextCtanSnapshot?.files || []);
    if (ctanFiles) {
        const entries = ctanFiles instanceof Map ? ctanFiles : Object.entries(ctanFiles);
        for (const [path, content] of entries) resolvedCtanFiles.set(path, content);
    }


    // The compiler validates project paths. Keep the directory so TeX can resolve ../ inputs.
    const sourcePath = '/' + (mainFile || 'document.tex').replace(/^\/+/, '');
    // TeX removes the last extension from the job filename, including .dtx.
    docBase = sourcePath.replace(/\/([^/]+)\.[^/.]*$/, '/$1');
    const workingDirectory = sourcePath.slice(0, sourcePath.lastIndexOf('/')) || '/';

    // Allow runtime verbose toggle via compile options
    if (options?.verbose !== undefined) {
        verboseLogging = options.verbose;
    }

    if (checkpointBoot) await checkpointBoot;
    if (engine === 'pdflatex' && checkpointDriver) await ensureCheckpointRuntime();
    const projectKey = request.checkpointProject || mainFile || 'document.tex';
    activeRuntimeKind = checkpointDriver && engine === 'pdflatex' && !chapterPreview && !toolProjects.has(projectKey)
        ? 'checkpoint' : 'combined';
    workerLog('=== Compilation Started ===');

    // Fallback to bundleDeps.deferred if not passed in message (for older compilers)
    const effectiveDeferredBundles = deferredBundleNames || bundleDeps?.deferred || [];
    workerLog(`deferredBundleNames: ${JSON.stringify(effectiveDeferredBundles)}`);

    if (!fileManifest) throw new Error('fileManifest not set');

    let toolCalls=0;
    const toolFailures = [];
    const writtenToolFiles = new Set();
    const generatedToolFiles=new Map();
    const sameGenerated=(a,b)=>a.size===b.size&&[...a].every(([path,bytes])=>{const other=b.get(path);return other&&bytes.length===other.length&&bytes.every((v,i)=>v===other[i]);});
    function mountGeneratedTools(FS){for(const[path,data]of generatedToolFiles){FS.mkdirTree(path.slice(0,path.lastIndexOf('/'))||'/');FS.writeFile(path,data);}}

    let checkpointContext = null;
    const checkpointEnabled = checkpointDriver && !chapterPreview && !toolProjects.has(projectKey)
        && (checkpointRuntimeConfig.engines || ['pdflatex']).includes(engine);
    const nativePhases = { texMs: 0, conversionMs: 0 };
    const convertXdv = module => {
        const start = performance.now();
        const result = module.callMainWithRedirects(['xdvipdfmx', '-o', docBase + '.pdf', docBase + '.xdv']);
        nativePhases.conversionMs += performance.now() - start;
        return result;
    };
    const runXePass = (module, fmtPath) => {
        const start = performance.now();
        let result = module.callMainWithRedirects([
            'xelatex', ...texProcessArguments(module, request.toolCommands), '--interaction=nonstopmode',
            '--file-line-error', '--halt-on-error', '--synctex=-1', '--no-pdf',
            '--fmt=' + fmtPath, sourcePath,
        ]);
        nativePhases.texMs += performance.now() - start;
        if (checkpointContext && module._siglum_checkpoint_engine?.() === 2) {
            const continuedAt = performance.now();
            const status = callNativeEntry(() => checkpointDriver.afterPass(module, result.exit_code));
            nativePhases.texMs += performance.now() - continuedAt;
            result = { exit_code: status, ...module.__siglumOutput() };
        }
        if (result.exit_code === 0 && !module._siglum_checkpoint_paused?.()) result = convertXdv(module);
        return result;
    };
    if (checkpointEnabled) {
        const files = Object.fromEntries([...(projectFiles || [])].map(([path, value]) =>
            [path.replace(/^\/+/, ''), value]));
        const main = sourcePath.replace(/^\/+/, '');
        files[main] = prepareCompileSource(source, engine, cachedFormat);
        const suppliedFocus = request.checkpointFocus;
        const focusSource = suppliedFocus?.path === main ? source : files[suppliedFocus?.path];
        const focusText = typeof focusSource === 'string' ? focusSource : new TextDecoder().decode(focusSource || new Uint8Array());
        // Preparation preserves lines while changing prefix byte/column lengths.
        const focus = suppliedFocus?.offsetUTF16 !== undefined
            ? { path: suppliedFocus.path, line: focusText.slice(0, suppliedFocus.offsetUTF16).split('\n').length }
            : suppliedFocus || { path: main, line: String(files[main]).split('\n').length };
        checkpointContext = { key: projectKey, engine, main, files, focus, forceFull: request.forceFull,
            assets: new Map([...resolvedCtanFiles].filter(([path]) => !projectFiles?.has(path))), aux: cachedAuxFiles || {},
            pdfPath: docBase + '.pdf',
            signature: JSON.stringify([checkpointRuntimeConfig.identity, engine === 'xelatex' ? normalWasmUrl : null, engine, request.toolIdentity || [], bundleNames, effectiveDeferredBundles, selectedFontBundles, cachedFormat?.fmtName || null]),
            collectAux: collectAuxFiles,
            beforeResume: (module, vfs) => {
                // Only already-resolved resources belong to this checkpoint.
                // New demand goes through this job's normal resolver/full build,
                // rather than a receiver closing over the preceding request.
                module.siglumResolveInput = null;
                vfs.syncInput = null;
                module.setPrefix(engine);
            },
            finishOutput: engine === 'xelatex' ? module => convertXdv(module).exit_code : null,
            needsRerun: (FS, aux) => {
                // Match the ordinary convergence policy. Changed auxiliary bytes
                // alone do not imply that the document needs another TeX pass.
                if (/\\bib(?:data|style)\{/.test(Object.values(aux).join('\n'))) return true;
                try { return /Rerun to get|Label\(s\) may have changed|There were undefined references|Rerun LaTeX/i
                    .test(FS.readFile(docBase + '.log', { encoding: 'utf8' })); }
                catch { return true; }
            },
            finishFonts: async (module, vfs, status) => {
                // A resumed prefix already owns its fully mounted immutable files.
                // New demand is handed back to the normal full-build resolver.
                if (module._siglum_finalize_paused?.()) {
                    for (let i = 0; i < module._siglum_finalize_request_count(); i++) {
                        const name = module.UTF8ToString(module._siglum_finalize_request_name(i));
                        const path = name.startsWith('/') ? name : vfs.fontFileLocations?.get(name) || name;
                        try {
                            const node = module.FS.lookupPath(path).node;
                            if (vfs.isDeferredMarker(node.contents) && !vfs.resolveDeferred(node.contents).byteLength) return 1;
                        } catch { return 1; }
                    }
                    return module._siglum_finalize_resume();
                }
                return status;
            },
        };
        checkpointDriver.begin(checkpointContext);
        if(checkpointDriver.module)connectToolRunner(checkpointDriver.module);
        const resumed = await checkpointDriver.tryResume();
        if(checkpointContext.captureDisabled)checkpointDriver.drop('External tool dependencies require a full build');
        if (resumed?.needsConvergence) {
            // The resumed TeX pass is valid work. Its changed labels belong to
            // the normal convergence pipeline, rather than restarting with stale
            // auxiliary input and repeating an already completed pass.
            cachedAuxFiles = resumed.aux;
            checkpointContext.aux = resumed.aux;
            completedResumePasses = 1;
            resumeConvergenceMs = resumed.metadata.totalMs;
        } else if (resumed) {
          try {
            const start = performance.now(), module = resumed.module;
            const pdf = module.FS.readFile(docBase + '.pdf');
            if (!hasCompletePdf(pdf)) throw new Error('Native PDF finalization is incomplete');
            if (nativeAssetStore) await nativeAssetStore.flush();
            const mapping = module.FS.readFile(docBase + '.synctex', { encoding: 'utf8' });
            const log = module.FS.readFile(docBase + '.log', { encoding: 'utf8' });
            const heap = module.HEAPU8.byteLength;
            self.postMessage({ type: 'compile-response', id, success: true, projectFileRevision,
                ctanFileRevision: ctanFileSnapshot?.revision, pdfData: pdf.buffer, syncTexData: mapping,
                exitCode: 0, auxFilesToCache: resumed.aux, fontRanges: resumed.fontRanges, log,
                stats: { compileTimeMs: performance.now() - requestStarted,
                    checkpoint: resumed.metadata, nativePhases: { texMs: resumed.metadata.texMs, conversionMs: resumed.metadata.conversionMs },
                    nativeResources: module.__siglumNativeResourceStats?.(), outputCopies: 1, wasmHeapBytes: heap,
                    memory: { wasmHeapBytes: heap, instanceId: module.__siglumInstanceId, reused: true, ...nativeFontMemoryStats(module), ...wasmAllocationStats(module) } },
            }, [pdf.buffer]);
            return;
          } catch (error) {
            checkpointDriver.drop('Resumed output is unavailable: ' + error.message);
            workerLog('Using a full build after incomplete resumed output');
          }
        }
    }

    // Track accumulated resources across retries
    const bundleDataMap = new Map();
    const bundleMetaMap = new Map(); // Store bundle metadata for dynamically loaded bundles
    // Package retries and project overrides only mutate this compile's copy.
    const accumulatedCtanFiles = resolvedCtanFiles;
    const cachedFonts = loadCachedFontRanges(request.cachedFontRanges, selectedFontBundles, effectiveDeferredBundles, bundleNames);
    function connectToolRunner(module) {
        if (!module.siglumToolImport || !request.toolMailbox || !request.toolCommands?.length) return;
        module.__siglumDisconnectProcessTool?.();
        const access = createToolFileAccess(module, workingDirectory, sourcePath, projectFiles, writtenToolFiles, generatedToolFiles);
        const callback = command => {
            try {
                if (++toolCalls > 256) throw new Error('External tool call limit exceeded.');
                const [program, ...args] = parseToolCommand(command);
                if (!request.toolCommands.includes(program)) return 127;
                if (checkpointContext) checkpointContext.captureDisabled = true;
                module._siglum_checkpoint_disarm?.();
                const status = receiveToolProcess({ buffer: request.toolMailbox, compileId: id, command: program, args,
                    files: access, postMessage: (message, transfer) => self.postMessage(message, transfer), log: workerLog });
                if (status !== 0) toolFailures.push({ command: program, status });
                return status;
            } catch (error) { workerLog('Tool failed: ' + error.message); toolFailures.push({ command: 'process', status: 126 }); return 126; }
        };
        module.siglumRunTool = callback;
        const cleanup = () => {
            if (module.siglumRunTool === callback) module.siglumRunTool = null;
            if (module.__siglumDisconnectProcessTool === cleanup) module.__siglumDisconnectProcessTool = null;
            access.disconnect();
            processCleanups.delete(cleanup);
        };
        module.__siglumDisconnectProcessTool = cleanup;
        processCleanups.add(cleanup);
    }


    const tikzOutlineLoad = request.cachedFontRanges?.length ? [] : prefetchTikzOutlines(
        source, engine, selectedFontBundles, effectiveDeferredBundles, bundleNames);

    // Load bundles from OPFS/network if names provided (worker-direct loading)
    // This avoids main thread memory usage for bundle data
    // Done BEFORE totalStart — bundle I/O is setup, not compilation.
    if (bundleNames && bundleNames.length > 0) {
        workerLog(`Loading ${bundleNames.length} bundles (worker-direct)...`);
        const effectiveUrl = bundlesUrl || workerBundlesUrl;

        await Promise.all(bundleNames.map(async (name) => {
            try {
                const data = await loadBundleInWorker(name, effectiveUrl);
                if (data) bundleDataMap.set(name, data);
            } catch (e) {
                workerLog(`Failed to load ${name}: ${e.message}`);
            }
        }));
        workerLog(`Loaded ${bundleDataMap.size}/${bundleNames.length} bundles`);
    }
    // Backward compat - bundles sent directly in message (legacy path)
    else if (bundleData) {
        const data = bundleData instanceof Map ? bundleData : new Map(Object.entries(bundleData || {}));
        for (const [name, d] of data) bundleDataMap.set(name, d);
    }

    const totalStart = performance.now();

    // Bundles to load on-demand (e.g., font bundles like cm-super)
    const deferredBundles = new Set(effectiveDeferredBundles);
    const rangeFontBundles = new Set(selectedFontBundles || []);
    const observedFonts = new Map();
    let observedFontBytes = 0;
    const onDeferredRead = ({ bundleName, start, end }) => {
        if (!rangeFontBundles.has(bundleName) || observedFonts.size >= MAX_FONT_PLAN_RANGES) return;
        const key = `${bundleName}:${start}:${end}`;
        if (observedFonts.has(key) || observedFontBytes + end - start > MAX_FONT_PLAN_BYTES) return;
        observedFonts.set(key, [bundleName, start, end]);
        observedFontBytes += end - start;
    };

    // Project inputs take precedence over CTAN entries with the same path.
    if (projectFiles) {
        for (const [path, data] of projectFiles) accumulatedCtanFiles.set(path, data);
    }

    // The compatibility retry replaces only the selected TeX packages for this job.
    // Keep the historical files out of shared CTAN snapshots and fetch caches.
    const legacyTkzFiles = request.legacyTkzFiles && new Map(Object.entries(request.legacyTkzFiles)
        .filter(([path]) => !projectFiles?.has(path)));
    const tkzPackagePath = /^\/texlive\/texmf-dist\/tex\/latex\/tkz-(?:euclide|base)\//;
    if (legacyTkzFiles) workerLog('Retrying with tkz-euclide 1.16c and tkz-base 1.16d (TeX Live 2018)');
    let beamerRecovery = null;
    let attemptedBeamerRecovery = false;
    const mountCompileFiles = vfs => {
        if (legacyTkzFiles) {
            for (const path of accumulatedCtanFiles.keys()) {
                if (tkzPackagePath.test(path) && !projectFiles?.has(path)) accumulatedCtanFiles.delete(path);
            }
        }
        if (accumulatedCtanFiles.size) vfs.mountCtanFiles(accumulatedCtanFiles, { forceOverride: packageTLVersions.size > 0 });
        if (legacyTkzFiles) vfs.mountCtanFiles(legacyTkzFiles, { forceOverride: true });
        if (beamerRecovery) mountVerifiedBeamerRecovery(vfs.FS, beamerRecovery, packageTLVersions.has('beamer'));
    };

    let pdfData = null;
    let syncTexData = null;  // SyncTeX data for source/PDF synchronization
    let finalAuxFiles = null;
    let compileSuccess = false;
    let outputReadMs = 0;
    let retryCount = 0;
    const maxRetries = options.maxRetries ?? 15;  // Configurable, default 15
    const fetchedPackages = new Set();
    // Use global cache for Range-fetched files (persists across compiles)
    let lastExitCode = -1;
    let texLog = '';
    let compileError = '';
    let Module = null;
    let FS = null;

    // Auto-rerun tracking for cross-references/TOC
    // Predict passes needed based on source analysis
    const predictedPasses = predictRequiredPasses(source);
    let rerunPass = 0;
    let maxRerunPasses = Math.max(0, predictedPasses - 1 - completedResumePasses);  // 1 initial + N reruns

    if (predictedPasses === 1) {
        workerLog('Single-pass mode: no cross-references detected');
    }

    // The file index depends on mounted paths and the font map also depends
    // on the contents of the map files. Ordinary TeX source and font contents
    // do not affect either output. Preserve mount order for path collisions.
    const computeFinalizeSig = vfs => {
        if (legacyTkzFiles || beamerRecovery || packageTLVersions.size || bundleMetaMap.size || bundleData) return null;
        for (const path of accumulatedCtanFiles.keys()) {
            if (!vfs.mountedFiles.has(path)) return null;
        }
        const resources = [...accumulatedCtanFiles].map(([path, content]) => [
            path,
            path.endsWith('.map')
                ? (typeof content === 'string' ? ['text', content] : ['bytes', mapByteDecoder.decode(content)])
                : null,
        ]);
        return JSON.stringify([[...bundleDataMap.keys()], [...deferredBundles], [...rangeFontBundles], resources]);
    };

    // Version fallback tracking for packages with kernel incompatibility
    // Map<packageName, tlYear> - which TL year to use for each package
    const packageTLVersions = new Map();

    const fetchPendingFonts = createFontRangeLoader(
        rangeFontBundles, bundleDataMap, deferredBundles, bundlesUrl, maxRetries
    );
    const [cmMetrics, cmSuperMetadata, reusedFonts, tikzOutlines] = await Promise.all([
        preloadCmMetrics(rangeFontBundles, deferredBundles, bundleDataMap, bundlesUrl),
        preloadCmSuperMetadata(rangeFontBundles, deferredBundles, bundleDataMap, bundlesUrl),
        cachedFonts,
        tikzOutlineLoad,
    ]);
    if (reusedFonts.length) workerLog(`Reused ${reusedFonts.length} cached font ranges before TeX`);
    if (tikzOutlines.length) workerLog(`Loaded ${tikzOutlines.length} TikZ outline ranges before TeX`);

    const connectSyncInput = (module, vfs) => {
        if (!syncInputBuffer || !createSyncInputReceiver || module._siglum_io_api_version?.() !== 1
            || !module._siglum_io_register_file || packageTLVersions.size || legacyTkzFiles) return;
        const byName = new Map(), ranges = new Map();
        const index = (path, entry) => {
            const name = path.slice(path.lastIndexOf('/') + 1);
            if (!byName.has(name)) byName.set(name, []);
            byName.get(name).push([path, entry]);
            if (entry) ranges.set(entry.bundle + ':' + entry.start + ':' + entry.end, { path, bundleName: entry.bundle, start: entry.start, end: entry.end });
        };
        for (const [path, entry] of Object.entries(fileManifest)) index(path, entry);
        for (const path of vfs.mountedFiles) if (!fileManifest[path]) index(path, null);
        const stem = path => path.slice(path.lastIndexOf('/') + 1).replace(/\.[^.]+$/, '');
        const projectStems = new Set([stem(sourcePath), ...[...(projectFiles?.keys() || [])]
            .filter(path => /\.(?:tex|ltx|dtx)$/i.test(path)).map(stem)]);
        let registerPointer = 0, registerCapacity = 0;
        const register = path => {
            if (registerPointer && module.lengthBytesUTF8(path) < registerCapacity) {
                module.stringToUTF8(path, registerPointer, registerCapacity);
                module._siglum_io_register_file(registerPointer);
            }
        };
        const receiver = createSyncInputReceiver({ buffer: syncInputBuffer,
            postMessage: message => self.postMessage(message), log: workerLog,
            known: name => shouldResolveRuntimeInput(name, byName, projectStems, syncInputNames),
            lookup: name => {
                let found;
                for (const [path] of byName.get(name) || []) {
                    try {
                        const node = module.FS.lookupPath(path).node;
                        if (vfs.isDeferredMarker(node.contents) || vfs.isLazyMarker(node.contents)) continue;
                        register(path); found ||= { path };
                    } catch {}
                }
                return found;
            },
            describeRange: (name, marker) => marker
                ? ranges.get(marker.bundleName + ':' + marker.start + ':' + marker.end)
                : (byName.get(name) || []).map(([path, e]) => e && ({ path, bundleName: e.bundle, start: e.start, end: e.end })).find(Boolean),
            install: (path, data) => {
                if (vfs.mountedFiles.has(path)) {
                    if (!vfs.materializeKnownFile(path, data)) return;
                } else checkpointDriver.installResolvedAsset(module.FS, path, data);
                vfs.mountedFiles.add(path); vfs._trackFontFile(path);
                // Immutable release ranges already belong to the manifest.
                // Treating them as CTAN overrides would invalidate an otherwise
                // reusable checkpoint on the next job's CTAN snapshot.
                if (!fileManifest[path]) accumulatedCtanFiles.set(path, data);
                if (!fileManifest[path]) index(path, null);
                register(path);
                // Registration is append-only and never reads a map recursively
                // inside Kpathsea. pdfTeX consumes queued maps at its next normal
                // font-map lookup, after the entire package has been installed.
                if (path.endsWith('.map') && module._siglum_io_queue_map && registerPointer
                    && module.lengthBytesUTF8(path) < registerCapacity) {
                    module.stringToUTF8(path, registerPointer, registerCapacity);
                    if (module._siglum_io_queue_map(registerPointer) > 0) vfs.pendingFontMaps.delete(path);
                }
                if (checkpointContext && !fileManifest[path]) checkpointContext.assets.set(path, data);
            },
        });
        module.siglumResolveInput = (name, format, mustExist, pointer, capacity) => {
            registerPointer = pointer; registerCapacity = capacity;
            try { return receiver.resolve(name, module, pointer, capacity); }
            finally { registerPointer = 0; registerCapacity = 0; }
        };
        vfs.syncInput = receiver;
    };

    compileAttempts: while (!compileSuccess && retryCount < maxRetries) {
        if (retryCount > 0) {
            workerLog(`Retry #${retryCount}...`);
        }

        try {
            // [PERF] Phase-2 cost attribution markers (worker-side, same clock as totalStart)
            const _pModuleStart = performance.now();
            // Get or create global WASM instance (reused to avoid memory leaks)
            Module = await getOrCreateModule();
            FS = Module.FS;
            const _pModuleEnd = performance.now();

            // Reset filesystem for clean compilation
            resetFS(FS);
            const _pResetEnd = performance.now();

            // Create VFS with unified mount handling
            let vfs = new VirtualFileSystem(FS, {
                onLog: workerLog,
                lazyEnabled: options.enableLazyFS,
                fetchedFilesCache: globalFetchedFilesCache,  // Persist across compiles
                onDeferredRead,
            });

            if (retryCount === 0) {
                for (const file of reusedFonts) vfs.storeFetchedFile(file.bundle, file.start, file.end, file.data);
                for (const file of tikzOutlines) vfs.storeFetchedFile(file.bundle, file.start, file.end, file.data);
            }

            // Register this VFS for lazy loading (updates the holder each compile)
            if (options.enableLazyFS) {
                vfs.patchForLazyLoading();
            }

            // Mount all bundles (regular and deferred)
            workerProgress('mount', 'Mounting files...');
            for (const [bundleName, data] of bundleDataMap) {
                const meta = bundleMetaMap.get(bundleName) || null;
                vfs.mountBundle(bundleName, data, fileManifest, meta);
            }

            // Mount deferred bundles (file markers without data - loaded on demand)
            mountDeferredFonts(vfs, deferredBundles, bundleDataMap, rangeFontBundles, cmMetrics, cmSuperMetadata);

            // Mount CTAN files
            // Use forceOverride when we have version fallback packages to override bundle files
            mountCompileFiles(vfs);

            FS.mkdirTree(workingDirectory);
            FS.chdir(workingDirectory);

            // Compare against the same aux snapshot that was actually restored.
            const initialAuxFiles = beamerRecovery ? null : cachedAuxFiles;
            if (initialAuxFiles && Object.keys(initialAuxFiles).length > 0) {
                const restored = restoreAuxFiles(FS, initialAuxFiles);
                if (restored > 0) workerLog(`Restored ${restored} aux files`);
            }

            const _pMountEnd = performance.now();

            // Finalize VFS - processes font maps, generates ls-R (cached when safe)
            finalizeVfsCached(vfs, computeFinalizeSig(vfs));
            const _pFinalizeEnd = performance.now();

            // Every TeX/BibTeX pass gets fresh C globals but the same project cwd,
            // mounted input files, and auxiliary files from the preceding pass.
            let mountedAuxFiles = initialAuxFiles || {};
            const resetForPass = async (auxFiles, tools = false) => {
                mountedAuxFiles = auxFiles || {};
                if (tools) {
                    toolProjects.add(projectKey);
                    activeRuntimeKind = 'combined';
                    checkpointDriver?.drop('An external TeX tool is required');
                }
                Module = await getOrCreateModule();
                FS = Module.FS;
                resetFS(FS);
                vfs = new VirtualFileSystem(FS, {
                    onLog: workerLog, lazyEnabled: options.enableLazyFS,
                    fetchedFilesCache: globalFetchedFilesCache, onDeferredRead
                });
                if (options.enableLazyFS) vfs.patchForLazyLoading();
                for (const [name, data] of bundleDataMap) {
                    vfs.mountBundle(name, data, fileManifest, bundleMetaMap.get(name) || null);
                }
                mountDeferredFonts(vfs, deferredBundles, bundleDataMap, rangeFontBundles, cmMetrics, cmSuperMetadata);
                mountCompileFiles(vfs);
                FS.mkdirTree(workingDirectory);
                FS.chdir(workingDirectory);
                restoreAuxFiles(FS, auxFiles);
                finalizeVfsCached(vfs, computeFinalizeSig(vfs));
            };


            // Prepare document source
            const docSource = prepareCompileSource(source, engine, cachedFormat);
            let fmtPath = engine === 'pdflatex'
                ? '/texlive/texmf-dist/texmf-var/web2c/pdftex/pdflatex.fmt'
                : '/texlive/texmf-dist/texmf-var/web2c/xetex/xelatex.fmt';

            if (cachedFormat && engine === 'pdflatex' && cachedFormat.fmtData) {
                // Verify buffer isn't detached before using
                if (cachedFormat.fmtData.buffer && cachedFormat.fmtData.buffer.byteLength > 0) {
                    FS.writeFile('/custom.fmt', cachedFormat.fmtData);
                    fmtPath = '/custom.fmt';
                    workerLog('Using custom format');
                    // Restore files the preamble wrote during format precompilation
                    // (e.g. insdljs' .djs). Reusing the format skips the preamble,
                    // so without this the body's \input of them would fail.
                    const nRestored = restoreSideEffectFiles(FS, cachedFormat.sideEffectFiles);
                    if (nRestored > 0) workerLog(`Restored ${nRestored} preamble side-effect file(s) for cached format`);

                } else {
                    workerLog('Custom format buffer is detached, using default format');
                }
            }

            mountGeneratedTools(FS);
            FS.writeFile(sourcePath, docSource);

            // Run compilation
            workerProgress('compile', `Running ${engine}...`);
            let passToolState=new Map(generatedToolFiles);
            const _pCallStart = performance.now();
            let result;

            connectSyncInput(Module, vfs);
                        connectToolRunner(Module);
            if (engine === 'pdflatex' && Module.__siglumKind === 'checkpoint') {
                const removedRows = checkpointDriver.prepareDefaultMap(Module);
                if (removedRows) workerLog(`[FONT] Private default map omitted ${removedRows} byte-identical rows; original maps retained`);
                Module._siglum_finalize_enable(1);
            }
            if (checkpointContext) {
                checkpointContext.assets = new Map([...accumulatedCtanFiles].filter(([path]) => !projectFiles?.has(path)));
                try { await checkpointDriver.preparePass(Module, vfs, mountedAuxFiles, !legacyTkzFiles && !beamerRecovery && !checkpointContext.captureDisabled); }
                catch (error) { checkpointDriver.drop(error.message); workerLog('Snapshot unavailable; full build continues: ' + error.message); }
            }
            if (engine === 'pdflatex') {
                result = Module.callMainWithRedirects([
                    'pdflatex', ...texProcessArguments(Module, request.toolCommands), '--interaction=nonstopmode',
                    '--file-line-error', '--halt-on-error', '--synctex=-1', '--fmt=' + fmtPath, sourcePath
                ]);
            } else {
                result = runXePass(Module, fmtPath);
            }

            if (Module.__siglumKind === 'checkpoint' && engine === 'pdflatex') {
                let status = callNativeEntry(() => checkpointDriver.afterPass(Module, result.exit_code));
                status = await finishNativeFonts(Module, vfs, status, fetchPendingFonts, bundleDataMap);
                result = { exit_code: status, ...Module.__siglumOutput() };
            }
            if(checkpointContext?.captureDisabled)checkpointDriver?.drop(checkpointContext.disabledReason || 'External tool dependencies require a full build');
            let toolOutputsChanged=!sameGenerated(passToolState,generatedToolFiles);
            let toolReruns=0;
            const _pCallEnd = performance.now();
            if (verboseLogging) {
                workerLog(`[PERF] module=${(_pModuleEnd - _pModuleStart).toFixed(0)}ms reset=${(_pResetEnd - _pModuleEnd).toFixed(0)}ms mount=${(_pMountEnd - _pResetEnd).toFixed(0)}ms finalize=${(_pFinalizeEnd - _pMountEnd).toFixed(0)}ms callMain=${(_pCallEnd - _pCallStart).toFixed(0)}ms`);
            }

            lastExitCode = result.exit_code;
            // A missing optional font can still produce a PDF with substituted
            // glyphs. Never accept a pass that read an unresolved placeholder.
            if (await fetchPendingFonts(vfs, retryCount)) {
                retryCount++;
                continue;
            }
            // Emscripten redirects can omit TeX diagnostics from stdout; the .log is authoritative.
            try { texLog = FS.readFile(docBase + '.log', { encoding: 'utf8' }); }
            catch { texLog = [result.stdout, result.stderr].filter(Boolean).join('\n'); }
            if (toolFailures.length) throw new Error(toolFailureMessage(toolFailures));
            if (result.exit_code !== 0) {
                const fileDiagnostic = texLog.match(/^(.+?):(\d+):\s*(.+)$/m);
                const diagnostic = texLog.match(/^!\s*(.+)$/m)?.[1];
                const line = texLog.match(/^l\.(\d+)\s*(.*)$/m);
                compileError = fileDiagnostic
                    ? `${fileDiagnostic[1]}:${fileDiagnostic[2]}: ${fileDiagnostic[3]}`
                    : diagnostic ? `${sourcePath}${line ? ':' + line[1] : ''}: ${diagnostic}${line?.[2] ? ' ' + line[2] : ''}`
                    : `TeX compilation failed for ${sourcePath} (exit code ${result.exit_code})`;
            }

            // Restrict this trial to project builds, which already bypass the
            // compiler's PDF/format caches. Retain the first diagnostic in the trace.
            if (result.exit_code !== 0 && !attemptedBeamerRecovery && !cachedFormat && !chapterPreview && !legacyTkzFiles
                && workingDirectory !== '/' && projectFiles?.size && !packageTLVersions.has('beamer')
                && retryCount + 1 < maxRetries && starredGraphicsError.test(texLog)) {
                attemptedBeamerRecovery = true;
                beamerRecovery = await beamerStarRecoveryFiles(FS, source, projectFiles, texLog);
                if (beamerRecovery) {
                    workerLog(`Pinned Beamer 3.77 starred graphics recovery after: ${compileError}`);
                    retryCount++;
                    continue;
                }
            }

            if (result.exit_code === 0) {
                try {
                    // Confirm output exists before considering this pass for a rerun.
                    FS.stat(docBase + '.pdf');

                    // A successful first TeX pass can still contain unresolved citations.
                    // BibTeX must run before two further TeX passes can resolve them.
                    let bibliographyPasses = 0;
                    let bibliographyWarnings = '';
                    if (!chapterPreview) {
                        try {
                            if (FS.stat(docBase + '.bcf') && !projectFiles?.has(docBase + '.bbl')
                                && !accumulatedCtanFiles.has(docBase + '.bbl')) {
                                if (!request.auxiliaryTools?.includes('biber')) {
                                    throw new Error('This document requires Biber. Configure an isolated Biber tool runner, or supply its generated .bbl file.');
                                }
                                workerProgress('compile', 'Building bibliography…');
                                const biber = await requestAuxiliaryTool(id, 'biber', FS.readFile(docBase + '.bcf'), checkpointContext);
                                const output = new TextDecoder('utf-8', { fatal: true }).decode(biber.bytes);
                                if (!output.startsWith('% $ biblatex auxiliary file $') || !/\\endinput\s*$/.test(output)) {
                                    throw new Error('Biber returned an incomplete bibliography.');
                                }
                                bibliographyWarnings = biber.log || '';
                                FS.writeFile(docBase + '.bbl', biber.bytes);
                                workerLog('Biber completed in an isolated tool worker.');
                                bibliographyPasses = 2;
                                maxRerunPasses = Math.max(maxRerunPasses, rerunPass + 2);
                            }
                        } catch (error) { if (!error.errno) throw error; }
                    }
                    let currentAuxFiles = collectAuxFiles(FS);
                    const docIndexStyle = chapterPreview ? null
                        : await loadDocIndexStyle(FS, accumulatedCtanFiles, texLog, source, cachedFormat);
                    const readIndexJobs = aux => chapterPreview
                        ? new Map()
                        : readMakeIndexJobs(FS, accumulatedCtanFiles, aux['.aux'] || '', docIndexStyle);
                    let indexJobs = readIndexJobs(currentAuxFiles);
                    const bibliographyAux = chapterPreview ? '' : Object.values(currentAuxFiles).join('\n');
                    if (/\\bibdata\{/.test(bibliographyAux) && /\\bibstyle\{/.test(bibliographyAux)) {
                        const styleBundles = new Set(['bibtex']);
                        for (const match of bibliographyAux.matchAll(/\\bibstyle\{([^}]+)\}/g)) {
                            const style = Object.entries(fileManifest).find(([path]) => path.endsWith('/' + match[1] + '.bst'))?.[1];
                            if (style?.bundle) styleBundles.add(style.bundle);
                        }
                        for (const name of styleBundles) if (!bundleDataMap.has(name)) {
                            const bundle = await requestBundleFetch(name);
                            if (!bundle.success) throw new Error('Could not load the BibTeX styles bundle.');
                            bundleDataMap.set(name, bundle.bundleData);
                            if (bundle.bundleMeta) bundleMetaMap.set(name, bundle.bundleMeta);
                        }
                        await resetForPass(currentAuxFiles, true);
                        currentAuxFiles = null;
                        workerProgress('compile', 'Building bibliography…');
                        workerLog('Running BibTeX…');
                        const bblPath = docBase + '.bbl';
                        const blgPath = docBase + '.blg';
                        // A restored output must not satisfy the check for a new bibliography.
                        if (FS.analyzePath(bblPath).exists) FS.unlink(bblPath);
                        if (FS.analyzePath(blgPath).exists) FS.unlink(blgPath);
                        const bib = Module.callMainWithRedirects(['bibtex8', '--8bit', docBase.slice(docBase.lastIndexOf('/') + 1)]);
                        let bibLog = [bib.stdout, bib.stderr].filter(Boolean).join('\n');
                        try { bibLog = FS.readFile(blgPath, { encoding: 'utf8' }); } catch {}
                        // BibTeX8 reserves exit status 1 for warnings and 2–3 for errors.
                        const warningExit = bib.exit_code === 1
                            && /^\(There (?:was 1 warning|were \d+ warnings)\)\r?$/m.test(bibLog);
                        if (bib.exit_code !== 0 && !warningExit) {
                            lastExitCode = bib.exit_code;
                            texLog += '\n' + bibLog;
                            throw new Error('BibTeX failed: ' + (bibLog.match(/^(?:I couldn.t|I found no|.*---line).*$/m)?.[0] || 'check the bibliography file and full log.'));
                        }
                        if (!FS.analyzePath(bblPath).exists || !FS.readFile(bblPath, { encoding: 'utf8' }).trim()) {
                            lastExitCode = bib.exit_code;
                            texLog += '\n' + bibLog;
                            throw new Error('BibTeX did not produce a bibliography (.bbl).');
                        }
                        if (warningExit) bibliographyWarnings = bibLog;
                        workerLog('BibTeX completed.');
                        bibliographyPasses = 2;
                        maxRerunPasses = Math.max(maxRerunPasses, rerunPass + 2);
                    }

                    // Auto-rerun loop for cross-references/TOC
                    // LaTeX needs multiple passes to resolve forward references
                    // Regex for rerun detection (single pass through log, case-insensitive)
                    const rerunPattern = /Rerun to get|Label\(s\) may have changed|There were undefined references|Rerun LaTeX/i;

                    let prevAuxFiles = initialAuxFiles || {};
                    let processedIndexJobs = new Map();
                    const indexOutputs = new Map();
                    const indexLogs = new Map();
                    let indexPasses = 0;

                    while (true) {
                        // A later TeX pass can move index entries to different pages.
                        // Rebuild on changed input, keeping the generated bytes local to this build.
                        const changedIndexPaths = [...new Set([...indexJobs.keys(), ...processedIndexJobs.keys()])]
                            .filter(path => !sameMakeIndexJob(indexJobs.get(path), processedIndexJobs.get(path)));
                        const indexChanged = changedIndexPaths.length > 0;
                        if (indexChanged) {
                            if (++indexPasses > 3) throw new Error('MakeIndex page numbers did not converge.');
                            for (const outputPath of changedIndexPaths) {
                                const job = indexJobs.get(outputPath);
                                if (!job) {
                                    indexOutputs.delete(outputPath);
                                    indexLogs.delete(outputPath);
                                    continue;
                                }
                                currentAuxFiles ??= collectAuxFiles(FS);
                                await resetForPass(currentAuxFiles, true);
                                currentAuxFiles = null;
                                FS.writeFile(job.inputPath, job.input);
                                if (job.style) {
                                    if (job.style.path.startsWith('/')) {
                                        FS.mkdirTree(job.style.path.slice(0, job.style.path.lastIndexOf('/')));
                                    }
                                    FS.writeFile(job.style.path, job.style.data);
                                }
                                workerProgress('compile', outputPath.endsWith('.ind') ? 'Building index…' : 'Building glossary…');
                                // BusyTeX prepends its executable to the caller's argv in place.
                                const index = Module.callMainWithRedirects([...job.args]);
                                let indexLog = [index.stdout, index.stderr].filter(Boolean).join('\n');
                                try { indexLog = FS.readFile(job.logPath, { encoding: 'utf8' }); } catch {}
                                if (index.exit_code !== 0 || /\b[1-9]\d* rejected\b/.test(indexLog)
                                    || !FS.analyzePath(outputPath).exists || !FS.stat(outputPath).size) {
                                    lastExitCode = index.exit_code;
                                    texLog += '\n' + indexLog;
                                    throw new Error(`MakeIndex failed to generate ${outputPath}. Check the full compiler log.`);
                                }
                                indexOutputs.set(outputPath, FS.readFile(outputPath));
                                indexLogs.set(outputPath, indexLog);
                            }
                            processedIndexJobs = indexJobs;
                            maxRerunPasses = Math.max(maxRerunPasses, rerunPass + 1);
                        }
                        if(toolOutputsChanged){
                            if(++toolReruns>3)throw new Error('Generated tool outputs did not converge.');
                            maxRerunPasses=Math.max(maxRerunPasses,rerunPass+1);
                        }
                        if (rerunPass >= maxRerunPasses) break;

                        // Check if log suggests rerun is needed
                        let logSaysRerun = false;
                        try {
                            const logContent = FS.readFile(docBase + '.log', { encoding: 'utf8' });
                            logSaysRerun = rerunPattern.test(logContent);
                        } catch (e) {}

                        if (!logSaysRerun && bibliographyPasses === 0 && !indexChanged && !toolOutputsChanged) break;

                        // Reuse a pass's snapshot for bibliography, convergence and cache output.
                        currentAuxFiles ??= collectAuxFiles(FS);
                        if (bibliographyPasses === 0 && !indexChanged && !toolOutputsChanged && sameAuxFiles(currentAuxFiles, prevAuxFiles)) {
                            workerLog('Aux files unchanged, skipping unnecessary rerun');
                            break;
                        }

                        prevAuxFiles = currentAuxFiles;

                        rerunPass++;
                        workerLog(`Auto-rerun pass ${rerunPass}/${maxRerunPasses}: resolving cross-references...`);
                        workerProgress('compile', `Rerun ${rerunPass}/${maxRerunPasses}...`);

                        // IMPORTANT: pdfTeX has internal C globals (glyph_unicode_tree, etc.) that
                        // don't reset between invocations, causing assertion failures. We MUST
                        // create a fresh WASM module for each rerun pass.

                        // Use aux files we already collected for comparison
                        const rerunAuxFiles = prevAuxFiles;

                        await resetForPass(rerunAuxFiles);
                        currentAuxFiles = null;
                        if (bibliographyPasses > 0) bibliographyPasses--;
                        for (const [path, data] of indexOutputs) FS.writeFile(path, data);

                        // Rewrite document source
                        mountGeneratedTools(FS);
            FS.writeFile(sourcePath, docSource);

                        // Mount custom format if used
                        if (fmtPath === '/custom.fmt' && cachedFormat?.fmtData?.buffer?.byteLength > 0) {
                            FS.writeFile('/custom.fmt', cachedFormat.fmtData);
                            // Re-restore preamble side-effect files in case the rerun
                            // rebuilt the VFS (the cached format skips the preamble that
                            // would otherwise regenerate them).
                            restoreSideEffectFiles(FS, cachedFormat.sideEffectFiles);
                        }

                        // Run compilation (use same format path as initial compilation)
                        passToolState=new Map(generatedToolFiles);
                        let rerunResult;
                        connectSyncInput(Module, vfs);
                        connectToolRunner(Module);
                        if (engine === 'pdflatex' && Module.__siglumKind === 'checkpoint') {
                            const removedRows = checkpointDriver.prepareDefaultMap(Module);
                            if (removedRows) workerLog(`[FONT] Private default map omitted ${removedRows} byte-identical rows; original maps retained`);
                            Module._siglum_finalize_enable(1);
                        }
                        if (checkpointContext) {
                            try { await checkpointDriver.preparePass(Module, vfs, mountedAuxFiles, !legacyTkzFiles && !beamerRecovery && !checkpointContext.captureDisabled); }
                            catch (error) { checkpointDriver.drop(error.message); workerLog('Snapshot unavailable; full build continues: ' + error.message); }
                        }
                        if (engine === 'pdflatex') {
                            rerunResult = Module.callMainWithRedirects([
                                'pdflatex', ...texProcessArguments(Module, request.toolCommands), '--interaction=nonstopmode',
                                '--file-line-error', '--halt-on-error', '--synctex=-1', '--fmt=' + fmtPath, sourcePath
                            ]);
                        } else {
                            rerunResult = runXePass(Module, fmtPath);
                            toolOutputsChanged = !sameGenerated(passToolState, generatedToolFiles);
                            if (checkpointContext?.captureDisabled) checkpointDriver?.drop(checkpointContext.disabledReason || 'External tool dependencies require a full build');
                        }

                        if (Module.__siglumKind === 'checkpoint' && engine === 'pdflatex') {
                            let status = callNativeEntry(() => checkpointDriver.afterPass(Module, rerunResult.exit_code));
                            status = await finishNativeFonts(Module, vfs, status, fetchPendingFonts, bundleDataMap);
                            rerunResult = { exit_code: status, ...Module.__siglumOutput() };
                        }
                        if (toolFailures.length) throw new Error(toolFailureMessage(toolFailures));
                        if (await fetchPendingFonts(vfs, retryCount)) {
                            compileSuccess = false;
                            pdfData = null;
                            syncTexData = null;
                            rerunPass = 0;
                            maxRerunPasses = predictedPasses - 1;
                            retryCount++;
                            continue compileAttempts;
                        }

                        toolOutputsChanged=!sameGenerated(passToolState,generatedToolFiles);
                        if(checkpointContext?.captureDisabled)checkpointDriver?.drop(checkpointContext.disabledReason || 'External tool dependencies require a full build');
                        if (rerunResult.exit_code === 0) {
                            FS.stat(docBase + '.pdf');
                            if (!chapterPreview) {
                                currentAuxFiles = collectAuxFiles(FS);
                                indexJobs = readIndexJobs(currentAuxFiles);
                            }
                            // Reflect the final pass in the returned log: the first-pass
                            // transcript still contains the (now-resolved) "undefined
                            // references" warning, which would otherwise surface as a
                            // spurious warning in the UI and mask convergence.
                            try { texLog = FS.readFile(docBase + '.log', { encoding: 'utf8' }); }
                            catch { texLog = rerunResult.stdout || texLog; }
                            lastExitCode = rerunResult.exit_code;
                            workerLog(`Rerun ${rerunPass} successful`);
                        } else {
                            lastExitCode = rerunResult.exit_code;
                            try { texLog = FS.readFile(docBase + '.log', { encoding: 'utf8' }); } catch {}
                            throw new Error(`TeX rerun ${rerunPass} failed; check the full compiler log.`);
                        }
                    }
                    if (bibliographyWarnings) texLog += '\n' + bibliographyWarnings;
                    for (const indexLog of indexLogs.values()) if (indexLog) texLog += '\n' + indexLog;

                    // Only the converged pass is returned. Intermediate PDFs and
                    // SyncTeX files stay in the pass's filesystem.
                    const outputStart = performance.now();
                    pdfData = FS.readFile(docBase + '.pdf');
                    if (!hasCompletePdf(pdfData)) throw new Error('PDF finalization did not complete');
                    try {
                        const syncTexBytes = FS.readFile(docBase + '.synctex');
                        syncTexData = new TextDecoder().decode(syncTexBytes);
                        workerLog(`SyncTeX data: ${(syncTexBytes.byteLength / 1024).toFixed(1)}KB`);
                    } catch {
                        syncTexData = null;
                        workerLog('No SyncTeX file generated');
                    }
                    outputReadMs = performance.now() - outputStart;
                    compileSuccess = true;
                    workerLog('Compilation successful!');

                    if (!chapterPreview) finalAuxFiles = currentAuxFiles ?? collectAuxFiles(FS);

                    // Log summary if reruns occurred
                    if (rerunPass > 0) {
                        workerLog(`Completed ${rerunPass + 1 + completedResumePasses} passes (${completedResumePasses} resumed + 1 initial + ${rerunPass} reruns)`);
                    }
                } catch (e) {
                    compileSuccess = false;
                    pdfData = null;
                    compileError = e.message;
                    texLog += '\n! ' + e.message;
                    workerLog('Compilation failed: ' + e.message);
                }
            }

            if (toolFailures.length) break;

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
                    try { logContent = new TextDecoder().decode(FS.readFile(docBase + '.log')); } catch (e) {}
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

                            // Prefer the authoritative manifest lookup: a missing
                            // .sty/.cls/.def/etc. is routed to the bundle that
                            // actually ships it (e.g. pdftex.def → "graphics").
                            // getPackageFromFile() only strips the extension, which
                            // mis-attributes files whose basename ≠ their package
                            // (pdftex.def is in package graphics-def, not "pdftex").
                            const bundleName = getMissingFileBundle(missingFile, pkgName);

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
                                    if (!projectFiles?.has(path)) accumulatedCtanFiles.set(path, content);
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
                                if (legacyTkzFiles && /^tkz-(?:euclide|base)$/.test(pkgName)) continue;
                                // Get current TL year for this package (default to 2026)
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
                                    workerLog(`[VERSION FALLBACK] ${pkgName}: exhausted all TL versions (2026→2025→2024→2023), preserving the TeX error`);
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

                    // Undefined user commands are source errors. Never invent no-op macros
                    // or retry unchanged source merely to suppress the diagnostic.

                }
            }

            // No more retries possible
            if (!compileSuccess) break;

        } catch (e) {
            if ((e.checkpointCaptureFailed || String(e?.message).startsWith('Checkpoint asset is read-only:')) && checkpointContext && retryCount + 1 < maxRetries) {
                checkpointContext.captureDisabled = true;
                checkpointContext.disabledReason = e.message;
                checkpointDriver.drop(e.message);
                workerLog('Retrying in a fresh module without a checkpoint: ' + e.message);
                retryCount++;
                continue;
            }
            if (Module?.__siglumKind === 'checkpoint'
                && (e?.name === 'RuntimeError' || e?.name === 'RangeError' && /memory|allocation/i.test(e.message)
                    || String(e?.message).startsWith('Checkpoint asset is read-only:'))
                && retryCount + 1 < maxRetries) {
                checkpointDriver.drop('Native runtime could not complete this document');
                toolProjects.add(projectKey);
                activeRuntimeKind = 'combined';
                workerLog('Retrying with the combined runtime after a native runtime failure: ' + e.message);
                retryCount++;
                continue;
            }
            compileError = e.message;
            workerLog(`Error: ${e.message}`);
            break;
        }
    }

    if (toolFailures.length) {
        compileSuccess = false; pdfData = null; syncTexData = null;
        compileError = toolFailureMessage(toolFailures);
        texLog += '\n! ' + compileError;
        checkpointDriver?.drop('External process failed');
    }

    const auxFiles = compileSuccess && !beamerRecovery ? finalAuxFiles : null;
    if (compileSuccess) {
        // The caller can close the page as soon as it receives the PDF.
        await Promise.all([...bundleDataMap.keys()].map(name => pendingBundleWrites.get(name)));
    }
    if (nativeAssetStore) await nativeAssetStore.flush();
    const pipelineTime = performance.now() - totalStart;
    const totalTime = performance.now() - requestStarted;
    workerLog(`Total time: ${totalTime.toFixed(0)}ms`);

    // Combined-runtime heaps remain fresh between passes. The opt-in native
    // runtime retains at most one guarded checkpoint taken at its safe point.

    // Sample logical linear-memory bytes before releasing local references.
    // Process RSS and retained checkpoint storage are separate measurements.
    let wasmMemoryBytes = 0;
    try {
        // Emscripten exposes WASM memory as Module.HEAPU8 (Uint8Array view)
        // Also try Module.wasmMemory for alternative Emscripten configs
        const buf = Module?.HEAPU8?.buffer || Module?.wasmMemory?.buffer;
        if (buf) wasmMemoryBytes = buf.byteLength;
    } catch (e) { /* defensive */ }

    const nativeResourceStats = Module?.__siglumNativeResourceStats?.();
    const fontAllocationStats = nativeFontMemoryStats(Module);
    const allocationStats = wasmAllocationStats(Module);
    const instanceId = Module?.__siglumInstanceId;
    const checkpointStats = checkpointContext
        ? checkpointDriver.confirm(Module, auxFiles || {}, [...observedFonts.values()], compileSuccess) : null;
    // Module cleanup happens in getOrCreateModule() before next compile
    // Just clear local references here
    Module = null;
    FS = null;

    // Build response message
    const stats = {
        compileTimeMs: totalTime,
        toolCalls, generatedToolFiles:generatedToolFiles.size,
        pipelineTimeMs: pipelineTime,
        completedResumePasses,
        resumeConvergenceMs,
        checkpoint: checkpointStats,
        nativePhases,
        outputReadMs,
        outputCopies: compileSuccess ? 1 : 0,
        reusedFontRanges: reusedFonts.length,
        ...(nativeResourceStats ? { nativeResources: nativeResourceStats } : {}),
        bundlesUsed: [...bundleDataMap.keys()],
        wasmHeapBytes: wasmMemoryBytes,
        // Nested form expected by the perf gate / memory invariant (#5).
        memory: { wasmHeapBytes: wasmMemoryBytes, instanceId, ...fontAllocationStats, ...allocationStats },
    };

    // Transfer PDF ownership without retaining a shared output buffer.
    self.postMessage({
        type: 'compile-response',
        id,
        success: compileSuccess,
        projectFileRevision: compileSuccess ? projectFileRevision : undefined,
        ctanFileRevision: ctanFileSnapshot?.revision,
        error: compileSuccess ? undefined : (compileError || `No PDF produced for ${sourcePath}`),
        pdfData: pdfData ? pdfData.buffer : null,
        syncTexData,
        exitCode: lastExitCode,
        auxFilesToCache: auxFiles,
        fontRanges: compileSuccess ? [...observedFonts.values()] : undefined,
        stats,
        log: texLog,
    }, pdfData ? [pdfData.buffer] : []);
}

// ============ Format Generation ============

async function handleFormatGenerate(request) {
    // Runtime selection belongs inside the serialized operation, never in the
    // message handler while another compilation can still be awaiting I/O.
    if (checkpointBoot) await checkpointBoot;
    if (request.engine === 'pdflatex' && checkpointDriver) await ensureCheckpointRuntime();
    activeRuntimeKind = request.engine === 'pdflatex' && checkpointDriver ? 'checkpoint' : 'combined';
    checkpointDriver?.drop('Generating a preamble format');
    const { id, preambleContent, engine, manifest, packageMapData, bundleDepsData, bundleRegistryData, bundleData, bundleNames, bundlesUrl, ctanFiles, rangeFontBundles: selectedFontBundles, maxRetries: maxRetriesOption } = request;

    const formatMain = request.mainFile || 'document.tex';
    if (typeof formatMain !== 'string' || /[\\/\0\r\n]/.test(formatMain) || formatMain === '.' || formatMain === '..') {
        self.postMessage({ type: 'format-generate-response', id, success: false, error: 'Format generation requires a top-level document name' });
        return;
    }
    const formatJob = formatMain.replace(/\.[^/.]*$/, '');
    const formatOutput = '/' + formatJob;

    workerLog('=== Format Generation Started ===');
    const startTime = performance.now();

    fileManifest = manifest;
    packageMap = packageMapData;
    bundleDeps = bundleDepsData;
    bundleRegistry = new Set(bundleRegistryData);

    const bundleDataMap = new Map();
    const bundleMetaMap = new Map(); // Store bundle metadata for dynamically loaded bundles

    // NEW: Load bundles from OPFS/network if names provided (worker-direct loading)
    if (bundleNames && bundleNames.length > 0) {
        workerLog(`Loading ${bundleNames.length} bundles (worker-direct)...`);
        const effectiveUrl = bundlesUrl || workerBundlesUrl;

        await Promise.all(bundleNames.map(async (name) => {
            try {
                const data = await loadBundleInWorker(name, effectiveUrl);
                if (data) bundleDataMap.set(name, data);
            } catch (e) {
                workerLog(`Failed to load ${name}: ${e.message}`);
            }
        }));
        workerLog(`Loaded ${bundleDataMap.size}/${bundleNames.length} bundles`);
    }
    // OLD: Backward compat - bundles sent directly in message (legacy path)
    else if (bundleData) {
        const data = bundleData instanceof Map ? bundleData : new Map(Object.entries(bundleData));
        for (const [name, d] of data) bundleDataMap.set(name, d);
    }

    const accumulatedCtanFiles = new Map();

    if (ctanFiles) {
        const ctanFilesMap = ctanFiles instanceof Map ? ctanFiles : new Map(Object.entries(ctanFiles));
        for (const [path, content] of ctanFilesMap) accumulatedCtanFiles.set(path, content);
    }

    let retryCount = 0;
    const maxRetries = maxRetriesOption ?? 15;  // Configurable, default 15
    const fetchedPackages = new Set();
    const rangeFontBundles = new Set(selectedFontBundles || []);
    const deferredBundles = new Set(rangeFontBundles);
    const fetchPendingFonts = createFontRangeLoader(
        rangeFontBundles, bundleDataMap, deferredBundles, bundlesUrl, maxRetries
    );
    const [cmMetrics, cmSuperMetadata] = await Promise.all([
        preloadCmMetrics(rangeFontBundles, deferredBundles, bundleDataMap, bundlesUrl),
        preloadCmSuperMetadata(rangeFontBundles, deferredBundles, bundleDataMap, bundlesUrl),
    ]);

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

            if (deferredBundles.size > 0) {
                vfs.patchForLazyLoading();
                mountDeferredFonts(vfs, deferredBundles, bundleDataMap, rangeFontBundles, cmMetrics, cmSuperMetadata);
            }

            if (accumulatedCtanFiles.size > 0) {
                vfs.mountCtanFiles(accumulatedCtanFiles);
            }

            vfs.finalize();

            // Apply kernel compat shim for format generation too
            const shimmedPreamble = injectKernelCompatShim(engine === 'pdflatex' ? injectMicrotypeWorkaround(preambleContent) : preambleContent);
            FS.writeFile('/myformat.ini', shimmedPreamble + '\n\\dump\n');

            // Snapshot the working tree so we can detect files the preamble writes
            // as a side effect during the dump (e.g. insdljs' .djs via \openout).
            // These must travel with the cached format and be restored on reuse,
            // since reusing the format skips the preamble that produced them.
            // Recursive (not just root) so writes into subdirectories are caught;
            // the mounted texmf tree and system dirs are pruned (see snapshot fn).
            const filesBefore = snapshotWorkTree(FS);

            // Use the correct engine for format generation
            let formatArgs;
            if (engine === 'xelatex') {
                formatArgs = [
                    'xelatex', '-ini', '-jobname=' + formatJob, '-interaction=nonstopmode',
                    '&/texlive/texmf-dist/texmf-var/web2c/xetex/xelatex', '/myformat.ini'
                ];
            } else {
                // Default to pdflatex
                formatArgs = [
                    'pdflatex', '-ini', '-jobname=' + formatJob, '-interaction=nonstopmode',
                    '&/texlive/texmf-dist/texmf-var/web2c/pdftex/pdflatex', '/myformat.ini'
                ];
            }
            workerLog(`Generating format with engine: ${engine}`);
            let result;
            let engineError;
            try {
                result = Module.callMainWithRedirects(formatArgs);
            } catch (error) {
                engineError = error;
            }

            // A preamble can dump a format even after a missing font read.
            // Discard the entire attempt before emitting any cached outputs.
            try {
                if (await fetchPendingFonts(vfs, retryCount)) {
                    retryCount++;
                    continue;
                }
            } catch (error) {
                self.postMessage({ type: 'format-generate-response', id, success: false, error: error.message });
                return;
            }
            if (engineError) throw engineError;

            if (result.exit_code === 0) {
                const formatData = FS.readFile(formatOutput + '.fmt');
                workerLog(`Format generated: ${(formatData.byteLength / 1024 / 1024).toFixed(1)}MB in ${(performance.now() - startTime).toFixed(0)}ms`);

                // Collect any files the preamble created anywhere in the working
                // tree, excluding only the format job's own format/log outputs. Keyed
                // by absolute path so subdirectory writes round-trip faithfully.
                const sideEffectFiles = {};
                const transfer = [formatData.buffer];
                for (const path of snapshotWorkTree(FS)) {
                    if (filesBefore.has(path)) continue;
                    if (path === formatOutput + '.fmt' || path === formatOutput + '.log') continue;
                    try {
                        const data = FS.readFile(path); // Uint8Array
                        const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
                        sideEffectFiles[path] = buf;
                        transfer.push(buf);
                    } catch (e) { /* skip unreadable */ }
                }
                if (Object.keys(sideEffectFiles).length > 0) {
                    workerLog(`Captured ${Object.keys(sideEffectFiles).length} preamble side-effect file(s): ${Object.keys(sideEffectFiles).join(', ')}`);
                }

                if (nativeAssetStore) await nativeAssetStore.flush();
                self.postMessage({
                    type: 'format-generate-response', id, success: true, formatData: formatData.buffer, sideEffectFiles
                }, transfer);
                return;
            }

            // Check for missing packages - extract ALL and fetch in parallel
            let logContent = '';
            try { logContent = new TextDecoder().decode(FS.readFile(formatOutput + '.log')); } catch (e) {}
            const allOutput = logContent + ' ' + (result.stdout || '') + ' ' + (result.stderr || '');
            const missingFiles = extractAllMissingFiles(allOutput, fetchedPackages);

            if (missingFiles.length > 0) {
                workerLog(`[FORMAT] Missing ${missingFiles.length} packages: ${missingFiles.join(', ')}`);

                // Categorize packages: bundles vs CTAN
                const bundlesToFetch = [];
                const ctanToFetch = [];

                for (const missingFile of missingFiles) {
                    const pkgName = getPackageFromFile(missingFile);
                    const bundleName = getMissingFileBundle(missingFile, pkgName);

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

async function loadWorkerInputCatalog(url) {
    let cache;
    try { cache = await caches.open('siglum-ctan-index-v1'); } catch {}
    const parse = async response => {
        if (!response?.ok) return null;
        const index = await response.json();
        if (!index || typeof index !== 'object' || Array.isArray(index)) return null;
        const names = new Set();
        for (const name in index) if (Object.hasOwn(index, name) && typeof index[name] === 'string') names.add(name);
        return names;
    };
    const saved = async () => {
        try { return await parse(await cache?.match(url)); } catch { return null; }
    };
    const immutable = /\/releases\/tl2026-[a-f0-9]{16}\//.test(url);
    if (immutable) {
        const names = await saved();
        if (names) return names;
    }
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 8000);
    try {
        const response = await fetch(url, { signal: controller.signal });
        const copy = response.clone();
        const names = await parse(response);
        if (!names) throw new Error('Invalid runtime input catalog');
        try { await cache?.put(url, copy); } catch {}
        return names;
    } catch (error) {
        const names = await saved();
        if (names) return names;
        workerLog('Runtime input catalog unavailable; normal resolver retained: ' + error.message);
        return new Set();
    } finally { clearTimeout(timer); }
}

// ============ Message Handler ============

self.onmessage = async function(e) {
    const msg = e.data;

    switch (msg.type) {
        case 'init':
            wasmAllocationWorkerId = Number.isSafeInteger(msg.workerId) && msg.workerId > 0 ? msg.workerId : null;
            ctanFileSnapshot = null;
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
            nativeAssetStore = null; nativeAssetBoot = null;
            nativeAssetConfig = { descriptors: bundleDeps?.nativeResources || [], url: msg.nativeAssetsUrl, base: msg.bundlesUrl };
            cachedWasmModule = msg.wasmModule;
            normalWasmUrl = msg.wasmUrl;
            syncInputBuffer = msg.syncInputBuffer || null;
            syncInputNames = new Set(msg.syncInputNames || []);
            const catalogBoot = syncInputBuffer && msg.syncInputCatalogUrl && !syncInputNames.size
                ? loadWorkerInputCatalog(msg.syncInputCatalogUrl) : null;
            checkpointRuntimeConfig = msg.checkpointRuntime || null;
            checkpointNativeBoot = null;
            checkpointBoot = checkpointRuntimeConfig ? loadCheckpointApi().catch(error => {
                checkpointDriver = null; activeRuntimeKind = 'combined';
                workerLog('Native checkpoint unavailable; using normal runtime: ' + error.message);
            }) : null;
            const initialEngine = msg.initialEngine === 'xelatex' ? 'xelatex' : 'pdflatex';
            activeRuntimeKind = checkpointRuntimeConfig && initialEngine === 'pdflatex' ? 'checkpoint' : 'combined';

            // Store bundlesUrl for worker-direct network fetches
            workerBundlesUrl = msg.bundlesUrl || null;

            // Detect OPFS capability (async, but don't block ready message)
            workerOPFSReady = detectWorkerOPFS().then(available => {
                canUseWorkerOPFS = available;
                workerLog(`Worker OPFS: ${canUseWorkerOPFS ? 'available' : 'not available (will use main thread)'}`);
            });

            // Eagerly pre-instantiate WASM module in background.
            // First compile will reuse this instead of paying ~150ms for instantiation.
            // getOrCreateModule() awaits globalModulePromise if a compile arrives before this finishes.
            globalModulePromise = (async () => {
                if (checkpointBoot) await checkpointBoot;
                if (initialEngine === 'pdflatex') await ensureCheckpointRuntime();
                const kind = checkpointDriver && initialEngine === 'pdflatex' ? 'checkpoint' : 'combined';
                const wasm = kind === 'checkpoint' ? checkpointRuntimeConfig.wasmModule : await loadCombinedModule();
                return initBusyTeX(wasm, busytexJsUrl, null, kind);
            })()
                .then(mod => {
                    globalModule = mod;
                    globalModuleUsed = false;
                    globalModulePromise = null;
                    workerLog('[MEMORY] WASM module pre-instantiated');
                })
                .catch(e => {
                    globalModulePromise = null;
                    workerLog('[MEMORY] WASM pre-instantiation failed (will retry on compile): ' + e.message);
                });

            if (msg.rangeFontBundles?.includes('fonts-cm')) {
                // Start storage and range I/O alongside the regular preload.
                // Compilation shares the promise and handles any fallback.
                loadCmMetricFiles().catch(() => {});
            }
            if (msg.rangeFontBundles?.includes('cm-super')) loadCmSuperMetadata().catch(() => {});
            void preloadDefaultBundles(msg.rangeFontBundles, initialEngine);
            if (catalogBoot) syncInputNames = await catalogBoot;
            self.postMessage({
                type: 'ready', rangeFonts: true, cmMetrics: true, cmSuperRanges: true,
                projectFileDeltas: true, ctanFileDeltas: true, chapterPreview: true, legacyTkz: true,
                formatRequestIds: true, sourceAnalysis: true,
            });
            break;

        case 'analyze-source':
            self.postMessage({ type: 'source-analysis-response', id: msg.id,
                passes: typeof msg.source === 'string' ? predictRequiredPasses(msg.source) : null });
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
            }).finally(() => checkpointDriver?.endRequest?.());
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

        case 'auxiliary-tool-response': {
            const pendingTool = pendingToolRequests.get(msg.requestId);
            if (pendingTool) {
                pendingToolRequests.delete(msg.requestId);
                clearTimeout(pendingTool.timeout);
                if (msg.success && msg.bytes instanceof Uint8Array && msg.bytes.byteLength <= 16 * 1024 * 1024) pendingTool.resolve(msg);
                else pendingTool.reject(new Error(msg.error || 'Auxiliary tool returned invalid output.'));
            }
            break;
        }

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

        case 'ctan-files-clear':
            ctanFileSnapshot = null;
            break;

        case 'cleanup':
            // Release caches to free memory when compiler is idle
            // Bundles will be re-read from OPFS on next compile
            projectFileSnapshot = null;
            ctanFileSnapshot = null;
            pendingBundleLoads.clear();
            workerBundleCache.clear();
            globalFetchedFilesCache.clear();
            cmMetricLoad = null;
            cmSuperMetadataLoad = null;
            globalFinalizeCache.clear();
            if (globalModule) {
                destroyModule(globalModule);
                globalModule = null;
                globalModuleUsed = false;
            }
            workerLog('[MEMORY] Caches cleared');
            break;
    }
};

self.onerror = function(e) {
    self.postMessage({ type: 'log', message: 'Worker error: ' + e.message });
};
