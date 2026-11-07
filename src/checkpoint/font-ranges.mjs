// A cost decision for a complete, validated list of actually used resources.
// It does not discover fonts, inspect TeX source, fetch data or change old retry
// heuristics. Callers must probe cached ranges first; only misses belong here.
export function planCompleteFontRanges(requests, bundleMetadata, policy = {}) {
  const options = { maxInputRequests: 2048, maxRangeRequests: 256, maxRangeBytes: 8 * 1024 * 1024,
    maxBundleBytes: 1024 * 1024 * 1024, gapBytes: 64 * 1024, maxCostRatio: 0.5,
    requestOverheadBytes: 4096, ...policy }
  const invalid = reason => ({ valid: false, reason, plans: [] })
  for (const key of ['maxInputRequests','maxRangeRequests','maxRangeBytes','maxBundleBytes','gapBytes','requestOverheadBytes']) {
    if (!Number.isSafeInteger(options[key]) || options[key] < 0) return invalid('Invalid policy: ' + key)
  }
  if (!Number.isFinite(options.maxCostRatio) || options.maxCostRatio <= 0 || options.maxCostRatio > 1) return invalid('Invalid cost ratio')
  if (!Array.isArray(requests) || requests.length > options.maxInputRequests) return invalid('Complete request list exceeds its bound')
  const bundles = new Map()
  for (const request of requests) {
    const { bundleName, start, end } = request || {}
    if (typeof bundleName !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(bundleName)
        || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start) return invalid('Invalid range metadata')
    const metadata = bundleMetadata instanceof Map ? bundleMetadata.get(bundleName)
      : bundleMetadata && Object.hasOwn(bundleMetadata, bundleName) ? bundleMetadata[bundleName] : undefined
    if (!metadata || !Number.isSafeInteger(metadata.rawBytes) || metadata.rawBytes < 1 || metadata.rawBytes > options.maxBundleBytes
        || end > metadata.rawBytes || metadata.compressedBytes !== undefined && (!Number.isSafeInteger(metadata.compressedBytes) || metadata.compressedBytes < 1 || metadata.compressedBytes > options.maxBundleBytes)) return invalid('Invalid full-bundle metadata')
    if (!bundles.has(bundleName)) bundles.set(bundleName, { metadata, requests: new Map(), inputCount: 0 })
    const bundle = bundles.get(bundleName)
    bundle.inputCount++
    bundle.requests.set(start + ':' + end, { bundleName, start, end })
  }
  let budgetBytes = options.maxRangeBytes, budgetRequests = options.maxRangeRequests
  const plans = []
  for (const [bundleName, bundle] of bundles) {
    const selected = [...bundle.requests.values()].sort((a,b) => a.start-b.start || a.end-b.end)
    const merge = gap => {
      const groups = []
      for (const file of selected) {
        const last = groups.at(-1)
        if (last && file.start <= last.end + gap) last.end = Math.max(last.end, file.end)
        else groups.push({ start: file.start, end: file.end })
      }
      return groups
    }
    const union = merge(0), groups = merge(options.gapBytes)
    const requestedBytes = union.reduce((sum, range) => sum + range.end-range.start, 0)
    const coalescedBytes = groups.reduce((sum, range) => sum + range.end-range.start, 0)
    const estimatedRangeCost = coalescedBytes + groups.length * options.requestOverheadBytes
    const fullBytes = bundle.metadata.compressedBytes ?? bundle.metadata.rawBytes
    let mode = 'ranges', reason = 'Complete bounded range set is cheaper'
    if (!Number.isSafeInteger(estimatedRangeCost)) return invalid('Range cost overflow')
    if (selected.length > budgetRequests || coalescedBytes > budgetBytes) { mode = 'bundle'; reason = 'Complete range budget exceeded' }
    else if (estimatedRangeCost > fullBytes * options.maxCostRatio) { mode = 'bundle'; reason = 'Full bundle is cheaper under the cost policy' }
    if (mode === 'ranges') { budgetBytes -= coalescedBytes; budgetRequests -= selected.length }
    plans.push({ bundleName, mode, reason, inputRequests: bundle.inputCount, uniqueRequests: selected.length,
      requestedBytes, coalescedBytes, groups, requests: selected, estimatedRangeCost, fullBytes,
      fullCostKind: bundle.metadata.compressedBytes === undefined ? 'raw-size-estimate' : 'compressed-size',
      rawBundleBytes: bundle.metadata.rawBytes })
  }
  return { valid: true, plans, reservedRangeBytes: options.maxRangeBytes-budgetBytes,
    reservedRangeRequests: options.maxRangeRequests-budgetRequests }
}
