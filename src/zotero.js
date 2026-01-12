// Zotero integration - client-side library access with caching
// Follows the same patterns as storage.js and ctan.js

const ZOTERO_DB_NAME = 'siglum-zotero-cache';
const ZOTERO_STORE = 'library';
const ZOTERO_CONFIG_STORE = 'config';
const ZOTERO_CACHE_VERSION = 1;

let zoteroDb = null;
const memoryCache = new Map();

// Open IndexedDB for Zotero data
async function openZoteroDb() {
    if (zoteroDb) return zoteroDb;
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(ZOTERO_DB_NAME, ZOTERO_CACHE_VERSION);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
            zoteroDb = request.result;
            resolve(zoteroDb);
        };
        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            if (!db.objectStoreNames.contains(ZOTERO_STORE)) {
                const store = db.createObjectStore(ZOTERO_STORE, { keyPath: 'key' });
                store.createIndex('title', 'title', { unique: false });
                store.createIndex('creators', 'creatorsText', { unique: false });
            }
            if (!db.objectStoreNames.contains(ZOTERO_CONFIG_STORE)) {
                db.createObjectStore(ZOTERO_CONFIG_STORE, { keyPath: 'id' });
            }
        };
    });
}

// Get Zotero credentials from config
export async function getZoteroConfig() {
    try {
        const db = await openZoteroDb();
        return new Promise((resolve) => {
            const tx = db.transaction(ZOTERO_CONFIG_STORE, 'readonly');
            const store = tx.objectStore(ZOTERO_CONFIG_STORE);
            const request = store.get('credentials');
            request.onerror = () => resolve(null);
            request.onsuccess = () => resolve(request.result);
        });
    } catch (e) {
        return null;
    }
}

// Save Zotero credentials
export async function saveZoteroConfig(userId, apiKey) {
    try {
        const db = await openZoteroDb();
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
    } catch (e) {
        return false;
    }
}

// Clear Zotero credentials and cache
export async function disconnectZotero() {
    try {
        const db = await openZoteroDb();
        const tx = db.transaction([ZOTERO_CONFIG_STORE, ZOTERO_STORE], 'readwrite');
        tx.objectStore(ZOTERO_CONFIG_STORE).clear();
        tx.objectStore(ZOTERO_STORE).clear();
        memoryCache.clear();
        return true;
    } catch (e) {
        return false;
    }
}

// Parse creators into searchable text
function creatorsToText(creators) {
    if (!creators || !Array.isArray(creators)) return '';
    return creators.map(c => {
        if (c.name) return c.name;
        return [c.firstName, c.lastName].filter(Boolean).join(' ');
    }).join(' ');
}

// Generate a citation key from item data
function generateCiteKey(item) {
    const creators = item.data?.creators || [];
    const year = item.data?.date?.match(/\d{4}/)?.[0] || '';

    let authorPart = '';
    if (creators.length > 0) {
        const first = creators[0];
        authorPart = (first.lastName || first.name || 'unknown').toLowerCase();
        // Remove diacritics and non-ascii
        authorPart = authorPart.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        authorPart = authorPart.replace(/[^a-z]/g, '');
    }

    // Get first significant word from title
    let titlePart = '';
    const title = item.data?.title || '';
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

// Convert Zotero item to BibTeX
export function itemToBibtex(item) {
    const data = item.data || {};
    const key = item.citeKey || generateCiteKey(item);

    // Map Zotero types to BibTeX types
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

    // Basic fields
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
        // Escape special chars in abstract
        const abstract = data.abstractNote
            .replace(/\\/g, '\\textbackslash{}')
            .replace(/[{}]/g, '\\$&')
            .replace(/&/g, '\\&')
            .replace(/%/g, '\\%');
        fields.push(`  abstract = {${abstract}}`);
    }

    return `@${bibType}{${key},\n${fields.join(',\n')}\n}`;
}

