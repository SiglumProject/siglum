// CitationProvider - Base class for citation providers
// Subclasses: ZoteroProvider, BibtexProvider, MendeleyProvider (future)

/**
 * Base class for citation providers.
 * All providers must implement search, getItem, and getBibtex methods.
 */
export class CitationProvider {
    constructor(options = {}) {
        this.id = options.id || 'unknown';
        this.name = options.name || 'Unknown Provider';
        this.proxyUrl = options.proxyUrl || '';
    }

    /**
     * Check if this provider is connected/ready
     * @returns {boolean}
     */
    isConnected() {
        return false;
    }

    /**
     * Get current status
     * @returns {Object} Status object with connected, syncing, itemCount, etc.
     */
    getStatus() {
        return {
            connected: false,
            syncing: false,
            itemCount: 0,
        };
    }

    /**
     * Subscribe to status changes
     * @param {Function} callback - Called with status object on changes
     * @returns {Function} Unsubscribe function
     */
    onStatus(callback) {
        // Base implementation - override in subclasses
        callback(this.getStatus());
        return () => {};
    }

    /**
     * Search for citations
     * @param {string} query - Search query
     * @param {number} limit - Max results to return
     * @returns {Promise<Array>} Array of citation objects
     */
    async search(query, limit = 20) {
        throw new Error('search() must be implemented by subclass');
    }

    /**
     * Get a single citation by ID
     * @param {string} id - Citation ID
     * @returns {Promise<Object|null>} Citation object or null
     */
    async getItem(id) {
        throw new Error('getItem() must be implemented by subclass');
    }

    /**
     * Get a citation by its cite key
     * @param {string} citeKey - The citation key (e.g., "smith2024quantum")
     * @returns {Promise<Object|null>} Citation object or null
     */
    async getItemByCiteKey(citeKey) {
        throw new Error('getItemByCiteKey() must be implemented by subclass');
    }

    /**
     * Generate BibTeX for a citation
     * @param {Object} item - Citation object
     * @returns {string} BibTeX string
     */
    getBibtex(item) {
        throw new Error('getBibtex() must be implemented by subclass');
    }

    /**
     * Track that a citation has been used (for caching/bibliography)
     * @param {Object} item - Citation object
     */
    async trackUsed(item) {
        // Override in subclasses that support caching
    }

    /**
     * Connect to the provider with credentials
     * @param {Object} credentials - Provider-specific credentials
     */
    async connect(credentials) {
        throw new Error('connect() must be implemented by subclass');
    }

    /**
     * Disconnect from the provider
     */
    async disconnect() {
        throw new Error('disconnect() must be implemented by subclass');
    }

    /**
     * Initialize from saved configuration
     * @returns {Promise<boolean>} True if successfully initialized
     */
    async init() {
        return false;
    }
}
