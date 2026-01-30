/**
 * @module @siglum/engine
 * Browser-based LaTeX compilation with lazy bundle loading.
 *
 * @example
 * ```js
 * import { SiglumCompiler } from '@siglum/engine';
 *
 * const compiler = new SiglumCompiler({
 *   bundlesUrl: '/bundles',
 *   onLog: console.log
 * });
 *
 * await compiler.init();
 * const result = await compiler.compile('\\documentclass{article}...');
 * if (result.pdf) {
 *   // Use result.pdf (Uint8Array)
 * }
 * ```
 */

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
export { createBatchedLogger } from './utils.js';
