// Guarded same-instance pdfTeX checkpoints with bounded host-owned snapshots.
const encoder = new TextEncoder();
const bytes = value => typeof value === 'string' ? encoder.encode(value) : new Uint8Array(value);
const now = () => performance.now();
const immutableGuards = new WeakMap();
const projectAccesses = new WeakMap();
const invalidatedInstances = new WeakSet();

function normalized(path) {
  const parts = [];
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') throw new Error('Parent paths are not accepted in checkpoint projects');
    parts.push(part);
  }
  return '/' + parts.join('/');
}

function projectMap(files, root) {
  root = normalized(root);
  const result = new Map();
  for (const [path, value] of Object.entries(files)) {
    const name = normalized(path.startsWith('/') ? path : root + '/' + path);
    if (root !== '/' && name !== root && !name.startsWith(root + '/')) throw new Error('Project path escapes its root: ' + name);
    if (result.has(name)) throw new Error('Duplicate normalized project path: ' + name);
    result.set(name, bytes(value).slice());
  }
  return result;
}

function equal(a, b, end = a.length) {
  if (b.length < end || a.length < end) return false;
  for (let i = 0; i < end; i++) if (a[i] !== b[i]) return false;
  return true;
}

function offsetOfLine(data, line) {
  if (!Number.isInteger(line) || line < 1) throw new Error('Invalid checkpoint line');
  let current = 1;
  for (let i = 0; i < data.length; i++) {
    if (current === line) return i;
    if (data[i] === 10) current++;
  }
  if (current === line) return data.length;
  throw new Error('Checkpoint line is past end of source');
}

function properties(object) {
  return Object.getOwnPropertyDescriptors(object);
}

function restoreProperties(object, descriptors) {
  for (const key of Reflect.ownKeys(object)) {
    if (!Object.hasOwn(descriptors, key) && Object.getOwnPropertyDescriptor(object, key)?.configurable) {
      delete object[key];
    }
  }
  Object.defineProperties(object, descriptors);
}

/** Pin already-mounted asset trees before starting TeX. This guards the FS
 * operations reached by libc, not hostile JavaScript with direct node access.
 * Restore may share these byte arrays only while this guard remains installed.
 */
export function protectImmutableRoots(FS, roots) {
  const normalizedRoots = roots.map(normalized);
  const previous = immutableGuards.get(FS);
  if (previous) {
    for (const root of normalizedRoots) previous.register(root);
    return;
  }
  const guard = { roots: new Set(), ancestors: new Set(), wrappers: new Map(), staticByRoot: new Map(), staticSets: new Map(), staticPaths: new WeakMap(), immutableNodes: new WeakSet() };
  guard.register = root => {
    if (guard.roots.has(root)) return;
    const nodes = [];
    const seen = new Set();
    const nodeSet = new WeakSet();
    const visit = node => {
      if (!node || seen.has(node)) return;
      seen.add(node);
      guard.immutableNodes.add(node);
      nodeSet.add(node);
      guard.staticPaths.set(node, FS.getPath(node));
      nodes.push(node);
      if (FS.isDir(node.mode)) for (const child of Object.values(node.contents ?? {})) visit(child);
    };
    visit(FS.lookupPath(root, { follow: true }).node);
    guard.staticByRoot.set(root, nodes);
    guard.staticSets.set(root, nodeSet);
    guard.roots.add(root);
    let parent = root;
    while (parent !== '/') {
      const slash = parent.lastIndexOf('/');
      parent = slash <= 0 ? '/' : parent.slice(0, slash);
      guard.ancestors.add(parent);
    }

  };
  for (const root of normalizedRoots) guard.register(root);
  const pathOf = path => typeof path === 'string'
    ? normalized(path.startsWith('/') ? path : FS.cwd() + '/' + path)
    : FS.getPath(path);
  // Cost follows path depth, not the number of mounted asset aliases. TeX
  // writes logs/SyncTeX frequently; scanning every pinned file on each write
  // allocates and performs unrelated work on the native hot path.
  const isProtected = (path, ancestors = false) => {
    if (path == null) return false;
    if (ancestors && guard.ancestors.has(path)) return true;
    let prefix = path;
    while (true) {
      if (guard.roots.has(prefix)) return true;
      const slash = prefix.lastIndexOf('/');
      if (slash <= 0) return guard.roots.has('/');
      prefix = prefix.slice(0, slash);
    }
  };
  guard.containsPath = path => isProtected(path);
  const reject = (value, ancestors = false, follow = true) => {
    if (!value) return;
    const path = pathOf(value);
    if (guard.trustedPaths?.has(path)) return;
    if (isProtected(path, ancestors)) throw new Error('Checkpoint asset is read-only: ' + path);
    if (follow && typeof value === 'string') {
      try {
        const resolved = FS.lookupPath(value, { follow: true }).node;
        if (resolved && isProtected(FS.getPath(resolved), ancestors)) throw new Error('Checkpoint asset is read-only: ' + path);
      } catch (error) {
        if (!error?.errno) throw error;
      }
    }
  };
  const wrap = (name, before) => {
    const original = FS[name];
    if (typeof original !== 'function') return;
    const wrapped = function (...args) { before(...args); return original.apply(this, args); };
    FS[name] = wrapped;
    guard.wrappers.set(name, wrapped);
  };
  wrap('open', (path, flags) => {
    const writes = typeof flags === 'string' ? /[wa+]/.test(flags) : (flags & (3 | 64 | 128 | 512 | 1024));
    if (writes) reject(path);
  });
  for (const name of ['write', 'allocate', 'msync']) wrap(name, stream => reject(stream?.node));
  wrap('mmap', (stream, length, position, prot) => { if (prot & 2) reject(stream?.node); });
  for (const name of ['truncate', 'mknod', 'mkdir', 'mkdirTree', 'chmod', 'lchmod', 'chown', 'lchown', 'utime']) {
    wrap(name, path => reject(path));
  }
  for (const name of ['ftruncate', 'fchmod', 'fchown']) wrap(name, fd => reject(FS.getStreamChecked(fd).node));
  for (const name of ['unlink', 'rmdir']) wrap(name, path => reject(path, true));
  wrap('rename', (oldPath, newPath) => { reject(oldPath, true); reject(newPath, true); });
  wrap('symlink', (target, path) => reject(path));
  wrap('mount', (type, options, path) => { if (path) reject(path); });
  wrap('unmount', path => reject(path));
  // Backend lookup may call createNode while resolving a path. Its parent is
  // already canonical; resolving that same child again would recurse in NODEFS.
  wrap('createNode', (parent, name) => { if (parent) reject(FS.getPath(parent) + '/' + name, false, false); });
  immutableGuards.set(FS, guard);
}