// Store items in cache
async function cacheItems(items) {
    try {
        const db = await openZoteroDb();
        const tx = db.transaction(ZOTERO_STORE, 'readwrite');
        const store = tx.objectStore(ZOTERO_STORE);

        for (const item of items) {
            const citeKey = generateCiteKey(item);
            const creatorsText = creatorsToText(item.data?.creators);
            const entry = {
                key: item.key,
                citeKey,
                title: item.data?.title || '',
                creatorsText,
                year: item.data?.date?.match(/\d{4}/)?.[0] || '',
                itemType: item.data?.itemType || 'misc',
                data: item.data,
                version: item.version,
                cachedAt: Date.now(),
            };
            store.put(entry);
            memoryCache.set(item.key, entry);
        }

        return new Promise(resolve => {
            tx.oncomplete = () => resolve(true);
            tx.onerror = () => resolve(false);
        });
    } catch (e) {
        return false;
    }
}

// Get all cached items
export async function getCachedLibrary() {
    // Check memory cache first
    if (memoryCache.size > 0) {
        return Array.from(memoryCache.values());
    }

    try {
        const db = await openZoteroDb();
        return new Promise((resolve) => {
            const tx = db.transaction(ZOTERO_STORE, 'readonly');
            const store = tx.objectStore(ZOTERO_STORE);
            const request = store.getAll();
            request.onerror = () => resolve([]);
            request.onsuccess = () => {
                const items = request.result || [];
                // Populate memory cache
                for (const item of items) {
                    memoryCache.set(item.key, item);
                }
                resolve(items);
            };
        });
    } catch (e) {
        return [];
    }
}

// Get a single item by key
export async function getCachedItem(key) {
    if (memoryCache.has(key)) {
        return memoryCache.get(key);
    }

    try {
        const db = await openZoteroDb();
        return new Promise((resolve) => {
            const tx = db.transaction(ZOTERO_STORE, 'readonly');
            const store = tx.objectStore(ZOTERO_STORE);
            const request = store.get(key);
            request.onerror = () => resolve(null);
            request.onsuccess = () => {
                if (request.result) {
                    memoryCache.set(key, request.result);
                }
                resolve(request.result);
            };
        });
    } catch (e) {
        return null;
    }
}

// Search library (fuzzy matching)
export async function searchLibrary(query) {
    const items = await getCachedLibrary();
    if (!query || query.trim() === '') {
        // Return recent items sorted by cache time
        return items.slice(0, 20);
    }

    const terms = query.toLowerCase().split(/\s+/).filter(t => t.length > 0);

    const scored = items.map(item => {
        let score = 0;
        const title = (item.title || '').toLowerCase();
        const creators = (item.creatorsText || '').toLowerCase();
        const year = item.year || '';
        const citeKey = (item.citeKey || '').toLowerCase();

        for (const term of terms) {
            // Exact match in cite key (highest priority)
            if (citeKey.includes(term)) score += 100;
            // Match in creators
            if (creators.includes(term)) score += 50;
            // Match in title
            if (title.includes(term)) score += 30;
            // Match in year
            if (year.includes(term)) score += 20;
        }

        return { item, score };
    });

    return scored
        .filter(s => s.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 50)
        .map(s => s.item);
}

/**
 * ZoteroService - main class for Zotero integration
 * Follows the singleton pattern like other services
 */
export class ZoteroService {
    constructor(options = {}) {
        this.proxyUrl = options.proxyUrl || 'http://localhost:8787';
        this.userId = null;
        this.apiKey = null;
        this.connected = false;
        this.syncing = false;
        this.lastSync = null;
        this.itemCount = 0;
        this.subscribers = new Set();
        this.syncInterval = null;
    }

    // Subscribe to status changes
    onStatus(callback) {
        this.subscribers.add(callback);
        // Immediately notify with current status
        callback(this.getStatus());
        return () => this.subscribers.delete(callback);
    }

