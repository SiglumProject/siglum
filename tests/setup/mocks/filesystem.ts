/**
 * Mock for @siglum/filesystem module.
 * Provides in-memory filesystem operations for testing.
 */

import { vi } from 'vitest';

// In-memory filesystem storage
interface FileEntry {
    type: 'file';
    content: Uint8Array;
    mtime: number;
}

interface DirectoryEntry {
    type: 'directory';
    children: Map<string, FileEntry | DirectoryEntry>;
    mtime: number;
}

let root: DirectoryEntry = createDirectory();

function createDirectory(): DirectoryEntry {
    return {
        type: 'directory',
        children: new Map(),
        mtime: Date.now(),
    };
}

function createFile(content: Uint8Array): FileEntry {
    return {
        type: 'file',
        content,
        mtime: Date.now(),
    };
}

function normalizePath(path: string): string {
    // Remove leading slash for internal storage, but keep track for root references
    return path.replace(/^\/+/, '').replace(/\/+$/, '');
}

function getPathParts(path: string): string[] {
    return normalizePath(path).split('/').filter(p => p);
}

function getParentAndName(path: string): { parent: DirectoryEntry; name: string } | null {
    const parts = getPathParts(path);
    if (parts.length === 0) return null;

    const name = parts.pop()!;
    let current: DirectoryEntry = root;

    for (const part of parts) {
        const child = current.children.get(part);
        if (!child || child.type !== 'directory') {
            return null;
        }
        current = child;
    }

    return { parent: current, name };
}

function ensureDirectoryExists(path: string): DirectoryEntry {
    const parts = getPathParts(path);
    let current: DirectoryEntry = root;

    for (const part of parts) {
        let child = current.children.get(part);
        if (!child) {
            child = createDirectory();
            current.children.set(part, child);
        } else if (child.type !== 'directory') {
            throw new Error(`Path ${path} exists but is not a directory`);
        }
        current = child;
    }

    return current;
}

function getEntry(path: string): FileEntry | DirectoryEntry | null {
    if (!path || path === '/') return root;

    const parts = getPathParts(path);
    let current: FileEntry | DirectoryEntry = root;

    for (const part of parts) {
        if (current.type !== 'directory') {
            return null;
        }
        const child = current.children.get(part);
        if (!child) {
            return null;
        }
        current = child;
    }

    return current;
}

// Track mounted paths for mount simulation
const mountedPaths = new Set<string>();

