// ZoteroProvider - Zotero citation provider with hybrid search
// Uses Zotero API for server-side search, caches only used items

import { CitationProvider } from './provider.js';

const ZOTERO_DB_NAME = 'siglum-zotero-v2';
const ZOTERO_ITEMS_STORE = 'items';
const ZOTERO_CONFIG_STORE = 'config';
const ZOTERO_DB_VERSION = 1;

/**
 * ZoteroProvider - Memory-efficient Zotero integration
 *
 * Key design decisions:
 * - Uses Zotero API ?q=query for server-side search (no memory overhead)
 * - Only caches items the user actually uses (trackUsed)
 * - Falls back to cached items when offline
 * - No full library sync - saves memory and bandwidth
 */
export class ZoteroProvider extends CitationProvider {
    constructor(options = {}) {
        super({
            id: 'zotero',
            name: 'Zotero',
            ...options,
        });

        this.userId = null;
        this.apiKey = null;
        this._connected = false;
        this._syncing = false;
        this._itemCount = 0;
        this._db = null;
        this._subscribers = new Set();

        // L1 memory cache - fast lookup before IndexedDB
        this._itemCache = new Map();          // key -> item (LRU)
        this._itemCacheByKey = new Map();     // citeKey -> item
        this._searchCache = new Map();        // query -> {results, timestamp}
        this._cacheMaxSize = 200;
        this._searchCacheTTL = 60000;         // 1 minute for search results

        // Request deduplication - coalesce parallel requests
        this._inFlightSearches = new Map();   // query -> Promise
        this._inFlightItems = new Map();      // key -> Promise
    }

    // ========================================
    // Status & Subscription
    // ========================================

    isConnected() {
        return this._connected;
    }

    getStatus() {
        return {
            connected: this._connected,
            syncing: this._syncing,
            itemCount: this._itemCount,
            userId: this.userId,
        };
    }

    onStatus(callback) {
        this._subscribers.add(callback);
        callback(this.getStatus());
        return () => this._subscribers.delete(callback);
    }

    _notify() {
        const status = this.getStatus();
        this._subscribers.forEach(cb => cb(status));
    }

    // ========================================
    // IndexedDB Setup
    // ========================================

    async _openDb() {
        if (this._db) return this._db;

        return new Promise((resolve, reject) => {
            const request = indexedDB.open(ZOTERO_DB_NAME, ZOTERO_DB_VERSION);

            request.onerror = () => reject(request.error);

            request.onsuccess = () => {
                this._db = request.result;
                resolve(this._db);
            };

            request.onupgradeneeded = (event) => {
                const db = event.target.result;

                // Items store - for caching used citations
                if (!db.objectStoreNames.contains(ZOTERO_ITEMS_STORE)) {
                    const store = db.createObjectStore(ZOTERO_ITEMS_STORE, { keyPath: 'key' });
                    store.createIndex('citeKey', 'citeKey', { unique: false });
                    store.createIndex('usedAt', 'usedAt', { unique: false });
                    // Composite index for search
                    store.createIndex('searchText', 'searchText', { unique: false });
                }

                // Config store - for credentials
                if (!db.objectStoreNames.contains(ZOTERO_CONFIG_STORE)) {
                    db.createObjectStore(ZOTERO_CONFIG_STORE, { keyPath: 'id' });
                }
            };
        });
    }

    // ========================================
    // Configuration
    // ========================================

    async _getConfig() {
        try {
            const db = await this._openDb();
            return new Promise((resolve) => {
                const tx = db.transaction(ZOTERO_CONFIG_STORE, 'readonly');
                const store = tx.objectStore(ZOTERO_CONFIG_STORE);
                const request = store.get('credentials');
                request.onerror = () => resolve(null);
                request.onsuccess = () => resolve(request.result);
            });
        } catch {
            return null;
        }
    }

    async _saveConfig(userId, apiKey) {
        try {
            const db = await this._openDb();
            return new Promise((resolve) => {
                const tx = db.transaction(ZOTERO_CONFIG_STORE, 'readwrite');
                const store = tx.objectStore(ZOTERO_CONFIG_STORE);
                const request = store.put({
                    id: 'credentials',
                    userId,
                    apiKey,
                    connectedAt: Date.now(),
                });
                request.onerror = () => resolve(false);
                request.onsuccess = () => resolve(true);
            });
        } catch {
            return false;
        }
    }

