// Compilation Cache for Bounded Incremental Compilation
// Stores compiled artifacts with LRU eviction and memory limits
// Optimized for memory efficiency and performance

import { hashContent } from './section-parser.js';

/**
 * Lightweight cache entry - stores only references, not copies
 */
class CacheEntry {
    constructor(data) {
        this.sourceHash = data.sourceHash;
        this.pdfData = data.pdfData;  // Uint8Array reference
        this.auxData = data.auxData;
        this.syncTexData = data.syncTexData;
        this.sections = data.sections;
        this.pageMapping = data.pageMapping;
        this.counterStates = data.counterStates;
        this.timestamp = Date.now();
        this.accessCount = 0;
        // Approximate memory size (PDF is typically largest)
        this.byteSize = (data.pdfData?.length || 0) +
                        (data.auxData?.length || 0) +
                        (data.syncTexData?.length || 0);
    }

    touch() {
        this.timestamp = Date.now();
        this.accessCount++;
    }

    isValid(sourceHash) {
        return this.sourceHash === sourceHash;
    }
}

/**
 * LRU Cache with memory limits for compiled documents
 */
export class CompilationCache {
    constructor(options = {}) {
        this.maxEntries = options.maxEntries || 10;
        this.maxAge = options.maxAge || 30 * 60 * 1000;  // 30 minutes
        this.maxMemoryBytes = options.maxMemoryBytes || 100 * 1024 * 1024;  // 100MB default

        this.entries = new Map();
        this.sectionCache = new Map();
        this.totalBytes = 0;

        // LRU tracking - Map maintains insertion order
        this.accessOrder = [];
    }

    /**
     * Get cache entry with LRU update
     * @param {string} documentId
     * @returns {CacheEntry|null}
     */
    get(documentId) {
        const entry = this.entries.get(documentId);
        if (!entry) return null;

        // Check expiry
        const age = Date.now() - entry.timestamp;
        if (age > this.maxAge) {
            this._delete(documentId);
            return null;
        }

        // Update LRU order
        entry.touch();
        this._moveToEnd(documentId);

        return entry;
    }

    /**
     * Store a cache entry with eviction if needed
     * @param {string} documentId
     * @param {Object} data
     * @returns {CacheEntry}
     */
    set(documentId, data) {
        // Remove existing entry if present
        if (this.entries.has(documentId)) {
            this._delete(documentId);
        }

        const entry = new CacheEntry(data);

        // Evict until we have space
        while (this._shouldEvict(entry.byteSize)) {
            this._evictLRU();
        }

        this.entries.set(documentId, entry);
        this.accessOrder.push(documentId);
        this.totalBytes += entry.byteSize;

        return entry;
    }

    /**
     * Update specific fields without full replacement
     * @param {string} documentId
     * @param {Object} updates
     * @returns {CacheEntry|null}
     */
    update(documentId, updates) {
        const existing = this.entries.get(documentId);
        if (!existing) return null;

        // Calculate size change
        const oldSize = existing.byteSize;

        // Update fields
        if (updates.sourceHash !== undefined) existing.sourceHash = updates.sourceHash;
        if (updates.pdfData !== undefined) existing.pdfData = updates.pdfData;
        if (updates.auxData !== undefined) existing.auxData = updates.auxData;
        if (updates.syncTexData !== undefined) existing.syncTexData = updates.syncTexData;
        if (updates.sections !== undefined) existing.sections = updates.sections;
        if (updates.pageMapping !== undefined) existing.pageMapping = updates.pageMapping;
        if (updates.counterStates !== undefined) existing.counterStates = updates.counterStates;

        // Recalculate size
        existing.byteSize = (existing.pdfData?.length || 0) +
                           (existing.auxData?.length || 0) +
                           (existing.syncTexData?.length || 0);
        existing.timestamp = Date.now();

        this.totalBytes += existing.byteSize - oldSize;
        this._moveToEnd(documentId);

        return existing;
    }

    /**
     * Check if eviction is needed
     */
    _shouldEvict(additionalBytes) {
        return (this.entries.size >= this.maxEntries) ||
               (this.totalBytes + additionalBytes > this.maxMemoryBytes);
    }

    /**
     * Evict least recently used entry
     */
    _evictLRU() {
        if (this.accessOrder.length === 0) return;

        const lruId = this.accessOrder[0];
        this._delete(lruId);
    }

    /**
     * Move entry to end of access order (most recent)
     */
    _moveToEnd(documentId) {
        const idx = this.accessOrder.indexOf(documentId);
        if (idx > -1) {
            this.accessOrder.splice(idx, 1);
        }
        this.accessOrder.push(documentId);
    }

    /**
     * Delete entry and update tracking
     */
    _delete(documentId) {
        const entry = this.entries.get(documentId);
        if (entry) {
            this.totalBytes -= entry.byteSize;
            this.entries.delete(documentId);
        }
        const idx = this.accessOrder.indexOf(documentId);
        if (idx > -1) {
            this.accessOrder.splice(idx, 1);
        }
    }

    /**
     * Public delete
     */
    delete(documentId) {
        this._delete(documentId);
    }

    /**
     * Clear all entries
     */
    clear() {
        this.entries.clear();
        this.sectionCache.clear();
        this.accessOrder = [];
        this.totalBytes = 0;
    }

