/* Optional same-instance nonzero-page storage. No session/editor integration.
 * A scanner imports this exact engine memory and writes only its reserved
 * bitmap bytes. Full engine/FS/stack correctness remains the session's job.
 */
const allocatedInstances = new WeakSet();
const scratchLeases = new WeakMap();
const supportedPageBytes = new Set([4096, 16384, 65536]);

function engineMemory(Module) {
  const memory = Module.asm?.memory ?? Module.wasmMemory ?? Module.__siglumObservedMemory;
  if (!(memory instanceof WebAssembly.Memory)) {
    throw new Error('Compact snapshots require the exported engine WebAssembly.Memory');
  }
  return memory;
}

function validRange(pointer, length, bound) {
  return Number.isSafeInteger(pointer) && Number.isSafeInteger(length)
    && pointer >= 0 && length >= 0 && pointer + length <= bound;
}

/** Matched control for the Rust scanner ABI. One byte per page, 0 or 1.
 * The reserved bitmap pages are conservatively nonzero. No full-heap copy is
 * made, and only ceil(heapLen/pageBytes) bytes of bitmap storage are written.
 */
export function createJsScanner(memory) {
  if (!(memory instanceof WebAssembly.Memory)) throw new Error('Expected WebAssembly.Memory');
  return {
    name: 'javascript-nonzero-pages',
    memory,
    scan(livePtr, heapLen, pageBytes, bitmapPtr, bitmapCapacity) {
      const heap = new Uint8Array(memory.buffer);
      if (!supportedPageBytes.has(pageBytes) || !validRange(livePtr, heapLen, heap.length)
          || !validRange(bitmapPtr, bitmapCapacity, heap.length)) return 0xffffffff;
      const pageCount = Math.ceil(heapLen / pageBytes);
      if (bitmapCapacity < pageCount) return 0xfffffffe;
      const bitmap = new Uint8Array(memory.buffer, bitmapPtr, pageCount);
      bitmap.fill(0);
      let nonzero = 0;
      for (let page = 0; page < pageCount; page++) {
        const start = livePtr + page * pageBytes;
        const end = Math.min(livePtr + heapLen, start + pageBytes);
        let present = start < bitmapPtr + bitmapCapacity && end > bitmapPtr;
        // Page starts are aligned in normal use. Keep the ABI valid for other
        // offsets, rather than giving Uint32Array an unaligned byte offset.
        let cursor = start;
        while (!present && cursor < end && (cursor & 3)) present = heap[cursor++] !== 0;
        if (!present && cursor + 4 <= end) {
          const words = new Uint32Array(memory.buffer, cursor, Math.floor((end - cursor) / 4));
          for (let i = 0; i < words.length; i++) {
            if (words[i] !== 0) { present = true; break; }
          }
          cursor += words.byteLength;
        }
        while (!present && cursor < end) present = heap[cursor++] !== 0;
        if (present) { bitmap[page] = 1; nonzero++; }
      }
      return nonzero;
    },
  };
}

function runScanner(scanner, memory, heapLength, pageBytes, pointer, capacity) {
  if (scanner.memory !== memory || typeof scanner.scan !== 'function') {
    throw new Error('Scanner must bind the same exported engine memory');
  }
  const count = scanner.scan(0, heapLength, pageBytes, pointer, capacity) >>> 0;
  const pages = Math.ceil(heapLength / pageBytes);
  if (count > pages) throw new Error('Nonzero-page scanner rejected the memory range: ' + count);
  // This copy must happen BEFORE zeroing/restoring any heap page: the live
  // bitmap itself is inside the memory that those operations will modify.
  const bitmap = new Uint8Array(memory.buffer, pointer, pages).slice();
  let actual = 0;
  for (const value of bitmap) {
    if (value !== 0 && value !== 1) throw new Error('Scanner returned a non-boolean page bitmap');
    actual += value;
  }
  if (actual !== count) throw new Error('Scanner count does not match its bitmap');
  return { bitmap, count, pages };
}

