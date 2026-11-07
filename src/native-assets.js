// Classic-worker helper. Runtime manifests describe immutable native data; no
// library names, locale lists or package exceptions belong in the loader.
class SiglumNativeAssetStore {
    constructor(baseUrl, descriptors = [], log = () => {}) {
        this.baseUrl = new URL(baseUrl.endsWith('/') ? baseUrl : baseUrl + '/', self.location.href).href;
        this.descriptors = descriptors;
        this.log = log;
        this.contexts = new Map();
        this.pending = new Set();
        this.failure = null;
        if (!Array.isArray(descriptors) || descriptors.length > 8) throw new Error('Invalid native resource descriptors');
    }
    relative(value) {
        if (typeof value !== 'string' || !value || value.length > 1024 || !/^[A-Za-z0-9_./-]+$/.test(value)
            || value.startsWith('/') || value.split('/').some(p => !p || p === '.' || p === '..')) throw new Error('Invalid native resource path');
        return value;
    }
    async digest(bytes) {
        if (globalThis.crypto?.subtle) return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(v => v.toString(16).padStart(2, '0')).join('');
        // SHA-256 (FIPS 180-4), bounded block storage. HTTP LAN previews lack
        // SubtleCrypto; they must still verify the identical asset digest.
        const k = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
            0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
            0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
            0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
            0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
            0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
            0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
            0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
        const state = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
        const words = new Uint32Array(64), end = Math.ceil((bytes.length + 9) / 64) * 64;
        const low = (bytes.length * 8) >>> 0, high = Math.floor(bytes.length / 0x20000000);
        const rotate = (v, n) => (v >>> n) | (v << (32 - n));
        const byte = p => p < bytes.length ? bytes[p] : p === bytes.length ? 128 : p < end - 8 ? 0 : ((p < end - 4 ? high : low) >>> ((3 - p % 4) * 8)) & 255;
        for (let block = 0; block < end; block += 64) {
            for (let i = 0; i < 16; i++) { const p = block + i * 4; words[i] = (byte(p) << 24) | (byte(p+1) << 16) | (byte(p+2) << 8) | byte(p+3); }
            for (let i = 16; i < 64; i++) { const x = words[i-15], y = words[i-2]; words[i] = (words[i-16] + (rotate(x,7)^rotate(x,18)^(x>>>3)) + words[i-7] + (rotate(y,17)^rotate(y,19)^(y>>>10))) >>> 0; }
            let [a,b,c,d,e,f,g,h] = state;
            for (let i = 0; i < 64; i++) {
                const first = (h + (rotate(e,6)^rotate(e,11)^rotate(e,25)) + ((e&f)^(~e&g)) + k[i] + words[i]) >>> 0;
                const second = ((rotate(a,2)^rotate(a,13)^rotate(a,22)) + ((a&b)^(a&c)^(b&c))) >>> 0;
                h=g; g=f; f=e; e=(d+first)>>>0; d=c; c=b; b=a; a=(first+second)>>>0;
            }
            for (const [i,v] of [a,b,c,d,e,f,g,h].entries()) state[i] = (state[i]+v)>>>0;
        }
        return state.map(v => v.toString(16).padStart(8,'0')).join('');
    }
    queue(operation) {
        const pending = Promise.resolve(operation).catch(error => { this.failure ||= error; });
        this.pending.add(pending);
        pending.finally(() => this.pending.delete(pending));
    }
    async settle() {
        while (this.pending.size) await Promise.all([...this.pending]);
        if (this.failure) { const error = this.failure; this.failure = null; throw error; }
    }
    async prepare(descriptor) {
        if (descriptor.version !== 1 || !/^_siglum_[a-z0-9_]+$/.test(descriptor.initialize)
            || typeof descriptor.directory !== 'string' || !descriptor.directory.startsWith('/') || descriptor.directory === '/') throw new Error('Invalid native resource descriptor');
        this.relative(descriptor.directory.slice(1));
        const url = new URL(this.relative(descriptor.index), this.baseUrl).href;
        if (this.contexts.has(url)) return this.contexts.get(url);
        const promise = this.openContext(descriptor, url);
        this.contexts.set(url, promise);
        try { return await promise; } catch (error) { this.contexts.delete(url); throw error; }
    }
    async openContext(descriptor, url) {
        let cache;
        try { cache = await caches.open('siglum-native-assets-v1'); } catch { this.log('Native resource disk cache unavailable'); }
        let response = await cache?.match(url);
        if (!response?.ok) {
            response = await fetch(url);
            if (!response.ok) throw new Error('Native resource index unavailable: ' + response.status);
            if (cache) { try { await cache.put(url, response.clone()); } catch { this.log('Native resource index could not be cached'); } }
        }
        const index = await response.json();
        if (index.version !== 1 || !Number.isSafeInteger(index.bytes) || index.bytes <= 0 || index.bytes > 64 * 1024 * 1024
            || !Array.isArray(index.files) || index.files.length > 8192) throw new Error('Invalid native resource index');
        const packUrl = new URL(this.relative(index.pack), this.baseUrl).href;
        const files = new Map(), children = new Map(); let previousEnd = 0;
        for (const file of index.files) {
            const name = this.relative(file.name);
            if (files.has(name) || !Number.isSafeInteger(file.offset) || !Number.isSafeInteger(file.bytes)
                || file.bytes <= 0 || file.offset < previousEnd || file.offset + file.bytes > index.bytes
                || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error('Invalid native resource entry');
            previousEnd = file.offset + file.bytes;
            files.set(name, file);
            const parts = name.split('/'); let parent = '';
            for (const part of parts) { if (!children.has(parent)) children.set(parent, new Set()); children.get(parent).add(part); parent = parent ? parent + '/' + part : part; }
        }
        const context = { descriptor, url, packUrl, index, files, children, cache, bytes: new Map(), used: new Set(), dirty: false, wholePack: null, loads: 0 };
        const usageUrl = url + '?siglum-native-used';
        let used = [];
        try { used = await (await cache?.match(usageUrl))?.json() || []; } catch {}
        if (!Array.isArray(used) || used.length > files.size) used = [];
        for (const name of used) {
            const file = files.get(name); if (!file) continue;
            const saved = await cache?.match(this.fileKey(context, file));
            if (!saved?.ok) continue;
            const bytes = new Uint8Array(await saved.arrayBuffer());
            if (bytes.byteLength === file.bytes && await this.digest(bytes) === file.sha256) { context.bytes.set(name, bytes); context.used.add(name); }
        }
        return context;
    }
    fileKey(context, file) {
        return context.packUrl + '?siglum-native-file=' + encodeURIComponent(file.name);
    }
    load(context, file) {
        const cached = context.bytes.get(file.name);
        if (cached) return cached;
        let bytes;
        if (context.wholePack) bytes = context.wholePack.subarray(file.offset, file.offset + file.bytes);
        else {
            const xhr = new XMLHttpRequest();
            xhr.open('GET', context.packUrl, false);
            xhr.setRequestHeader('Range', 'bytes=' + file.offset + '-' + (file.offset + file.bytes - 1));
            xhr.responseType = 'arraybuffer'; xhr.send(null);
            if (xhr.status === 206 && xhr.response instanceof ArrayBuffer && xhr.response.byteLength === file.bytes) {
                const range = xhr.getResponseHeader('Content-Range');
                if (range && range !== 'bytes ' + file.offset + '-' + (file.offset + file.bytes - 1) + '/' + context.index.bytes) throw new Error('Native resource range mismatch');
                bytes = new Uint8Array(xhr.response);
            } else if (xhr.status === 200 && xhr.response instanceof ArrayBuffer && xhr.response.byteLength === context.index.bytes) {
                context.wholePack = new Uint8Array(xhr.response);
                bytes = context.wholePack.subarray(file.offset, file.offset + file.bytes);
            } else throw new Error('Native resource unavailable: ' + file.name + ' (HTTP ' + xhr.status + ')');
        }
        context.loads++;
        context.bytes.set(file.name, bytes); context.used.add(file.name); context.dirty = true;
        this.queue((async () => {
            if (await this.digest(bytes) !== file.sha256) { context.bytes.delete(file.name); context.used.delete(file.name); throw new Error('Native resource checksum mismatch: ' + file.name); }
            if (context.cache) { try { await context.cache.put(this.fileKey(context, file), new Response(bytes)); } catch { this.log('Native resource could not be cached: ' + file.name); } }
        })());
        return bytes;
    }
    async mount(module, kind) {
        const mounts = [];
        for (const descriptor of this.descriptors) {
            if (descriptor.runtime && descriptor.runtime !== kind) continue;
            const initialize = module[descriptor.initialize];
            if (typeof initialize !== 'function') throw new Error('Native resource initializer is missing');
            const context = await this.prepare(descriptor), FS = module.FS;
            FS.__siglumNativeResourceRoots ||= new Set();
            FS.__siglumNativeResourceRoots.add(descriptor.directory);
            let materialized = 0;
            const immutable = () => { throw new FS.ErrnoError(2); };
            const createFile = (parent, name, file) => {
                // Lookup is already in progress. The path-based create helpers
                // perform another mayCreate/lookup and would recursively enter
                // this lazy directory. Use MEMFS's node constructor directly.
                const node = FS.filesystems.MEMFS.createNode(parent, name, 32768 | 292, 0);
                const operations = node.stream_ops;
                node.contents = null; node.usedBytes = file.bytes; materialized++;
                const hydrate = () => { if (!(node.contents instanceof Uint8Array)) node.contents = this.load(context, file); };
                node.stream_ops = { ...operations, read(...args) { hydrate(); return operations.read(...args); }, mmap(...args) { hydrate(); return operations.mmap(...args); }, write: immutable, allocate: immutable, msync: immutable };
                const nodeOps = node.node_ops;
                node.node_ops = { ...nodeOps, setattr(n, attributes) { if (attributes.size !== undefined) immutable(); return nodeOps.setattr(n, attributes); } };
                return node;
            };
            FS.mkdirTree(descriptor.directory);
            for (const directory of context.children.keys()) {
                const path = descriptor.directory + (directory ? '/' + directory : '');
                FS.mkdirTree(path);
                const node = FS.lookupPath(path).node, operations = node.node_ops;
                node.node_ops = { ...operations,
                    lookup(parent, name) {
                        const key = directory ? directory + '/' + name : name, file = context.files.get(key);
                        return file ? createFile(parent, name, file) : operations.lookup(parent, name);
                    },
                    readdir(n) { return [...new Set([...operations.readdir(n), ...context.children.get(directory)])]; }
                };
            }
            // Previously used immutable files already have verified bytes.
            // Materialize their metadata before any checkpoint pins this tree;
            // payloads remain shared and are read only when the library asks.
            for (const name of context.bytes.keys()) FS.lookupPath(descriptor.directory + '/' + name);
            const status = initialize();
            if (status !== 0) throw new Error('Native resource initialization failed: ' + status);
            mounts.push(() => ({ directory: descriptor.directory, files: materialized, loadedFiles: context.bytes.size, loadedBytes: [...context.bytes.values()].reduce((n, b) => n + b.byteLength, 0), rangeLoads: context.loads }));
        }
        if (mounts.length) module.__siglumNativeResourceStats = () => mounts.map(stats => stats());
    }
    async flush() {
        await this.settle();
        for (const pending of this.contexts.values()) {
            const context = await pending;
            if (context.dirty && context.cache) {
                try { await context.cache.put(context.url + '?siglum-native-used', new Response(JSON.stringify([...context.used]), { headers: { 'Content-Type': 'application/json' } })); context.dirty = false; }
                catch { this.log('Native resource usage could not be cached'); }
            }
        }
    }
}
globalThis.SiglumNativeAssetStore = SiglumNativeAssetStore;