    /**
     * Get cached section data
     */
    getCachedSection(sectionHash) {
        const entry = this.sectionCache.get(sectionHash);
        if (!entry) return null;

        // Check section cache expiry (shorter than document cache)
        if (Date.now() - entry.timestamp > this.maxAge / 2) {
            this.sectionCache.delete(sectionHash);
            return null;
        }
        return entry;
    }

    /**
     * Cache section data with size-based eviction
     */
    cacheSection(sectionHash, data) {
        // Limit section cache to 50 entries
        if (this.sectionCache.size >= 50) {
            // Remove oldest entries
            const keys = this.sectionCache.keys();
            for (let i = 0; i < 10; i++) {
                const key = keys.next().value;
                if (key) this.sectionCache.delete(key);
            }
        }

        this.sectionCache.set(sectionHash, {
            ...data,
            timestamp: Date.now(),
        });
    }

    /**
     * Get cache statistics
     */
    getStats() {
        return {
            documentEntries: this.entries.size,
            sectionEntries: this.sectionCache.size,
            totalMemoryBytes: this.totalBytes,
            maxMemoryBytes: this.maxMemoryBytes,
            memoryUsagePercent: (this.totalBytes / this.maxMemoryBytes * 100).toFixed(1),
            maxEntries: this.maxEntries,
            maxAge: this.maxAge,
        };
    }
}

/**
 * Page mapping - tracks section to page relationships
 * Uses typed arrays for memory efficiency
 */
export class PageMapping {
    constructor() {
        this.sectionPages = new Map();
        this.totalPages = 0;
    }

    setSection(sectionId, startPage, endPage) {
        this.sectionPages.set(sectionId, { startPage, endPage });
        if (endPage > this.totalPages) this.totalPages = endPage;
    }

    getSection(sectionId) {
        return this.sectionPages.get(sectionId);
    }

    getPagesForSections(sectionIds) {
        const pages = [];
        for (let i = 0; i < sectionIds.length; i++) {
            const range = this.sectionPages.get(sectionIds[i]);
            if (range) {
                for (let p = range.startPage; p <= range.endPage; p++) {
                    if (pages.indexOf(p) === -1) pages.push(p);
                }
            }
        }
        return pages.sort((a, b) => a - b);
    }

    toJSON() {
        return {
            sectionPages: Object.fromEntries(this.sectionPages),
            totalPages: this.totalPages,
        };
    }

    static fromJSON(data) {
        const mapping = new PageMapping();
        mapping.totalPages = data.totalPages;
        for (const [key, value] of Object.entries(data.sectionPages)) {
            mapping.sectionPages.set(key, value);
        }
        return mapping;
    }
}

/**
 * Counter state for LaTeX counter preservation
 * Minimal memory footprint
 */
export class CounterState {
    constructor() {
        this.counters = new Map();
    }

    set(name, value) {
        this.counters.set(name, value | 0);  // Ensure integer
    }

    get(name) {
        return this.counters.get(name);
    }

    toLatex() {
        const parts = [];
        for (const [name, value] of this.counters) {
            parts.push(`\\setcounter{${name}}{${value}}`);
        }
        return parts.join('\n');
    }

    static fromAuxContent(auxContent) {
        const state = new CounterState();
        if (!auxContent) return state;

        // Parse counter values efficiently
        const regex = /\\setcounter\{([^}]+)\}\{(\d+)\}/g;
        let m;
        while ((m = regex.exec(auxContent)) !== null) {
            state.set(m[1], parseInt(m[2], 10));
        }
        return state;
    }

    toJSON() {
        return Object.fromEntries(this.counters);
    }

    static fromJSON(data) {
        const state = new CounterState();
        if (data) {
            for (const [key, value] of Object.entries(data)) {
                state.set(key, value);
            }
        }
        return state;
    }
}

// Precompiled regex for aux parsing
const LABEL_REGEX = /\\newlabel\{([^}]+)\}\{\{([^}]*)\}\{(\d+)\}/g;

/**
 * Extract counter states at section boundaries
 * @param {string} auxContent
 * @param {Array} sections
 * @returns {Map<string, CounterState>}
 */
export function extractCounterStates(auxContent, sections) {
    const states = new Map();
    if (!auxContent || !sections.length) return states;

    // Parse all labels once
    const labels = [];
    LABEL_REGEX.lastIndex = 0;
    let m;
    while ((m = LABEL_REGEX.exec(auxContent)) !== null) {
        labels.push({
            name: m[1],
            ref: m[2],
            page: parseInt(m[3], 10),
        });
    }

    // Build states for each section
    for (let i = 0; i < sections.length; i++) {
        const section = sections[i];
        const state = new CounterState();

        // Find page for this section from labels
        if (labels.length > 0) {
            const lastLabel = labels[labels.length - 1];
            state.set('page', lastLabel.page);
        }

        states.set(section.id, state);
    }

    return states;
}

// Global cache singleton
let globalCache = null;

/**
 * Get or create global cache
 * @param {Object} options
 * @returns {CompilationCache}
 */
export function getGlobalCache(options) {
    if (!globalCache) {
        globalCache = new CompilationCache(options);
    }
    return globalCache;
}

/**
 * Reset global cache
 */
export function resetGlobalCache() {
    if (globalCache) {
        globalCache.clear();
    }
    globalCache = null;
}
