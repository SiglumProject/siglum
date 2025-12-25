declare module 'busytex-lazy' {
  export interface CompilerOptions {
    bundlesUrl?: string;
    wasmUrl?: string;
    xzwasmUrl?: string;
    workerUrl?: string;
    ctanProxyUrl?: string;
    enableCtan?: boolean;
    enableLazyFS?: boolean;
    enableDocCache?: boolean;
    onLog?: (msg: string) => void;
    onProgress?: (stage: string, detail?: string) => void;
  }

  export interface CompileOptions {
    engine?: 'pdflatex' | 'xelatex';
    useCache?: boolean;
    additionalFiles?: Record<string, string | Uint8Array>;
  }

  export interface CompileResult {
    success: boolean;
    pdf?: Uint8Array;
    error?: string;
    log?: string;
    cached?: boolean;
    stats?: Record<string, unknown>;
    exitCode?: number;
  }

  export interface BundleStats {
    bundlesCached: number;
    bytesDownloaded: number;
    cacheHits: number;
  }

  export interface CTANStats {
    fetchCount: number;
  }

  export interface CompilerStats {
    bundles: BundleStats;
    ctan: CTANStats;
  }

  export class BusyTeXCompiler {
    constructor(options?: CompilerOptions);
    init(): Promise<void>;
    compile(source: string, options?: CompileOptions): Promise<CompileResult>;
    generateFormat(source: string, options?: { engine?: string }): Promise<Uint8Array>;
    clearCache(): Promise<void>;
    getStats(): CompilerStats;
    terminate(): void;
    enableCtan: boolean;
    enableLazyFS: boolean;
    enableDocCache: boolean;
  }

  export function detectEngine(source: string): 'pdflatex' | 'xelatex';
  export function extractPreamble(source: string): string | null;
  export function hashPreamble(preamble: string): string;
  export function hashDocument(source: string): string;
  export function clearCTANCache(): Promise<void>;
  export function getCachedPdf(hash: string, engine: string): Promise<ArrayBuffer | null>;
  export function saveCachedPdf(hash: string, engine: string, data: ArrayBuffer): Promise<void>;
  export function listAllCachedPackages(): Promise<string[]>;
}
