// Centralized hashing using BLAKE3 (WASM) for ~10x faster hashing on large documents
// Falls back to DJB2 for sync contexts before BLAKE3 is initialized

let blake3Module = null;
let blake3LoadPromise = null;

// 8 bytes = 64-bit hash, sufficient for change detection (not cryptographic security)
const HASH_LENGTH = 8;
// Skip WASM overhead for tiny inputs where DJB2 is faster
const SMALL_INPUT_THRESHOLD = 128;
// Pre-allocated options object to avoid allocation on every hash call
const BLAKE3_OPTIONS = Object.freeze({ length: HASH_LENGTH });

/**
 * DJB2 hash - fast fallback for small inputs or before BLAKE3 loads
 * @param {string} content
 * @returns {string} hex hash
 */
function djb2Hash(content) {
    let hash = 5381 >>> 0;
    const len = content.length;
    for (let i = 0; i < len; i++) {
        hash = ((hash * 33) ^ content.charCodeAt(i)) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
}

/**
 * Initialize BLAKE3 module (called once, cached)
 * @returns {Promise<object>}
 */
async function loadBlake3() {
    if (blake3Module) return blake3Module;
    if (blake3LoadPromise) return blake3LoadPromise;

    blake3LoadPromise = import('blake3-wasm/browser.js').then(module => {
        blake3Module = module;
        return module;
    }).catch(err => {
        console.warn('BLAKE3 load failed, using DJB2 fallback:', err.message);
        return null;
    });

    return blake3LoadPromise;
}

/**
 * Hash content using BLAKE3 (async, preferred for large documents)
 * @param {string} content
 * @returns {Promise<string>} hex hash
 */
export async function hashAsync(content) {
    // Use DJB2 for small inputs - WASM overhead not worth it
    if (content.length < SMALL_INPUT_THRESHOLD) {
        return djb2Hash(content);
    }
    const module = await loadBlake3();
    if (module) {
        return module.hash(content, BLAKE3_OPTIONS).toString('hex');
    }
    return djb2Hash(content);
}

/**
 * Hash content synchronously - uses BLAKE3 if loaded, else DJB2
 * Call initHash() early to ensure BLAKE3 is available for sync hashing
 * @param {string} content
 * @returns {string} hex hash
 */
export function hashSync(content) {
    // Use DJB2 for small inputs - WASM overhead not worth it
    if (content.length < SMALL_INPUT_THRESHOLD) {
        return djb2Hash(content);
    }
    if (blake3Module) {
        return blake3Module.hash(content, BLAKE3_OPTIONS).toString('hex');
    }
    return djb2Hash(content);
}

/**
 * Initialize BLAKE3 for use with hashSync
 * Call this early in app startup for best performance
 * @returns {Promise<boolean>} true if BLAKE3 loaded successfully
 */
export async function initHash() {
    const module = await loadBlake3();
    return !!module;
}

/**
 * Check if BLAKE3 is ready for sync hashing
 * @returns {boolean}
 */
export function isBlake3Ready() {
    return !!blake3Module;
}

// Legacy export names for drop-in replacement
export { hashSync as hashContent };
export { hashSync as hashDocument };
export { hashSync as hashPreamble };
