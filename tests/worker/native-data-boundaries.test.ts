import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
const source = readFileSync(process.cwd() + '/src/worker.js', 'utf8')
function worker() {
  const context = createContext({ self: { postMessage() {} }, TextDecoder, TextEncoder, Uint8Array, ArrayBuffer })
  runInContext(source, context)
  return { Vfs: runInContext('VirtualFileSystem', context), snapshot: runInContext('snapshotWorkTree', context) }
}
describe('native data ownership boundaries', () => {
  it('adopts only a fresh independent eager bundle range, preserving cached bundle bytes', () => {
    const { Vfs } = worker(), files = new Map(), writes: any[] = []
    const FS = { filesystems: { MEMFS: {} }, stat() { return { mode: 16384 } }, mkdir() {},
      writeFile(path: string, data: Uint8Array, options: any) { writes.push({ path, data, options }); files.set(path, options?.canOwn ? data : data.slice()) } }
    const vfs = new Vfs(FS), cached = Uint8Array.from([0,1,2,3,4,5,6,7])
    vfs.mountBundle('fixture', cached.buffer, { '/texlive/test.fmt': { bundle: 'fixture', start: 2, end: 6 } })
    expect(writes[0].options).toEqual({ canOwn: true })
    expect(files.get('/texlive/test.fmt').buffer).not.toBe(cached.buffer)
    files.get('/texlive/test.fmt')[0] = 99
    expect([...cached]).toEqual([0,1,2,3,4,5,6,7])
    const caller = Uint8Array.from([10,11,12]); vfs.mount('/project.tex', caller)
    expect(writes[1].options).toBeUndefined()
    caller[0] = 55; expect(files.get('/project.tex')[0]).toBe(10)
  })
  it('does not enumerate immutable runtime roots as document outputs', () => {
    const { snapshot } = worker(), stat = vi.fn((path: string) => {
      if (path.startsWith('/native')) throw Error('Native resources must not be walked')
      return { mode: path === '/project' ? 16384 : 32768 }
    })
    const FS = { __siglumNativeResourceRoots: new Set(['/native']),
      readdir(path: string) { if (path === '/') return ['.', '..', 'native', 'project']; if (path === '/project') return ['.', '..', 'generated.tex']; throw Error('Unexpected walk') }, stat,
      isDir: (mode: number) => mode === 16384 }
    expect([...snapshot(FS)]).toEqual(['/project/generated.tex'])
    expect(stat).not.toHaveBeenCalledWith('/native')
  })
})
