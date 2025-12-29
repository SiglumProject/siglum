/**
 * CompilerService - LaTeX compilation using BusyTeX
 *
 * Wraps the busytex-lazy BusyTeXCompiler to provide
 * in-browser LaTeX → PDF compilation.
 */

import { BusyTeXCompiler, detectEngine } from 'busytex-lazy';

// API endpoint for bundles and WASM
// In development, use local wrangler dev server (must run with --remote for R2 access)
// TEMP: Use production API for faster testing (local wrangler --remote adds latency)
const API_BASE = 'https://siglum-api.vtp-ips.workers.dev';
// const API_BASE = import.meta.env.DEV
//   ? 'http://localhost:8787'
//   : 'https://siglum-api.vtp-ips.workers.dev';

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

// Default idle timeout before unloading (5 minutes)
const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
// Shorter timeout when tab is hidden (30 seconds)
const HIDDEN_TAB_TIMEOUT_MS = 30 * 1000;

class CompilerService {
  private compiler: BusyTeXCompiler | null = null;
  private initPromise: Promise<void> | null = null;
  private statusCallbacks: Set<StatusCallback> = new Set();
  private logCallbacks: Set<LogCallback> = new Set();
  private currentStatus: CompileStatus = 'idle';
  private isInitializing = false;
  private compilePromise: Promise<CompileResult> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private autoUnloadEnabled = true;
  private idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS;
  private visibilityHandler: (() => void) | null = null;
  private isTabHidden = false;

  constructor() {
    this.setupVisibilityListener();
  }

  private setupVisibilityListener(): void {
    this.visibilityHandler = () => {
      if (!this.autoUnloadEnabled) return;

      const wasHidden = this.isTabHidden;
      this.isTabHidden = document.hidden;

      if (this.isTabHidden && !wasHidden && this.compiler) {
        // Tab just became hidden - start shorter timer
        this.log('Tab hidden - starting 30s unload timer');
        this.resetIdleTimer(HIDDEN_TAB_TIMEOUT_MS);
      } else if (!this.isTabHidden && wasHidden && this.compiler) {
        // Tab just became visible - reset to normal timer
        this.log('Tab visible - resetting to 5min timer');
        this.resetIdleTimer();
      }
    };
    document.addEventListener('visibilitychange', this.visibilityHandler);
  }

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

    // Reset idle timer when compilation finishes
    if (status === 'idle' || status === 'success' || status === 'error') {
      this.resetIdleTimer();
    } else {
      // Clear timer during active work
      this.clearIdleTimer();
    }
  }

  private log(message: string) {
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
    } catch (error) {
      this.isInitializing = false;
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
      // Use the actual TeX compile time from the worker, not the round-trip time
      const stats = result.stats as { compileTimeMs?: number } | undefined;
      const timeMs = stats?.compileTimeMs ?? (performance.now() - startTime);

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

  /**
   * Check if compiler is currently loaded in memory
   */
  isLoaded(): boolean {
    return this.compiler?.isLoaded() ?? false;
  }

  /**
   * Unload compiler to free memory (~500-800MB)
   * Disk caches (OPFS/IndexedDB) are preserved for offline use.
   */
  unload(): void {
    this.clearIdleTimer();
    if (this.compiler) {
      // Log memory before (Chrome only)
      const memBefore = (performance as any).memory?.usedJSHeapSize;

      this.compiler.unload();
      this.compiler = null;
      this.initPromise = null;

      // Log memory after (note: GC may not have run yet)
      const memAfter = (performance as any).memory?.usedJSHeapSize;
      if (memBefore && memAfter) {
        const savedMB = (memBefore - memAfter) / 1024 / 1024;
        this.log(`Compiler unloaded (JS heap: ${savedMB.toFixed(1)}MB freed, GC pending for WASM/worker)`);
      } else {
        this.log('Compiler unloaded to free memory');
      }
    }
  }

  /**
   * Enable/disable auto-unload when idle
   */
  setAutoUnload(enabled: boolean): void {
    this.autoUnloadEnabled = enabled;
    if (!enabled) {
      this.clearIdleTimer();
    } else if (this.currentStatus === 'idle' || this.currentStatus === 'success') {
      this.resetIdleTimer();
    }
    this.log(`Auto-unload ${enabled ? 'enabled' : 'disabled'}`);
  }

  /**
   * Get auto-unload setting
   */
  getAutoUnload(): boolean {
    return this.autoUnloadEnabled;
  }

  /**
   * Set idle timeout before auto-unload (in milliseconds)
   */
  setIdleTimeout(ms: number): void {
    this.idleTimeoutMs = ms;
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private resetIdleTimer(customTimeoutMs?: number): void {
    this.clearIdleTimer();
    if (this.autoUnloadEnabled && this.compiler) {
      const timeout = customTimeoutMs ?? this.idleTimeoutMs;
      const timeoutSec = Math.round(timeout / 1000);
      this.log(`Idle timer set: ${timeoutSec}s`);
      this.idleTimer = setTimeout(() => {
        if (this.currentStatus === 'idle' || this.currentStatus === 'success' || this.currentStatus === 'error') {
          this.log('Idle timeout reached - unloading compiler');
          this.unload();
        }
      }, timeout);
    }
  }
}

export default new CompilerService();