    notify() {
        const status = this.getStatus();
        this.subscribers.forEach(cb => cb(status));
    }

    getStatus() {
        return {
            connected: this.connected,
            syncing: this.syncing,
            lastSync: this.lastSync,
            itemCount: this.itemCount,
            userId: this.userId,
        };
    }

    // Initialize from saved config
    async init() {
        const config = await getZoteroConfig();
        if (config?.userId && config?.apiKey) {
            this.userId = config.userId;
            this.apiKey = config.apiKey;
            this.connected = true;

            // Load cached library
            const items = await getCachedLibrary();
            this.itemCount = items.length;

            this.notify();

            // Start background sync
            this.startBackgroundSync();

            return true;
        }
        return false;
    }

    // Connect with credentials
    async connect(userId, apiKey) {
        this.syncing = true;
        this.notify();

        try {
            // Test credentials by fetching library
            const response = await fetch(
                `${this.proxyUrl}/api/zotero/users/${userId}/items?limit=1`,
                {
                    headers: { 'Zotero-API-Key': apiKey },
                }
            );

            if (!response.ok) {
                throw new Error('Invalid credentials or network error');
            }

            // Save credentials
            await saveZoteroConfig(userId, apiKey);
            this.userId = userId;
            this.apiKey = apiKey;
            this.connected = true;

            // Fetch full library
            await this.syncLibrary();

            // Start background sync
            this.startBackgroundSync();

            return true;
        } catch (e) {
            this.syncing = false;
            this.notify();
            throw e;
        }
    }

    // Disconnect
    async disconnect() {
        this.stopBackgroundSync();
        await disconnectZotero();
        this.userId = null;
        this.apiKey = null;
        this.connected = false;
        this.itemCount = 0;
        this.lastSync = null;
        this.notify();
    }

    // Sync library from Zotero API
    async syncLibrary() {
        if (!this.connected || this.syncing) return;

        this.syncing = true;
        this.notify();

        try {
            const allItems = [];
            let start = 0;
            const limit = 100;

            while (true) {
                const response = await fetch(
                    `${this.proxyUrl}/api/zotero/users/${this.userId}/items?start=${start}&limit=${limit}&itemType=-attachment&itemType=-note`,
                    {
                        headers: { 'Zotero-API-Key': this.apiKey },
                    }
                );

                if (!response.ok) {
                    throw new Error('Failed to fetch library');
                }

                const items = await response.json();
                if (!items.length) break;

                allItems.push(...items);
                start += limit;

                // Zotero API returns total in header
                const total = parseInt(response.headers.get('Total-Results') || '0', 10);
                if (start >= total) break;
            }

            // Cache all items
            await cacheItems(allItems);
            this.itemCount = allItems.length;
            this.lastSync = Date.now();

        } finally {
            this.syncing = false;
            this.notify();
        }
    }

    // Background sync every 30 minutes
    startBackgroundSync() {
        this.stopBackgroundSync();
        this.syncInterval = setInterval(() => {
            this.syncLibrary().catch(() => {});
        }, 30 * 60 * 1000);
    }

    stopBackgroundSync() {
        if (this.syncInterval) {
            clearInterval(this.syncInterval);
            this.syncInterval = null;
        }
    }

    // Search library
    async search(query) {
        return searchLibrary(query);
    }

    // Get BibTeX for specific keys
    async getBibtex(citeKeys) {
        const items = await getCachedLibrary();
        const keySet = new Set(citeKeys);

        const matching = items.filter(item => keySet.has(item.citeKey));
        return matching.map(item => itemToBibtex(item)).join('\n\n');
    }

    // Get BibTeX for a single item
    getItemBibtex(item) {
        return itemToBibtex(item);
    }
}

// Default instance
let defaultInstance = null;

export function getZoteroService(options) {
    if (!defaultInstance) {
        defaultInstance = new ZoteroService(options);
    }
    return defaultInstance;
}

export { ZOTERO_CACHE_VERSION };