    async _clearConfig() {
        try {
            const db = await this._openDb();
            const tx = db.transaction([ZOTERO_CONFIG_STORE, ZOTERO_ITEMS_STORE], 'readwrite');
            tx.objectStore(ZOTERO_CONFIG_STORE).clear();
            tx.objectStore(ZOTERO_ITEMS_STORE).clear();
            return true;
        } catch {
            return false;
        }
    }

    // ========================================
    // Connection
    // ========================================

    async init() {
        const config = await this._getConfig();
        if (config?.userId && config?.apiKey) {
            this.userId = config.userId;
            this.apiKey = config.apiKey;
            this._connected = true;

            // Count cached items
            this._itemCount = await this._getCachedItemCount();
            this._notify();
            return true;
        }
        return false;
    }

    async connect(credentials) {
        const { userId, apiKey } = credentials;

        this._syncing = true;
        this._notify();

        try {
            // Test credentials with a minimal API call
            const response = await fetch(
                `${this.proxyUrl}/api/zotero/users/${userId}/items?limit=1`,
                { headers: { 'Zotero-API-Key': apiKey } }
            );

            if (!response.ok) {
                throw new Error('Invalid Zotero credentials');
            }

            // Save credentials
            await this._saveConfig(userId, apiKey);
            this.userId = userId;
            this.apiKey = apiKey;
            this._connected = true;
            this._syncing = false;
            this._notify();
            return true;

        } catch (e) {
            this._syncing = false;
            this._notify();
            throw e;
        }
    }

    async disconnect() {
        await this._clearConfig();
        this.userId = null;
        this.apiKey = null;
        this._connected = false;
        this._itemCount = 0;
        this._notify();
    }

    /**
     * Sync - Clear caches and force fresh data from Zotero API
     * Does not re-download the full library, just clears stale cache
     */
    async sync() {
        if (!this._connected) return false;

        this._syncing = true;
        this._notify();

        try {
            // Clear L1 memory caches
            this._itemCache.clear();
            this._itemCacheByKey.clear();
            this._searchCache.clear();

            // Clear in-flight deduplication (allow new requests)
            this._inFlightSearches.clear();
            this._inFlightItems.clear();

            // Verify connection is still valid with a minimal API call
            const response = await fetch(
                `${this.proxyUrl}/api/zotero/users/${this.userId}/items?limit=1`,
                { headers: { 'Zotero-API-Key': this.apiKey } }
            );

            if (!response.ok) {
                throw new Error('Zotero sync failed - connection invalid');
            }

            // Update cached item count from IndexedDB
            this._itemCount = await this._getCachedItemCount();

            this._syncing = false;
            this._notify();
            return true;
        } catch (e) {
            this._syncing = false;
            this._notify();
            throw e;
        }
    }

    // ========================================
    // Search - The core of hybrid approach
    // ========================================

    async search(query, limit = 20) {
        if (!this._connected) {
            return [];
        }

        const trimmedQuery = (query || '').trim();

        // Empty query: return recently used items from cache
        if (!trimmedQuery) {
            return this._getRecentlyUsed(limit);
        }

        const cacheKey = `${trimmedQuery}:${limit}`;

        // Check L1 search cache first
        const cached = this._searchCache.get(cacheKey);
        if (cached && Date.now() - cached.timestamp < this._searchCacheTTL) {
            return cached.results;
        }

        // Check for in-flight request (deduplication)
        if (this._inFlightSearches.has(cacheKey)) {
            return this._inFlightSearches.get(cacheKey);
        }

        // Create and track the search promise
        const searchPromise = this._executeSearch(trimmedQuery, limit, cacheKey);
        this._inFlightSearches.set(cacheKey, searchPromise);

        try {
            return await searchPromise;
        } finally {
            this._inFlightSearches.delete(cacheKey);
        }
    }

    async _executeSearch(query, limit, cacheKey) {
        let results;

        // Online: use Zotero API server-side search
        if (navigator.onLine) {
            try {
                results = await this._apiSearch(query, limit);
            } catch (e) {
                console.warn('Zotero API search failed, falling back to cache:', e);
                results = await this._searchCached(query, limit);
            }
        } else {
            // Offline: search cached items only
            results = await this._searchCached(query, limit);
        }

        // Populate L1 cache
        this._searchCache.set(cacheKey, { results, timestamp: Date.now() });

        // Also cache individual items for fast lookup
        for (const item of results) {
            this._addToItemCache(item);
        }

        // Lazy prune: only when cache gets large, delete oldest entries
        if (this._searchCache.size > 100) {
            // Delete entries older than TTL, but stop after pruning half
            const now = Date.now();
            let pruned = 0;
            const maxPrune = 50;
            for (const [key, entry] of this._searchCache) {
                if (now - entry.timestamp > this._searchCacheTTL) {
                    this._searchCache.delete(key);
                    if (++pruned >= maxPrune) break;
                }
            }
        }

        return results;
    }

