/**
 * Browser API mocks for testing siglum-engine.
 * Provides mocks for Cache API, OPFS, WebAssembly, and Navigator.
 */

import { vi } from 'vitest';

// ============ Cache API Mocks ============

interface CacheEntry {
    response: Response;
}

let mockCacheStorage: Map<string, Map<string, CacheEntry>> = new Map();

export class MockCache {
    private name: string;

    constructor(name: string) {
        this.name = name;
        if (!mockCacheStorage.has(name)) {
            mockCacheStorage.set(name, new Map());
        }
    }

    async match(request: RequestInfo | URL): Promise<Response | undefined> {
        const url = this._getUrl(request);
        const cache = mockCacheStorage.get(this.name);
        const entry = cache?.get(url);
        if (entry) {
            // Clone the response to simulate real Cache API behavior
            return entry.response.clone();
        }
        return undefined;
    }

    async put(request: RequestInfo | URL, response: Response): Promise<void> {
        const url = this._getUrl(request);
        const cache = mockCacheStorage.get(this.name);
        if (cache) {
            cache.set(url, { response: response.clone() });
        }
    }

    async delete(request: RequestInfo | URL): Promise<boolean> {
        const url = this._getUrl(request);
        const cache = mockCacheStorage.get(this.name);
        return cache?.delete(url) ?? false;
    }

    async keys(): Promise<readonly Request[]> {
        const cache = mockCacheStorage.get(this.name);
        if (!cache) return [];
        return Array.from(cache.keys()).map(url => new Request(url));
    }

    private _getUrl(request: RequestInfo | URL): string {
        if (typeof request === 'string') return request;
        if (request instanceof URL) return request.href;
        return request.url;
    }
}

export class MockCacheStorage {
    async open(cacheName: string): Promise<MockCache> {
        return new MockCache(cacheName);
    }

    async has(cacheName: string): Promise<boolean> {
        return mockCacheStorage.has(cacheName);
    }

    async delete(cacheName: string): Promise<boolean> {
        return mockCacheStorage.delete(cacheName);
    }

    async keys(): Promise<string[]> {
        return Array.from(mockCacheStorage.keys());
    }
}

export function resetMockCacheStorage(): void {
    mockCacheStorage = new Map();
}

// ============ OPFS / File System Access API Mocks ============

interface MockFileEntry {
    kind: 'file';
    name: string;
    content: Uint8Array;
}

interface MockDirectoryEntry {
    kind: 'directory';
    name: string;
    entries: Map<string, MockFileEntry | MockDirectoryEntry>;
}

let opfsRoot: MockDirectoryEntry = {
    kind: 'directory',
    name: '',
    entries: new Map(),
};

export class MockFileSystemFileHandle {
    private entry: MockFileEntry;

    constructor(entry: MockFileEntry) {
        this.entry = entry;
    }

    get kind(): 'file' {
        return 'file';
    }

    get name(): string {
        return this.entry.name;
    }

    async getFile(): Promise<File> {
        return new File([this.entry.content], this.entry.name);
    }

    async createWritable(): Promise<MockFileSystemWritableFileStream> {
        return new MockFileSystemWritableFileStream(this.entry);
    }
}

export class MockFileSystemWritableFileStream {
    private entry: MockFileEntry;
    private chunks: Uint8Array[] = [];

    constructor(entry: MockFileEntry) {
        this.entry = entry;
    }

    async write(data: BufferSource | Blob | string): Promise<void> {
        let bytes: Uint8Array;
        if (data instanceof Uint8Array) {
            bytes = data;
        } else if (data instanceof ArrayBuffer) {
            bytes = new Uint8Array(data);
        } else if (typeof data === 'string') {
            bytes = new TextEncoder().encode(data);
        } else if (data instanceof Blob) {
            bytes = new Uint8Array(await data.arrayBuffer());
        } else {
            bytes = new Uint8Array((data as ArrayBufferView).buffer);
        }
        this.chunks.push(bytes);
    }

    async close(): Promise<void> {
        // Concatenate all chunks
        const totalLength = this.chunks.reduce((sum, chunk) => sum + chunk.length, 0);
        const result = new Uint8Array(totalLength);
        let offset = 0;
        for (const chunk of this.chunks) {
            result.set(chunk, offset);
            offset += chunk.length;
        }
        this.entry.content = result;
    }
}

export class MockFileSystemDirectoryHandle {
    private entry: MockDirectoryEntry;

    constructor(entry: MockDirectoryEntry) {
        this.entry = entry;
    }

    get kind(): 'directory' {
        return 'directory';
    }

    get name(): string {
        return this.entry.name;
    }

    async getFileHandle(
        name: string,
        options?: { create?: boolean }
    ): Promise<MockFileSystemFileHandle> {
        let fileEntry = this.entry.entries.get(name);
        if (!fileEntry) {
            if (options?.create) {
                fileEntry = { kind: 'file', name, content: new Uint8Array(0) };
                this.entry.entries.set(name, fileEntry);
            } else {
                throw new DOMException('File not found', 'NotFoundError');
            }
        }
        if (fileEntry.kind !== 'file') {
            throw new DOMException('Not a file', 'TypeMismatchError');
        }
        return new MockFileSystemFileHandle(fileEntry as MockFileEntry);
    }