/** Append a resolver-owned immutable file without opening authored TeX writes.
 * This synchronous transaction cannot replace an existing asset. Its parents
 * and new node join the guard before control returns to the native engine.
 */
export function installResolvedAsset(FS, path, content) {
  path = normalized(path);
  if (!path.startsWith('/texlive/') || !ArrayBuffer.isView(content)) throw new Error('Invalid resolved asset');
  if (FS.analyzePath(path).exists) throw new Error('Resolved asset already exists: ' + path);
  const guard = immutableGuards.get(FS);
  const paths = new Set();
  const parts = path.split('/').filter(Boolean);
  let current = '';
  for (const part of parts) { current += '/' + part; paths.add(current); }
  if (guard?.trustedPaths) throw new Error('Nested resolver installation');
  if (guard) guard.trustedPaths = paths;
  try {
    FS.mkdirTree(path.slice(0, path.lastIndexOf('/')));
    FS.writeFile(path, content, { canOwn: true });
  } finally { if (guard) guard.trustedPaths = null; }
  if (guard) for (const root of guard.roots) {
    if (!path.startsWith(root + '/')) continue;
    const nodes = guard.staticByRoot.get(root), seen = guard.staticSets.get(root);
    for (const entry of paths) if (entry === root || entry.startsWith(root + '/')) {
      const node = FS.lookupPath(entry, { follow: true }).node;
      const canonical = FS.getPath(node);
      if (canonical !== entry) throw new Error('Resolved asset traversed a link');
      if (!seen.has(node)) {
        seen.add(node);nodes.push(node);guard.immutableNodes.add(node);guard.staticPaths.set(node, canonical);
      }
    }
  }
}

/** Install after mounting project files, before the fresh engine's first call.
 * Metadata probes count as reads: changing a file whose existence/attributes
 * already influenced TeX is not accepted merely because no bytes were read.
 */
