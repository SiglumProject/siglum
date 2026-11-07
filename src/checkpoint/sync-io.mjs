// Bounded single-producer/single-consumer mailbox. Shared bytes are transport
// only: no package or bundle is retained on a SharedArrayBuffer.
export const SYNC_IO_BYTES = 256 * 1024 + 32;
const WORDS = 8, WAIT = 0, DATA = 1, DONE = 2, FAILED = 3;
const encoder = new TextEncoder(), decoder = new TextDecoder();
const safePath = path => typeof path === 'string' && path.startsWith('/texlive/')
  && !path.split('/').some(part => part === '.' || part === '..') && encoder.encode(path).length < 4096;
export async function respondSyncInput({ buffer, sequence, files, waitAck, live = () => true }) {
  const header = new Int32Array(buffer, 0, WORDS), area = new Uint8Array(buffer, WORDS * 4);
  const current = () => live() && Atomics.load(header, 1) === sequence && Atomics.load(header, 0) !== FAILED;
  let transferred = 0, count = 0, frame = 0;
  try {
    if (!(files instanceof Map) || !files.size || files.size > 8192) throw Error('No input files');
    for (const [path, value] of files) {
      const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
      if (!safePath(path) || bytes.length > 32 * 1024 * 1024 || transferred + bytes.length > 128 * 1024 * 1024) throw Error('Input exceeds mailbox budget');
      const name = encoder.encode(path);let offset = 0;
      do {
        if (!current()) return false;
        const nameLength = offset === 0 ? name.length : 0;
        const length = Math.min(bytes.length - offset, area.length - nameLength);
        area.set(name.subarray(0, nameLength));area.set(bytes.subarray(offset, offset + length), nameLength);
        const number = ++frame;
        const acknowledged = waitAck(sequence, number);
        Atomics.store(header, 2, nameLength);Atomics.store(header, 3, length);
        Atomics.store(header, 4, offset);Atomics.store(header, 5, bytes.length);Atomics.store(header, 6, number);
        Atomics.store(header, 0, DATA);Atomics.notify(header, 0);
        if (!await acknowledged) return false;
        offset += length;
        // An empty file has one frame too.
      } while (offset < bytes.length);
      transferred += bytes.length;count++;
    }
    if (!current()) return false;
    Atomics.store(header, 7, count);Atomics.store(header, 0, DONE);Atomics.notify(header, 0);
    return true;
  } catch {
    if (current()) {Atomics.store(header, 0, FAILED);Atomics.notify(header, 0);}
    return false;
  }
}

// Called only in a dedicated worker, from a synchronous native import.
export function createSyncInputReceiver({ buffer, postMessage, install, lookup, known, describeRange, log = () => {} }) {
  const header = new Int32Array(buffer, 0, WORDS), area = new Uint8Array(buffer, WORDS * 4);
  const negative = new Set();
  function request(fileName, range = null) {
    if (negative.has(fileName)) return null;
    const sequence = (Atomics.add(header, 1, 1) + 1) | 0;
    Atomics.store(header, 0, WAIT);
    const started = performance.now(), deadline = started + 30000;
    postMessage({ type: 'sync-input-request', sequence, fileName, range });
    let path = null, bytes = null, offset = 0, found = null, files = 0;
    try {
      for (;;) {
        const remaining = deadline - performance.now();
        if (remaining <= 0 || Atomics.wait(header, 0, WAIT, remaining) === 'timed-out') throw Error('Input resolution timed out');
        if (Atomics.load(header, 1) !== sequence) throw Error('Input response belongs to another revision');
        const state = Atomics.load(header, 0);
        if (state === DONE) {
          if (bytes || files !== Atomics.load(header, 7)) throw Error('Incomplete input response');
          log(`[SyncIO] ${fileName}: ${files} files in ${(performance.now() - started).toFixed(1)}ms; same TeX pass`);
          if (!found && negative.size < 256) negative.add(fileName);
          return found;
        }
        if (state !== DATA) throw Error('Input provider unavailable');
        const nameLength = Atomics.load(header, 2), length = Atomics.load(header, 3), position = Atomics.load(header, 4), total = Atomics.load(header, 5);
        if (nameLength < 0 || length < 0 || nameLength + length > area.length || total < 0 || total > 32 * 1024 * 1024) throw Error('Invalid input frame');
        if (nameLength) {
          if (bytes || position !== 0 || ++files > 8192) throw Error('Overlapping input files');
          path = decoder.decode(area.slice(0, nameLength));
          if (!safePath(path)) throw Error('Invalid input path');
          bytes = new Uint8Array(total);offset = 0;
        }
        if (!bytes || position !== offset || offset + length > bytes.length) throw Error('Out-of-order input frame');
        bytes.set(area.subarray(nameLength, nameLength + length), offset);offset += length;
        if (offset === bytes.length) {
          install(path, bytes);
          if (path.split('/').pop() === fileName) found = { path, data: bytes };
          bytes = null;path = null;
        }
        const frame = Atomics.load(header, 6);
        Atomics.store(header, 0, WAIT);postMessage({ type: 'sync-input-ack', sequence, frame });
      }
    } catch (error) {
      log('[SyncIO] ' + fileName + ': ' + error.message + '; normal resolver retained');
      Atomics.store(header, 0, FAILED);Atomics.notify(header, 0);
      postMessage({ type: 'sync-input-abort', sequence });
      if (negative.size < 256) negative.add(fileName);
      return null;
    }
  }
  return {
    resolve(name, module, pointer, capacity) {
      if (typeof name !== 'string') return 0;
      const fileName = name.startsWith('./') ? name.slice(2) : name;
      if (fileName.includes('/') || !known(fileName)) return 0;
      const existing = lookup(fileName);
      const result = existing || request(fileName, describeRange?.(fileName));
      if (!result || encoder.encode(result.path).length >= capacity) return 0;
      module.stringToUTF8(result.path, pointer, capacity);
      return 1;
    },
    range(marker) {
      const range = describeRange?.(null, marker);
      return range ? request(range.path.split('/').pop(), range)?.data : null;
    },
  };
}