    async getDirectoryHandle(
        name: string,
        options?: { create?: boolean }
    ): Promise<MockFileSystemDirectoryHandle> {
        let dirEntry = this.entry.entries.get(name);
        if (!dirEntry) {
            if (options?.create) {
                dirEntry = { kind: 'directory', name, entries: new Map() };
                this.entry.entries.set(name, dirEntry);
            } else {
                throw new DOMException('Directory not found', 'NotFoundError');
            }
        }
        if (dirEntry.kind !== 'directory') {
            throw new DOMException('Not a directory', 'TypeMismatchError');
        }
        return new MockFileSystemDirectoryHandle(dirEntry as MockDirectoryEntry);
    }

    async removeEntry(name: string, options?: { recursive?: boolean }): Promise<void> {
        const entry = this.entry.entries.get(name);
        if (!entry) {
            throw new DOMException('Entry not found', 'NotFoundError');
        }
        if (entry.kind === 'directory' && (entry as MockDirectoryEntry).entries.size > 0 && !options?.recursive) {
            throw new DOMException('Directory not empty', 'InvalidModificationError');
        }
        this.entry.entries.delete(name);
    }

    async *entries(): AsyncIterableIterator<[string, MockFileSystemFileHandle | MockFileSystemDirectoryHandle]> {
        for (const [name, entry] of this.entry.entries) {
            if (entry.kind === 'file') {
                yield [name, new MockFileSystemFileHandle(entry as MockFileEntry)];
            } else {
                yield [name, new MockFileSystemDirectoryHandle(entry as MockDirectoryEntry)];
            }
        }
    }

    async *values(): AsyncIterableIterator<MockFileSystemFileHandle | MockFileSystemDirectoryHandle> {
        for (const entry of this.entry.entries.values()) {
            if (entry.kind === 'file') {
                yield new MockFileSystemFileHandle(entry as MockFileEntry);
            } else {
                yield new MockFileSystemDirectoryHandle(entry as MockDirectoryEntry);
            }
        }
    }

    async *keys(): AsyncIterableIterator<string> {
        for (const name of this.entry.entries.keys()) {
            yield name;
        }
    }
}

export function getOPFSRoot(): MockFileSystemDirectoryHandle {
    return new MockFileSystemDirectoryHandle(opfsRoot);
}

export function resetOPFS(): void {
    opfsRoot = {
        kind: 'directory',
        name: '',
        entries: new Map(),
    };
}

// ============ WebAssembly Mocks ============

export interface MockWasmModule {
    _mockId: string;
}

export interface MockWasmInstance {
    exports: {
        memory: WebAssembly.Memory;
        [key: string]: unknown;
    };
}

let mockWasmModuleCounter = 0;

export function createMockWasmModule(): MockWasmModule {
    return { _mockId: `mock-wasm-${++mockWasmModuleCounter}` };
}

export function createMockWasmInstance(): MockWasmInstance {
    return {
        exports: {
            memory: new WebAssembly.Memory({ initial: 256 }),
        },
    };
}

export const mockWebAssembly = {
    compile: vi.fn().mockImplementation(async () => createMockWasmModule()),
    compileStreaming: vi.fn().mockImplementation(async () => createMockWasmModule()),
    instantiate: vi.fn().mockImplementation(async (moduleOrBytes: unknown) => {
        const module = typeof moduleOrBytes === 'object' && '_mockId' in (moduleOrBytes as object)
            ? moduleOrBytes as MockWasmModule
            : createMockWasmModule();
        return { module, instance: createMockWasmInstance() };
    }),
    instantiateStreaming: vi.fn().mockImplementation(async () => ({
        module: createMockWasmModule(),
        instance: createMockWasmInstance(),
    })),
    Memory: WebAssembly.Memory,
    Module: class MockModule {
        constructor() {
            return createMockWasmModule();
        }
    },
    Instance: class MockInstance {
        exports: MockWasmInstance['exports'];
        constructor() {
            const inst = createMockWasmInstance();
            this.exports = inst.exports;
        }
    },
    validate: vi.fn().mockReturnValue(true),
};

// ============ Navigator Mocks ============

export const mockStorageManager = {
    getDirectory: vi.fn().mockImplementation(async () => getOPFSRoot()),
    estimate: vi.fn().mockResolvedValue({ quota: 1024 * 1024 * 1024, usage: 0 }),
    persist: vi.fn().mockResolvedValue(true),
    persisted: vi.fn().mockResolvedValue(true),
};

export const mockNavigator = {
    storage: mockStorageManager,
    userAgent: 'Mozilla/5.0 (Test) Vitest',
    hardwareConcurrency: 4,
};

// ============ Crypto Mocks ============

let uuidCounter = 0;

