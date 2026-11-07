import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { webcrypto, createHash } from 'node:crypto'
const source = readFileSync(process.cwd() + '/src/native-assets.js', 'utf8')
const Store = new Function(source + '\nreturn SiglumNativeAssetStore')()
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const pack = new TextEncoder().encode('HEADabcdWXYZ')
const descriptor = { version: 1, runtime: 'combined', directory: '/native-test', initialize: '_siglum_test_initialize', index: 'native/index.json' }
const index = () => ({ version: 1, pack: 'native/data.bin', bytes: pack.length, files: [
  { name: 'p/alpha.res', offset: 4, bytes: 4, sha256: hash(pack.subarray(4, 8)) },
  { name: 'p/beta.res', offset: 8, bytes: 4, sha256: hash(pack.subarray(8, 12)) },
] })
function fakeFs() {
  class ErrnoError extends Error { constructor(public errno: number) { super(String(errno)) } }
  const directoryOps = { lookup() { throw new ErrnoError(44) }, readdir(node: any) { return ['.', '..', ...Object.keys(node.contents)] } }
  const fileOps = { setattr(node: any, attributes: any) { Object.assign(node, attributes) } }
  const streamOps = {
    read(stream: any, buffer: Uint8Array, offset: number, length: number, position: number) { const b = stream.node.contents.subarray(position, position + length); buffer.set(b, offset); return b.length },
    mmap(stream: any) { return stream.node.contents.slice() }, write() { throw Error('unwrapped write') }, allocate() {}, msync() {},
  }
  const root: any = { contents: {}, node_ops: directoryOps }
  const fs: any = { ErrnoError,
    mkdirTree(path: string) { let node = root; for (const name of path.split('/').filter(Boolean)) node = node.contents[name] ||= { contents: {}, node_ops: directoryOps } },
    lookupPath(path: string) { let node = root; for (const name of path.split('/').filter(Boolean)) node = node.contents[name] || node.node_ops.lookup(node, name); return { node } },
    createDataFile(parent: any, name: string, bytes: Uint8Array) { const node = { contents: bytes, node_ops: fileOps, stream_ops: streamOps, usedBytes: bytes.length }; parent.contents[name] = node; return node },
    filesystems: { MEMFS: { createNode(parent: any, name: string) { if (parent.contents[name]) throw Error('Duplicate node'); return fs.createDataFile(parent, name, new Uint8Array(0)) } } },
    read(path: string) { const node = fs.lookupPath(path).node, out = new Uint8Array(node.usedBytes); node.stream_ops.read({ node }, out, 0, out.length, 0); return out },
  }
  return fs
}
let cache: Map<string, Response>, requests: string[], fetchIndex: ReturnType<typeof vi.fn>, responseIndex: any, status = 206, corrupt = false, badRange = false
beforeEach(() => {
  cache = new Map(); requests = []; responseIndex = index(); status = 206; corrupt = false; badRange = false
  vi.stubGlobal('self', { location: { href: 'https://example.test/' } })
  vi.stubGlobal('crypto', webcrypto)
  vi.stubGlobal('caches', { open: async () => ({ match: async (url: string) => cache.get(url)?.clone(), put: async (url: string, response: Response) => cache.set(url, response.clone()) }) })
  fetchIndex = vi.fn(async () => new Response(JSON.stringify(responseIndex), { headers: { 'Content-Type': 'application/json' } }))
  vi.stubGlobal('fetch', fetchIndex)
  vi.stubGlobal('XMLHttpRequest', class {
    status = status; responseType = ''; response: ArrayBuffer | null = null; url = ''; from = 0; to = 0
    open(method: string, url: string, async: boolean) { expect(method).toBe('GET'); expect(async).toBe(false); this.url = url }
    setRequestHeader(name: string, value: string) { expect(name).toBe('Range'); const m = value.match(/^bytes=(\d+)-(\d+)$/)!; this.from = +m[1]; this.to = +m[2] }
    send() { requests.push(this.url); const b = (this.status === 200 ? pack : pack.slice(this.from, this.to + 1)).slice(); if (corrupt) b[0] ^= 1; this.response = b.buffer }
    getResponseHeader() { return badRange ? 'bytes 0-3/12' : `bytes ${this.from}-${this.to}/12` }
  })
})
afterEach(() => vi.unstubAllGlobals())
const moduleFor = () => ({ FS: fakeFs(), _siglum_test_initialize: () => 0, __siglumNativeResourceStats: () => ({}) })