/** Reserve scratch once, shared by the RAM and OPFS storage variants. */
export function reserveScannerScratch(Module, { pageBytes, maximumBytes }) {
  const memory = engineMemory(Module);
  if (!supportedPageBytes.has(pageBytes)) throw new Error('Choose a 4, 16 or 64 KiB snapshot page');
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < memory.buffer.byteLength
      || maximumBytes > 0xffffffff) throw new Error('Invalid compact snapshot maximum memory size');
  if (allocatedInstances.has(Module)) throw new Error('Use a fresh engine instance for another compact capture');
  if (typeof Module._malloc !== 'function') throw new Error('Engine must export malloc for reserved scanner scratch');
  const bitmapCapacity = Math.ceil(maximumBytes / pageBytes);
  const bitmapPointer = Module._malloc(bitmapCapacity) >>> 0;
  if (!bitmapPointer || !validRange(bitmapPointer, bitmapCapacity, memory.buffer.byteLength)) {
    throw new Error('Could not reserve scanner bitmap scratch');
  }
  allocatedInstances.add(Module);
  const byteLength = memory.buffer.byteLength;
  if (byteLength > maximumBytes) throw new Error('Scratch allocation exceeded the configured maximum memory size');
  new Uint8Array(memory.buffer).fill(0, bitmapPointer, bitmapPointer + bitmapCapacity);
  return { byteLength, bitmapPointer, bitmapCapacity };
}

export { engineMemory as getEngineMemory, runScanner as scanNonzeroPages };

/** Store only nonzero pages of this paused engine's current memory.
 *
 * The scratch allocation occurs before capture, so its allocator state is part
 * of the saved engine state. It is deliberately never freed through a possibly
 * invalid/rewound C allocator. A single scratch allocation lives until the
 * engine instance is discarded. Default captures still require a fresh instance.
 * After a successful restore, takeScratchLease() can explicitly release the
 * sole snapshot and transfer its existing reservation to one forward capture.
 * This does not permit concurrent snapshots or rewinding before that allocation.
 * dispose() releases only the host snapshot payload, never native scratch.
 *
 * maximumBytes must cover every subsequent engine memory size. Exceeding it
 * rejects restore rather than accepting an incomplete scan of the grown tail.
 */