export function trackProjectAccesses(FS, root = '/project', { projectPaths } = {}) {
  root = normalized(root);
  const selectedPaths = projectPaths === undefined ? null : new Set([...projectPaths].map(path => normalized(path.startsWith('/') ? path : root + '/' + path)));
  const existing = projectAccesses.get(FS);
  if (existing) {
    if (existing.root !== root) throw new Error('Project access tracker root cannot change');
    if (selectedPaths && (!existing.projectPaths || selectedPaths.size !== existing.projectPaths.size
        || [...selectedPaths].some(path => !existing.projectPaths.has(path)))) throw new Error('Project access tracker inputs cannot change');
    return existing;
  }
  const tracking = { root, touched: new Set(), projectPaths: selectedPaths };
  const projectNodes = selectedPaths ? new WeakSet() : null;
  if (selectedPaths) for (const path of selectedPaths) {
    try { projectNodes.add(FS.lookupPath(path, { follow: true }).node); } catch (error) { if (!error?.errno) throw error; }
  }
  const canonical = path => {
    const absolute = path.startsWith('/') ? path : FS.cwd() + '/' + path;
    const parts = [];
    for (const part of absolute.split('/')) {
      if (!part || part === '.') continue;
      if (part === '..') parts.pop();
      else parts.push(part);
    }
    return '/' + parts.join('/');
  };
  const record = value => {
    if (!value) return;
    // Native font/ICU reads are guarded runtime assets, not authored inputs.
    // Exact authored paths keep metadata invalidation without journaling every
    // font stream read. File-set changes are checked separately before reuse.
    if (selectedPaths && typeof value !== 'string' && !projectNodes.has(value)) return;
    const canonicalAbsolute = typeof value === 'string' && value.startsWith('/')
      && !value.includes('/.') && !value.includes('//') && !value.endsWith('/');
    const path = typeof value === 'string' ? (canonicalAbsolute ? value : canonical(value)) : FS.getPath(value);
    if (selectedPaths && !selectedPaths.has(path)) return;
    if (path != null && (root === '/' || path === root || path.startsWith(root + '/'))) tracking.touched.add(path);
  };
  const lookup = FS.lookupPath;
  FS.lookupPath = function (path, ...args) {
    record(path);
    const result = lookup.call(this, path, ...args);
    record(result?.node);
    return result;
  };
  const open = FS.open;
  const wrappedOpen = function (path, ...args) {
    record(path);
    const stream = open.call(this, path, ...args);
    record(stream?.node);
    return stream;
  };
  FS.open = wrappedOpen;
  // Both wrappers are owned by this module; preserve readonly-guard auditing.
  immutableGuards.get(FS)?.wrappers.set('open', wrappedOpen);
  const read = FS.read;
  FS.read = function (stream, ...args) {
    record(stream?.node);
    return read.call(this, stream, ...args);
  };
  projectAccesses.set(FS, tracking);
  return tracking;
}

/** Capture JS-owned MEMFS state together with libc state in linear memory.
 * Read-only asset bytes are shared. Project/output bytes and stream state are copied.
 * NODEFS, IDBFS, pipes, sockets, and nonstandard stream backends are unsupported.
 */