    async _apiSearch(query, limit) {
        // Zotero API doesn't reliably support excluding multiple types server-side.
        // Per pyzotero docs, client-side filtering is the recommended approach.
        // Request extra items to account for attachments/notes we'll filter out.
        const fetchLimit = Math.min(limit * 3, 100);
        const url = `${this.proxyUrl}/api/zotero/users/${this.userId}/items?q=${encodeURIComponent(query)}&limit=${fetchLimit}`;

        const response = await fetch(url, {
            headers: { 'Zotero-API-Key': this.apiKey }
        });

        if (!response.ok) {
            throw new Error(`Zotero API error: ${response.status}`);
        }

        const items = await response.json();

        // Filter out attachments and notes client-side
        const citable = items.filter(item => {
            const itemType = item.data?.itemType;
            return itemType !== 'attachment' && itemType !== 'note';
        });

        return citable.slice(0, limit).map(item => this._normalizeItem(item));
    }

    async _getRecentlyUsed(limit) {
        try {
            const db = await this._openDb();
            return new Promise((resolve) => {
                const tx = db.transaction(ZOTERO_ITEMS_STORE, 'readonly');
                const store = tx.objectStore(ZOTERO_ITEMS_STORE);
                const index = store.index('usedAt');

                const results = [];
                const request = index.openCursor(null, 'prev'); // Descending by usedAt

                request.onsuccess = (e) => {
                    const cursor = e.target.result;
                    if (cursor && results.length < limit) {
                        results.push(cursor.value);
                        cursor.continue();
                    } else {
                        resolve(results);
                    }
                };
                request.onerror = () => resolve([]);
            });
        } catch {
            return [];
        }
    }

    async _searchCached(query, limit) {
        try {
            const db = await this._openDb();
            const terms = query.toLowerCase().split(/\s+/).filter(t => t.length > 0);

            // First check L1 memory cache for quick results
            const memoryCacheResults = [];
            for (const item of this._itemCache.values()) {
                const searchText = (item.searchText || this._buildSearchText(item)).toLowerCase();
                if (terms.every(term => searchText.includes(term))) {
                    memoryCacheResults.push(item);
                    if (memoryCacheResults.length >= limit * 2) break;
                }
            }

            // If we have enough from memory cache, return early
            if (memoryCacheResults.length >= limit) {
                return this._scoreAndSort(memoryCacheResults, terms, limit);
            }

            // Fall back to IndexedDB scan
            return new Promise((resolve) => {
                const tx = db.transaction(ZOTERO_ITEMS_STORE, 'readonly');
                const store = tx.objectStore(ZOTERO_ITEMS_STORE);
                const results = [...memoryCacheResults]; // Start with memory cache results
                const seenKeys = new Set(memoryCacheResults.map(r => r.key));

                const request = store.openCursor();
                request.onsuccess = (e) => {
                    const cursor = e.target.result;
                    if (cursor) {
                        const item = cursor.value;

                        // Skip if already in memory cache results
                        if (seenKeys.has(item.key)) {
                            cursor.continue();
                            return;
                        }

                        const searchText = item.searchText || '';

                        // Check if all terms match
                        if (terms.every(term => searchText.includes(term))) {
                            results.push(item);
                        }

                        // Early exit when we have enough
                        if (results.length >= limit * 2) {
                            resolve(this._scoreAndSort(results, terms, limit));
                        } else {
                            cursor.continue();
                        }
                    } else {
                        resolve(this._scoreAndSort(results, terms, limit));
                    }
                };
                request.onerror = () => resolve(this._scoreAndSort(memoryCacheResults, terms, limit));
            });
        } catch {
            return [];
        }
    }

    _scoreAndSort(items, terms, limit) {
        const scored = items.map(item => {
            let score = 0;
            const citeKey = (item.citeKey || '').toLowerCase();
            const title = (item.title || '').toLowerCase();
            const creators = (item.creatorsText || '').toLowerCase();

            for (const term of terms) {
                if (citeKey.includes(term)) score += 100;
                if (creators.includes(term)) score += 50;
                if (title.includes(term)) score += 30;
            }

            return { item, score };
        });

        return scored
            .sort((a, b) => b.score - a.score)
            .slice(0, limit)
            .map(s => s.item);
    }