export const mockCrypto = {
    randomUUID: vi.fn().mockImplementation(() => {
        const id = ++uuidCounter;
        return `00000000-0000-0000-0000-${id.toString().padStart(12, '0')}`;
    }),
    getRandomValues: vi.fn().mockImplementation((arr: Uint8Array) => {
        for (let i = 0; i < arr.length; i++) {
            arr[i] = Math.floor(Math.random() * 256);
        }
        return arr;
    }),
    subtle: {
        digest: vi.fn().mockImplementation(async (algorithm: string, data: BufferSource) => {
            // Simple mock hash - not cryptographically secure
            const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array((data as ArrayBufferView).buffer);
            let hash = 0;
            for (let i = 0; i < bytes.length; i++) {
                hash = ((hash << 5) - hash) + bytes[i];
                hash = hash & hash;
            }
            const result = new ArrayBuffer(32);
            const view = new DataView(result);
            view.setInt32(0, hash);
            return result;
        }),
    },
};

// ============ Fetch Mocks ============

export interface FetchMockConfig {
    url: string | RegExp;
    response: {
        status?: number;
        statusText?: string;
        headers?: Record<string, string>;
        body?: BodyInit | null;
        json?: unknown;
        arrayBuffer?: ArrayBuffer;
    };
}

const fetchMocks: FetchMockConfig[] = [];

export function addFetchMock(config: FetchMockConfig): void {
    fetchMocks.push(config);
}

export function clearFetchMocks(): void {
    fetchMocks.length = 0;
}

export function createMockFetch(): typeof fetch {
    return vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

        for (const mock of fetchMocks) {
            const matches = typeof mock.url === 'string'
                ? url === mock.url || url.endsWith(mock.url)
                : mock.url.test(url);

            if (matches) {
                const { status = 200, statusText = 'OK', headers = {}, body, json, arrayBuffer } = mock.response;

                let responseBody: BodyInit | null = body ?? null;
                const responseHeaders = new Headers(headers);

                if (json !== undefined) {
                    responseBody = JSON.stringify(json);
                    if (!responseHeaders.has('Content-Type')) {
                        responseHeaders.set('Content-Type', 'application/json');
                    }
                } else if (arrayBuffer !== undefined) {
                    responseBody = arrayBuffer;
                }

                return new Response(responseBody, {
                    status,
                    statusText,
                    headers: responseHeaders,
                });
            }
        }

        // Default: 404 for unmatched requests
        return new Response(null, { status: 404, statusText: 'Not Found' });
    }) as typeof fetch;
}

// ============ Worker Mocks ============

export class MockWorker {
    public onmessage: ((event: MessageEvent) => void) | null = null;
    public onerror: ((event: ErrorEvent) => void) | null = null;
    private messageHandlers: ((data: unknown) => unknown | Promise<unknown>)[] = [];

    constructor(public scriptURL: string | URL) {}

    postMessage(message: unknown, transfer?: Transferable[]): void {
        // Simulate async message handling
        setTimeout(() => {
            for (const handler of this.messageHandlers) {
                try {
                    const response = handler(message);
                    if (response !== undefined) {
                        this.simulateResponse(response);
                    }
                } catch (e) {
                    if (this.onerror) {
                        this.onerror(new ErrorEvent('error', { error: e }));
                    }
                }
            }
        }, 0);
    }

    terminate(): void {
        this.messageHandlers = [];
        this.onmessage = null;
        this.onerror = null;
    }

    // Test utility: add message handler
    addMessageHandler(handler: (data: unknown) => unknown | Promise<unknown>): void {
        this.messageHandlers.push(handler);
    }

    // Test utility: simulate a message from the worker
    simulateResponse(data: unknown): void {
        if (this.onmessage) {
            this.onmessage(new MessageEvent('message', { data }));
        }
    }

    // Test utility: simulate an error from the worker
    simulateError(error: Error): void {
        if (this.onerror) {
            this.onerror(new ErrorEvent('error', { error, message: error.message }));
        }
    }
}

// ============ DecompressionStream Mock ============

export class MockDecompressionStream {
    readable: ReadableStream<Uint8Array>;
    writable: WritableStream<Uint8Array>;

    constructor(format: string) {
        // For testing, just pass through the data (no actual decompression)
        let controller: ReadableStreamDefaultController<Uint8Array>;
        this.readable = new ReadableStream({
            start(c) {
                controller = c;
            },
        });
        this.writable = new WritableStream({
            write(chunk) {
                controller.enqueue(chunk);
            },
            close() {
                controller.close();
            },
        });
    }
}

// Export a helper to install DecompressionStream mock
export function installDecompressionStreamMock(): void {
    vi.stubGlobal('DecompressionStream', MockDecompressionStream);
}

// ============ Blob/Response streaming utilities ============

export function createMockBlobStream(data: Uint8Array): ReadableStream<Uint8Array> {
    return new ReadableStream({
        start(controller) {
            controller.enqueue(data);
            controller.close();
        },
    });
}
