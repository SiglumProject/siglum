/**
 * Tests for worker message handling protocol.
 * Tests the message types and data flow between main thread and worker.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Message types for worker communication
type MessageType =
    | 'init'
    | 'compile'
    | 'generate-format'
    | 'ready'
    | 'log'
    | 'progress'
    | 'compile-response'
    | 'format-generate-response'
    | 'ctan-fetch-request'
    | 'ctan-fetch-response'
    | 'bundle-fetch-request'
    | 'bundle-fetch-response'
    | 'file-range-fetch-request'
    | 'file-range-fetch-response'
    | 'memory-snapshot';

interface BaseMessage {
    type: MessageType;
}

interface InitMessage extends BaseMessage {
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

interface CompileMessage extends BaseMessage {
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

interface CompileResponse extends BaseMessage {
    type: 'compile-response';
    success: boolean;
    pdfData?: ArrayBuffer;
    pdfDataIsShared?: boolean;
    syncTexData?: Record<string, unknown>;
    stats?: {
        totalTime?: number;
        wasmTime?: number;
        vfsTime?: number;
        wasmHeapBytes?: number;
    };
    log?: string;
    error?: string;
    exitCode?: number;
    auxFilesToCache?: Record<string, unknown>;
}

interface CtanFetchRequest extends BaseMessage {
    type: 'ctan-fetch-request';
    requestId: string;
    packageName: string;
    fileName?: string;
    tlYear?: number;
}

interface CtanFetchResponse extends BaseMessage {
    type: 'ctan-fetch-response';
    requestId: string;
    packageName: string;
    success: boolean;
    files?: Record<string, Uint8Array>;
    dependencies?: string[];
    error?: string;
}

interface BundleFetchRequest extends BaseMessage {
    type: 'bundle-fetch-request';
    requestId: string;
    bundleName: string;
}

interface BundleFetchResponse extends BaseMessage {
    type: 'bundle-fetch-response';
    requestId: string;
    bundleName: string;
    success: boolean;
    bundleData?: ArrayBuffer;
    error?: string;
}

interface FileRangeFetchRequest extends BaseMessage {
    type: 'file-range-fetch-request';
    requestId: string;
    bundleName: string;
    start: number;
    end: number;
}

interface FileRangeFetchResponse extends BaseMessage {
    type: 'file-range-fetch-response';
    requestId: string;
    bundleName: string;
    start: number;
    end: number;
    success: boolean;
    data?: Uint8Array;
    error?: string;
}

interface MemorySnapshotMessage extends BaseMessage {
    type: 'memory-snapshot';
    snapshot: ArrayBuffer;
    byteLength: number;
    isShared: boolean;
}

describe('Worker Message Protocol', () => {
    describe('Init message', () => {
        it('should have required fields', () => {
            const msg: InitMessage = {
                type: 'init',
                wasmModule: { _mockModule: true },
                busytexJsUrl: 'http://test/busytex.js',
                manifest: {},
            };

            expect(msg.type).toBe('init');
            expect(msg.wasmModule).toBeDefined();
            expect(msg.busytexJsUrl).toBeDefined();
            expect(msg.manifest).toBeDefined();
        });

        it('should accept optional fields', () => {
            const msg: InitMessage = {
                type: 'init',
                wasmModule: {},
                busytexJsUrl: 'test.js',
                manifest: {},
                packageMapData: { amsmath: 'amsmath' },
                bundleDepsData: { engines: {} },
                bundleRegistryData: ['base', 'amsmath'],
                verbose: true,
                bundlesUrl: 'http://bundles/',
                memorySnapshot: new ArrayBuffer(100),
            };

            expect(msg.packageMapData).toBeDefined();
            expect(msg.bundleRegistryData).toContain('base');
            expect(msg.memorySnapshot?.byteLength).toBe(100);
        });
    });

    describe('Compile message', () => {
        it('should have required fields', () => {
            const msg: CompileMessage = {
                type: 'compile',
                id: 'compile-123',
                source: '\\documentclass{article}\\begin{document}Hello\\end{document}',
                engine: 'pdflatex',
                options: {},
                bundleNames: ['base'],
                bundlesUrl: 'http://bundles/',
            };

            expect(msg.type).toBe('compile');
            expect(msg.id).toBeDefined();
            expect(msg.source).toContain('documentclass');
            expect(msg.engine).toBe('pdflatex');
        });

        it('should accept compile options', () => {
            const msg: CompileMessage = {
                type: 'compile',
                id: 'compile-456',
                source: 'test',
                engine: 'xelatex',
                options: {
                    enableLazyFS: true,
                    enableCtan: true,
                    maxRetries: 5,
                    verbose: false,
                },
                bundleNames: [],
                bundlesUrl: '',
            };

            expect(msg.options.enableLazyFS).toBe(true);
            expect(msg.options.maxRetries).toBe(5);
        });

        it('should accept CTAN files', () => {
            const msg: CompileMessage = {
                type: 'compile',
                id: 'compile-789',
                source: 'test',
                engine: 'pdflatex',
                options: {},
                bundleNames: [],
                bundlesUrl: '',
                ctanFiles: {
                    '/texlive/test.sty': new Uint8Array([1, 2, 3]),
                },
            };

            expect(msg.ctanFiles?.['/texlive/test.sty']).toBeDefined();
        });

        it('should accept cached format', () => {
            const msg: CompileMessage = {
                type: 'compile',
                id: 'test',
                source: 'test',
                engine: 'pdflatex',
                options: {},
                bundleNames: [],
                bundlesUrl: '',
                cachedFormat: {
                    fmtName: 'test_pdflatex',
                    fmtData: new Uint8Array([0x54, 0x45, 0x58]),
                },
            };

            expect(msg.cachedFormat?.fmtName).toBe('test_pdflatex');
        });

        it('should accept deferred bundle names', () => {
            const msg: CompileMessage = {
                type: 'compile',
                id: 'test',
                source: 'test',
                engine: 'pdflatex',
                options: {},
                bundleNames: ['base'],
                bundlesUrl: '',
                deferredBundleNames: ['cm-super', 'fonts-extra'],
            };

            expect(msg.deferredBundleNames).toContain('cm-super');
        });
    });

    describe('Compile response', () => {
        it('should indicate success with PDF', () => {
            const response: CompileResponse = {
                type: 'compile-response',
                success: true,
                pdfData: new ArrayBuffer(1000),
                stats: {
                    totalTime: 1500,
                    wasmTime: 1200,
                },
                log: 'Compilation successful',
            };

            expect(response.success).toBe(true);
            expect(response.pdfData?.byteLength).toBe(1000);
        });

        it('should indicate failure with error', () => {
            const response: CompileResponse = {
                type: 'compile-response',
                success: false,
                error: 'Missing package: tikz',
                exitCode: 1,
                log: 'Error log...',
            };

            expect(response.success).toBe(false);
            expect(response.error).toContain('tikz');
            expect(response.exitCode).toBe(1);
        });

        it('should include memory stats', () => {
            const response: CompileResponse = {
                type: 'compile-response',
                success: true,
                stats: {
                    wasmHeapBytes: 64 * 1024 * 1024,
                },
            };

            expect(response.stats?.wasmHeapBytes).toBe(64 * 1024 * 1024);
        });

        it('should indicate SharedArrayBuffer usage', () => {
            const response: CompileResponse = {
                type: 'compile-response',
                success: true,
                pdfData: new ArrayBuffer(100),
                pdfDataIsShared: false,
            };

            expect(response.pdfDataIsShared).toBe(false);
        });

        it('should include aux files for caching', () => {
            const response: CompileResponse = {
                type: 'compile-response',
                success: true,
                auxFilesToCache: {
                    'document.aux': '\\relax',
                    'document.toc': '\\contentsline...',
                },
            };

            expect(response.auxFilesToCache?.['document.aux']).toBeDefined();
        });
    });

    describe('CTAN fetch request', () => {
        it('should request package by name', () => {
            const request: CtanFetchRequest = {
                type: 'ctan-fetch-request',
                requestId: 'ctan-001',
                packageName: 'tikz',
            };

            expect(request.requestId).toBe('ctan-001');
            expect(request.packageName).toBe('tikz');
        });

        it('should include optional file name for lookup', () => {
            const request: CtanFetchRequest = {
                type: 'ctan-fetch-request',
                requestId: 'ctan-002',
                packageName: 'algorithm',
                fileName: 'algorithm.sty',
            };

            expect(request.fileName).toBe('algorithm.sty');
        });

        it('should request specific TexLive year', () => {
            const request: CtanFetchRequest = {
                type: 'ctan-fetch-request',
                requestId: 'ctan-003',
                packageName: 'enumitem',
                tlYear: 2024,
            };

            expect(request.tlYear).toBe(2024);
        });
    });

    describe('CTAN fetch response', () => {
        it('should return files on success', () => {
            const response: CtanFetchResponse = {
                type: 'ctan-fetch-response',
                requestId: 'ctan-001',
                packageName: 'tikz',
                success: true,
                files: {
                    '/texlive/texmf-dist/tex/latex/tikz/tikz.sty': new Uint8Array([1, 2, 3]),
                },
                dependencies: ['pgf'],
            };

            expect(response.success).toBe(true);
            expect(response.files).toBeDefined();
            expect(response.dependencies).toContain('pgf');
        });

        it('should return error on failure', () => {
            const response: CtanFetchResponse = {
                type: 'ctan-fetch-response',
                requestId: 'ctan-002',
                packageName: 'nonexistent',
                success: false,
                error: 'Package not found',
            };

            expect(response.success).toBe(false);
            expect(response.error).toBe('Package not found');
        });
    });

    describe('Bundle fetch request', () => {
        it('should request bundle by name', () => {
            const request: BundleFetchRequest = {
                type: 'bundle-fetch-request',
                requestId: 'bundle-001',
                bundleName: 'cm-super',
            };

            expect(request.bundleName).toBe('cm-super');
        });
    });

    describe('Bundle fetch response', () => {
        it('should return bundle data on success', () => {
            const response: BundleFetchResponse = {
                type: 'bundle-fetch-response',
                requestId: 'bundle-001',
                bundleName: 'cm-super',
                success: true,
                bundleData: new ArrayBuffer(50000),
            };

            expect(response.success).toBe(true);
            expect(response.bundleData?.byteLength).toBe(50000);
        });

        it('should return error on failure', () => {
            const response: BundleFetchResponse = {
                type: 'bundle-fetch-response',
                requestId: 'bundle-002',
                bundleName: 'missing',
                success: false,
                error: 'Bundle not found',
            };

            expect(response.success).toBe(false);
            expect(response.error).toBe('Bundle not found');
        });
    });

    describe('File range fetch request', () => {
        it('should request specific byte range', () => {
            const request: FileRangeFetchRequest = {
                type: 'file-range-fetch-request',
                requestId: 'range-001',
                bundleName: 'cm-super',
                start: 1000,
                end: 5000,
            };

            expect(request.start).toBe(1000);
            expect(request.end).toBe(5000);
            expect(request.end - request.start).toBe(4000);
        });
    });

    describe('File range fetch response', () => {
        it('should return range data on success', () => {
            const response: FileRangeFetchResponse = {
                type: 'file-range-fetch-response',
                requestId: 'range-001',
                bundleName: 'cm-super',
                start: 1000,
                end: 5000,
                success: true,
                data: new Uint8Array(4000),
            };

            expect(response.success).toBe(true);
            expect(response.data?.length).toBe(4000);
        });

        it('should echo back range info', () => {
            const response: FileRangeFetchResponse = {
                type: 'file-range-fetch-response',
                requestId: 'range-002',
                bundleName: 'test',
                start: 100,
                end: 200,
                success: true,
                data: new Uint8Array(100),
            };

            expect(response.start).toBe(100);
            expect(response.end).toBe(200);
        });
    });

    describe('Memory snapshot message', () => {
        it('should include snapshot data', () => {
            const msg: MemorySnapshotMessage = {
                type: 'memory-snapshot',
                snapshot: new ArrayBuffer(64 * 1024 * 1024),
                byteLength: 64 * 1024 * 1024,
                isShared: false,
            };

            expect(msg.byteLength).toBe(64 * 1024 * 1024);
            expect(msg.isShared).toBe(false);
        });

        it('should indicate if SharedArrayBuffer', () => {
            const msg: MemorySnapshotMessage = {
                type: 'memory-snapshot',
                snapshot: new ArrayBuffer(100), // Would be SharedArrayBuffer in real code
                byteLength: 100,
                isShared: true,
            };

            expect(msg.isShared).toBe(true);
        });
    });

    describe('Message validation', () => {
        it('should require type field', () => {
            const validMsg = { type: 'log', message: 'test' };
            expect(validMsg.type).toBeDefined();
        });

        it('should handle all message types', () => {
            const types: MessageType[] = [
                'init',
                'compile',
                'generate-format',
                'ready',
                'log',
                'progress',
                'compile-response',
                'format-generate-response',
                'ctan-fetch-request',
                'ctan-fetch-response',
                'bundle-fetch-request',
                'bundle-fetch-response',
                'file-range-fetch-request',
                'file-range-fetch-response',
                'memory-snapshot',
            ];

            // All types should be valid
            expect(types.length).toBe(15);
        });
    });

    describe('Transfer list handling', () => {
        it('should identify transferable ArrayBuffers', () => {
            const buffer = new ArrayBuffer(100);
            const transfer: Transferable[] = [buffer];

            expect(transfer.length).toBe(1);
            expect(buffer.byteLength).toBe(100);
        });

        it('should handle multiple transfers', () => {
            const files: Record<string, Uint8Array> = {
                '/a.sty': new Uint8Array(100),
                '/b.sty': new Uint8Array(200),
            };

            const transferList: Transferable[] = [];
            for (const data of Object.values(files)) {
                const copy = data.buffer.slice(0);
                transferList.push(copy);
            }

            expect(transferList.length).toBe(2);
        });

        it('should slice buffers to preserve originals', () => {
            const original = new Uint8Array([1, 2, 3]);
            const copy = original.buffer.slice(0);

            expect(original.length).toBe(3);
            expect(copy.byteLength).toBe(3);
            // Original should still be valid after transfer
        });
    });

    describe('Promise resolution patterns', () => {
        it('should match request/response by requestId', () => {
            const pending = new Map<string, { resolve: (value: unknown) => void }>();

            // Simulate sending request
            const requestId = 'req-123';
            const promise = new Promise(resolve => {
                pending.set(requestId, { resolve });
            });

            // Simulate receiving response
            const response = { requestId, success: true, data: 'result' };
            const handler = pending.get(response.requestId);
            if (handler) {
                handler.resolve(response);
                pending.delete(response.requestId);
            }

            expect(pending.size).toBe(0);
        });

        it('should handle timeout cleanup', () => {
            vi.useFakeTimers();

            const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
            const requestId = 'req-456';

            const promise = new Promise((resolve, reject) => {
                pending.set(requestId, { resolve, reject });

                setTimeout(() => {
                    if (pending.has(requestId)) {
                        pending.get(requestId)!.reject(new Error('Timeout'));
                        pending.delete(requestId);
                    }
                }, 5000);
            });
            // Attach a handler so the timeout rejection isn't reported as unhandled
            // when advanceTimersByTime fires it below.
            promise.catch(() => {});

            vi.advanceTimersByTime(6000);

            expect(pending.has(requestId)).toBe(false);

            vi.useRealTimers();
        });
    });
});
