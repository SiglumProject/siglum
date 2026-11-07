// The caller supplies compiler memory and the exact audited WASM bytes. Works in
// browser and Node; no fs/fetch dependency and no private Rust memory allocation.
function readUleb(bytes, at) {
  let value = 0
  let shift = 0
  while (at < bytes.length) {
    const byte = bytes[at++]
    value += (byte & 127) * 2 ** shift
    if (!(byte & 128)) return [value, at]
    shift += 7
  }
  throw new Error('Invalid WASM section length')
}

export async function instantiateMemoryKernel(memory, wasmBytes) {
  if (!(memory instanceof WebAssembly.Memory)) throw new TypeError('Pass the actual compiler WebAssembly.Memory')
  const bytes = wasmBytes instanceof Uint8Array ? wasmBytes : new Uint8Array(wasmBytes)
  let at = 8
  while (at < bytes.length) {
    const id = bytes[at++]
    let size
    ;[size, at] = readUleb(bytes, at)
    if (id === 8) throw new Error('Scanner must not run a start function against compiler memory')
    if (id === 11) {
      const [count] = readUleb(bytes, at)
      if (count !== 0) throw new Error('Scanner must not initialize data in compiler memory')
    }
    at += size
  }
  const module = await WebAssembly.compile(bytes)
  const imports = WebAssembly.Module.imports(module)
  if (imports.length !== 1 || imports[0].module !== 'env' || imports[0].name !== 'memory' || imports[0].kind !== 'memory') {
    throw new Error('Scanner must import only compiler memory')
  }
  const instance = await WebAssembly.instantiate(module, { env: { memory } })
  if (instance.exports.__stack_pointer?.value !== 0) throw new Error('Scanner must not use a linear-memory stack')
  return instance.exports
}

export async function createRustScanner(memory, wasmBytes) {
  const exports = await instantiateMemoryKernel(memory, wasmBytes)
  if (typeof exports.nonzero_pages !== 'function') throw new Error('Missing nonzero_pages export')
  return {
    name: 'rust-u64-nonzero-pages',
    memory,
    scan(livePtr, heapLen, pageBytes, bitmapPtr, bitmapCapacity) {
      const result = exports.nonzero_pages(livePtr, heapLen, pageBytes, bitmapPtr, bitmapCapacity) >>> 0
      if (result === 0xffffffff) throw new Error('Invalid sparse scanner arguments or memory bounds')
      if (result === 0xfffffffe) throw new Error('Sparse scanner bitmap reservation is too small')
      return result
    }
  }
}
