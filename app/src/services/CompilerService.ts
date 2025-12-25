/**
 * CompilerService - LaTeX compilation using BusyTeX
 *
 * Wraps the busytex-lazy BusyTeXCompiler to provide
 * in-browser LaTeX → PDF compilation.
 */

import { BusyTeXCompiler, detectEngine } from 'busytex-lazy';

// API endpoint for bundles and WASM
const API_BASE = 'https://siglum-api.vtp-ips.workers.dev';

// Workers must be same-origin - serve from /worker.js in public folder
const WORKER_URL = '/worker.js';

export type CompileStatus = 'idle' | 'initializing' | 'compiling' | 'success' | 'error';

export interface CompileResult {
  success: boolean;
  pdf?: Uint8Array;
  error?: string;
  log?: string;
  cached?: boolean;
  timeMs?: number;
}

export interface CompilerStats {
  bundles: {
    bundlesCached: number;
    bytesDownloaded: number;
    cacheHits: number;
  };
  ctan: {
    fetchCount: number;
  };
}

type StatusCallback = (status: CompileStatus, detail?: string) => void;
type LogCallback = (message: string) => void;

class CompilerService {
  private compiler: BusyTeXCompiler | null = null;
  private initPromise: Promise<void> | null = null;
  private statusCallbacks: Set<StatusCallback> = new Set();
  private logCallbacks: Set<LogCallback> = new Set();
  private currentStatus: CompileStatus = 'idle';
  private isInitializing = false;
  private compilePromise: Promise<CompileResult> | null = null;

  /**
   * Subscribe to status changes
   */
  onStatus(callback: StatusCallback): () => void {
    this.statusCallbacks.add(callback);
    // Immediately call with current status
    callback(this.currentStatus);
    return () => this.statusCallbacks.delete(callback);
  }

  /**
   * Subscribe to log messages
   */
  onLog(callback: LogCallback): () => void {
    this.logCallbacks.add(callback);
    return () => this.logCallbacks.delete(callback);
  }

  private setStatus(status: CompileStatus, detail?: string) {
    this.currentStatus = status;
    this.statusCallbacks.forEach(cb => cb(status, detail));
  }

  private log(message: string) {
    console.log('[Compiler]', message);
    this.logCallbacks.forEach(cb => cb(message));
  }

  /**
   * Initialize the compiler (lazy - only called when needed)
   */
  async initialize(): Promise<void> {
    if (this.compiler) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = this._initialize();
    return this.initPromise;
  }

  private async _initialize(): Promise<void> {
    this.isInitializing = true;
    this.setStatus('initializing', 'Loading compiler...');
    console.log('[CompilerService] Initializing...');

    try {
      this.compiler = new BusyTeXCompiler({
        bundlesUrl: `${API_BASE}/bundles`,
        wasmUrl: `${API_BASE}/wasm/busytex.wasm`,
        workerUrl: WORKER_URL,
        ctanProxyUrl: API_BASE,
        xzwasmUrl: import.meta.env.DEV ? '/src/xzwasm.js' : `${API_BASE}/xzwasm.js`,
        enableCtan: true,
        enableLazyFS: true,
        enableDocCache: false, // Disabled - causes detached ArrayBuffer errors on doc switch
        onLog: (msg: string) => this.log(msg),
        onProgress: (stage: string, detail?: string) => {
          // Only set 'initializing' status during actual initialization
          // (format generation also triggers progress callbacks)
          if (this.isInitializing) {
            this.setStatus('initializing', `${stage}: ${detail || ''}`);
          }
        },
      });

      await this.compiler.init();
      this.isInitializing = false;
      this.setStatus('idle');
      this.log('Compiler ready');
      console.log('[CompilerService] Initialized successfully');
    } catch (error) {
      this.isInitializing = false;
      console.error('[CompilerService] Init failed:', error);
      this.setStatus('error', (error as Error).message);
      throw error;
    }
  }

  /**
   * Compile LaTeX source to PDF
   */
  async compile(source: string, options: { engine?: 'pdflatex' | 'xelatex' | 'auto' } = {}): Promise<CompileResult> {
    // Wait for any existing compilation to finish to prevent concurrent WASM access
    if (this.compilePromise) {
      this.log('Waiting for previous compilation to finish...');
      try {
        await this.compilePromise;
      } catch {
        // Ignore errors from previous compile
      }
    }

    // Start new compilation
    this.compilePromise = this._compile(source, options);
    const result = await this.compilePromise;
    this.compilePromise = null;
    return result;
  }

  private async _compile(source: string, options: { engine?: 'pdflatex' | 'xelatex' | 'auto' } = {}): Promise<CompileResult> {
    const startTime = performance.now();

    try {
      // Initialize if needed
      await this.initialize();

      if (!this.compiler) {
        throw new Error('Compiler not initialized');
      }

      this.setStatus('compiling', 'Compiling...');

      // Auto-detect engine if not specified
      const engine = options.engine === 'auto' || !options.engine
        ? detectEngine(source)
        : options.engine;

      const result = await this.compiler.compile(source, { engine });
      const timeMs = performance.now() - startTime;

      if (result.success) {
        this.setStatus('success');
        return {
          success: true,
          pdf: result.pdf,
          cached: result.cached,
          log: result.log,
          timeMs,
        };
      } else {
        this.setStatus('error', result.error);
        return {
          success: false,
          error: result.error,
          log: result.log,
          timeMs,
        };
      }
    } catch (error) {
      const timeMs = performance.now() - startTime;
      this.setStatus('error', (error as Error).message);
      return {
        success: false,
        error: (error as Error).message,
        timeMs,
      };
    }
  }

  /**
   * Get compilation statistics
   */
  getStats(): CompilerStats | null {
    if (!this.compiler) return null;
    return this.compiler.getStats();
  }

  /**
   * Clear all caches
   */
  async clearCache(): Promise<void> {
    if (this.compiler) {
      await this.compiler.clearCache();
      this.log('Cache cleared');
    }
  }

  /**
   * Generate a format file (pre-compiled preamble) for faster subsequent compiles
   */
  async generateFormat(source: string, options: { engine?: 'pdflatex' | 'xelatex' | 'auto' } = {}): Promise<boolean> {
    try {
      await this.initialize();

      if (!this.compiler) {
        throw new Error('Compiler not initialized');
      }

      // Auto-detect engine if not specified
      const engine = options.engine === 'auto' || !options.engine
        ? detectEngine(source)
        : options.engine;

      this.log('Generating format for ' + engine + '...');
      await this.compiler.generateFormat(source, { engine });
      this.log('Format generated successfully');
      return true;
    } catch (error) {
      console.error('[CompilerService] generateFormat failed:', error);
      this.log('Format generation error: ' + (error as Error).message);
      return false;
    }
  }

  /**
   * Get current status
   */
  getStatus(): CompileStatus {
    return this.currentStatus;
  }

  /**
   * Check if compiler is ready
   */
  isReady(): boolean {
    return this.compiler !== null;
  }
}

export default new CompilerService();