export function captureFileSystem(FS, { immutableRoots = [], pruneImmutable = false } = {}) {
  immutableRoots = immutableRoots.map(normalized);
  const guard = immutableGuards.get(FS);
  if (immutableRoots.length && (!guard || immutableRoots.some(root => !guard.containsPath(root)))) {
    throw new Error('Install protectImmutableRoots before sharing checkpoint asset bytes');
  }
  if (guard && [...guard.wrappers].some(([name, wrapper]) => FS[name] !== wrapper)) {
    throw new Error('An immutable-asset filesystem guard was replaced');
  }
  let skipped = new WeakSet();
  const staticNameLinks = [];
  if (pruneImmutable && guard) {
    const exactSingle = immutableRoots.length === 1 && guard.staticSets.has(immutableRoots[0]);
    if (exactSingle) skipped = guard.staticSets.get(immutableRoots[0]);
    const linked = new Set();
    for (const [pinnedRoot, pinnedNodes] of guard.staticByRoot) {
      const selected = immutableRoots.filter(root => root === pinnedRoot || root.startsWith(pinnedRoot + '/'));
      if (!selected.length) continue;
      for (const node of pinnedNodes) {
        if (linked.has(node)) continue;
        const path = guard.staticPaths.get(node);
        if (path == null || !selected.some(root => path === root || path.startsWith(root + '/'))) continue;
        if (!exactSingle) skipped.add(node);
        linked.add(node);
        staticNameLinks.push([node, node.name_next]);
      }
    }
  }
  const nodes = new Set();
  function visit(node) {
    if (!node || nodes.has(node) || skipped.has(node)) return;
    nodes.add(node);
    if (FS.isDir(node.mode)) for (const child of Object.values(node.contents ?? {})) visit(child);
    if (node.mounted) visit(node.mounted.root);
  }
  visit(FS.root);
  for (const head of FS.nameTable) for (let node = head; node; node = node.name_next) visit(node);
  for (const stream of FS.streams) if (stream) visit(stream.node);
  let copiedBytes = 0;
  const savedNodes = [];
  for (const node of nodes) {
    const path = FS.getPath(node);
    const descriptors = properties(node);
    const immutable = path != null && immutableRoots.some(root => path === root || path.startsWith(root + '/'));
    if (FS.isFile(node.mode) && node.mount?.type !== FS.filesystems.MEMFS) {
      throw new Error('Checkpoint files must use MEMFS: ' + path);
    }
    if (FS.isDir(node.mode) && descriptors.contents) {
      descriptors.contents.value = { ...node.contents };
    } else if (FS.isFile(node.mode) && node.contents) {
      if (!ArrayBuffer.isView(node.contents) && !Array.isArray(node.contents)) {
        throw new Error('Checkpoint does not support lazy file contents: ' + path);
      }
      if (!immutable) {
        const copy = new Uint8Array(node.contents).slice(0, node.usedBytes);
        descriptors.contents.value = copy;
        copiedBytes += copy.byteLength;
      }
    }
    savedNodes.push({ node, descriptors, immutable });
  }
  const streamTable = FS.streams.slice();
  const sharedStates = new Map();
  const terminalStates = new Map();
  for (const stream of streamTable.filter(Boolean)) {
    if (stream.shared && !sharedStates.has(stream.shared)) sharedStates.set(stream.shared, properties(stream.shared));
    if (stream.tty && !terminalStates.has(stream.tty)) {
      terminalStates.set(stream.tty, { descriptors: properties(stream.tty), input: stream.tty.input?.slice(), output: stream.tty.output?.slice() });
    }
    if (FS.isFile(stream.node.mode) && stream.node.mount?.type !== FS.filesystems.MEMFS) {
      throw new Error('Checkpoint streams must use MEMFS: ' + FS.getPath(stream.node));
    }
  }
  const streams = streamTable.filter(Boolean).map(stream => ({
    stream,
    descriptors: properties(stream),
    shared: stream.shared,
    ungotten: stream.ungotten?.slice(),
    getdents: stream.getdents?.slice(),
  }));
  const nameTable = FS.nameTable.slice();
  const state = Object.fromEntries(['nextInode', 'currentPath', 'ignorePermissions'].map(key => [key, FS[key]]));
  return {
    copiedBytes,
    nodes: savedNodes.length,
    streams: streams.length,
    prunedImmutableNodes: staticNameLinks.length,
    restore() {
      if (guard && [...guard.wrappers].some(([name, wrapper]) => FS[name] !== wrapper)) {
        throw new Error('An immutable-asset filesystem guard was replaced');
      }
      for (const { node, descriptors, immutable } of savedNodes) {
        const restored = { ...descriptors };
        if (FS.isDir(descriptors.mode.value) && descriptors.contents) {
          restored.contents = { ...descriptors.contents, value: { ...descriptors.contents.value } };
        } else if (FS.isFile(descriptors.mode.value) && descriptors.contents?.value != null) {
          if (!immutable) {
            restored.contents = { ...descriptors.contents, value: descriptors.contents.value.slice() };
          }
        }
        restoreProperties(node, restored);
      }
      // New/deleted mutable nodes can change collision chains that pass through
      // pinned nodes. Their bytes/metadata are fixed; these links are not.
      for (const [node, next] of staticNameLinks) node.name_next = next;
      FS.nameTable = nameTable.slice();
      FS.streams = streamTable.slice();
      Object.assign(FS, state);
      const restoredShared = new Map([...sharedStates].map(([original, descriptors]) => [original, Object.defineProperties({}, descriptors)]));
      for (const [tty, { descriptors, input, output }] of terminalStates) {
        restoreProperties(tty, descriptors);
        if (input) tty.input = input.slice();
        if (output) tty.output = output.slice();
      }
      for (const { stream, descriptors, shared, ungotten, getdents } of streams) {
        restoreProperties(stream, descriptors);
        if (shared) stream.shared = restoredShared.get(shared);
        if (ungotten) stream.ungotten = ungotten.slice();
        if (getdents) stream.getdents = getdents.slice();
      }
    },
  };
}