describe('manifest-bound native assets', () => {
  it('materializes only opened files and preserves immutable bytes', async () => {
    const store = new Store('https://example.test/releases/one/bundles', [descriptor]), module = moduleFor()
    await store.mount(module, 'combined')
    expect(module.__siglumNativeResourceStats()[0]).toMatchObject({ files: 0, loadedFiles: 0 })
    expect(module.FS.lookupPath('/native-test/p').node.node_ops.readdir(module.FS.lookupPath('/native-test/p').node)).toEqual(['.', '..', 'alpha.res', 'beta.res'])
    expect(new TextDecoder().decode(module.FS.read('/native-test/p/alpha.res'))).toBe('abcd')
    expect(new TextDecoder().decode(module.FS.read('/native-test/p/alpha.res'))).toBe('abcd')
    expect(requests).toHaveLength(1)
    const node = module.FS.lookupPath('/native-test/p/alpha.res').node
    expect(() => node.stream_ops.write()).toThrow()
    expect(() => node.stream_ops.allocate()).toThrow()
    expect(() => node.node_ops.setattr(node, { size: 0 })).toThrow()
    expect(() => module.FS.lookupPath('/native-test/p/unknown')).toThrow()
    await store.flush()
  })
  it('reopens a fresh native module and a fresh offline store without network reads', async () => {
    const first = new Store('https://example.test/releases/one/bundles', [descriptor]), module = moduleFor()
    await first.mount(module, 'combined'); module.FS.read('/native-test/p/alpha.res'); await first.flush()
    fetchIndex.mockRejectedValue(Error('offline'))
    const next = new Store('https://example.test/releases/one/bundles', [descriptor]), second = moduleFor()
    await next.mount(second, 'combined'); expect(new TextDecoder().decode(second.FS.read('/native-test/p/alpha.res'))).toBe('abcd')
    expect(requests).toHaveLength(1)
    const third = moduleFor(); await next.mount(third, 'combined'); third.FS.read('/native-test/p/alpha.res'); expect(requests).toHaveLength(1)
  })
  it('rejects changed payload checksums before a successful flush', async () => {
    corrupt = true
    const store = new Store('https://example.test/', [descriptor]), module = moduleFor()
    await store.mount(module, 'combined'); module.FS.read('/native-test/p/alpha.res')
    await expect(store.flush()).rejects.toThrow('checksum mismatch')
    expect([...cache.keys()].some(k => k.includes('siglum-native-file='))).toBe(false)
  })
  it('rejects a server range mismatch', async () => {
    badRange = true
    const store = new Store('https://example.test/', [descriptor]), module = moduleFor()
    await store.mount(module, 'combined'); expect(() => module.FS.read('/native-test/p/alpha.res')).toThrow('range mismatch')
  })
  it('handles a bounded complete response from a server that ignores ranges once', async () => {
    status = 200
    const store = new Store('https://example.test/', [descriptor]), module = moduleFor()
    await store.mount(module, 'combined'); expect(new TextDecoder().decode(module.FS.read('/native-test/p/alpha.res'))).toBe('abcd')
    expect(new TextDecoder().decode(module.FS.read('/native-test/p/beta.res'))).toBe('WXYZ'); expect(requests).toHaveLength(1)
    await store.flush()
  })
  it.each(['../escape', '/absolute', 'p/../escape', 'p//file', '__proto__/../escape'])('rejects unsafe index names %s', async name => {
    responseIndex.files[0].name = name
    await expect(new Store('https://example.test/', [descriptor]).mount(moduleFor(), 'combined')).rejects.toThrow('path')
  })
  it('rejects overlapping, duplicate and oversized indexes', async () => {
    responseIndex.files[1].offset = 6
    await expect(new Store('https://example.test/one/', [descriptor]).mount(moduleFor(), 'combined')).rejects.toThrow('entry')
    responseIndex = index(); responseIndex.files[1].name = responseIndex.files[0].name
    await expect(new Store('https://example.test/two/', [descriptor]).mount(moduleFor(), 'combined')).rejects.toThrow('entry')
    responseIndex = index(); responseIndex.bytes = 128 * 1024 * 1024
    await expect(new Store('https://example.test/three/', [descriptor]).mount(moduleFor(), 'combined')).rejects.toThrow('index')
  })
  it('does not mount combined-only resources into a checkpoint module', async () => {
    const store = new Store('https://example.test/', [descriptor])
    await store.mount({}, 'checkpoint'); expect(fetchIndex).not.toHaveBeenCalled()
  })
})


describe('portable native asset checksum', () => {
    it('matches SHA-256 across padding boundaries and large binary input without SubtleCrypto', async () => {
        vi.stubGlobal('crypto', {});
        const store = new Store('https://example.test/', []);
        for (const length of [0,1,3,55,56,57,63,64,65,128,1000000]) {
            const bytes = Uint8Array.from({ length }, (_, i) => (i * 23) & 255);
            expect(await store.digest(bytes)).toBe(hash(bytes));
        }
        expect(await store.digest(new TextEncoder().encode('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    });
});
