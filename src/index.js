// siglum-engine - Browser-based LaTeX compilation with lazy loading

export { SiglumCompiler, BusyTeXCompiler } from './compiler.js';
export { BundleManager, detectEngine, extractPreamble, hashPreamble } from './bundles.js';
export { CTANFetcher, getPackageFromFile, isValidPackageName, forceRefreshPackage } from './ctan.js';
export {
    clearCTANCache,
    hashDocument,
    getCachedPdf,
    saveCachedPdf,
    listAllCachedPackages,
} from './storage.js';

// New citation system (recommended)
export {
    CitationProvider,
    CitationManager,
    getCitationManager,
    ZoteroProvider,
    getZoteroProvider,
    initCitations,
} from './citations/index.js';

// Legacy Zotero exports (deprecated - use citations module instead)
export {
    ZoteroService,
    getZoteroService,
    getZoteroConfig,
    saveZoteroConfig,
    disconnectZotero,
    getCachedLibrary,
    searchLibrary,
    itemToBibtex,
} from './zotero.js';
