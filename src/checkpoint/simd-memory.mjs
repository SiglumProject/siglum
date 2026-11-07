/* Separate opt-in candidate. It does not change the stable lab, SDK or engine.
 * Embedded audited kernels remove an extra fetch and keep scalar fallback
 * available offline. This is outside the timed capture/restore path. */
import { createPageComparator } from './page-comparator.mjs'
import { createRustScanner } from './scanner.mjs'
import { scalarBytes, simd64Bytes, featureProbeBytes, scalarSha256, simd64Sha256 } from './embedded-kernels.mjs'

export function supportsSimd128() {
  try { return WebAssembly.validate(featureProbeBytes()) } catch { return false }
}

/** Omit simdAvailable for normal automatic feature detection. Explicit false
 * is a caller-selected compatibility control, not proof of an older device. */
export async function createPreferredRustScanner(memory, { simdAvailable = supportsSimd128() } = {}) {
  if (typeof simdAvailable !== 'boolean') throw new TypeError('SIMD availability must be a boolean')
  const bytes = simdAvailable ? simd64Bytes() : scalarBytes()
  // The standard loader still checks imports, data/start and zero stack. A
  // supported SIMD kernel failing those checks is an error; do not silently
  // mislabel corruption or ABI failures as a compatibility fallback.
  const scanner = await createRustScanner(memory, bytes)
  scanner.name = simdAvailable ? 'rust-simd128-64-nonzero-pages' : 'rust-u64-nonzero-pages'
  scanner.selection = Object.freeze({ variant: simdAvailable ? 'simd64' : 'scalar',
    kernelBytes: bytes.length, kernelSha256: simdAvailable ? simd64Sha256 : scalarSha256,
    scalarFallback: !simdAvailable, reason: simdAvailable ? 'SIMD128 feature probe accepted' : 'Scalar compatibility path selected',
    embedded: true })
  return scanner
}

/** Optional compact backend for either browser or Node adapters. The caller
 * injects its existing compact module so its one-capture guard is not duplicated.
 * This selects the measured scanner only; baseline page copying stays intact. */
export async function createPreferredMemoryBackend(module, {
  compact, simdAvailable = supportsSimd128(), pageBytes = 16384, maximumBytes = 268435456, scratchLease, deduplicate = false,
} = {}) {
  if (typeof compact?.getEngineMemory !== 'function' || typeof compact?.capture !== 'function') {
    throw new TypeError('Inject the existing compact memory module')
  }
  const scanner = await createPreferredRustScanner(compact.getEngineMemory(module), { simdAvailable })
  const comparator = deduplicate ? await createPageComparator(compact.getEngineMemory(module), { simdAvailable }) : undefined
  const metadata = { mode: 'compact-rust', scanner: scanner.name, ...scanner.selection, coalesced: false }
  return {
    metadata,
    memoryCapture(value) {
      if (value !== module) throw new Error('Memory backend belongs to a different compiler instance')
      const saved = compact.capture(module, { scanner, pageBytes, maximumBytes, scratchLease, comparator })
      Object.assign(metadata, { retainedHeapBytes: saved.retainedBytes,
        nonzeroPages: saved.nonzeroPages, zeroPages: saved.zeroPages, uniquePages: saved.uniquePages, deduplicatedBytes: saved.deduplicatedBytes })
      return saved
    },
  }
}
