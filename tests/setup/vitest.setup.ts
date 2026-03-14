/**
 * Vitest global setup for siglum-engine tests.
 * Sets up browser API mocks and global test utilities.
 */

import { vi, beforeEach, afterEach } from 'vitest';
import {
    MockCacheStorage,
    mockNavigator,
    mockCrypto,
    resetMockCacheStorage,
} from './mocks/browser-apis';
import { resetMockFileSystem } from './mocks/filesystem';

// Install global browser API mocks
beforeEach(() => {
    // Cache API
    vi.stubGlobal('caches', new MockCacheStorage());

    // Navigator with storage
    vi.stubGlobal('navigator', mockNavigator);

    // Crypto for randomUUID
    vi.stubGlobal('crypto', mockCrypto);

    // Performance API (usually available but ensure it's there)
    if (typeof performance === 'undefined') {
        vi.stubGlobal('performance', {
            now: () => Date.now(),
        });
    }

    // requestAnimationFrame for batched logger tests
    if (typeof requestAnimationFrame === 'undefined') {
        vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
            return setTimeout(() => cb(Date.now()), 0) as unknown as number;
        });
        vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));
    }

    // URL constructor with createObjectURL for worker tests
    if (typeof URL.createObjectURL === 'undefined') {
        URL.createObjectURL = vi.fn().mockReturnValue('blob:mock-url');
        URL.revokeObjectURL = vi.fn();
    }

    // TextEncoder/TextDecoder (usually available in happy-dom)
    if (typeof TextEncoder === 'undefined') {
        vi.stubGlobal('TextEncoder', class {
            encode(str: string): Uint8Array {
                const arr = new Uint8Array(str.length);
                for (let i = 0; i < str.length; i++) {
                    arr[i] = str.charCodeAt(i);
                }
                return arr;
            }
        });
    }

    if (typeof TextDecoder === 'undefined') {
        vi.stubGlobal('TextDecoder', class {
            decode(arr: Uint8Array): string {
                return String.fromCharCode.apply(null, Array.from(arr));
            }
        });
    }

    // atob/btoa for base64
    if (typeof atob === 'undefined') {
        vi.stubGlobal('atob', (str: string) => Buffer.from(str, 'base64').toString('binary'));
        vi.stubGlobal('btoa', (str: string) => Buffer.from(str, 'binary').toString('base64'));
    }
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    resetMockCacheStorage();
    resetMockFileSystem();
});

// Export test utilities that may be needed
export { vi };
