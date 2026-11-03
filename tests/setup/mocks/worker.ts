/**
 * Worker mock for testing siglum-engine compiler.
 * Simulates the worker's message handling behavior.
 */

import { vi } from 'vitest';

export interface WorkerMessage {
    type: string;
    [key: string]: unknown;
}

export interface CompileMessage extends WorkerMessage {
    type: 'compile';
    id: string;
    source: string;
    engine: string;
    options: {
        enableLazyFS?: boolean;
        enableCtan?: boolean;
        maxRetries?: number;
        verbose?: boolean;
    };
    bundleNames: string[];
    bundlesUrl: string;
    ctanFiles?: Record<string, Uint8Array>;
    cachedFormat?: { fmtName: string; fmtData: Uint8Array } | null;
    cachedAuxFiles?: Record<string, unknown> | null;
    deferredBundleNames?: string[];
}

export interface InitMessage extends WorkerMessage {
    type: 'init';
    wasmModule: unknown;
    busytexJsUrl: string;
    manifest: Record<string, unknown>;
    packageMapData?: Record<string, string>;
    bundleDepsData?: Record<string, unknown>;
    bundleRegistryData?: string[];
    verbose?: boolean;
    bundlesUrl?: string;
    memorySnapshot?: ArrayBuffer;
}

export interface GenerateFormatMessage extends WorkerMessage {
    type: 'generate-format';
    id: string;
    preambleContent: string;
    engine: string;
    manifest: Record<string, unknown>;
    bundleNames: string[];
    bundlesUrl: string;
    ctanFiles?: Record<string, Uint8Array>;
    maxRetries?: number;
}

export interface WorkerResponse {
    type: string;
    [key: string]: unknown;
}

export interface CompileResponse extends WorkerResponse {
    type: 'compile-response';
    success: boolean;
    pdfData?: ArrayBuffer;
    pdfDataIsShared?: boolean;
    syncTexData?: Record<string, unknown>;
    stats?: Record<string, unknown>;
    log?: string;
    error?: string;
    exitCode?: number;
    auxFilesToCache?: Record<string, unknown>;
}

export interface FormatResponse extends WorkerResponse {
    type: 'format-generate-response';
    success: boolean;
    formatData?: ArrayBuffer;
    error?: string;
}

export type MessageHandler = (message: WorkerMessage) => WorkerResponse | WorkerResponse[] | null | Promise<WorkerResponse | WorkerResponse[] | null>;

/**
 * Creates a mock worker for testing the compiler.
 * Allows configuring message handlers for different message types.
 */
export class MockCompilerWorker {
    public onmessage: ((event: MessageEvent) => void) | null = null;
    public onerror: ((event: ErrorEvent) => void) | null = null;
    public scriptURL: string | URL;
    public _workerId?: number;

    private handlers: Map<string, MessageHandler> = new Map();
    private defaultHandlers: Map<string, MessageHandler>;
    private terminated = false;

    constructor(scriptURL: string | URL = 'worker.js') {
        this.scriptURL = scriptURL;

        // Set up default handlers
        this.defaultHandlers = new Map([
            ['init', this.handleInit.bind(this)],
            ['compile', this.handleCompile.bind(this)],
            ['generate-format', this.handleGenerateFormat.bind(this)],
        ]);
    }

    postMessage(message: unknown, transfer?: Transferable[]): void {
        if (this.terminated) return;

        const msg = message as WorkerMessage;
        const handler = this.handlers.get(msg.type) || this.defaultHandlers.get(msg.type);

        // Simulate async processing
        setTimeout(async () => {
            if (this.terminated) return;

            try {
                if (handler) {
                    const response = await handler(msg);
                    if (response) {
                        const responses = Array.isArray(response) ? response : [response];
                        for (const resp of responses) {
                            this.sendResponse(resp);
                        }
                    }
                }
            } catch (e) {
                if (this.onerror) {
                    this.onerror(new ErrorEvent('error', { error: e, message: (e as Error).message }));
                }
            }
        }, 0);
    }

    terminate(): void {
        this.terminated = true;
        this.handlers.clear();
        this.onmessage = null;
        this.onerror = null;
    }

    // Test utility: set custom handler for message type
    setHandler(type: string, handler: MessageHandler): void {
        this.handlers.set(type, handler);
    }

    // Test utility: remove custom handler
    removeHandler(type: string): void {
        this.handlers.delete(type);
    }

    // Test utility: send a response directly
    sendResponse(data: WorkerResponse): void {
        if (this.onmessage && !this.terminated) {
            this.onmessage(new MessageEvent('message', { data }));
        }
    }