    async _getCachedItemCount() {
        try {
            const db = await this._openDb();
            return new Promise((resolve) => {
                const tx = db.transaction(ZOTERO_ITEMS_STORE, 'readonly');
                const store = tx.objectStore(ZOTERO_ITEMS_STORE);
                const request = store.count();
                request.onerror = () => resolve(0);
                request.onsuccess = () => resolve(request.result);
            });
        } catch {
            return 0;
        }
    }

    // ========================================
    // Item Access
    // ========================================

    async getItem(id) {
        // L1: Check memory cache first
        if (this._itemCache.has(id)) {
            return this._itemCache.get(id);
        }

        // Check for in-flight request (deduplication)
        if (this._inFlightItems.has(id)) {
            return this._inFlightItems.get(id);
        }

        const fetchPromise = this._fetchItem(id);
        this._inFlightItems.set(id, fetchPromise);

        try {
            return await fetchPromise;
        } finally {
            this._inFlightItems.delete(id);
        }
    }

    async _fetchItem(id) {
        // L2: Check IndexedDB cache
        const cached = await this._getCachedItem(id);
        if (cached) {
            this._addToItemCache(cached);
            return cached;
        }

        // Fetch from API if online
        if (!navigator.onLine || !this._connected) return null;

        try {
            const response = await fetch(
                `${this.proxyUrl}/api/zotero/users/${this.userId}/items/${id}`,
                { headers: { 'Zotero-API-Key': this.apiKey } }
            );

            if (!response.ok) return null;

            const item = await response.json();
            const normalized = this._normalizeItem(item);
            this._addToItemCache(normalized);
            return normalized;
        } catch {
            return null;
        }
    }

    async getItemByCiteKey(citeKey) {
        // L1: Check memory cache by citeKey
        if (this._itemCacheByKey.has(citeKey)) {
            return this._itemCacheByKey.get(citeKey);
        }

        // L2: Check IndexedDB
        try {
            const db = await this._openDb();
            return new Promise((resolve) => {
                const tx = db.transaction(ZOTERO_ITEMS_STORE, 'readonly');
                const store = tx.objectStore(ZOTERO_ITEMS_STORE);
                const index = store.index('citeKey');
                const request = index.get(citeKey);
                request.onerror = () => resolve(null);
                request.onsuccess = () => {
                    const item = request.result || null;
                    if (item) this._addToItemCache(item);
                    resolve(item);
                };
            });
        } catch {
            return null;
        }
    }

    async _getCachedItem(key) {
        try {
            const db = await this._openDb();
            return new Promise((resolve) => {
                const tx = db.transaction(ZOTERO_ITEMS_STORE, 'readonly');
                const store = tx.objectStore(ZOTERO_ITEMS_STORE);
                const request = store.get(key);
                request.onerror = () => resolve(null);
                request.onsuccess = () => resolve(request.result || null);
            });
        } catch {
            return null;
        }
    }

    /**
     * Add item to L1 memory cache with LRU eviction
     */
    _addToItemCache(item) {
        if (!item?.key) return;

        // Evict oldest if at capacity (simple LRU: Map preserves insertion order)
        if (this._itemCache.size >= this._cacheMaxSize) {
            const firstKey = this._itemCache.keys().next().value;
            const evicted = this._itemCache.get(firstKey);
            this._itemCache.delete(firstKey);
            if (evicted?.citeKey) {
                this._itemCacheByKey.delete(evicted.citeKey);
            }
        }

        // Add to both caches
        this._itemCache.set(item.key, item);
        if (item.citeKey) {
            this._itemCacheByKey.set(item.citeKey, item);
        }
    }

    // ========================================
    // Track Used - Cache items user selects
    // ========================================

    async trackUsed(item) {
        try {
            const db = await this._openDb();
            const entry = {
                ...item,
                usedAt: Date.now(),
                searchText: this._buildSearchText(item),
            };

            return new Promise((resolve) => {
                const tx = db.transaction(ZOTERO_ITEMS_STORE, 'readwrite');
                const store = tx.objectStore(ZOTERO_ITEMS_STORE);
                const request = store.put(entry);
                request.onsuccess = () => {
                    this._itemCount++;
                    this._notify();
                    resolve(true);
                };
                request.onerror = () => resolve(false);
            });
        } catch {
            return false;
        }
    }

    // ========================================
    // BibTeX Generation
    // ========================================

