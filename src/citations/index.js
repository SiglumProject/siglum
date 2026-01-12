// Citations module - Unified citation provider system
//
// This module provides a provider-agnostic citation system with:
// - Memory-efficient search (API-based for Zotero, indexed for BibTeX)
// - Hybrid caching (online API search, offline cached items)
// - Unified search across multiple providers
// - Bibliography generation for LaTeX compilation

// Base provider class
export { CitationProvider } from './provider.js';

// Zotero provider
export { ZoteroProvider, getZoteroProvider } from './zotero.js';

// Citation manager (orchestrator)
export { CitationManager, getCitationManager } from './manager.js';

// Re-export default instances for convenience
import { getZoteroProvider } from './zotero.js';
import { getCitationManager } from './manager.js';

/**
 * Initialize the citation system with default providers
 * @param {Object} options - Configuration options
 * @param {string} options.proxyUrl - API proxy URL for Zotero
 * @returns {CitationManager} Configured citation manager
 */
export function initCitations(options = {}) {
    const manager = getCitationManager();

    // Register Zotero provider
    const zotero = getZoteroProvider({
        proxyUrl: options.proxyUrl || 'http://localhost:8787',
    });
    manager.registerProvider('zotero', zotero);

    // Initialize Zotero from saved config
    zotero.init().catch(() => {
        // No saved config or init failed - that's OK
    });

    return manager;
}