    // Test utility: send an error
    sendError(error: Error): void {
        if (this.onerror && !this.terminated) {
            this.onerror(new ErrorEvent('error', { error, message: error.message }));
        }
    }

    // Test utility: request CTAN fetch
    requestCtanFetch(requestId: string, packageName: string, fileName?: string, tlYear?: number): void {
        this.sendResponse({
            type: 'ctan-fetch-request',
            requestId,
            packageName,
            fileName,
            tlYear,
        });
    }

    // Test utility: request bundle fetch
    requestBundleFetch(requestId: string, bundleName: string): void {
        this.sendResponse({
            type: 'bundle-fetch-request',
            requestId,
            bundleName,
        });
    }

    // Test utility: request file range fetch
    requestFileRangeFetch(requestId: string, bundleName: string, start: number, end: number): void {
        this.sendResponse({
            type: 'file-range-fetch-request',
            requestId,
            bundleName,
            start,
            end,
        });
    }

    // Test utility: send memory snapshot
    sendMemorySnapshot(snapshot: ArrayBuffer, byteLength: number, isShared = false): void {
        this.sendResponse({
            type: 'memory-snapshot',
            snapshot,
            byteLength,
            isShared,
        });
    }

    // Default handler: init
    private handleInit(msg: InitMessage): WorkerResponse {
        return { type: 'ready' };
    }

    // Default handler: compile
    private handleCompile(msg: CompileMessage): CompileResponse {
        // Create a simple PDF-like response
        const pdfContent = new TextEncoder().encode('%PDF-1.4 mock pdf');
        return {
            type: 'compile-response',
            success: true,
            pdfData: pdfContent.buffer,
            pdfDataIsShared: false,
            stats: {
                totalTime: 100,
                wasmTime: 80,
                vfsTime: 20,
            },
            log: 'Mock compilation log',
        };
    }

    // Default handler: generate-format
    private handleGenerateFormat(msg: GenerateFormatMessage): FormatResponse {
        const formatContent = new TextEncoder().encode('mock format data');
        return {
            type: 'format-generate-response',
            success: true,
            formatData: formatContent.buffer,
        };
    }
}

// Factory function to create worker mock for vi.mock
export function createMockWorkerConstructor(): typeof Worker {
    return class extends MockCompilerWorker {
        constructor(scriptURL: string | URL, options?: WorkerOptions) {
            super(scriptURL);
        }
    } as unknown as typeof Worker;
}

// Preset configurations for common test scenarios

export interface CompileScenario {
    success: boolean;
    pdf?: boolean;
    error?: string;
    exitCode?: number;
    auxFiles?: Record<string, unknown>;
    syncTexData?: Record<string, unknown>;
}

/**
 * Configure worker to respond with specific compile scenario.
 */
export function configureCompileScenario(worker: MockCompilerWorker, scenario: CompileScenario): void {
    worker.setHandler('compile', (msg: WorkerMessage) => {
        if (scenario.success) {
            const pdfContent = scenario.pdf !== false
                ? new TextEncoder().encode('%PDF-1.4 mock pdf')
                : undefined;
            return {
                type: 'compile-response',
                success: true,
                pdfData: pdfContent?.buffer,
                pdfDataIsShared: false,
                stats: { totalTime: 100 },
                log: 'Success',
                auxFilesToCache: scenario.auxFiles,
                syncTexData: scenario.syncTexData,
            };
        } else {
            return {
                type: 'compile-response',
                success: false,
                error: scenario.error || 'Compilation failed',
                exitCode: scenario.exitCode ?? 1,
                log: 'Error log',
            };
        }
    });
}

/**
 * Configure worker to simulate CTAN fetch during compile.
 */
export function configureCtanFetchScenario(
    worker: MockCompilerWorker,
    packageName: string,
    onFetch: (requestId: string) => void
): void {
    worker.setHandler('compile', (msg: WorkerMessage) => {
        // First request CTAN package
        const requestId = 'ctan-' + Date.now();
        worker.requestCtanFetch(requestId, packageName);
        onFetch(requestId);

        // Return success after (in real scenario, would wait for response)
        return {
            type: 'compile-response',
            success: true,
            pdfData: new TextEncoder().encode('%PDF').buffer,
            log: 'Success with CTAN fetch',
        };
    });
}

/**
 * Configure worker to timeout on init (never send ready).
 */
export function configureInitTimeout(worker: MockCompilerWorker): void {
    worker.setHandler('init', () => null); // Never respond
}

/**
 * Configure worker to fail on init.
 */
export function configureInitError(worker: MockCompilerWorker, error: Error): void {
    worker.setHandler('init', () => {
        throw error;
    });
}
