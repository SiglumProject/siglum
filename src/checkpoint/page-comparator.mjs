// Read-only kernels share the compiler memory. Fingerprints select candidates;
// only a full byte comparison can make two pages share saved storage.
import { instantiateMemoryKernel } from './scanner.mjs'
import { scalarBytes, simdBytes } from './embedded-dedup-kernels.mjs'

export async function createPageComparator(memory, { simdAvailable = false } = {}) {
  if (typeof simdAvailable !== 'boolean') throw new TypeError('SIMD availability must be a boolean')
  const exports = await instantiateMemoryKernel(memory, simdAvailable ? simdBytes() : scalarBytes())
  if (typeof exports.page_fingerprint !== 'function' || typeof exports.equal_pages !== 'function') {
    throw new Error('Missing page comparison exports')
  }
  const valid = (at, length) => Number.isSafeInteger(at) && Number.isSafeInteger(length)
    && at >= 0 && length > 0 && at + length <= memory.buffer.byteLength
  return {
    memory,
    name: simdAvailable ? 'rust-simd128-page-comparison' : 'rust-scalar-page-comparison',
    fingerprint(at, length) {
      if (!valid(at, length) || at % 4 !== 0) throw new Error('Invalid page fingerprint range')
      return exports.page_fingerprint(at, length) >>> 0
    },
    equal(left, right, length) {
      if (!valid(left, length) || !valid(right, length)) throw new Error('Invalid page comparison range')
      return exports.equal_pages(left, right, length) === 1
    },
  }
}