    getBibtex(item) {
        const data = item.data || item;
        const key = item.citeKey || this._generateCiteKey(item);

        const typeMap = {
            'journalArticle': 'article',
            'book': 'book',
            'bookSection': 'incollection',
            'conferencePaper': 'inproceedings',
            'thesis': 'phdthesis',
            'report': 'techreport',
            'webpage': 'misc',
            'preprint': 'unpublished',
        };

        const bibType = typeMap[data.itemType] || 'misc';
        const fields = [];

        // Authors
        const creators = data.creators || [];
        const authors = creators
            .filter(c => c.creatorType === 'author' || !c.creatorType)
            .map(c => c.name || `${c.lastName}, ${c.firstName}`)
            .join(' and ');
        if (authors) fields.push(`  author = {${authors}}`);

        // Editors
        const editors = creators
            .filter(c => c.creatorType === 'editor')
            .map(c => c.name || `${c.lastName}, ${c.firstName}`)
            .join(' and ');
        if (editors) fields.push(`  editor = {${editors}}`);

        // Standard fields
        if (data.title) fields.push(`  title = {${data.title}}`);
        if (data.date) {
            const year = data.date.match(/\d{4}/)?.[0];
            if (year) fields.push(`  year = {${year}}`);
        }
        if (data.publicationTitle) fields.push(`  journal = {${data.publicationTitle}}`);
        if (data.bookTitle) fields.push(`  booktitle = {${data.bookTitle}}`);
        if (data.publisher) fields.push(`  publisher = {${data.publisher}}`);
        if (data.place) fields.push(`  address = {${data.place}}`);
        if (data.volume) fields.push(`  volume = {${data.volume}}`);
        if (data.issue) fields.push(`  number = {${data.issue}}`);
        if (data.pages) fields.push(`  pages = {${data.pages.replace('-', '--')}}`);
        if (data.DOI) fields.push(`  doi = {${data.DOI}}`);
        if (data.ISBN) fields.push(`  isbn = {${data.ISBN}}`);
        if (data.ISSN) fields.push(`  issn = {${data.ISSN}}`);
        if (data.url) fields.push(`  url = {${data.url}}`);
        if (data.abstractNote) {
            const abstract = data.abstractNote
                .replace(/\\/g, '\\textbackslash{}')
                .replace(/[{}]/g, '\\$&')
                .replace(/&/g, '\\&')
                .replace(/%/g, '\\%');
            fields.push(`  abstract = {${abstract}}`);
        }

        return `@${bibType}{${key},\n${fields.join(',\n')}\n}`;
    }

    // ========================================
    // Helpers
    // ========================================

    _normalizeItem(apiItem) {
        const data = apiItem.data || apiItem;
        const citeKey = this._generateCiteKey(apiItem);

        return {
            key: apiItem.key,
            citeKey,
            title: data.title || '',
            creatorsText: this._creatorsToText(data.creators),
            year: data.date?.match(/\d{4}/)?.[0] || '',
            itemType: data.itemType || 'misc',
            data: data,
            version: apiItem.version,
            provider: 'zotero',
        };
    }

    _creatorsToText(creators) {
        if (!creators || !Array.isArray(creators)) return '';
        return creators.map(c => {
            if (c.name) return c.name;
            return [c.firstName, c.lastName].filter(Boolean).join(' ');
        }).join(' ');
    }

    _generateCiteKey(item) {
        const data = item.data || item;
        const creators = data.creators || [];
        const year = data.date?.match(/\d{4}/)?.[0] || '';

        let authorPart = '';
        if (creators.length > 0) {
            const first = creators[0];
            authorPart = (first.lastName || first.name || 'unknown').toLowerCase();
            authorPart = authorPart.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
            authorPart = authorPart.replace(/[^a-z]/g, '');
        }

        let titlePart = '';
        const title = data.title || '';
        const words = title.toLowerCase().split(/\s+/);
        const stopWords = new Set(['a', 'an', 'the', 'of', 'in', 'on', 'for', 'and', 'or', 'to']);
        for (const word of words) {
            const clean = word.replace(/[^a-z]/g, '');
            if (clean.length > 2 && !stopWords.has(clean)) {
                titlePart = clean;
                break;
            }
        }

        return `${authorPart}${year}${titlePart}`.slice(0, 40);
    }

    _buildSearchText(item) {
        const parts = [
            item.citeKey || '',
            item.title || '',
            item.creatorsText || '',
            item.year || '',
        ];
        return parts.join(' ').toLowerCase();
    }
}

// ========================================
// Singleton instance
// ========================================

let _instance = null;

export function getZoteroProvider(options) {
    if (!_instance) {
        _instance = new ZoteroProvider(options);
    }
    return _instance;
}

export default ZoteroProvider;
