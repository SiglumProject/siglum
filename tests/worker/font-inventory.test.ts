import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const context = createContext({ self: { postMessage() {} }, TextDecoder });
runInContext(readFileSync(resolve(__dirname, '../../src/worker.js'), 'utf8'), context);
const Vfs = runInContext('VirtualFileSystem', context);
function fixture() {
    const nodes = new Map<string, any>();
    const links = new Map<string, string>();
    const fs = {
        filesystems: { MEMFS: {} }, mkdirTree: vi.fn(),
        lookupPath: (path: string) => { if (!nodes.has(path)) throw Error('Absent'); return { node: nodes.get(path) }; },
        readdir: () => ['.', '..', ...links.keys()],
        unlink: (path: string) => links.delete(path.slice(path.lastIndexOf('/') + 1)),
        symlink: (source: string, destination: string) => links.set(destination.slice(destination.lastIndexOf('/') + 1), source),
        writeFile: vi.fn(), readFile: vi.fn(() => { throw Error('Inventory must not read a font'); }),
    };
    const vfs = new Vfs(fs);
    const add = (name: string, data: unknown) => { const path = '/texlive/texmf-dist/fonts/type1/test/' + name; nodes.set(path, { contents: data }); vfs.mountedFiles.add(path); return path; };
    return { fs, vfs, add, links, nodes };
}

describe('font inventory and demand loading', () => {
    it('inventories installed and resident-bundle fonts without reading bytes or hydrating absent ranges', () => {
        const { fs, vfs, add, links } = fixture();
        const installed = add('installed.pfb', new Uint8Array([1]));
        const resident = add('resident.otf', vfs._createLazyMarker('resident', 0, 10));
        vfs.bundleCache.set('resident', new ArrayBuffer(10));
        add('absent.pfb', vfs._createDeferredMarker('absent', 0, 10));
        add('unknown.otf', vfs._createLazyMarker('unknown', 0, 10));
        add('unrelated.sty', new Uint8Array([2]));
        vfs.writeFontconfig();
        expect([...links.values()]).toEqual([installed, resident]);
        expect(fs.readFile).not.toHaveBeenCalled();
        expect(fs.writeFile).toHaveBeenCalledWith('/texlive/fonts.conf', expect.stringContaining('<dir>/texlive/fontconfig-fonts</dir>'));
        expect(vfs.mountedFiles.has(installed)).toBe(true);
    });
    it('includes a deferred font once its exact range is cached and removes stale index links', () => {
        const { vfs, add, links } = fixture();
        links.set('stale.pfb', '/no-longer-mounted.pfb');
        const path = add('cached.pfb', vfs._createDeferredMarker('range', 10, 20));
        vfs.fetchedFiles.set('range:10:20', new Uint8Array(10));
        vfs.writeFontconfig();
        expect([...links.values()]).toEqual([path]);
        vfs.mountedFiles.clear();
        vfs.writeFontconfig();
        expect(links.size).toBe(0);
    });
});


describe('resolver-owned placeholder materialization', () => {
    it('installs an exact range once without overwriting a mounted source or font', () => {
        const { vfs, add, nodes } = fixture();
        const path = add('pending.pfb', vfs._createDeferredMarker('range', 10, 13));
        const data = new Uint8Array([1, 2, 3]);
        expect(vfs.materializeKnownFile(path, data)).toBe(true);
        expect(nodes.get(path).contents).toBe(data);
        expect(vfs.materializeKnownFile(path, new Uint8Array([4, 5, 6]))).toBe(false);
        expect(vfs.materializeKnownFile('/not-mounted', data)).toBe(false);
    });
    it('rejects truncated bytes while keeping the original placeholder intact', () => {
        const { vfs, add } = fixture();
        const path = add('pending.pfb', vfs._createDeferredMarker('range', 10, 13));
        expect(() => vfs.materializeKnownFile(path, new Uint8Array(2))).toThrow('length mismatch');
        expect(vfs.materializeKnownFile(path, new Uint8Array(3))).toBe(true);
    });
});