export function capture(Module, {
  scanner,
  comparator,
  pageBytes = 16384,
  maximumBytes = 268435456,
  scratchLease,
} = {}) {
  let memory = engineMemory(Module);
  scanner ??= createJsScanner(memory);
  if (scanner.memory !== memory || typeof scanner.scan !== 'function') {
    throw new Error('Scanner must bind the same exported engine memory');
  }
  if (comparator && (comparator.memory !== memory || typeof comparator.fingerprint !== 'function'
      || typeof comparator.equal !== 'function')) throw new Error('Comparator must bind the same engine memory');
  let reservation;
  if (scratchLease !== undefined) {
    const lease = scratchLeases.get(scratchLease);
    if (!lease || lease.module !== Module || lease.memory !== memory
        || lease.pageBytes !== pageBytes || lease.maximumBytes !== maximumBytes
        || memory.buffer.byteLength < lease.byteLength || memory.buffer.byteLength > maximumBytes) {
      throw new Error('Invalid, foreign or consumed scanner scratch lease');
    }
    scratchLeases.delete(scratchLease);
    reservation = { byteLength: memory.buffer.byteLength, bitmapPointer: lease.bitmapPointer, bitmapCapacity: lease.bitmapCapacity };
    new Uint8Array(memory.buffer).fill(0, reservation.bitmapPointer, reservation.bitmapPointer + reservation.bitmapCapacity);
    scratchLease = undefined;
  } else reservation = reserveScannerScratch(Module, { pageBytes, maximumBytes });
  const { byteLength, bitmapPointer, bitmapCapacity } = reservation;
  const scanned = runScanner(scanner, memory, byteLength, pageBytes, bitmapPointer, bitmapCapacity);
  let capturedBitmap = scanned.bitmap;
  let pageIndices = new Uint32Array(scanned.count);
  let payloadOffsets = comparator ? new Uint32Array(scanned.count) : null;
  let retainedDataBytes = 0, originalDataBytes = 0;
  let index = 0, uniquePages = [];
  let buckets = comparator ? new Map() : null;
  for (let page = 0; page < scanned.pages; page++) {
    if (!capturedBitmap[page]) continue;
    const start = page * pageBytes, length = Math.min(pageBytes, byteLength - start);
    pageIndices[index] = page;
    originalDataBytes += length;
    let payloadOffset;
    if (comparator) {
      const key = length + ':' + comparator.fingerprint(start, length);
      const bucket = buckets.get(key);
      // Limit collision work. An unequal page is always saved verbatim, even
      // if its fingerprint collides or its candidate bucket is already full.
      const match = bucket?.find(value => comparator.equal(start, value.page * pageBytes, length));
      if (match) payloadOffset = match.offset;
      else {
        payloadOffset = retainedDataBytes;
        const value = { page, offset: payloadOffset };
        if (!bucket) buckets.set(key, [value]);
        else if (bucket.length < 8) bucket.push(value);
        uniquePages.push(page);
        retainedDataBytes += length;
      }
      payloadOffsets[index] = payloadOffset;
    } else {
      uniquePages.push(page);
      retainedDataBytes += length;
    }
    index++;
  }
  const uniquePageCount = uniquePages.length;
  let savedPages = new Uint8Array(retainedDataBytes);
  let heap = new Uint8Array(memory.buffer);
  let offset = 0;
  for (const page of uniquePages) {
    const start = page * pageBytes;
    const end = Math.min(byteLength, start + pageBytes);
    savedPages.set(heap.subarray(start, end), offset);
    offset += end - start;
  }
  heap = null;
  uniquePages = null;
  buckets = null;
  comparator = null;
  let disposed = false, restoredOnce = false;
  const release = () => {
    disposed = true;
    savedPages = null;
    pageIndices = null;
    payloadOffsets = null;
    capturedBitmap = null;
    scanner = null;
    memory = null;
    Module = null;
  };
  return {
    byteLength,
    get retainedBytes() {
      return disposed ? 0 : savedPages.byteLength + pageIndices.byteLength + capturedBitmap.byteLength + (payloadOffsets?.byteLength || 0);
    },
    pageBytes,
    nonzeroPages: scanned.count,
    uniquePages: uniquePageCount,
    deduplicatedBytes: originalDataBytes - retainedDataBytes,
    zeroPages: scanned.pages - scanned.count,
    scanner: scanner.name ?? 'nonzero-page-scanner',
    scratch: Object.freeze({ pointer: bitmapPointer, byteLength: bitmapCapacity }),
    restore() {
      if (disposed) throw new Error('Compact snapshot has been disposed');
      try {
        if (engineMemory(Module) !== memory) throw new Error('Engine memory object was replaced');
        const currentLength = memory.buffer.byteLength;
        if (currentLength < byteLength || currentLength > maximumBytes) {
          throw new Error('Current heap size is outside the reserved scanner capacity');
        }
        const current = runScanner(scanner, memory, currentLength, pageBytes, bitmapPointer, bitmapCapacity);
        const live = new Uint8Array(memory.buffer);
        let zeroedPages = 0;
        for (let page = 0; page < current.pages; page++) {
          if (!current.bitmap[page] || capturedBitmap[page]) continue;
          live.fill(0, page * pageBytes, Math.min(currentLength, (page + 1) * pageBytes));
          zeroedPages++;
        }
        let sourceOffset = 0;
        for (let index = 0; index < pageIndices.length; index++) {
          const page = pageIndices[index];
          const target = page * pageBytes;
          const length = Math.min(pageBytes, byteLength - target);
          if (payloadOffsets) sourceOffset = payloadOffsets[index];
          live.set(savedPages.subarray(sourceOffset, sourceOffset + length), target);
          sourceOffset += length;
        }
        restoredOnce = true;
        return { byteLength: currentLength, scannedPages: current.pages, zeroedPages, restoredPages: pageIndices.length };
      } catch (error) {
        release();
        throw error;
      }
    },
    // Explicit forward-only ownership transfer after a successful restore.
    // The allocator reservation is never freed or duplicated. The opaque lease
    // is bound to this module/memory/policy and can be consumed exactly once.
    takeScratchLease() {
      if (disposed || !restoredOnce) throw new Error('Scratch transfer requires a live restored snapshot');
      const lease = Object.freeze({});
      scratchLeases.set(lease, { module: Module, memory, pageBytes, maximumBytes,
        byteLength, bitmapPointer, bitmapCapacity });
      release();
      return lease;
    },
    dispose() {
      release();
    },
  };
}