export function armCheckpoint(Module, path, nextLine) {
  if (invalidatedInstances.has(Module)) throw new Error('Checkpoint instance failed; create a fresh engine instance');
  const size = encoder.encode(path).length + 1;
  const ptr = Module._malloc(size);
  try {
    Module.stringToUTF8(path, ptr, size);
    return Module._siglum_checkpoint_arm(ptr, nextLine);
  } finally {
    Module._free(ptr);
  }
}

/** A checkpoint is tied to one live WASM instance and its pinned assets.
 * Restore is accepted only if every other project file and the already-consumed
 * source prefix are unchanged. General multi-file invalidation is not implemented.
 */
export function capturePaused(Module, files, {
  root = '/project', checkpointFile, nextLine, pdfPath = '/project/main.pdf', immutableRoots, pruneImmutable = false, memoryCapture, resumeNative, readResumedOutput,
} = {}) {
  if (invalidatedInstances.has(Module)) throw new Error('Checkpoint instance failed; create a fresh engine instance');
  if (!Module._siglum_checkpoint_paused()) throw new Error('Engine is not paused at a safe point');
  if (memoryCapture !== undefined && typeof memoryCapture !== 'function') throw new Error('memoryCapture must be a synchronous storage factory');
  const captureStart = now();
  let original = projectMap(files, root);
  files = null;
  const path = normalized(checkpointFile.startsWith('/') ? checkpointFile : root + '/' + checkpointFile);
  if (!original.has(path)) throw new Error('Checkpoint source must belong to the project');
  const actualLine = Module._siglum_checkpoint_next_line();
  const actualFile = normalized(Module.UTF8ToString(Module._siglum_checkpoint_filename()));
  if (actualFile !== path || actualLine !== nextLine) {
    throw new Error(`Requested checkpoint ${path}:${nextLine}, but engine paused at ${actualFile}:${actualLine}`);
  }
  if (!Module._siglum_checkpoint_input_state()
      || Module._siglum_checkpoint_buffer_loc() <= Module._siglum_checkpoint_buffer_limit()) {
    throw new Error('Checkpoint has unread TeX input-buffer text');
  }
  const unreadOffset = offsetOfLine(original.get(path), nextLine);
  const prepared = Module._siglum_checkpoint_prepare_snapshot();
  if (prepared !== 0) throw new Error('Could not prepare complete checkpoint state: ' + prepared);
  if (Module._siglum_checkpoint_input_offset() !== unreadOffset) {
    throw new Error('Physical input offset does not match the unchanged source prefix');
  }
  const tracking = projectAccesses.get(Module.FS);
  if (tracking && tracking.root !== normalized(root)) throw new Error('Checkpoint project root differs from access tracker');
  let touched = tracking && new Set(tracking.touched);
  let fsSnapshot = captureFileSystem(Module.FS, { immutableRoots, pruneImmutable });
  let heap = null;
  let memoryBackend = null;
  let disposed = false;
  let heapBytes;
  let heapPayloadBytes;
  const release = (fatal = false) => {
    // Mark the shared instance before dropping this handle's reference. Other
    // handles remain usable on normal disposal and reject after a fatal error.
    if (fatal && Module) invalidatedInstances.add(Module);
    disposed = true;
    const backend = memoryBackend;
    memoryBackend = null;
    heap = null;
    fsSnapshot = null;
    original = null;
    touched = null;
    memoryCapture = null;
    Module = null;
    try { backend?.dispose?.(); } catch {}
  };
  if (memoryCapture) {
    try {
      memoryBackend = memoryCapture(Module);
      if (!memoryBackend || typeof memoryBackend.restore !== 'function'
          || !Number.isSafeInteger(memoryBackend.byteLength)
          || memoryBackend.byteLength !== Module.HEAPU8.byteLength
          || !Number.isSafeInteger(memoryBackend.retainedBytes) || memoryBackend.retainedBytes < 0) {
        throw new Error('memoryCapture returned an invalid synchronous storage backend');
      }
      heapBytes = memoryBackend.byteLength;
      heapPayloadBytes = memoryBackend.retainedBytes;
    } catch (error) {
      release(true);
      throw error;
    }
  } else {
    heap = Module.HEAPU8.slice();
    heapBytes = heap.byteLength;
    heapPayloadBytes = heap.byteLength;
  }
  // A factory can close over its scanner and engine. The backend now owns the
  // needed state, so do not retain the factory for the lifetime of the handle.
  memoryCapture = null;
  const stack = Module.stackSave?.();
  const captureMs = now() - captureStart;
  const snapshot = {
    captureMs,
    memoryBytes: heapPayloadBytes + fsSnapshot.copiedBytes,
    heapBytes,
    heapPayloadBytes,
    fsBytes: fsSnapshot.copiedBytes,
    fsNodes: fsSnapshot.nodes,
    prunedImmutableNodes: fsSnapshot.prunedImmutableNodes,
    checkpointFile: path,
    nextLine,
    unreadOffset,
    touchedFiles: touched ? [...touched] : null,
    check(nextFiles) {
      if (disposed) return { accepted: false, reason: 'Checkpoint has been disposed; create a fresh engine instance' };
      if (invalidatedInstances.has(Module)) {
        release();
        return { accepted: false, reason: 'Checkpoint has been disposed; create a fresh engine instance' };
      }
      const next = projectMap(nextFiles, root);
      if (next.size !== original.size) return { accepted: false, reason: 'Project file set changed' };
      for (const [name, previous] of original) {
        const current = next.get(name);
        if (!current) return { accepted: false, reason: 'Project file removed: ' + name };
        if (name === path) {
          if (!equal(previous, current, unreadOffset)) return { accepted: false, reason: 'Consumed source prefix changed' };
        } else if (previous.length !== current.length || !equal(previous, current)) {
          if (!touched || touched.has(name)) return { accepted: false, reason: 'Dependency already accessed before checkpoint: ' + name };
        }
      }
      return { accepted: true, next };
    },
    restoreAndResume(nextFiles, { resumeNative: resumeOverride, allowCheckpointPause = false } = {}) {
      if (resumeOverride !== undefined && typeof resumeOverride !== 'function') throw new TypeError('Invalid native resume callback');
      if (typeof allowCheckpointPause !== 'boolean' || (allowCheckpointPause && !resumeOverride)) throw new TypeError('Checkpoint pause requires an explicit native resume callback');
      const start = now();
      const guard = snapshot.check(nextFiles);
      const guardMs = now() - start;
      if (!guard.accepted) return { ...guard, guardMs };
      try {
      if (memoryBackend) {
        memoryBackend.restore();
      } else {
      Module.HEAPU8.set(heap);
      Module.HEAPU8.fill(0, heap.byteLength);
      }
      if (stack !== undefined) Module.stackRestore(stack);
      fsSnapshot.restore();
      for (const [name, current] of guard.next) {
        const previous = original.get(name);
        if (previous.length !== current.length || !equal(previous, current)) {
          Module.FS.writeFile(name, current);
        }
      }
      // Host restore and input installation are not native source accesses.
      // Rewind the access journal to the exact prefix captured with this state.
      if (tracking) tracking.touched = new Set(touched);
      const restoredAt = now();
      const refreshStatus = Module._siglum_checkpoint_refresh_inputs();
      if (refreshStatus !== 0) throw new Error('Could not synchronize restored input streams: ' + refreshStatus);
      const refreshedAt = now();
      const nativeResume = resumeOverride ?? resumeNative;
      const status = nativeResume ? nativeResume(Module) : Module._siglum_checkpoint_resume();
      const resumedAt = now();
      if (status !== 0 && !(readResumedOutput && (status === 4 || status === 3
          || (allowCheckpointPause && status === 1 && Module._siglum_checkpoint_paused() === 1)))) throw new Error('Resume did not complete: ' + status);
      const resumedOutput = readResumedOutput ? readResumedOutput(Module, status) : { pdf: Module.FS.readFile(pdfPath).slice() };
      return {
        accepted: true, status, ...resumedOutput, guardMs,
        restoreMs: restoredAt - start - guardMs,
        refreshMs: refreshedAt - restoredAt,
        texMs: resumedAt - refreshedAt,
        outputMs: now() - resumedAt,
        totalMs: now() - start,
        heapBytes: Module.HEAPU8.byteLength,
      };
      } catch (error) {
        // A trap or error may leave JS/Emscripten state outside the rewindable
        // heap. Do not let a corrected edit reuse this instance (or another
        // checkpoint captured from it). The caller must create a fresh engine.
        release(true);
        throw error;
      }
    },
    disposeForRecapture() {
      if (disposed || typeof memoryBackend?.takeScratchLease !== 'function') throw new Error('Snapshot cannot transfer scanner scratch');
      const lease = memoryBackend.takeScratchLease();
      release();
      return lease;
    },
    dispose() {
      release();
    },
  };
  return snapshot;
}
