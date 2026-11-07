import { describe, expect, it, vi } from 'vitest';
import { protectImmutableRoots, captureFileSystem, trackProjectAccesses } from '../../src/checkpoint/session.mjs';

type Node = { path: string; mode: number; contents: Record<string, Node> | Uint8Array; usedBytes?: number; mount?: object };
function fixture() {
    const nodes = new Map<string, Node>();
    const absolute = (path: string) => path.startsWith('/') ? path : '/work/' + path;
    const FS = {
        filesystems: { MEMFS: {} }, streams: [], nameTable: [], root: undefined as unknown as Node,
        cwd: () => '/work', isDir: (mode: number) => mode === 1, isFile: (mode: number) => mode === 2,
        getPath: (node: Node) => node.path,
        lookupPath: (path: string) => {
            const node = nodes.get(absolute(path));
            if (!node) throw Object.assign(new Error('Missing'), { errno: 44 });
            return { node };
        },
        read: vi.fn(),
        open: vi.fn((path: string, _flags?: string | number) => ({ node: nodes.get(absolute(path)) })), write: vi.fn(),
        unlink: vi.fn(), rmdir: vi.fn(), rename: vi.fn(), mkdir: vi.fn(),
    };
    function add(path: string, directory = false) {
        const node: Node = { path, mode: directory ? 1 : 2,
            contents: directory ? {} : new Uint8Array([7]), usedBytes: directory ? undefined : 1,
            mount: { type: FS.filesystems.MEMFS } };
        nodes.set(path, node);
        if (path !== '/') {
            const at = path.lastIndexOf('/'), parent = nodes.get(path.slice(0, at) || '/');
            if (parent) (parent.contents as Record<string, Node>)[path.slice(at + 1)] = node;
        }
        return node;
    }
    FS.root = add('/', true); add('/assets', true); add('/work', true);
    return { FS, add, nodes };
}

describe('indexed immutable asset paths', () => {
    it('protects nested streams and exact file aliases while allowing adjacent names', () => {
        const { FS, add } = fixture();
        add('/assets/data', true); const protectedFile = add('/assets/data/a.sty');
        add('/assets/data2', true); const writable = add('/assets/data2/a.sty');
        add('/work/alias.sty'); add('/work/source.tex');
        const open = FS.open, write = FS.write;
        protectImmutableRoots(FS, ['/assets/data', '/work/alias.sty']);
        expect(() => FS.open('/assets/data/a.sty', 'w')).toThrow(/read-only/);
        expect(() => FS.write({ node: protectedFile })).toThrow(/read-only/);
        expect(() => FS.open('alias.sty', 2)).toThrow(/read-only/);
        FS.open('/assets/data/a.sty', 'r'); FS.write({ node: writable }); FS.open('source.tex', 'w');
        expect(open).toHaveBeenCalledTimes(2);
        expect(write).toHaveBeenCalledTimes(1);
    });

    it('rejects deleting or renaming an ancestor and indexes roots registered later', () => {
        const { FS, add } = fixture(); add('/assets/first.sty');
        protectImmutableRoots(FS, ['/assets/first.sty']);
        expect(() => FS.unlink('/assets')).toThrow(/read-only/);
        expect(() => FS.rename('/work', '/assets')).toThrow(/read-only/);
        FS.unlink('/assets-neighbor');
        add('/work/later', true); add('/work/later/a.sty');
        protectImmutableRoots(FS, ['/work/later']);
        expect(() => FS.rmdir('/work')).toThrow(/read-only/);
        expect(() => FS.open('later/a.sty', 'w')).toThrow(/read-only/);
        FS.mkdir('/work/later-neighbor');
    });

    it('keeps canonical symlink-target checks and accepts protected subtrees for capture', () => {
        const { FS, add, nodes } = fixture(); add('/assets/data', true); const pinned = add('/assets/data/a.sty');
        nodes.set('/work/link', pinned);
        protectImmutableRoots(FS, ['/assets/data']);
        expect(() => FS.open('/work/link', 'w')).toThrow(/read-only/);
        expect(() => captureFileSystem(FS, { immutableRoots: ['/assets/data/a.sty'] })).not.toThrow();
        expect(() => captureFileSystem(FS, { immutableRoots: ['/assets/data2'] })).toThrow(/protectImmutableRoots/);
    });

    it('protects the root namespace when it is explicitly pinned', () => {
        const { FS } = fixture(); protectImmutableRoots(FS, ['/']);
        expect(() => FS.mkdir('/anything')).toThrow(/read-only/);
        expect(() => FS.unlink('/')).toThrow(/read-only/);
    });
});


describe('authored input access journal', () => {
    it('keeps source and metadata dependencies while skipping unrelated runtime streams', () => {
        const { FS, add, nodes } = fixture();
        const source = add('/work/source.tex'), runtime = add('/assets/runtime.otf');
        add('/work/future.tex'); const custom = add('/assets/custom.otf');
        nodes.set('/work/source-link', source);
        protectImmutableRoots(FS, ['/assets']);
        const paths = ['/work/source.tex', '/work/future.tex', '/assets/custom.otf'];
        const tracking = trackProjectAccesses(FS, '/', { projectPaths: paths });
        FS.lookupPath('/assets/runtime.otf'); FS.read({ node: runtime });
        expect([...tracking.touched]).toEqual([]);
        FS.lookupPath('source.tex'); FS.lookupPath('/work/future.tex');
        // Authored overrides remain dependencies even inside a pinned asset tree.
        FS.read({ node: custom });
        expect([...tracking.touched].sort()).toEqual([...paths].sort());
        tracking.touched.clear(); FS.open('/work/source-link', 'r');
        expect([...tracking.touched]).toEqual(['/work/source.tex']);
        expect(trackProjectAccesses(FS, '/', { projectPaths: paths.slice().reverse() })).toBe(tracking);
        expect(() => trackProjectAccesses(FS, '/', { projectPaths: ['/work/different.tex'] })).toThrow(/inputs cannot change/);
    });
});
