// Keep the current finalizer's requested bytes alive independently of the
// bounded cross-document LRU. Exact buffers are shared; oversized backing views
// are copied once into an exact owner before both cache and MEMFS retain them.
export function createUsedFontPinScope(vfs) {
  if (typeof vfs?.storeFetchedFile !== 'function') throw new TypeError('Font cache writer is unavailable')
  const original = vfs.storeFetchedFile, nodes = new Map()
  const observedResources = new Set(), retainedResources = new Set(), observedBuffers = new WeakSet(), retainedBuffers = new WeakSet(), owners = new Map()
  const counters = { visibleBytes: 0, backingBytes: 0, retainedVisibleBytes: 0, retainedBackingBytes: 0, copies: 0, copiedBytes: 0 }
  let active = true
  const key = (bundle,start,end) => bundle + ':' + start + ':' + end
  const own = (id,data,start,end) => {
    if (!(data instanceof Uint8Array) || data.byteLength !== end-start) throw new Error('Invalid cached font range length')
    if (!observedResources.has(id)) { observedResources.add(id); counters.visibleBytes += data.byteLength }
    if (!observedBuffers.has(data.buffer)) { observedBuffers.add(data.buffer); counters.backingBytes += data.buffer.byteLength }
    let owned = owners.get(id)
    if (owned && owned !== data) {
      for (let i=0;i<data.length;i++) if (owned[i] !== data[i]) throw new Error('Font resource changed during paused finalization')
    }
    if (!owned) {
      owned = data
      if (!(data.buffer instanceof ArrayBuffer) || data.byteOffset !== 0 || data.byteLength !== data.buffer.byteLength) {
        owned = new Uint8Array(data.byteLength); owned.set(data); counters.copies++; counters.copiedBytes += owned.byteLength
      }
      owners.set(id,owned)
    }
    if (!retainedResources.has(id)) { retainedResources.add(id); counters.retainedVisibleBytes += owned.byteLength }
    if (!retainedBuffers.has(owned.buffer)) { retainedBuffers.add(owned.buffer); counters.retainedBackingBytes += owned.buffer.byteLength }
    return owned
  }
  const apply = (node,data,start,end) => {
    if (!(data instanceof Uint8Array) || data.byteLength !== end-start) throw new Error('Invalid cached font range length')
    node.contents = data
    node.usedBytes = data.byteLength
  }
  function store(bundle,start,end,data) {
    const held = active ? nodes.get(key(bundle,start,end)) : null
    if (held && (!(data instanceof Uint8Array) || data.byteLength !== end-start)) throw new Error('Invalid fetched font range length')
    const owned = active ? own(key(bundle,start,end),data,start,end) : data
    original.call(this,bundle,start,end,owned)
    if (held) for (const node of held) apply(node,owned,start,end)
  }
  vfs.storeFetchedFile = store
  return {
    hold(node,marker,resolved) {
      if (!active) throw new Error('Font pin scope is closed')
      const {bundleName,start,end} = marker || {}
      if (!node || typeof bundleName !== 'string' || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start) throw new Error('Invalid pinned font metadata')
      const id = key(bundleName,start,end)
      if (!nodes.has(id)) nodes.set(id,new Set())
      nodes.get(id).add(node)
      if (resolved?.byteLength) {
        const owned = own(id,resolved,start,end)
        if (owned !== resolved) original.call(vfs,bundleName,start,end,owned)
        apply(node,owned,start,end)
      }
    },
    release() {
      if (!active) return
      active = false
      if (vfs.storeFetchedFile === store) vfs.storeFetchedFile = original
      nodes.clear()
      owners.clear()
    },
    // Unique-buffer totals encountered in this scope, not process RSS. On an
    // immutable resource range each owner is normally seen once.
    stats() { return { ...counters, resources: retainedResources.size } },
  }
}