export const mockFileSystem = {
    mountAuto: vi.fn().mockImplementation(async (path: string) => {
        const normalizedPath = '/' + normalizePath(path);
        if (mountedPaths.has(normalizedPath)) {
            return; // Already mounted
        }
        ensureDirectoryExists(normalizedPath);
        mountedPaths.add(normalizedPath);
    }),

    readFile: vi.fn().mockImplementation(async (path: string): Promise<string> => {
        const entry = getEntry(path);
        if (!entry || entry.type !== 'file') {
            throw new Error(`File not found: ${path}`);
        }
        return new TextDecoder().decode(entry.content);
    }),

    readBinary: vi.fn().mockImplementation(async (path: string): Promise<Uint8Array> => {
        const entry = getEntry(path);
        if (!entry || entry.type !== 'file') {
            throw new Error(`File not found: ${path}`);
        }
        return entry.content;
    }),

    writeFile: vi.fn().mockImplementation(async (
        path: string,
        content: string,
        options?: { createParents?: boolean; silent?: boolean }
    ): Promise<void> => {
        const parts = getPathParts(path);
        if (parts.length === 0) {
            throw new Error('Cannot write to root');
        }

        const name = parts.pop()!;
        let parent: DirectoryEntry;

        if (options?.createParents) {
            parent = ensureDirectoryExists('/' + parts.join('/'));
        } else {
            const result = getParentAndName(path);
            if (!result) {
                throw new Error(`Parent directory not found: ${path}`);
            }
            parent = result.parent;
        }

        const data = new TextEncoder().encode(content);
        parent.children.set(name, createFile(data));
    }),

    writeBinary: vi.fn().mockImplementation(async (
        path: string,
        content: Uint8Array,
        options?: { createParents?: boolean; silent?: boolean }
    ): Promise<void> => {
        const parts = getPathParts(path);
        if (parts.length === 0) {
            throw new Error('Cannot write to root');
        }

        const name = parts.pop()!;
        let parent: DirectoryEntry;

        if (options?.createParents) {
            parent = ensureDirectoryExists('/' + parts.join('/'));
        } else {
            const result = getParentAndName(path);
            if (!result) {
                throw new Error(`Parent directory not found: ${path}`);
            }
            parent = result.parent;
        }

        // Make a copy to avoid shared references
        parent.children.set(name, createFile(new Uint8Array(content)));
    }),

    mkdir: vi.fn().mockImplementation(async (path: string): Promise<void> => {
        ensureDirectoryExists(path);
    }),

    readdir: vi.fn().mockImplementation(async (path: string): Promise<Array<{ name: string; path: string }>> => {
        const entry = getEntry(path);
        if (!entry || entry.type !== 'directory') {
            throw new Error(`Directory not found: ${path}`);
        }

        const results: Array<{ name: string; path: string }> = [];
        for (const [name] of entry.children) {
            const fullPath = path.endsWith('/') ? `${path}${name}` : `${path}/${name}`;
            results.push({ name, path: fullPath });
        }
        return results;
    }),

    rmdir: vi.fn().mockImplementation(async (path: string, options?: { recursive?: boolean }): Promise<void> => {
        const result = getParentAndName(path);
        if (!result) {
            throw new Error(`Path not found: ${path}`);
        }

        const entry = result.parent.children.get(result.name);
        if (!entry) {
            throw new Error(`Path not found: ${path}`);
        }

        if (entry.type === 'directory' && entry.children.size > 0 && !options?.recursive) {
            throw new Error(`Directory not empty: ${path}`);
        }

        result.parent.children.delete(result.name);
        mountedPaths.delete('/' + normalizePath(path));
    }),

    exists: vi.fn().mockImplementation(async (path: string): Promise<boolean> => {
        return getEntry(path) !== null;
    }),

    stat: vi.fn().mockImplementation(async (path: string): Promise<{ isFile: boolean; isDirectory: boolean; size: number; mtime: number }> => {
        const entry = getEntry(path);
        if (!entry) {
            throw new Error(`Path not found: ${path}`);
        }

        return {
            isFile: entry.type === 'file',
            isDirectory: entry.type === 'directory',
            size: entry.type === 'file' ? entry.content.length : 0,
            mtime: entry.mtime,
        };
    }),
};

// Capture each method's implementation at module load. The global afterEach in
// vitest.setup.ts calls vi.restoreAllMocks(), which strips the implementation
// from these module-level vi.fn() mocks. Without re-installing them, every test
// after the first would get a mock that returns undefined (e.g. readBinary()
// returning undefined → `.catch` throwing). resetMockFileSystem() re-applies them.
const _impls = Object.fromEntries(
    Object.entries(mockFileSystem).map(([key, fn]) => [key, (fn as ReturnType<typeof vi.fn>).getMockImplementation()])
) as Record<string, (...args: any[]) => any>;

export function resetMockFileSystem(): void {
    root = createDirectory();
    mountedPaths.clear();
    vi.clearAllMocks();
    // Re-install implementations in case a prior afterEach restored/stripped them.
    for (const [key, impl] of Object.entries(_impls)) {
        (mockFileSystem as Record<string, ReturnType<typeof vi.fn>>)[key].mockImplementation(impl);
    }
}

// Helper to set up test data
export function setMockFile(path: string, content: string | Uint8Array): void {
    const parts = getPathParts(path);
    if (parts.length === 0) {
        throw new Error('Cannot write to root');
    }

    const name = parts.pop()!;
    const parent = ensureDirectoryExists('/' + parts.join('/'));

    const data = typeof content === 'string'
        ? new TextEncoder().encode(content)
        : new Uint8Array(content);

    parent.children.set(name, createFile(data));
}

// Helper to get test data
export function getMockFile(path: string): Uint8Array | null {
    const entry = getEntry(path);
    if (!entry || entry.type !== 'file') {
        return null;
    }
    return entry.content;
}

// Helper to check if path exists
export function mockPathExists(path: string): boolean {
    return getEntry(path) !== null;
}

// Helper to list directory contents
export function getMockDirectory(path: string): string[] | null {
    const entry = getEntry(path);
    if (!entry || entry.type !== 'directory') {
        return null;
    }
    return Array.from(entry.children.keys());
}

// Default export that can be used for mocking the module
export const fileSystem = mockFileSystem;
