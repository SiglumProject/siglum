/**
 * Resolve once when creating a compiler, then retain its immutable URLs.
 * A verified descriptor and manifest are cached together for offline reopen.
 * Only network failures can reuse that same service/SDK cache entry.
 * @param {ResolveRuntimeOptions} [options]
 * @returns {Promise<ResolvedRuntime>}
 */
export function resolveRuntime(options?: ResolveRuntimeOptions): Promise<ResolvedRuntime>;
export type RuntimeDescriptor = {
    schemaVersion: 1;
    engineVersion: string;
    releaseId: string;
    baseUrl: string;
    manifestUrl: string;
    manifestSha256: string;
};
export type ResolvedRuntime = {
    engineVersion: string;
    releaseId: string;
    texLiveYear: number;
    /**
     * - Immutable runtime base URL
     */
    baseUrl: string;
    manifestUrl: string;
    manifestSha256: string;
    wasmUrl: string;
    jsUrl: string;
    bundlesUrl: string;
    ctanProxyUrl: string;
    xzwasmUrl: string;
};
export type ResolveRuntimeOptions = {
    /**
     * - Service base URL, defaults to https://packages.siglum.org
     */
    baseUrl?: string;
    /**
     * - Fetch implementation
     */
    fetch?: typeof globalThis.fetch;
    /**
     * - Persistent cache, or null to disable it
     */
    cacheStorage?: CacheStorage | null;
};
