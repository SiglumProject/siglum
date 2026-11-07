var __defProp = Object.defineProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, {
      get: all[name],
      enumerable: true,
      configurable: true,
      set: (newValue) => all[name] = () => newValue
    });
};

// src/checkpoint/sync-io.mjs
var SYNC_IO_BYTES = 256 * 1024 + 32;
var WORDS = 8;
var WAIT = 0;
var DATA = 1;
var DONE = 2;
var FAILED = 3;
var encoder = new TextEncoder;
var decoder = new TextDecoder;
var safePath = (path) => typeof path === "string" && path.startsWith("/texlive/") && !path.split("/").some((part) => part === "." || part === "..") && encoder.encode(path).length < 4096;
function createSyncInputReceiver({ buffer, postMessage, install, lookup, known, describeRange, log = () => {} }) {
  const header = new Int32Array(buffer, 0, WORDS), area = new Uint8Array(buffer, WORDS * 4);
  const negative = new Set;
  function request(fileName, range = null) {
    if (negative.has(fileName))
      return null;
    const sequence = Atomics.add(header, 1, 1) + 1 | 0;
    Atomics.store(header, 0, WAIT);
    const started = performance.now(), deadline = started + 30000;
    postMessage({ type: "sync-input-request", sequence, fileName, range });
    let path = null, bytes = null, offset = 0, found = null, files = 0;
    try {
      for (;; ) {
        const remaining = deadline - performance.now();
        if (remaining <= 0 || Atomics.wait(header, 0, WAIT, remaining) === "timed-out")
          throw Error("Input resolution timed out");
        if (Atomics.load(header, 1) !== sequence)
          throw Error("Input response belongs to another revision");
        const state = Atomics.load(header, 0);
        if (state === DONE) {
          if (bytes || files !== Atomics.load(header, 7))
            throw Error("Incomplete input response");
          log(`[SyncIO] ${fileName}: ${files} files in ${(performance.now() - started).toFixed(1)}ms; same TeX pass`);
          if (!found && negative.size < 256)
            negative.add(fileName);
          return found;
        }
        if (state !== DATA)
          throw Error("Input provider unavailable");
        const nameLength = Atomics.load(header, 2), length = Atomics.load(header, 3), position = Atomics.load(header, 4), total = Atomics.load(header, 5);
        if (nameLength < 0 || length < 0 || nameLength + length > area.length || total < 0 || total > 32 * 1024 * 1024)
          throw Error("Invalid input frame");
        if (nameLength) {
          if (bytes || position !== 0 || ++files > 8192)
            throw Error("Overlapping input files");
          path = decoder.decode(area.slice(0, nameLength));
          if (!safePath(path))
            throw Error("Invalid input path");
          bytes = new Uint8Array(total);
          offset = 0;
        }
        if (!bytes || position !== offset || offset + length > bytes.length)
          throw Error("Out-of-order input frame");
        bytes.set(area.subarray(nameLength, nameLength + length), offset);
        offset += length;
        if (offset === bytes.length) {
          install(path, bytes);
          if (path.split("/").pop() === fileName)
            found = { path, data: bytes };
          bytes = null;
          path = null;
        }
        const frame = Atomics.load(header, 6);
        Atomics.store(header, 0, WAIT);
        postMessage({ type: "sync-input-ack", sequence, frame });
      }
    } catch (error) {
      log("[SyncIO] " + fileName + ": " + error.message + "; normal resolver retained");
      Atomics.store(header, 0, FAILED);
      Atomics.notify(header, 0);
      postMessage({ type: "sync-input-abort", sequence });
      if (negative.size < 256)
        negative.add(fileName);
      return null;
    }
  }
  return {
    resolve(name, module, pointer, capacity) {
      if (typeof name !== "string")
        return 0;
      const fileName = name.startsWith("./") ? name.slice(2) : name;
      if (fileName.includes("/") || !known(fileName))
        return 0;
      const existing = lookup(fileName);
      const result = existing || request(fileName, describeRange?.(fileName));
      if (!result || encoder.encode(result.path).length >= capacity)
        return 0;
      module.stringToUTF8(result.path, pointer, capacity);
      return 1;
    },
    range(marker) {
      const range = describeRange?.(null, marker);
      return range ? request(range.path.split("/").pop(), range)?.data : null;
    }
  };
}
// src/checkpoint/placement.mjs
var key = (value) => value.path + ":" + value.editLine;
function placementCandidates(plan, hints) {
  const result = [], seen = new Set;
  const add = (value) => {
    const id = value.path + ":" + value.line + ":" + value.editLine;
    if (!seen.has(id)) {
      seen.add(id);
      result.push(value);
    }
  };
  for (const candidate of plan.candidates) {
    const earlier = hints.get(key(candidate));
    if (Number.isSafeInteger(earlier) && earlier > 0 && earlier < candidate.line) {
      add({ ...candidate, line: earlier, reason: "Earlier boundary after observed native read-ahead" });
    }
    add(candidate);
  }
  return result;
}
function recordOvershoot(hints, candidate, actualLine) {
  if (!Number.isSafeInteger(actualLine) || actualLine <= candidate.editLine || candidate.line <= 1)
    return false;
  const earlier = Math.max(1, candidate.line - Math.max(2, actualLine - candidate.editLine + 2));
  hints.delete(key(candidate));
  hints.set(key(candidate), earlier);
  while (hints.size > 16)
    hints.delete(hints.keys().next().value);
  return true;
}

// src/checkpoint/default-map.mjs
function compactDefaultMap(text) {
  const seen = new Set;
  let removed = 0;
  const lines = text.split(`
`).filter((line) => {
    if (!line.trim() || line.trimStart().startsWith("%"))
      return true;
    if (seen.has(line)) {
      removed++;
      return false;
    }
    seen.add(line);
    return true;
  });
  return { text: lines.join(`
`), removed };
}
function prepareDefaultMap(module) {
  if (!module._siglum_configure_default_map)
    return 0;
  const source = "/texlive/texmf-dist/texmf-var/fonts/map/pdftex/updmap/pdftex.map";
  const target = "/tmp/siglum-default-font-map.map";
  if (module.FS.analyzePath(target).exists)
    return 0;
  let original;
  try {
    original = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(module.FS.readFile(source));
  } catch {
    return 0;
  }
  const compact = compactDefaultMap(original);
  if (!compact.removed)
    return 0;
  module.FS.writeFile(target, compact.text);
  const pointer = module._malloc(target.length + 1);
  try {
    module.stringToUTF8(target, pointer, target.length + 1);
    if (module._siglum_configure_default_map(pointer) !== 0) {
      module.FS.unlink(target);
      return 0;
    }
  } finally {
    module._free(pointer);
  }
  module.__siglumDefaultMapPath = target;
  return compact.removed;
}

// src/checkpoint/font-ranges.mjs
function planCompleteFontRanges(requests, bundleMetadata, policy = {}) {
  const options = {
    maxInputRequests: 2048,
    maxRangeRequests: 256,
    maxRangeBytes: 8 * 1024 * 1024,
    maxBundleBytes: 1024 * 1024 * 1024,
    gapBytes: 64 * 1024,
    maxCostRatio: 0.5,
    requestOverheadBytes: 4096,
    ...policy
  };
  const invalid = (reason) => ({ valid: false, reason, plans: [] });
  for (const key2 of ["maxInputRequests", "maxRangeRequests", "maxRangeBytes", "maxBundleBytes", "gapBytes", "requestOverheadBytes"]) {
    if (!Number.isSafeInteger(options[key2]) || options[key2] < 0)
      return invalid("Invalid policy: " + key2);
  }
  if (!Number.isFinite(options.maxCostRatio) || options.maxCostRatio <= 0 || options.maxCostRatio > 1)
    return invalid("Invalid cost ratio");
  if (!Array.isArray(requests) || requests.length > options.maxInputRequests)
    return invalid("Complete request list exceeds its bound");
  const bundles = new Map;
  for (const request of requests) {
    const { bundleName, start, end } = request || {};
    if (typeof bundleName !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(bundleName) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start)
      return invalid("Invalid range metadata");
    const metadata = bundleMetadata instanceof Map ? bundleMetadata.get(bundleName) : bundleMetadata && Object.hasOwn(bundleMetadata, bundleName) ? bundleMetadata[bundleName] : undefined;
    if (!metadata || !Number.isSafeInteger(metadata.rawBytes) || metadata.rawBytes < 1 || metadata.rawBytes > options.maxBundleBytes || end > metadata.rawBytes || metadata.compressedBytes !== undefined && (!Number.isSafeInteger(metadata.compressedBytes) || metadata.compressedBytes < 1 || metadata.compressedBytes > options.maxBundleBytes))
      return invalid("Invalid full-bundle metadata");
    if (!bundles.has(bundleName))
      bundles.set(bundleName, { metadata, requests: new Map, inputCount: 0 });
    const bundle = bundles.get(bundleName);
    bundle.inputCount++;
    bundle.requests.set(start + ":" + end, { bundleName, start, end });
  }
  let { maxRangeBytes: budgetBytes, maxRangeRequests: budgetRequests } = options;
  const plans = [];
  for (const [bundleName, bundle] of bundles) {
    const selected = [...bundle.requests.values()].sort((a, b) => a.start - b.start || a.end - b.end);
    const merge = (gap) => {
      const groups2 = [];
      for (const file of selected) {
        const last = groups2.at(-1);
        if (last && file.start <= last.end + gap)
          last.end = Math.max(last.end, file.end);
        else
          groups2.push({ start: file.start, end: file.end });
      }
      return groups2;
    };
    const union = merge(0), groups = merge(options.gapBytes);
    const requestedBytes = union.reduce((sum, range) => sum + range.end - range.start, 0);
    const coalescedBytes = groups.reduce((sum, range) => sum + range.end - range.start, 0);
    const estimatedRangeCost = coalescedBytes + groups.length * options.requestOverheadBytes;
    const fullBytes = bundle.metadata.compressedBytes ?? bundle.metadata.rawBytes;
    let mode = "ranges", reason = "Complete bounded range set is cheaper";
    if (!Number.isSafeInteger(estimatedRangeCost))
      return invalid("Range cost overflow");
    if (selected.length > budgetRequests || coalescedBytes > budgetBytes) {
      mode = "bundle";
      reason = "Complete range budget exceeded";
    } else if (estimatedRangeCost > fullBytes * options.maxCostRatio) {
      mode = "bundle";
      reason = "Full bundle is cheaper under the cost policy";
    }
    if (mode === "ranges") {
      budgetBytes -= coalescedBytes;
      budgetRequests -= selected.length;
    }
    plans.push({
      bundleName,
      mode,
      reason,
      inputRequests: bundle.inputCount,
      uniqueRequests: selected.length,
      requestedBytes,
      coalescedBytes,
      groups,
      requests: selected,
      estimatedRangeCost,
      fullBytes,
      fullCostKind: bundle.metadata.compressedBytes === undefined ? "raw-size-estimate" : "compressed-size",
      rawBundleBytes: bundle.metadata.rawBytes
    });
  }
  return {
    valid: true,
    plans,
    reservedRangeBytes: options.maxRangeBytes - budgetBytes,
    reservedRangeRequests: options.maxRangeRequests - budgetRequests
  };
}

// src/checkpoint/font-pins.mjs
function createUsedFontPinScope(vfs) {
  if (typeof vfs?.storeFetchedFile !== "function")
    throw new TypeError("Font cache writer is unavailable");
  const original = vfs.storeFetchedFile, nodes = new Map;
  const observedResources = new Set, retainedResources = new Set, observedBuffers = new WeakSet, retainedBuffers = new WeakSet, owners = new Map;
  const counters = { visibleBytes: 0, backingBytes: 0, retainedVisibleBytes: 0, retainedBackingBytes: 0, copies: 0, copiedBytes: 0 };
  let active = true;
  const key2 = (bundle, start, end) => bundle + ":" + start + ":" + end;
  const own = (id, data, start, end) => {
    if (!(data instanceof Uint8Array) || data.byteLength !== end - start)
      throw new Error("Invalid cached font range length");
    if (!observedResources.has(id)) {
      observedResources.add(id);
      counters.visibleBytes += data.byteLength;
    }
    if (!observedBuffers.has(data.buffer)) {
      observedBuffers.add(data.buffer);
      counters.backingBytes += data.buffer.byteLength;
    }
    let owned = owners.get(id);
    if (owned && owned !== data) {
      for (let i = 0;i < data.length; i++)
        if (owned[i] !== data[i])
          throw new Error("Font resource changed during paused finalization");
    }
    if (!owned) {
      owned = data;
      if (!(data.buffer instanceof ArrayBuffer) || data.byteOffset !== 0 || data.byteLength !== data.buffer.byteLength) {
        owned = new Uint8Array(data.byteLength);
        owned.set(data);
        counters.copies++;
        counters.copiedBytes += owned.byteLength;
      }
      owners.set(id, owned);
    }
    if (!retainedResources.has(id)) {
      retainedResources.add(id);
      counters.retainedVisibleBytes += owned.byteLength;
    }
    if (!retainedBuffers.has(owned.buffer)) {
      retainedBuffers.add(owned.buffer);
      counters.retainedBackingBytes += owned.buffer.byteLength;
    }
    return owned;
  };
  const apply = (node, data, start, end) => {
    if (!(data instanceof Uint8Array) || data.byteLength !== end - start)
      throw new Error("Invalid cached font range length");
    node.contents = data;
    node.usedBytes = data.byteLength;
  };
  function store(bundle, start, end, data) {
    const held = active ? nodes.get(key2(bundle, start, end)) : null;
    if (held && (!(data instanceof Uint8Array) || data.byteLength !== end - start))
      throw new Error("Invalid fetched font range length");
    const owned = active ? own(key2(bundle, start, end), data, start, end) : data;
    original.call(this, bundle, start, end, owned);
    if (held)
      for (const node of held)
        apply(node, owned, start, end);
  }
  vfs.storeFetchedFile = store;
  return {
    hold(node, marker, resolved) {
      if (!active)
        throw new Error("Font pin scope is closed");
      const { bundleName, start, end } = marker || {};
      if (!node || typeof bundleName !== "string" || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start)
        throw new Error("Invalid pinned font metadata");
      const id = key2(bundleName, start, end);
      if (!nodes.has(id))
        nodes.set(id, new Set);
      nodes.get(id).add(node);
      if (resolved?.byteLength) {
        const owned = own(id, resolved, start, end);
        if (owned !== resolved)
          original.call(vfs, bundleName, start, end, owned);
        apply(node, owned, start, end);
      }
    },
    release() {
      if (!active)
        return;
      active = false;
      if (vfs.storeFetchedFile === store)
        vfs.storeFetchedFile = original;
      nodes.clear();
      owners.clear();
    },
    stats() {
      return { ...counters, resources: retainedResources.size };
    }
  };
}

// src/checkpoint/session.mjs
var encoder2 = new TextEncoder;
var bytes = (value) => typeof value === "string" ? encoder2.encode(value) : new Uint8Array(value);
var now = () => performance.now();
var immutableGuards = new WeakMap;
var projectAccesses = new WeakMap;
var invalidatedInstances = new WeakSet;
function normalized(path) {
  const parts = [];
  for (const part of path.split("/")) {
    if (!part || part === ".")
      continue;
    if (part === "..")
      throw new Error("Parent paths are not accepted in checkpoint projects");
    parts.push(part);
  }
  return "/" + parts.join("/");
}
function projectMap(files, root) {
  root = normalized(root);
  const result = new Map;
  for (const [path, value] of Object.entries(files)) {
    const name = normalized(path.startsWith("/") ? path : root + "/" + path);
    if (root !== "/" && name !== root && !name.startsWith(root + "/"))
      throw new Error("Project path escapes its root: " + name);
    if (result.has(name))
      throw new Error("Duplicate normalized project path: " + name);
    result.set(name, bytes(value).slice());
  }
  return result;
}
function equal(a, b, end = a.length) {
  if (b.length < end || a.length < end)
    return false;
  for (let i = 0;i < end; i++)
    if (a[i] !== b[i])
      return false;
  return true;
}
function offsetOfLine(data, line) {
  if (!Number.isInteger(line) || line < 1)
    throw new Error("Invalid checkpoint line");
  let current = 1;
  for (let i = 0;i < data.length; i++) {
    if (current === line)
      return i;
    if (data[i] === 10)
      current++;
  }
  if (current === line)
    return data.length;
  throw new Error("Checkpoint line is past end of source");
}
function properties(object) {
  return Object.getOwnPropertyDescriptors(object);
}
function restoreProperties(object, descriptors) {
  for (const key2 of Reflect.ownKeys(object)) {
    if (!Object.hasOwn(descriptors, key2) && Object.getOwnPropertyDescriptor(object, key2)?.configurable) {
      delete object[key2];
    }
  }
  Object.defineProperties(object, descriptors);
}
function protectImmutableRoots(FS, roots) {
  const normalizedRoots = roots.map(normalized);
  const previous = immutableGuards.get(FS);
  if (previous) {
    for (const root of normalizedRoots)
      previous.register(root);
    return;
  }
  const guard = { roots: new Set, ancestors: new Set, wrappers: new Map, staticByRoot: new Map, staticSets: new Map, staticPaths: new WeakMap, immutableNodes: new WeakSet };
  guard.register = (root) => {
    if (guard.roots.has(root))
      return;
    const nodes = [];
    const seen = new Set;
    const nodeSet = new WeakSet;
    const visit = (node) => {
      if (!node || seen.has(node))
        return;
      seen.add(node);
      guard.immutableNodes.add(node);
      nodeSet.add(node);
      guard.staticPaths.set(node, FS.getPath(node));
      nodes.push(node);
      if (FS.isDir(node.mode))
        for (const child of Object.values(node.contents ?? {}))
          visit(child);
    };
    visit(FS.lookupPath(root, { follow: true }).node);
    guard.staticByRoot.set(root, nodes);
    guard.staticSets.set(root, nodeSet);
    guard.roots.add(root);
    let parent = root;
    while (parent !== "/") {
      const slash = parent.lastIndexOf("/");
      parent = slash <= 0 ? "/" : parent.slice(0, slash);
      guard.ancestors.add(parent);
    }
  };
  for (const root of normalizedRoots)
    guard.register(root);
  const pathOf = (path) => typeof path === "string" ? normalized(path.startsWith("/") ? path : FS.cwd() + "/" + path) : FS.getPath(path);
  const isProtected = (path, ancestors = false) => {
    if (path == null)
      return false;
    if (ancestors && guard.ancestors.has(path))
      return true;
    let prefix = path;
    while (true) {
      if (guard.roots.has(prefix))
        return true;
      const slash = prefix.lastIndexOf("/");
      if (slash <= 0)
        return guard.roots.has("/");
      prefix = prefix.slice(0, slash);
    }
  };
  guard.containsPath = (path) => isProtected(path);
  const reject = (value, ancestors = false, follow = true) => {
    if (!value)
      return;
    const path = pathOf(value);
    if (guard.trustedPaths?.has(path))
      return;
    if (isProtected(path, ancestors))
      throw new Error("Checkpoint asset is read-only: " + path);
    if (follow && typeof value === "string") {
      try {
        const resolved = FS.lookupPath(value, { follow: true }).node;
        if (resolved && isProtected(FS.getPath(resolved), ancestors))
          throw new Error("Checkpoint asset is read-only: " + path);
      } catch (error) {
        if (!error?.errno)
          throw error;
      }
    }
  };
  const wrap = (name, before) => {
    const original = FS[name];
    if (typeof original !== "function")
      return;
    const wrapped = function(...args) {
      before(...args);
      return original.apply(this, args);
    };
    FS[name] = wrapped;
    guard.wrappers.set(name, wrapped);
  };
  wrap("open", (path, flags) => {
    const writes = typeof flags === "string" ? /[wa+]/.test(flags) : flags & (3 | 64 | 128 | 512 | 1024);
    if (writes)
      reject(path);
  });
  for (const name of ["write", "allocate", "msync"])
    wrap(name, (stream) => reject(stream?.node));
  wrap("mmap", (stream, length, position, prot) => {
    if (prot & 2)
      reject(stream?.node);
  });
  for (const name of ["truncate", "mknod", "mkdir", "mkdirTree", "chmod", "lchmod", "chown", "lchown", "utime"]) {
    wrap(name, (path) => reject(path));
  }
  for (const name of ["ftruncate", "fchmod", "fchown"])
    wrap(name, (fd) => reject(FS.getStreamChecked(fd).node));
  for (const name of ["unlink", "rmdir"])
    wrap(name, (path) => reject(path, true));
  wrap("rename", (oldPath, newPath) => {
    reject(oldPath, true);
    reject(newPath, true);
  });
  wrap("symlink", (target, path) => reject(path));
  wrap("mount", (type, options, path) => {
    if (path)
      reject(path);
  });
  wrap("unmount", (path) => reject(path));
  wrap("createNode", (parent, name) => {
    if (parent)
      reject(FS.getPath(parent) + "/" + name, false, false);
  });
  immutableGuards.set(FS, guard);
}
function installResolvedAsset(FS, path, content) {
  path = normalized(path);
  if (!path.startsWith("/texlive/") || !ArrayBuffer.isView(content))
    throw new Error("Invalid resolved asset");
  if (FS.analyzePath(path).exists)
    throw new Error("Resolved asset already exists: " + path);
  const guard = immutableGuards.get(FS);
  const paths = new Set;
  const parts = path.split("/").filter(Boolean);
  let current = "";
  for (const part of parts) {
    current += "/" + part;
    paths.add(current);
  }
  if (guard?.trustedPaths)
    throw new Error("Nested resolver installation");
  if (guard)
    guard.trustedPaths = paths;
  try {
    FS.mkdirTree(path.slice(0, path.lastIndexOf("/")));
    FS.writeFile(path, content, { canOwn: true });
  } finally {
    if (guard)
      guard.trustedPaths = null;
  }
  if (guard)
    for (const root of guard.roots) {
      if (!path.startsWith(root + "/"))
        continue;
      const nodes = guard.staticByRoot.get(root), seen = guard.staticSets.get(root);
      for (const entry of paths)
        if (entry === root || entry.startsWith(root + "/")) {
          const node = FS.lookupPath(entry, { follow: true }).node;
          const canonical = FS.getPath(node);
          if (canonical !== entry)
            throw new Error("Resolved asset traversed a link");
          if (!seen.has(node)) {
            seen.add(node);
            nodes.push(node);
            guard.immutableNodes.add(node);
            guard.staticPaths.set(node, canonical);
          }
        }
    }
}
function trackProjectAccesses(FS, root = "/project", { projectPaths } = {}) {
  root = normalized(root);
  const selectedPaths = projectPaths === undefined ? null : new Set([...projectPaths].map((path) => normalized(path.startsWith("/") ? path : root + "/" + path)));
  const existing = projectAccesses.get(FS);
  if (existing) {
    if (existing.root !== root)
      throw new Error("Project access tracker root cannot change");
    if (selectedPaths && (!existing.projectPaths || selectedPaths.size !== existing.projectPaths.size || [...selectedPaths].some((path) => !existing.projectPaths.has(path))))
      throw new Error("Project access tracker inputs cannot change");
    return existing;
  }
  const tracking = { root, touched: new Set, projectPaths: selectedPaths };
  const projectNodes = selectedPaths ? new WeakSet : null;
  if (selectedPaths)
    for (const path of selectedPaths) {
      try {
        projectNodes.add(FS.lookupPath(path, { follow: true }).node);
      } catch (error) {
        if (!error?.errno)
          throw error;
      }
    }
  const canonical = (path) => {
    const absolute = path.startsWith("/") ? path : FS.cwd() + "/" + path;
    const parts = [];
    for (const part of absolute.split("/")) {
      if (!part || part === ".")
        continue;
      if (part === "..")
        parts.pop();
      else
        parts.push(part);
    }
    return "/" + parts.join("/");
  };
  const record = (value) => {
    if (!value)
      return;
    if (selectedPaths && typeof value !== "string" && !projectNodes.has(value))
      return;
    const canonicalAbsolute = typeof value === "string" && value.startsWith("/") && !value.includes("/.") && !value.includes("//") && !value.endsWith("/");
    const path = typeof value === "string" ? canonicalAbsolute ? value : canonical(value) : FS.getPath(value);
    if (selectedPaths && !selectedPaths.has(path))
      return;
    if (path != null && (root === "/" || path === root || path.startsWith(root + "/")))
      tracking.touched.add(path);
  };
  const lookup = FS.lookupPath;
  FS.lookupPath = function(path, ...args) {
    record(path);
    const result = lookup.call(this, path, ...args);
    record(result?.node);
    return result;
  };
  const open = FS.open;
  const wrappedOpen = function(path, ...args) {
    record(path);
    const stream = open.call(this, path, ...args);
    record(stream?.node);
    return stream;
  };
  FS.open = wrappedOpen;
  immutableGuards.get(FS)?.wrappers.set("open", wrappedOpen);
  const read = FS.read;
  FS.read = function(stream, ...args) {
    record(stream?.node);
    return read.call(this, stream, ...args);
  };
  projectAccesses.set(FS, tracking);
  return tracking;
}
function captureFileSystem(FS, { immutableRoots = [], pruneImmutable = false } = {}) {
  immutableRoots = immutableRoots.map(normalized);
  const guard = immutableGuards.get(FS);
  if (immutableRoots.length && (!guard || immutableRoots.some((root) => !guard.containsPath(root)))) {
    throw new Error("Install protectImmutableRoots before sharing checkpoint asset bytes");
  }
  if (guard && [...guard.wrappers].some(([name, wrapper]) => FS[name] !== wrapper)) {
    throw new Error("An immutable-asset filesystem guard was replaced");
  }
  let skipped = new WeakSet;
  const staticNameLinks = [];
  if (pruneImmutable && guard) {
    const exactSingle = immutableRoots.length === 1 && guard.staticSets.has(immutableRoots[0]);
    if (exactSingle)
      skipped = guard.staticSets.get(immutableRoots[0]);
    const linked = new Set;
    for (const [pinnedRoot, pinnedNodes] of guard.staticByRoot) {
      const selected = immutableRoots.filter((root) => root === pinnedRoot || root.startsWith(pinnedRoot + "/"));
      if (!selected.length)
        continue;
      for (const node of pinnedNodes) {
        if (linked.has(node))
          continue;
        const path = guard.staticPaths.get(node);
        if (path == null || !selected.some((root) => path === root || path.startsWith(root + "/")))
          continue;
        if (!exactSingle)
          skipped.add(node);
        linked.add(node);
        staticNameLinks.push([node, node.name_next]);
      }
    }
  }
  const nodes = new Set;
  function visit(node) {
    if (!node || nodes.has(node) || skipped.has(node))
      return;
    nodes.add(node);
    if (FS.isDir(node.mode))
      for (const child of Object.values(node.contents ?? {}))
        visit(child);
    if (node.mounted)
      visit(node.mounted.root);
  }
  visit(FS.root);
  for (const head of FS.nameTable)
    for (let node = head;node; node = node.name_next)
      visit(node);
  for (const stream of FS.streams)
    if (stream)
      visit(stream.node);
  let copiedBytes = 0;
  const savedNodes = [];
  for (const node of nodes) {
    const path = FS.getPath(node);
    const descriptors = properties(node);
    const immutable = path != null && immutableRoots.some((root) => path === root || path.startsWith(root + "/"));
    if (FS.isFile(node.mode) && node.mount?.type !== FS.filesystems.MEMFS) {
      throw new Error("Checkpoint files must use MEMFS: " + path);
    }
    if (FS.isDir(node.mode) && descriptors.contents) {
      descriptors.contents.value = { ...node.contents };
    } else if (FS.isFile(node.mode) && node.contents) {
      if (!ArrayBuffer.isView(node.contents) && !Array.isArray(node.contents)) {
        throw new Error("Checkpoint does not support lazy file contents: " + path);
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
  const sharedStates = new Map;
  const terminalStates = new Map;
  for (const stream of streamTable.filter(Boolean)) {
    if (stream.shared && !sharedStates.has(stream.shared))
      sharedStates.set(stream.shared, properties(stream.shared));
    if (stream.tty && !terminalStates.has(stream.tty)) {
      terminalStates.set(stream.tty, { descriptors: properties(stream.tty), input: stream.tty.input?.slice(), output: stream.tty.output?.slice() });
    }
    if (FS.isFile(stream.node.mode) && stream.node.mount?.type !== FS.filesystems.MEMFS) {
      throw new Error("Checkpoint streams must use MEMFS: " + FS.getPath(stream.node));
    }
  }
  const streams = streamTable.filter(Boolean).map((stream) => ({
    stream,
    descriptors: properties(stream),
    shared: stream.shared,
    ungotten: stream.ungotten?.slice(),
    getdents: stream.getdents?.slice()
  }));
  const nameTable = FS.nameTable.slice();
  const state = Object.fromEntries(["nextInode", "currentPath", "ignorePermissions"].map((key2) => [key2, FS[key2]]));
  return {
    copiedBytes,
    nodes: savedNodes.length,
    streams: streams.length,
    prunedImmutableNodes: staticNameLinks.length,
    restore() {
      if (guard && [...guard.wrappers].some(([name, wrapper]) => FS[name] !== wrapper)) {
        throw new Error("An immutable-asset filesystem guard was replaced");
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
      for (const [node, next] of staticNameLinks)
        node.name_next = next;
      FS.nameTable = nameTable.slice();
      FS.streams = streamTable.slice();
      Object.assign(FS, state);
      const restoredShared = new Map([...sharedStates].map(([original, descriptors]) => [original, Object.defineProperties({}, descriptors)]));
      for (const [tty, { descriptors, input, output }] of terminalStates) {
        restoreProperties(tty, descriptors);
        if (input)
          tty.input = input.slice();
        if (output)
          tty.output = output.slice();
      }
      for (const { stream, descriptors, shared, ungotten, getdents } of streams) {
        restoreProperties(stream, descriptors);
        if (shared)
          stream.shared = restoredShared.get(shared);
        if (ungotten)
          stream.ungotten = ungotten.slice();
        if (getdents)
          stream.getdents = getdents.slice();
      }
    }
  };
}
function armCheckpoint(Module, path, nextLine) {
  if (invalidatedInstances.has(Module))
    throw new Error("Checkpoint instance failed; create a fresh engine instance");
  const size = encoder2.encode(path).length + 1;
  const ptr = Module._malloc(size);
  try {
    Module.stringToUTF8(path, ptr, size);
    return Module._siglum_checkpoint_arm(ptr, nextLine);
  } finally {
    Module._free(ptr);
  }
}
function capturePaused(Module, files, {
  root = "/project",
  checkpointFile,
  nextLine,
  pdfPath = "/project/main.pdf",
  immutableRoots,
  pruneImmutable = false,
  memoryCapture,
  resumeNative,
  readResumedOutput
} = {}) {
  if (invalidatedInstances.has(Module))
    throw new Error("Checkpoint instance failed; create a fresh engine instance");
  if (!Module._siglum_checkpoint_paused())
    throw new Error("Engine is not paused at a safe point");
  if (memoryCapture !== undefined && typeof memoryCapture !== "function")
    throw new Error("memoryCapture must be a synchronous storage factory");
  const captureStart = now();
  let original = projectMap(files, root);
  files = null;
  const path = normalized(checkpointFile.startsWith("/") ? checkpointFile : root + "/" + checkpointFile);
  if (!original.has(path))
    throw new Error("Checkpoint source must belong to the project");
  const actualLine = Module._siglum_checkpoint_next_line();
  const actualFile = normalized(Module.UTF8ToString(Module._siglum_checkpoint_filename()));
  if (actualFile !== path || actualLine !== nextLine) {
    throw new Error(`Requested checkpoint ${path}:${nextLine}, but engine paused at ${actualFile}:${actualLine}`);
  }
  if (!Module._siglum_checkpoint_input_state() || Module._siglum_checkpoint_buffer_loc() <= Module._siglum_checkpoint_buffer_limit()) {
    throw new Error("Checkpoint has unread TeX input-buffer text");
  }
  const unreadOffset = offsetOfLine(original.get(path), nextLine);
  const prepared = Module._siglum_checkpoint_prepare_snapshot();
  if (prepared !== 0)
    throw new Error("Could not prepare complete checkpoint state: " + prepared);
  if (Module._siglum_checkpoint_input_offset() !== unreadOffset) {
    throw new Error("Physical input offset does not match the unchanged source prefix");
  }
  const tracking = projectAccesses.get(Module.FS);
  if (tracking && tracking.root !== normalized(root))
    throw new Error("Checkpoint project root differs from access tracker");
  let touched = tracking && new Set(tracking.touched);
  let fsSnapshot = captureFileSystem(Module.FS, { immutableRoots, pruneImmutable });
  let heap = null;
  let memoryBackend = null;
  let disposed = false;
  let heapBytes;
  let heapPayloadBytes;
  const release = (fatal = false) => {
    if (fatal && Module)
      invalidatedInstances.add(Module);
    disposed = true;
    const backend = memoryBackend;
    memoryBackend = null;
    heap = null;
    fsSnapshot = null;
    original = null;
    touched = null;
    memoryCapture = null;
    Module = null;
    try {
      backend?.dispose?.();
    } catch {}
  };
  if (memoryCapture) {
    try {
      memoryBackend = memoryCapture(Module);
      if (!memoryBackend || typeof memoryBackend.restore !== "function" || !Number.isSafeInteger(memoryBackend.byteLength) || memoryBackend.byteLength !== Module.HEAPU8.byteLength || !Number.isSafeInteger(memoryBackend.retainedBytes) || memoryBackend.retainedBytes < 0) {
        throw new Error("memoryCapture returned an invalid synchronous storage backend");
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
      if (disposed)
        return { accepted: false, reason: "Checkpoint has been disposed; create a fresh engine instance" };
      if (invalidatedInstances.has(Module)) {
        release();
        return { accepted: false, reason: "Checkpoint has been disposed; create a fresh engine instance" };
      }
      const next = projectMap(nextFiles, root);
      if (next.size !== original.size)
        return { accepted: false, reason: "Project file set changed" };
      for (const [name, previous] of original) {
        const current = next.get(name);
        if (!current)
          return { accepted: false, reason: "Project file removed: " + name };
        if (name === path) {
          if (!equal(previous, current, unreadOffset))
            return { accepted: false, reason: "Consumed source prefix changed" };
        } else if (previous.length !== current.length || !equal(previous, current)) {
          if (!touched || touched.has(name))
            return { accepted: false, reason: "Dependency already accessed before checkpoint: " + name };
        }
      }
      return { accepted: true, next };
    },
    restoreAndResume(nextFiles, { resumeNative: resumeOverride, allowCheckpointPause = false } = {}) {
      if (resumeOverride !== undefined && typeof resumeOverride !== "function")
        throw new TypeError("Invalid native resume callback");
      if (typeof allowCheckpointPause !== "boolean" || allowCheckpointPause && !resumeOverride)
        throw new TypeError("Checkpoint pause requires an explicit native resume callback");
      const start = now();
      const guard = snapshot.check(nextFiles);
      const guardMs = now() - start;
      if (!guard.accepted)
        return { ...guard, guardMs };
      try {
        if (memoryBackend) {
          memoryBackend.restore();
        } else {
          Module.HEAPU8.set(heap);
          Module.HEAPU8.fill(0, heap.byteLength);
        }
        if (stack !== undefined)
          Module.stackRestore(stack);
        fsSnapshot.restore();
        for (const [name, current] of guard.next) {
          const previous = original.get(name);
          if (previous.length !== current.length || !equal(previous, current)) {
            Module.FS.writeFile(name, current);
          }
        }
        if (tracking)
          tracking.touched = new Set(touched);
        const restoredAt = now();
        const refreshStatus = Module._siglum_checkpoint_refresh_inputs();
        if (refreshStatus !== 0)
          throw new Error("Could not synchronize restored input streams: " + refreshStatus);
        const refreshedAt = now();
        const nativeResume = resumeOverride ?? resumeNative;
        const status = nativeResume ? nativeResume(Module) : Module._siglum_checkpoint_resume();
        const resumedAt = now();
        if (status !== 0 && !(readResumedOutput && (status === 4 || status === 3 || allowCheckpointPause && status === 1 && Module._siglum_checkpoint_paused() === 1)))
          throw new Error("Resume did not complete: " + status);
        const resumedOutput = readResumedOutput ? readResumedOutput(Module, status) : { pdf: Module.FS.readFile(pdfPath).slice() };
        return {
          accepted: true,
          status,
          ...resumedOutput,
          guardMs,
          restoreMs: restoredAt - start - guardMs,
          refreshMs: refreshedAt - restoredAt,
          texMs: resumedAt - refreshedAt,
          outputMs: now() - resumedAt,
          totalMs: now() - start,
          heapBytes: Module.HEAPU8.byteLength
        };
      } catch (error) {
        release(true);
        throw error;
      }
    },
    disposeForRecapture() {
      if (disposed || typeof memoryBackend?.takeScratchLease !== "function")
        throw new Error("Snapshot cannot transfer scanner scratch");
      const lease = memoryBackend.takeScratchLease();
      release();
      return lease;
    },
    dispose() {
      release();
    }
  };
  return snapshot;
}

// src/checkpoint/compact-memory.mjs
var exports_compact_memory = {};
__export(exports_compact_memory, {
  scanNonzeroPages: () => runScanner,
  reserveScannerScratch: () => reserveScannerScratch,
  getEngineMemory: () => engineMemory,
  createJsScanner: () => createJsScanner,
  capture: () => capture
});
var allocatedInstances = new WeakSet;
var scratchLeases = new WeakMap;
var supportedPageBytes = new Set([4096, 16384, 65536]);
function engineMemory(Module) {
  const memory = Module.asm?.memory ?? Module.wasmMemory ?? Module.__siglumObservedMemory;
  if (!(memory instanceof WebAssembly.Memory)) {
    throw new Error("Compact snapshots require the exported engine WebAssembly.Memory");
  }
  return memory;
}
function validRange(pointer, length, bound) {
  return Number.isSafeInteger(pointer) && Number.isSafeInteger(length) && pointer >= 0 && length >= 0 && pointer + length <= bound;
}
function createJsScanner(memory) {
  if (!(memory instanceof WebAssembly.Memory))
    throw new Error("Expected WebAssembly.Memory");
  return {
    name: "javascript-nonzero-pages",
    memory,
    scan(livePtr, heapLen, pageBytes, bitmapPtr, bitmapCapacity) {
      const heap = new Uint8Array(memory.buffer);
      if (!supportedPageBytes.has(pageBytes) || !validRange(livePtr, heapLen, heap.length) || !validRange(bitmapPtr, bitmapCapacity, heap.length))
        return 4294967295;
      const pageCount = Math.ceil(heapLen / pageBytes);
      if (bitmapCapacity < pageCount)
        return 4294967294;
      const bitmap = new Uint8Array(memory.buffer, bitmapPtr, pageCount);
      bitmap.fill(0);
      let nonzero = 0;
      for (let page = 0;page < pageCount; page++) {
        const start = livePtr + page * pageBytes;
        const end = Math.min(livePtr + heapLen, start + pageBytes);
        let present = start < bitmapPtr + bitmapCapacity && end > bitmapPtr;
        let cursor = start;
        while (!present && cursor < end && cursor & 3)
          present = heap[cursor++] !== 0;
        if (!present && cursor + 4 <= end) {
          const words = new Uint32Array(memory.buffer, cursor, Math.floor((end - cursor) / 4));
          for (let i = 0;i < words.length; i++) {
            if (words[i] !== 0) {
              present = true;
              break;
            }
          }
          cursor += words.byteLength;
        }
        while (!present && cursor < end)
          present = heap[cursor++] !== 0;
        if (present) {
          bitmap[page] = 1;
          nonzero++;
        }
      }
      return nonzero;
    }
  };
}
function runScanner(scanner, memory, heapLength, pageBytes, pointer, capacity) {
  if (scanner.memory !== memory || typeof scanner.scan !== "function") {
    throw new Error("Scanner must bind the same exported engine memory");
  }
  const count = scanner.scan(0, heapLength, pageBytes, pointer, capacity) >>> 0;
  const pages = Math.ceil(heapLength / pageBytes);
  if (count > pages)
    throw new Error("Nonzero-page scanner rejected the memory range: " + count);
  const bitmap = new Uint8Array(memory.buffer, pointer, pages).slice();
  let actual = 0;
  for (const value of bitmap) {
    if (value !== 0 && value !== 1)
      throw new Error("Scanner returned a non-boolean page bitmap");
    actual += value;
  }
  if (actual !== count)
    throw new Error("Scanner count does not match its bitmap");
  return { bitmap, count, pages };
}
function reserveScannerScratch(Module, { pageBytes, maximumBytes }) {
  const memory = engineMemory(Module);
  if (!supportedPageBytes.has(pageBytes))
    throw new Error("Choose a 4, 16 or 64 KiB snapshot page");
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < memory.buffer.byteLength || maximumBytes > 4294967295)
    throw new Error("Invalid compact snapshot maximum memory size");
  if (allocatedInstances.has(Module))
    throw new Error("Use a fresh engine instance for another compact capture");
  if (typeof Module._malloc !== "function")
    throw new Error("Engine must export malloc for reserved scanner scratch");
  const bitmapCapacity = Math.ceil(maximumBytes / pageBytes);
  const bitmapPointer = Module._malloc(bitmapCapacity) >>> 0;
  if (!bitmapPointer || !validRange(bitmapPointer, bitmapCapacity, memory.buffer.byteLength)) {
    throw new Error("Could not reserve scanner bitmap scratch");
  }
  allocatedInstances.add(Module);
  const byteLength = memory.buffer.byteLength;
  if (byteLength > maximumBytes)
    throw new Error("Scratch allocation exceeded the configured maximum memory size");
  new Uint8Array(memory.buffer).fill(0, bitmapPointer, bitmapPointer + bitmapCapacity);
  return { byteLength, bitmapPointer, bitmapCapacity };
}
function capture(Module, {
  scanner,
  comparator,
  pageBytes = 16384,
  maximumBytes = 268435456,
  scratchLease
} = {}) {
  let memory = engineMemory(Module);
  scanner ??= createJsScanner(memory);
  if (scanner.memory !== memory || typeof scanner.scan !== "function") {
    throw new Error("Scanner must bind the same exported engine memory");
  }
  if (comparator && (comparator.memory !== memory || typeof comparator.fingerprint !== "function" || typeof comparator.equal !== "function"))
    throw new Error("Comparator must bind the same engine memory");
  let reservation;
  if (scratchLease !== undefined) {
    const lease = scratchLeases.get(scratchLease);
    if (!lease || lease.module !== Module || lease.memory !== memory || lease.pageBytes !== pageBytes || lease.maximumBytes !== maximumBytes || memory.buffer.byteLength < lease.byteLength || memory.buffer.byteLength > maximumBytes) {
      throw new Error("Invalid, foreign or consumed scanner scratch lease");
    }
    scratchLeases.delete(scratchLease);
    reservation = { byteLength: memory.buffer.byteLength, bitmapPointer: lease.bitmapPointer, bitmapCapacity: lease.bitmapCapacity };
    new Uint8Array(memory.buffer).fill(0, reservation.bitmapPointer, reservation.bitmapPointer + reservation.bitmapCapacity);
    scratchLease = undefined;
  } else
    reservation = reserveScannerScratch(Module, { pageBytes, maximumBytes });
  const { byteLength, bitmapPointer, bitmapCapacity } = reservation;
  const scanned = runScanner(scanner, memory, byteLength, pageBytes, bitmapPointer, bitmapCapacity);
  let capturedBitmap = scanned.bitmap;
  let pageIndices = new Uint32Array(scanned.count);
  let payloadOffsets = comparator ? new Uint32Array(scanned.count) : null;
  let retainedDataBytes = 0, originalDataBytes = 0;
  let index = 0, uniquePages = [];
  let buckets = comparator ? new Map : null;
  for (let page = 0;page < scanned.pages; page++) {
    if (!capturedBitmap[page])
      continue;
    const start = page * pageBytes, length = Math.min(pageBytes, byteLength - start);
    pageIndices[index] = page;
    originalDataBytes += length;
    let payloadOffset;
    if (comparator) {
      const key2 = length + ":" + comparator.fingerprint(start, length);
      const bucket = buckets.get(key2);
      const match = bucket?.find((value) => comparator.equal(start, value.page * pageBytes, length));
      if (match)
        payloadOffset = match.offset;
      else {
        payloadOffset = retainedDataBytes;
        const value = { page, offset: payloadOffset };
        if (!bucket)
          buckets.set(key2, [value]);
        else if (bucket.length < 8)
          bucket.push(value);
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
    scanner: scanner.name ?? "nonzero-page-scanner",
    scratch: Object.freeze({ pointer: bitmapPointer, byteLength: bitmapCapacity }),
    restore() {
      if (disposed)
        throw new Error("Compact snapshot has been disposed");
      try {
        if (engineMemory(Module) !== memory)
          throw new Error("Engine memory object was replaced");
        const currentLength = memory.buffer.byteLength;
        if (currentLength < byteLength || currentLength > maximumBytes) {
          throw new Error("Current heap size is outside the reserved scanner capacity");
        }
        const current = runScanner(scanner, memory, currentLength, pageBytes, bitmapPointer, bitmapCapacity);
        const live = new Uint8Array(memory.buffer);
        let zeroedPages = 0;
        for (let page = 0;page < current.pages; page++) {
          if (!current.bitmap[page] || capturedBitmap[page])
            continue;
          live.fill(0, page * pageBytes, Math.min(currentLength, (page + 1) * pageBytes));
          zeroedPages++;
        }
        let sourceOffset = 0;
        for (let index2 = 0;index2 < pageIndices.length; index2++) {
          const page = pageIndices[index2];
          const target = page * pageBytes;
          const length = Math.min(pageBytes, byteLength - target);
          if (payloadOffsets)
            sourceOffset = payloadOffsets[index2];
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
    takeScratchLease() {
      if (disposed || !restoredOnce)
        throw new Error("Scratch transfer requires a live restored snapshot");
      const lease = Object.freeze({});
      scratchLeases.set(lease, {
        module: Module,
        memory,
        pageBytes,
        maximumBytes,
        byteLength,
        bitmapPointer,
        bitmapCapacity
      });
      release();
      return lease;
    },
    dispose() {
      release();
    }
  };
}

// src/checkpoint/planner.mjs
var encoder3 = new TextEncoder;
var decoder2 = new TextDecoder("utf-8", { fatal: true });
var argumentDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
function bytes2(value) {
  return typeof value === "string" ? encoder3.encode(value) : new Uint8Array(value);
}
function canonical(path) {
  if (typeof path !== "string" || !path || path.includes("\x00") || path.includes("\\"))
    throw new Error("Invalid project path");
  if (path.startsWith("/project/"))
    path = path.slice("/project/".length);
  else if (path.startsWith("/"))
    throw new Error("Project path escapes its root");
  const parts = [];
  for (const part of path.split("/")) {
    if (!part || part === ".")
      continue;
    if (part === "..") {
      if (!parts.length)
        throw new Error("Project path escapes its root");
      parts.pop();
    } else
      parts.push(part);
  }
  if (!parts.length)
    throw new Error("Invalid project file path");
  return parts.join("/");
}
function fileMap(files) {
  const map = new Map;
  for (const [key2, value] of Object.entries(files || {})) {
    const path = canonical(key2);
    if (map.has(path))
      throw new Error("Duplicate normalized project path: " + path);
    let encoded;
    map.set(path, { key: key2, value, get bytes() {
      return encoded ??= bytes2(value);
    } });
  }
  return map;
}
function sourceText(value) {
  if (typeof value !== "string")
    return decoder2.decode(bytes2(value));
  let source = value.charCodeAt(0) === 65279 ? value.slice(1) : value;
  if (typeof source.toWellFormed === "function")
    return source.toWellFormed();
  let result = "", from = 0;
  for (let i = 0;i < source.length; i++) {
    const unit = source.charCodeAt(i);
    if (unit >= 55296 && unit <= 56319) {
      const next = source.charCodeAt(i + 1);
      if (next >= 56320 && next <= 57343) {
        i++;
        continue;
      }
    } else if (unit < 56320 || unit > 57343)
      continue;
    result += source.slice(from, i) + "�";
    from = i + 1;
  }
  return from ? result + source.slice(from) : source;
}
function firstDifference(a, b) {
  if (a === b)
    return -1;
  const end = Math.min(a.length, b.length);
  for (let i = 0;i < end; i++)
    if (a[i] !== b[i])
      return i;
  return a.length === b.length ? -1 : end;
}
function lineAt(data, offset) {
  let line = 1;
  for (let i = 0;i < Math.min(offset, data.length); i++)
    if (data[i] === 10)
      line++;
  return line;
}
function lineOffset(data, line) {
  let current = 1;
  for (let i = 0;i < data.length; i++) {
    if (current === line)
      return i;
    if (data[i] === 10)
      current++;
  }
  return data.length;
}
var mask = (text) => text.replace(/[^\n]/g, " ");
function lexicalText(source) {
  source = source.replace(/\\begin\{(verbatim\*?|lstlisting|minted)\}[\s\S]*?\\end\{\1\}/g, mask);
  let result = "";
  for (let i = 0;i < source.length; ) {
    if (source.startsWith("\\verb", i) && !/[A-Za-z@]/.test(source[i + 5] || "")) {
      const begin = i;
      let delimiterAt = i + 5;
      if (source[delimiterAt] === "*")
        delimiterAt++;
      const delimiter = source[delimiterAt];
      if (delimiter && !/\s/.test(delimiter)) {
        let end = source.indexOf(delimiter, delimiterAt + 1);
        const newline = source.indexOf(`
`, delimiterAt + 1);
        if (end < 0 || newline >= 0 && newline < end)
          end = newline < 0 ? source.length - 1 : newline - 1;
        i = end + 1;
        result += mask(source.slice(begin, i));
        continue;
      }
    }
    if (source[i] === "%") {
      let slashes = 0;
      for (let at = i - 1;at >= 0 && source[at] === "\\"; at--)
        slashes++;
      if (slashes % 2 === 0) {
        const newline = source.indexOf(`
`, i);
        const end = newline < 0 ? source.length : newline;
        result += mask(source.slice(i, end));
        i = end;
        continue;
      }
    }
    result += source[i++];
  }
  return result;
}
function initialCheckpointCandidate(main, value) {
  const source = sourceText(value), visible = lexicalText(source);
  const begin = /\\begin\s*\{document\}/.exec(visible);
  if (!begin)
    return null;
  return {
    path: canonical(main),
    line: source.slice(0, begin.index + begin[0].length).split(`
`).length + 1,
    editLine: source.split(`
`).length,
    reason: "Initial post-preamble boundary"
  };
}
function resolveInput(argument, files) {
  if (!argument || /[\\#$~\s{}]/.test(argument))
    return { uncertain: true };
  let path;
  try {
    path = canonical(argument);
  } catch {
    return { uncertain: true };
  }
  const variants = [path, path + ".tex"];
  for (const candidate of variants)
    if (files.has(candidate))
      return { path: candidate };
  const matches = [...files.keys()].filter((name) => variants.some((candidate) => name.endsWith("/" + candidate)));
  return matches.length === 1 ? { path: matches[0] } : { uncertain: matches.length > 1 };
}
function parseDirectives(value) {
  let text;
  try {
    const raw = sourceText(value);
    if (!/\\(?:input|include)(?![A-Za-z@])/.test(raw))
      return [];
    text = lexicalText(raw);
  } catch {
    return [];
  }
  const commands = /\\(input|include)(?![A-Za-z@])\s*(?:\{([^{}]*)\}|([^\s{}%]+))?/g;
  const directives = [];
  let line = 1, previous = 0;
  for (const match of text.matchAll(commands)) {
    for (let at = previous;at < match.index; at++)
      if (text.charCodeAt(at) === 10)
        line++;
    previous = match.index;
    const argument = match[2] ?? match[3];
    const copied = argument === undefined ? null : argumentDecoder.decode(encoder3.encode(argument));
    directives.push({ argument: copied, line });
  }
  return directives;
}
function inputGraph(files, main, sourceCache) {
  const incoming = new Map;
  const visited = new Set;
  const sources = new Map;
  let uncertain = false;
  function source(path) {
    if (!sources.has(path)) {
      let text;
      try {
        text = lexicalText(sourceText(files.get(path)?.value));
      } catch {}
      sources.set(path, text);
    }
    return sources.get(path);
  }
  function visit(path, ancestors) {
    if (ancestors.has(path)) {
      uncertain = true;
      return;
    }
    if (visited.has(path))
      return;
    visited.add(path);
    const value = files.get(path);
    if (!value)
      return;
    const directives = sourceCache?.get(path, value.value) ?? parseDirectives(value.value);
    const nextAncestors = new Set([...ancestors, path]);
    for (const directive of directives) {
      const resolved = resolveInput(directive.argument, files);
      if (resolved.uncertain)
        uncertain = true;
      if (!resolved.path)
        continue;
      const edge = { parent: path, child: resolved.path, line: directive.line };
      if (!incoming.has(edge.child))
        incoming.set(edge.child, []);
      incoming.get(edge.child).push(edge);
      visit(edge.child, nextAncestors);
    }
  }
  visit(main, new Set);
  function chain(path, active = new Set) {
    if (path === main)
      return [];
    if (active.has(path))
      return null;
    const parents = incoming.get(path);
    if (parents?.length !== 1)
      return null;
    const edge = parents[0];
    const prefix = chain(edge.parent, new Set([...active, path]));
    return prefix && [...prefix, edge];
  }
  return { uncertain, source, chain };
}
function paragraphStart(source, targetLine) {
  if (!source)
    return targetLine;
  const lines = source.split(`
`);
  let start = Math.max(1, Math.min(targetLine, lines.length));
  if (/^\s*\\(?:chapter|section|subsection|subsubsection|paragraph|begin|input|include)(?![A-Za-z@])/.test(lines[start - 1] || ""))
    return start;
  for (let line = start - 1;line >= 1; line--) {
    const text = lines[line - 1];
    if (!text.trim() || /\\par(?![A-Za-z@])\s*$/.test(text) || /^\s*\\(?:chapter|section|subsection|subsubsection|paragraph|begin|newpage|clearpage|cleardoublepage)(?![A-Za-z@])/.test(text))
      return line + 1;
    start = line;
  }
  return start;
}
function insideDiagram(source, targetLine) {
  if (!source)
    return false;
  const active = [];
  for (const match of source.matchAll(/\\(begin|end)\s*\{(tikzpicture|pgfpicture)\}/g)) {
    const line = source.slice(0, match.index).split(`
`).length;
    if (line > targetLine)
      break;
    if (match[1] === "begin")
      active.push(match[2]);
    else {
      if (line === targetLine && active.includes(match[2]))
        return true;
      const at = active.lastIndexOf(match[2]);
      if (at >= 0)
        active.splice(at, 1);
    }
  }
  return active.length > 0;
}
function planCheckpoints(project, { previousFiles, focus, maxCandidates = 3, sourceCache } = {}) {
  const files = fileMap(project.files);
  const main = canonical(project.main);
  if (!files.has(main))
    return { targets: [], candidates: [], reason: "Main file is missing" };
  if (!Number.isInteger(maxCandidates) || maxCandidates < 1 || maxCandidates > 16)
    throw new Error("Invalid checkpoint candidate limit");
  const targets = [];
  let fileSetChanged = false;
  if (previousFiles) {
    const previous = fileMap(previousFiles);
    for (const path of [...new Set([...files.keys(), ...previous.keys()])].sort()) {
      const currentFile = files.get(path), previousFile = previous.get(path);
      if (currentFile && previousFile && typeof currentFile.value === "string" && currentFile.value === previousFile.value)
        continue;
      const current = currentFile?.bytes;
      const before = previousFile?.bytes;
      if (!current || !before) {
        fileSetChanged = true;
        targets.push({ path, offset: 0, line: 1 });
        continue;
      }
      const offset = firstDifference(before, current);
      if (offset >= 0)
        targets.push({ path, offset, line: lineAt(current, offset) });
    }
  }
  if (!targets.length && focus) {
    const path = canonical(focus.path);
    const value = files.get(path);
    if (value) {
      const requested = Number.isSafeInteger(focus.offset) && focus.offset >= 0 ? focus.offset : lineOffset(value.bytes, Number.isInteger(focus.line) && focus.line > 0 ? focus.line : 1);
      const offset = Math.min(requested, value.bytes.length);
      targets.push({ path, offset, line: lineAt(value.bytes, offset) });
    }
  }
  if (!targets.length)
    return { targets, candidates: [], reason: "No changed source or valid focus" };
  const graph = inputGraph(files, main, sourceCache);
  const chains = targets.map((target) => graph.chain(target.path));
  const candidates = [];
  const add = (path, line, editLine, reason2) => {
    line = Math.max(1, line);
    if (!candidates.some((candidate) => candidate.path === path && candidate.line === line))
      candidates.push({ path, line, editLine, reason: reason2 });
  };
  const limitAt = (path) => {
    let limit = Number.MAX_SAFE_INTEGER;
    targets.forEach((target, i) => {
      if (target.path === path)
        limit = Math.min(limit, target.line);
      else {
        const edge = chains[i]?.find((item) => item.parent === path);
        if (edge)
          limit = Math.min(limit, edge.line);
      }
    });
    return limit;
  };
  let reason = "Before the changed editing region";
  if (fileSetChanged || graph.uncertain || chains.some((chain) => !chain)) {
    reason = fileSetChanged ? "Project file set changed" : "Input resolution is ambiguous or dynamic";
    add(main, 1, limitAt(main), reason + "; root fallback requires the access guard");
  } else {
    const nodePaths = targets.map((target, i) => [main, ...chains[i].map((edge) => edge.child)]);
    let common = main;
    for (let depth = 1;nodePaths.every((path) => path[depth] && path[depth] === nodePaths[0][depth]); depth++)
      common = nodePaths[0][depth];
    let anchor = common;
    let anchorLine = limitAt(anchor);
    if (targets.length === 1) {
      const target = targets[0];
      const source = graph.source(target.path);
      const isTikz = insideDiagram(source, target.line);
      if (isTikz && chains[0].length) {
        const parent = chains[0][chains[0].length - 1];
        anchor = parent.parent;
        anchorLine = parent.line;
        reason = "Before the parent input of a diagram";
      } else {
        anchor = target.path;
        anchorLine = target.line;
      }
    } else
      reason = "Before the common ancestor of changed files";
    const boundary = reason.includes("diagram") ? anchorLine : paragraphStart(graph.source(anchor), anchorLine);
    add(anchor, boundary - 1, limitAt(anchor), reason + "; validate the actual safe point");
    add(anchor, 1, limitAt(anchor), "Earlier file start after a missed or overshot boundary");
    add(main, 1, limitAt(main), "Root fallback requires the access guard");
  }
  return { targets, candidates: candidates.slice(0, maxCandidates), reason };
}
function createCheckpointPlanner({ maxCacheBytes = 8 * 1024 * 1024, maxCacheFiles = 256 } = {}) {
  if (!Number.isSafeInteger(maxCacheBytes) || maxCacheBytes < 0 || !Number.isSafeInteger(maxCacheFiles) || maxCacheFiles < 0)
    throw new Error("Invalid planner cache budget");
  const entries = new Map;
  let retainedBytes = 0, additionalDataBytes = 0, referencedSourceBytes = 0, hits = 0, misses = 0, disposed = false;
  const remove = (path) => {
    const entry = entries.get(path);
    if (entry) {
      retainedBytes -= entry.cost;
      additionalDataBytes -= entry.metadataBytes;
      referencedSourceBytes -= entry.sourceBytes;
    }
    entries.delete(path);
  };
  const sourceCache = {
    get(path, value) {
      const entry = entries.get(path);
      if (typeof value === "string" && entry?.value === value) {
        hits++;
        entries.delete(path);
        entries.set(path, entry);
        return entry.directives;
      }
      misses++;
      remove(path);
      const directives = parseDirectives(value);
      if (typeof value !== "string" || maxCacheFiles === 0)
        return directives;
      const sourceBytes = value.length * 2;
      const metadataBytes = 96 + path.length * 2 + directives.reduce((sum, item) => sum + 64 + (item.argument?.length ?? 0) * 2, 0);
      const cost = sourceBytes + metadataBytes;
      if (cost > maxCacheBytes)
        return directives;
      while (entries.size && (entries.size >= maxCacheFiles || retainedBytes + cost > maxCacheBytes))
        remove(entries.keys().next().value);
      entries.set(path, { value, directives, cost, sourceBytes, metadataBytes });
      retainedBytes += cost;
      additionalDataBytes += metadataBytes;
      referencedSourceBytes += sourceBytes;
      return directives;
    }
  };
  const planner = (project, options = {}) => {
    if (disposed)
      throw new Error("Planner disposed");
    const current = fileMap(project.files);
    for (const [path, entry] of entries)
      if (current.get(path)?.value !== entry.value)
        remove(path);
    return planCheckpoints(project, { ...options, sourceCache });
  };
  planner.clear = () => {
    entries.clear();
    retainedBytes = 0;
    additionalDataBytes = 0;
    referencedSourceBytes = 0;
  };
  planner.dispose = () => {
    planner.clear();
    disposed = true;
  };
  Object.defineProperty(planner, "cacheInfo", { get: () => ({
    retainedBytes,
    additionalDataBytes,
    referencedSourceBytes,
    encodedSourceBytes: 0,
    lexicalSourceBytes: 0,
    files: entries.size,
    hits,
    misses,
    maxCacheBytes,
    maxCacheFiles,
    disposed
  }) });
  return planner;
}
function targetProbeFiles(files, targets) {
  const map = fileMap(files);
  const result = Object.assign(Object.create(null), files);
  const edited = new Set;
  for (const target of targets) {
    const path = canonical(target.path);
    const file = map.get(path);
    if (!file) {
      result[path] = Uint8Array.of(33);
      continue;
    }
    const existing = bytes2(result[file.key]);
    const offset = Math.max(0, Math.min(Number.isSafeInteger(target.offset) ? target.offset : lineOffset(existing, target.line), existing.length));
    const key2 = path + ":" + offset;
    if (edited.has(key2))
      continue;
    edited.add(key2);
    const changed = new Uint8Array(existing.length + (offset === existing.length ? 1 : 0));
    changed.set(existing);
    changed[offset] = offset === existing.length ? 33 : existing[offset] ^ 1;
    result[file.key] = changed;
  }
  return result;
}

// src/checkpoint/scanner.mjs
function readUleb(bytes3, at) {
  let value = 0;
  let shift = 0;
  while (at < bytes3.length) {
    const byte = bytes3[at++];
    value += (byte & 127) * 2 ** shift;
    if (!(byte & 128))
      return [value, at];
    shift += 7;
  }
  throw new Error("Invalid WASM section length");
}
async function instantiateMemoryKernel(memory, wasmBytes) {
  if (!(memory instanceof WebAssembly.Memory))
    throw new TypeError("Pass the actual compiler WebAssembly.Memory");
  const bytes3 = wasmBytes instanceof Uint8Array ? wasmBytes : new Uint8Array(wasmBytes);
  let at = 8;
  while (at < bytes3.length) {
    const id = bytes3[at++];
    let size;
    [size, at] = readUleb(bytes3, at);
    if (id === 8)
      throw new Error("Scanner must not run a start function against compiler memory");
    if (id === 11) {
      const [count] = readUleb(bytes3, at);
      if (count !== 0)
        throw new Error("Scanner must not initialize data in compiler memory");
    }
    at += size;
  }
  const module = await WebAssembly.compile(bytes3);
  const imports = WebAssembly.Module.imports(module);
  if (imports.length !== 1 || imports[0].module !== "env" || imports[0].name !== "memory" || imports[0].kind !== "memory") {
    throw new Error("Scanner must import only compiler memory");
  }
  const instance = await WebAssembly.instantiate(module, { env: { memory } });
  if (instance.exports.__stack_pointer?.value !== 0)
    throw new Error("Scanner must not use a linear-memory stack");
  return instance.exports;
}
async function createRustScanner(memory, wasmBytes) {
  const exports = await instantiateMemoryKernel(memory, wasmBytes);
  if (typeof exports.nonzero_pages !== "function")
    throw new Error("Missing nonzero_pages export");
  return {
    name: "rust-u64-nonzero-pages",
    memory,
    scan(livePtr, heapLen, pageBytes, bitmapPtr, bitmapCapacity) {
      const result = exports.nonzero_pages(livePtr, heapLen, pageBytes, bitmapPtr, bitmapCapacity) >>> 0;
      if (result === 4294967295)
        throw new Error("Invalid sparse scanner arguments or memory bounds");
      if (result === 4294967294)
        throw new Error("Sparse scanner bitmap reservation is too small");
      return result;
    }
  };
}

// src/checkpoint/embedded-dedup-kernels.mjs
var scalarBytes = () => Uint8Array.from(atob("AGFzbQEAAAABDgJgA39/fwF/YAJ/fwF/Ag8BA2VudgZtZW1vcnkCAAADAwIAAQYQA38BQQALfwBBAAt/AEEACwdPBQ9fX3N0YWNrX3BvaW50ZXIDAAtlcXVhbF9wYWdlcwAAEHBhZ2VfZmluZ2VycHJpbnQAAQpfX2RhdGFfZW5kAwELX19oZWFwX2Jhc2UDAgrVBQKJAQEBfwJAPwBBEHQiAyAATw0AQQAPCwJAIAIgAyAAa00NAEEADwsCQCADIAFPDQBBAA8LAkAgAiADIAFrTQ0AQQAPCwJAAkAgAg0AQQEhAwwBCwJAA0AgAC0AACABLQAARw0BQQEhAyAAQQFqIQAgAUEBaiEBIAJBf2oiAkUNAgwACwtBAA8LIAMLxwQBAn8/ACECQQAhAwJAIABBA3ENACACQRB0IgIgAEkNACABIAIgAGtLDQACQCABQQRJDQAgACgCAEHFu/KIeHNBk4OACGwgAUF8aiIBQQ9uQfz///8BcSAAaigCAHNBk4OACGwgAUEBdEEPbkH8////AXEgAGooAgBzQZODgAhsIAFBA2xBD25B/P///wFxIABqKAIAc0GTg4AIbCABQQJ0QQ9uQfz///8BcSAAaigCAHNBk4OACGwgAUEFbEEPbkH8////AXEgAGooAgBzQZODgAhsIAFBBmxBD25B/P///wFxIABqKAIAc0GTg4AIbCABQQdsQQ9uQfz///8BcSAAaigCAHNBk4OACGwgAUEDdEEPbkH8////AXEgAGooAgBzQZODgAhsIAFBCWxBD25B/P///wFxIABqKAIAc0GTg4AIbCABQQpsQQ9uQfz///8BcSAAaigCAHNBk4OACGwgAUELbEEPbkH8////AXEgAGooAgBzQZODgAhsIAFBDGxBD25B/P///wFxIABqKAIAc0GTg4AIbCABQQ1sQQ9uQfz///8BcSAAaigCAHNBk4OACGwgAUEObEEPbkH8////AXEgAGooAgBzQZODgAhsIAFBD2xBD25B/P///wFxIABqKAIAc0GTg4AIbA8LAkAgAQ0AQcW78oh4DwsgAC0AAEHFu/KIeHNBk4OACGwhAyABQQFGDQAgAyAAQQFyLQAAc0GTg4AIbCEDIAFBAkYNACADIABBAnItAABzQZODgAhsIQMLIAMLAEkEbmFtZQAMC3NjYWxhci53YXNtASACAAtlcXVhbF9wYWdlcwEQcGFnZV9maW5nZXJwcmludAcSAQAPX19zdGFja19wb2ludGVyAD0JcHJvZHVjZXJzAQxwcm9jZXNzZWQtYnkBBXJ1c3RjHTEuOTIuMCAoZGVkNWMwNmNmIDIwMjUtMTItMDgpAJQBD3RhcmdldF9mZWF0dXJlcwgrC2J1bGstbWVtb3J5Kw9idWxrLW1lbW9yeS1vcHQrFmNhbGwtaW5kaXJlY3Qtb3ZlcmxvbmcrCm11bHRpdmFsdWUrD211dGFibGUtZ2xvYmFscysTbm9udHJhcHBpbmctZnB0b2ludCsPcmVmZXJlbmNlLXR5cGVzKwhzaWduLWV4dA=="), (c) => c.charCodeAt(0));
var simdBytes = () => Uint8Array.from(atob("AGFzbQEAAAABDgJgA39/fwF/YAJ/fwF/Ag8BA2VudgZtZW1vcnkCAAADAwIAAQYQA38BQQALfwBBAAt/AEEACwdPBQ9fX3N0YWNrX3BvaW50ZXIDAAtlcXVhbF9wYWdlcwAAEHBhZ2VfZmluZ2VycHJpbnQAAQpfX2RhdGFfZW5kAwELX19oZWFwX2Jhc2UDAgqYBgLMAQEEf0EAIQMCQD8AQRB0IgQgAEkNACACIAQgAGtLDQAgBCABSQ0AIAIgBCABa0sNAEEAIQMCQAJAA0ACQCADQRBqIgQgAk0NAAJAIAIgA0sNAEEBDwsgASADaiEEIAAgA2ohBSACIANrIQYMAgsgASADaiEFIAAgA2ohBiAEIQMgBv0AAAAgBf0AAAD9I/1jDQAMAgsLA0AgBS0AACAELQAARw0BQQEhAyAFQQFqIQUgBEEBaiEEIAZBf2oiBkUNAgwACwtBACEDCyADC8cEAQJ/PwAhAkEAIQMCQCAAQQNxDQAgAkEQdCICIABJDQAgASACIABrSw0AAkAgAUEESQ0AIAAoAgBBxbvyiHhzQZODgAhsIAFBfGoiAUEPbkH8////AXEgAGooAgBzQZODgAhsIAFBAXRBD25B/P///wFxIABqKAIAc0GTg4AIbCABQQNsQQ9uQfz///8BcSAAaigCAHNBk4OACGwgAUECdEEPbkH8////AXEgAGooAgBzQZODgAhsIAFBBWxBD25B/P///wFxIABqKAIAc0GTg4AIbCABQQZsQQ9uQfz///8BcSAAaigCAHNBk4OACGwgAUEHbEEPbkH8////AXEgAGooAgBzQZODgAhsIAFBA3RBD25B/P///wFxIABqKAIAc0GTg4AIbCABQQlsQQ9uQfz///8BcSAAaigCAHNBk4OACGwgAUEKbEEPbkH8////AXEgAGooAgBzQZODgAhsIAFBC2xBD25B/P///wFxIABqKAIAc0GTg4AIbCABQQxsQQ9uQfz///8BcSAAaigCAHNBk4OACGwgAUENbEEPbkH8////AXEgAGooAgBzQZODgAhsIAFBDmxBD25B/P///wFxIABqKAIAc0GTg4AIbCABQQ9sQQ9uQfz///8BcSAAaigCAHNBk4OACGwPCwJAIAENAEHFu/KIeA8LIAAtAABBxbvyiHhzQZODgAhsIQMgAUEBRg0AIAMgAEEBci0AAHNBk4OACGwhAyABQQJGDQAgAyAAQQJyLQAAc0GTg4AIbCEDCyADCwBHBG5hbWUACglzaW1kLndhc20BIAIAC2VxdWFsX3BhZ2VzARBwYWdlX2ZpbmdlcnByaW50BxIBAA9fX3N0YWNrX3BvaW50ZXIAPQlwcm9kdWNlcnMBDHByb2Nlc3NlZC1ieQEFcnVzdGMdMS45Mi4wIChkZWQ1YzA2Y2YgMjAyNS0xMi0wOCkAnQEPdGFyZ2V0X2ZlYXR1cmVzCSsLYnVsay1tZW1vcnkrD2J1bGstbWVtb3J5LW9wdCsWY2FsbC1pbmRpcmVjdC1vdmVybG9uZysKbXVsdGl2YWx1ZSsPbXV0YWJsZS1nbG9iYWxzKxNub250cmFwcGluZy1mcHRvaW50Kw9yZWZlcmVuY2UtdHlwZXMrCHNpZ24tZXh0KwdzaW1kMTI4"), (c) => c.charCodeAt(0));

// src/checkpoint/page-comparator.mjs
async function createPageComparator(memory, { simdAvailable = false } = {}) {
  if (typeof simdAvailable !== "boolean")
    throw new TypeError("SIMD availability must be a boolean");
  const exports = await instantiateMemoryKernel(memory, simdAvailable ? simdBytes() : scalarBytes());
  if (typeof exports.page_fingerprint !== "function" || typeof exports.equal_pages !== "function") {
    throw new Error("Missing page comparison exports");
  }
  const valid = (at, length) => Number.isSafeInteger(at) && Number.isSafeInteger(length) && at >= 0 && length > 0 && at + length <= memory.buffer.byteLength;
  return {
    memory,
    name: simdAvailable ? "rust-simd128-page-comparison" : "rust-scalar-page-comparison",
    fingerprint(at, length) {
      if (!valid(at, length) || at % 4 !== 0)
        throw new Error("Invalid page fingerprint range");
      return exports.page_fingerprint(at, length) >>> 0;
    },
    equal(left, right, length) {
      if (!valid(left, length) || !valid(right, length))
        throw new Error("Invalid page comparison range");
      return exports.equal_pages(left, right, length) === 1;
    }
  };
}

// src/checkpoint/embedded-kernels.mjs
var scalar = Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0, 1, 16, 2, 96, 2, 127, 127, 1, 127, 96, 5, 127, 127, 127, 127, 127, 1, 127, 2, 15, 1, 3, 101, 110, 118, 6, 109, 101, 109, 111, 114, 121, 2, 0, 0, 3, 3, 2, 0, 1, 6, 16, 3, 127, 1, 65, 0, 11, 127, 0, 65, 0, 11, 127, 0, 65, 0, 11, 7, 77, 5, 15, 95, 95, 115, 116, 97, 99, 107, 95, 112, 111, 105, 110, 116, 101, 114, 3, 0, 12, 98, 105, 116, 109, 97, 112, 95, 98, 121, 116, 101, 115, 0, 0, 13, 110, 111, 110, 122, 101, 114, 111, 95, 112, 97, 103, 101, 115, 0, 1, 10, 95, 95, 100, 97, 116, 97, 95, 101, 110, 100, 3, 1, 11, 95, 95, 104, 101, 97, 112, 95, 98, 97, 115, 101, 3, 2, 10, 139, 5, 2, 60, 1, 1, 127, 65, 127, 33, 2, 2, 64, 32, 0, 69, 13, 0, 2, 64, 32, 1, 65, 128, 32, 70, 13, 0, 32, 1, 65, 128, 128, 1, 70, 13, 0, 32, 1, 65, 128, 128, 4, 71, 13, 1, 11, 32, 0, 65, 127, 106, 32, 1, 110, 65, 1, 106, 33, 2, 11, 32, 2, 11, 203, 4, 1, 9, 127, 65, 127, 33, 5, 2, 64, 32, 1, 69, 13, 0, 2, 64, 32, 2, 65, 128, 32, 70, 13, 0, 32, 2, 65, 128, 128, 1, 70, 13, 0, 32, 2, 65, 128, 128, 4, 71, 13, 1, 11, 65, 126, 33, 5, 32, 4, 32, 1, 65, 127, 106, 32, 2, 110, 34, 6, 77, 13, 0, 2, 64, 63, 0, 65, 16, 116, 34, 7, 32, 0, 79, 13, 0, 65, 127, 15, 11, 2, 64, 32, 1, 32, 7, 32, 0, 107, 77, 13, 0, 65, 127, 15, 11, 2, 64, 32, 7, 32, 3, 79, 13, 0, 65, 127, 15, 11, 65, 127, 33, 5, 32, 4, 32, 7, 32, 3, 107, 75, 13, 0, 32, 4, 32, 3, 106, 33, 8, 32, 0, 33, 9, 65, 0, 33, 5, 65, 0, 33, 4, 3, 64, 32, 1, 32, 4, 34, 10, 32, 2, 108, 34, 11, 107, 34, 4, 32, 2, 32, 4, 32, 2, 73, 27, 33, 12, 2, 64, 2, 64, 32, 11, 32, 0, 106, 34, 13, 32, 8, 79, 13, 0, 65, 1, 33, 7, 32, 12, 32, 13, 106, 32, 3, 75, 13, 1, 11, 65, 0, 33, 4, 2, 64, 32, 1, 32, 11, 70, 13, 0, 2, 64, 65, 0, 32, 13, 107, 65, 7, 113, 34, 11, 69, 13, 0, 65, 1, 33, 7, 32, 13, 45, 0, 0, 13, 2, 32, 12, 33, 4, 32, 12, 65, 1, 70, 13, 1, 32, 11, 65, 1, 70, 13, 0, 65, 1, 33, 7, 32, 13, 65, 1, 106, 45, 0, 0, 13, 2, 32, 12, 33, 4, 32, 12, 65, 2, 70, 13, 1, 32, 11, 65, 2, 70, 13, 0, 32, 13, 65, 2, 106, 45, 0, 0, 13, 2, 32, 12, 33, 4, 32, 12, 65, 3, 70, 13, 1, 32, 11, 65, 3, 70, 13, 0, 32, 13, 65, 3, 106, 45, 0, 0, 13, 2, 32, 12, 33, 4, 32, 12, 65, 4, 70, 13, 1, 32, 11, 65, 4, 70, 13, 0, 32, 13, 65, 4, 106, 45, 0, 0, 13, 2, 32, 12, 33, 4, 32, 12, 65, 5, 70, 13, 1, 32, 11, 65, 5, 70, 13, 0, 32, 13, 65, 5, 106, 45, 0, 0, 13, 2, 32, 12, 33, 4, 32, 12, 65, 6, 70, 13, 1, 32, 11, 65, 6, 70, 13, 0, 32, 13, 65, 6, 106, 45, 0, 0, 13, 2, 32, 12, 33, 4, 32, 12, 65, 7, 70, 13, 1, 32, 11, 33, 4, 32, 11, 65, 7, 70, 13, 1, 32, 12, 33, 4, 32, 13, 65, 7, 106, 45, 0, 0, 69, 13, 1, 12, 2, 11, 32, 11, 33, 4, 11, 3, 64, 2, 64, 32, 4, 65, 8, 106, 34, 7, 32, 12, 77, 13, 0, 65, 0, 33, 7, 32, 4, 32, 12, 79, 13, 2, 3, 64, 32, 9, 32, 4, 106, 45, 0, 0, 34, 11, 65, 0, 71, 33, 7, 32, 11, 13, 3, 32, 4, 65, 1, 106, 34, 4, 32, 12, 73, 13, 0, 12, 3, 11, 11, 32, 9, 32, 4, 106, 33, 11, 32, 7, 33, 4, 32, 11, 41, 3, 0, 80, 13, 0, 11, 65, 1, 33, 7, 11, 32, 10, 65, 1, 106, 33, 4, 32, 10, 32, 3, 106, 32, 7, 58, 0, 0, 32, 9, 32, 2, 106, 33, 9, 32, 5, 32, 7, 106, 33, 5, 32, 10, 32, 6, 73, 13, 0, 11, 11, 32, 5, 11);
var simd64 = Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0, 1, 16, 2, 96, 2, 127, 127, 1, 127, 96, 5, 127, 127, 127, 127, 127, 1, 127, 2, 15, 1, 3, 101, 110, 118, 6, 109, 101, 109, 111, 114, 121, 2, 0, 0, 3, 3, 2, 0, 1, 6, 16, 3, 127, 1, 65, 0, 11, 127, 0, 65, 0, 11, 127, 0, 65, 0, 11, 7, 77, 5, 15, 95, 95, 115, 116, 97, 99, 107, 95, 112, 111, 105, 110, 116, 101, 114, 3, 0, 12, 98, 105, 116, 109, 97, 112, 95, 98, 121, 116, 101, 115, 0, 0, 13, 110, 111, 110, 122, 101, 114, 111, 95, 112, 97, 103, 101, 115, 0, 1, 10, 95, 95, 100, 97, 116, 97, 95, 101, 110, 100, 3, 1, 11, 95, 95, 104, 101, 97, 112, 95, 98, 97, 115, 101, 3, 2, 10, 241, 4, 2, 60, 1, 1, 127, 65, 127, 33, 2, 2, 64, 32, 0, 69, 13, 0, 2, 64, 32, 1, 65, 128, 32, 70, 13, 0, 32, 1, 65, 128, 128, 1, 70, 13, 0, 32, 1, 65, 128, 128, 4, 71, 13, 1, 11, 32, 0, 65, 127, 106, 32, 1, 110, 65, 1, 106, 33, 2, 11, 32, 2, 11, 177, 4, 1, 12, 127, 65, 127, 33, 5, 2, 64, 32, 1, 69, 13, 0, 2, 64, 32, 2, 65, 128, 32, 70, 13, 0, 32, 2, 65, 128, 128, 1, 70, 13, 0, 32, 2, 65, 128, 128, 4, 71, 13, 1, 11, 65, 126, 33, 5, 32, 4, 32, 1, 65, 127, 106, 32, 2, 110, 34, 6, 77, 13, 0, 2, 64, 63, 0, 65, 16, 116, 34, 7, 32, 0, 79, 13, 0, 65, 127, 15, 11, 2, 64, 32, 1, 32, 7, 32, 0, 107, 77, 13, 0, 65, 127, 15, 11, 2, 64, 32, 7, 32, 3, 79, 13, 0, 65, 127, 15, 11, 65, 127, 33, 5, 32, 4, 32, 7, 32, 3, 107, 75, 13, 0, 65, 0, 32, 0, 107, 33, 8, 32, 4, 32, 3, 106, 33, 9, 32, 0, 33, 10, 32, 1, 33, 11, 65, 0, 33, 5, 65, 0, 33, 4, 3, 64, 32, 1, 32, 4, 34, 12, 32, 2, 108, 34, 4, 107, 34, 7, 32, 2, 32, 7, 32, 2, 73, 27, 33, 13, 2, 64, 2, 64, 32, 4, 32, 0, 106, 34, 7, 32, 9, 79, 13, 0, 65, 1, 33, 14, 32, 13, 32, 7, 106, 32, 3, 75, 13, 1, 11, 65, 0, 33, 7, 2, 64, 32, 1, 32, 4, 70, 13, 0, 32, 8, 65, 15, 113, 33, 4, 32, 8, 65, 15, 113, 33, 7, 32, 10, 33, 14, 32, 2, 32, 11, 32, 2, 32, 11, 73, 27, 34, 15, 65, 1, 32, 15, 65, 1, 75, 27, 34, 16, 33, 15, 3, 64, 32, 4, 69, 13, 1, 2, 64, 32, 14, 45, 0, 0, 69, 13, 0, 65, 1, 33, 14, 12, 3, 11, 32, 14, 65, 1, 106, 33, 14, 32, 4, 65, 127, 106, 33, 4, 32, 15, 65, 127, 106, 34, 15, 13, 0, 11, 32, 16, 33, 7, 11, 2, 64, 3, 64, 32, 7, 65, 192, 0, 106, 34, 14, 32, 13, 75, 13, 1, 32, 10, 32, 7, 106, 33, 4, 32, 14, 33, 7, 32, 4, 253, 0, 4, 0, 32, 4, 65, 16, 106, 253, 0, 4, 0, 253, 80, 32, 4, 65, 32, 106, 253, 0, 4, 0, 253, 80, 32, 4, 65, 48, 106, 253, 0, 4, 0, 253, 80, 253, 83, 69, 13, 0, 11, 65, 1, 33, 14, 12, 1, 11, 3, 64, 2, 64, 32, 7, 65, 16, 106, 34, 4, 32, 13, 77, 13, 0, 65, 0, 33, 14, 32, 7, 32, 13, 79, 13, 2, 32, 10, 32, 7, 106, 33, 16, 65, 0, 33, 4, 3, 64, 32, 16, 32, 4, 106, 45, 0, 0, 34, 15, 65, 0, 71, 33, 14, 32, 15, 13, 3, 32, 4, 65, 1, 106, 34, 4, 32, 7, 106, 32, 13, 73, 13, 0, 12, 3, 11, 11, 32, 10, 32, 7, 106, 33, 14, 32, 4, 33, 7, 32, 14, 253, 0, 4, 0, 253, 83, 69, 13, 0, 11, 65, 1, 33, 14, 11, 32, 12, 65, 1, 106, 33, 4, 32, 12, 32, 3, 106, 32, 14, 58, 0, 0, 32, 10, 32, 2, 106, 33, 10, 32, 11, 32, 2, 107, 33, 11, 32, 8, 32, 2, 107, 33, 8, 32, 5, 32, 14, 106, 33, 5, 32, 12, 32, 6, 73, 13, 0, 11, 11, 32, 5, 11);
var simdFeatureProbe = Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 127, 3, 2, 1, 0, 7, 8, 1, 4, 115, 105, 109, 100, 0, 0, 10, 24, 1, 22, 0, 253, 12, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 253, 83, 11);
var scalarSha256 = "c4db1aa8a3f9c7732237999787cd3dc9e892995d13481e835c3b65f3a0b0661b";
var simd64Sha256 = "f56fe088482aa64ff225da0b1f0b21b410f6ceaac5607379a02bf561149d21af";
function scalarBytes2() {
  return scalar.slice();
}
function simd64Bytes() {
  return simd64.slice();
}
function featureProbeBytes() {
  return simdFeatureProbe.slice();
}

// src/checkpoint/simd-memory.mjs
function supportsSimd128() {
  try {
    return WebAssembly.validate(featureProbeBytes());
  } catch {
    return false;
  }
}
async function createPreferredRustScanner(memory, { simdAvailable = supportsSimd128() } = {}) {
  if (typeof simdAvailable !== "boolean")
    throw new TypeError("SIMD availability must be a boolean");
  const bytes3 = simdAvailable ? simd64Bytes() : scalarBytes2();
  const scanner = await createRustScanner(memory, bytes3);
  scanner.name = simdAvailable ? "rust-simd128-64-nonzero-pages" : "rust-u64-nonzero-pages";
  scanner.selection = Object.freeze({
    variant: simdAvailable ? "simd64" : "scalar",
    kernelBytes: bytes3.length,
    kernelSha256: simdAvailable ? simd64Sha256 : scalarSha256,
    scalarFallback: !simdAvailable,
    reason: simdAvailable ? "SIMD128 feature probe accepted" : "Scalar compatibility path selected",
    embedded: true
  });
  return scanner;
}
async function createPreferredMemoryBackend(module, {
  compact,
  simdAvailable = supportsSimd128(),
  pageBytes = 16384,
  maximumBytes = 268435456,
  scratchLease,
  deduplicate = false
} = {}) {
  if (typeof compact?.getEngineMemory !== "function" || typeof compact?.capture !== "function") {
    throw new TypeError("Inject the existing compact memory module");
  }
  const scanner = await createPreferredRustScanner(compact.getEngineMemory(module), { simdAvailable });
  const comparator = deduplicate ? await createPageComparator(compact.getEngineMemory(module), { simdAvailable }) : undefined;
  const metadata = { mode: "compact-rust", scanner: scanner.name, ...scanner.selection, coalesced: false };
  return {
    metadata,
    memoryCapture(value) {
      if (value !== module)
        throw new Error("Memory backend belongs to a different compiler instance");
      const saved = compact.capture(module, { scanner, pageBytes, maximumBytes, scratchLease, comparator });
      Object.assign(metadata, {
        retainedHeapBytes: saved.retainedBytes,
        nonzeroPages: saved.nonzeroPages,
        zeroPages: saved.zeroPages,
        uniquePages: saved.uniquePages,
        deduplicatedBytes: saved.deduplicatedBytes
      });
      return saved;
    }
  };
}

// src/checkpoint/page-packet.mjs
var infoNames = [
  "baseIndex",
  "objectNumber",
  "sizeSp",
  "designSizeSp",
  "pdfSizeSp",
  "mapType",
  "slant",
  "extend",
  "platformId",
  "encodingId",
  "noBuiltinToUnicode",
  "firstChar",
  "lastChar",
  "tfmChecksum",
  "descriptorFlags"
];
var stringNames = ["tfm", "fontFile", "encodingFile", "postscriptName", "subfontFile"];
var copy = (mod, pointer, length, maximum) => {
  if (!Number.isSafeInteger(length) || length < 0 || length > maximum || !pointer && length || pointer < 0 || pointer + length > mod.HEAPU8.length)
    throw new Error("Invalid native packet buffer");
  return mod.HEAPU8.slice(pointer, pointer + length);
};
var packetGuardFlags = Object.freeze({
  image: 1,
  form: 2,
  rawObject: 4,
  annotation: 8,
  link: 16,
  pageAttributes: 32,
  customResources: 64,
  pageGroup: 128,
  fontOverflow: 256,
  missingCapture: 512,
  bufferFailure: 1024,
  compilerError: 2048
});
function readLiveFonts(mod) {
  const maximum = mod._siglum_preview_font_max_index();
  if (!Number.isSafeInteger(maximum) || maximum < 0 || maximum > 1e5)
    throw new Error("Invalid live font maximum");
  const fonts = [];
  for (let index = 1;index <= maximum; index++) {
    if (mod._siglum_preview_font_info(index, 0) < 0)
      continue;
    const row = { index };
    for (let field = 0;field < infoNames.length; field++)
      row[infoNames[field]] = mod._siglum_preview_font_info(index, field);
    for (let field = 0;field < stringNames.length; field++) {
      const pointer = mod._siglum_preview_font_string(index, field);
      row[stringNames[field]] = pointer ? mod.UTF8ToString(pointer) : null;
    }
    row.usedCharacters = copy(mod, mod._siglum_preview_font_bits(index), 32, 32);
    row.attributes = copy(mod, mod._siglum_preview_font_attr_data(index), mod._siglum_preview_font_attr_length(index), 65536);
    fonts.push(row);
  }
  return fonts;
}
function readPagePacket(mod) {
  if (mod._siglum_preview_api_version?.() !== 1 || !mod._siglum_preview_paused())
    throw new Error("Engine is not paused with an exact page packet");
  const count = mod._siglum_preview_font_count();
  if (!Number.isSafeInteger(count) || count < 0 || count > 512)
    throw new Error("Invalid page font count");
  const fonts = readLiveFonts(mod);
  const pageFonts = Array.from({ length: count }, (_, index) => mod._siglum_preview_font_index(index));
  return {
    kind: "engine-page-preview",
    provisional: true,
    page: mod._siglum_preview_page(),
    widthSp: mod._siglum_preview_width_sp(),
    heightSp: mod._siglum_preview_height_sp(),
    flags: mod._siglum_preview_guard_flags(),
    content: copy(mod, mod._siglum_preview_content_data(), mod._siglum_preview_content_length(), 2 * 1024 * 1024),
    resources: copy(mod, mod._siglum_preview_resources_data(), mod._siglum_preview_resources_length(), 64 * 1024),
    pageFonts,
    fonts,
    inputStateAtYield: mod._siglum_checkpoint_input_state(),
    totalPagesAtYield: mod._siglum_checkpoint_total_pages()
  };
}
var equalBytes = (a, b) => a.length === b.length && a.every((value, index) => value === b[index]);
var fontIdentity = (font) => JSON.stringify(Object.fromEntries([
  ...infoNames.filter((name) => !["baseIndex", "objectNumber"].includes(name)),
  ...stringNames
].map((name) => [name, font[name]])));
function checkCachedFonts(packet, baselineFonts) {
  const union = (fonts, base) => {
    const bits = new Uint8Array(32);
    for (const font of fonts)
      if (font.baseIndex === base)
        for (let index = 0;index < bits.length; index++)
          bits[index] |= font.usedCharacters[index];
    return bits;
  };
  for (const base of packet.pageFonts) {
    const current = packet.fonts.find((font) => font.index === base);
    const previous = baselineFonts.find((font) => font.index === base);
    if (!current || !previous || current.mapType < 0 || current.mapType & 128 || current.subfontFile)
      return { accepted: false, reason: "Unknown, bitmap or subfont resource", font: base };
    if (current.objectNumber !== previous.objectNumber || fontIdentity(current) !== fontIdentity(previous) || !equalBytes(current.attributes, previous.attributes))
      return { accepted: false, reason: "Font metadata changed", font: base };
    const before = union(baselineFonts, base), after = union(packet.fonts, base);
    for (let index = 0;index < before.length; index++)
      if (after[index] & ~before[index])
        return { accepted: false, reason: "New character outside cached font subset", font: base, byte: index };
  }
  return { accepted: true };
}

// src/checkpoint-api.js
var encoder4 = new TextEncoder;
var decoder3 = new TextDecoder;
var now2 = () => performance.now();
function bytes3(value) {
  if (typeof value === "string")
    return encoder4.encode(value);
  if (ArrayBuffer.isView(value))
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return new Uint8Array(value);
}
function equal2(a, b) {
  if (a === b)
    return true;
  if (a == null || b == null)
    return false;
  const left = bytes3(a), right = bytes3(b);
  return left.length === right.length && left.every((value, i) => value === right[i]);
}
function sameMap(a, b) {
  return !!a && !!b && a.size === b.size && [...a].every(([key2, value]) => b.has(key2) && equal2(value, b.get(key2)));
}
function sameAux(a = {}, b = {}) {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key2) => Object.hasOwn(b, key2) && equal2(a[key2], b[key2]));
}

class CheckpointRetentionError extends Error {
  constructor(message, policy, bytes4 = 0) {
    super(message);
    this.name = "CheckpointRetentionError";
    this.policy = policy;
    this.bytes = bytes4;
  }
}
function createCheckpointDriver({ log = () => {}, maximumBytes = 48 * 1024 * 1024 } = {}) {
  const planner = createCheckpointPlanner();
  let saved = null, lastFiles = null, lastKey = null, job = null;
  let lastReason = "No reusable checkpoint", nextPlan = null, retentionFallback = null;
  const placements = new Map, placementHints = new Map;
  const copiedFiles = (files) => Object.fromEntries(Object.entries(files).map(([name, value]) => [name, typeof value === "string" ? value : bytes3(value).slice()]));
  function drop(reason) {
    saved?.handle.dispose();
    saved = null;
    if (reason)
      lastReason = reason;
  }
  function captureAtPoint(module, vfs, { candidate, plan, aux, immutableRoots, backend, fontRanges = [] }) {
    let handle;
    try {
      const actualLine = module._siglum_checkpoint_next_line();
      protectImmutableRoots(module.FS, immutableRoots);
      handle = capturePaused(module, job.files, {
        root: "/",
        checkpointFile: candidate.path,
        nextLine: actualLine,
        pdfPath: job.pdfPath,
        immutableRoots,
        pruneImmutable: true,
        memoryCapture: backend.memoryCapture,
        resumeNative: (value) => value._siglum_checkpoint_resume(),
        readResumedOutput: (_value, nativeStatus) => ({ nativeStatus })
      });
      if (handle.memoryBytes > maximumBytes)
        throw new CheckpointRetentionError("Checkpoint exceeds the retained memory budget: " + handle.memoryBytes + " > " + maximumBytes + " bytes", "memory", handle.memoryBytes);
      if (plan.targets.length) {
        const probe = handle.check(targetProbeFiles(job.files, plan.targets));
        if (!probe.accepted)
          throw new CheckpointRetentionError("Edited input already consumed: " + probe.reason, "placement");
      }
      return {
        handle,
        module,
        vfs,
        aux: { ...aux },
        assets: new Map(job.assets),
        signature: job.signature,
        key: job.key,
        actualLine,
        path: candidate.path,
        pages: module._siglum_checkpoint_total_pages(),
        fontRanges,
        immutableRoots
      };
    } catch (error) {
      handle?.dispose();
      throw error;
    }
  }
  return {
    prepareDefaultMap,
    installResolvedAsset,
    planFontRanges: planCompleteFontRanges,
    pinFonts: createUsedFontPinScope,
    begin(request) {
      job = request;
      nextPlan = null;
      if (lastKey !== job.key) {
        drop("Document changed");
        lastFiles = null;
        retentionFallback = null;
        planner.clear();
        placements.clear();
        placementHints.clear();
      }
      if (job.forceFull)
        drop("Explicit full build requested");
    },
    endRequest() {
      job = null;
      nextPlan = null;
    },
    get module() {
      return saved?.module;
    },
    get vfs() {
      return saved?.vfs;
    },
    drop,
    async tryResume() {
      if (!saved || job.forceFull)
        return null;
      if (saved.key !== job.key || saved.signature !== job.signature || !sameMap(saved.assets, job.assets) || !sameAux(saved.aux, job.aux)) {
        log("[Checkpoint] Guard inputs: " + JSON.stringify({ key: saved.key === job.key, signature: saved.signature === job.signature, assets: sameMap(saved.assets, job.assets), aux: sameAux(saved.aux, job.aux), savedAssets: saved.assets.size, assetsNow: job.assets.size }));
        log("[Checkpoint] Runtime inputs or auxiliary state changed");
        drop("Runtime inputs or auxiliary state changed");
        return null;
      }
      const editPlan = planner({ main: job.main, files: job.files }, {
        previousFiles: lastFiles,
        focus: job.focus,
        maxCandidates: 3
      });
      nextPlan = editPlan;
      const start = now2();
      try {
        job.beforeResume?.(saved.module, saved.vfs);
        saved.module.__siglumResetOutput?.();
        const current = saved;
        const candidate = placementCandidates(editPlan, placementHints).find((value) => !(value.path === job.main && value.line === 1) && !placements.has(value.path + ":" + value.line + ":" + value.editLine) && (value.path !== current.path || value.line > current.actualLine));
        const result = current.handle.restoreAndResume(job.files, candidate ? {
          allowCheckpointPause: true,
          resumeNative(module) {
            if (armCheckpoint(module, "/" + candidate.path, candidate.line) !== 0) {
              throw new Error("Checkpoint advance arm rejected");
            }
            return module._siglum_checkpoint_resume();
          }
        } : undefined);
        if (result.accepted && candidate && result.nativeStatus === 1 && current.module._siglum_checkpoint_paused() === 1) {
          const { module, vfs } = current;
          const actualLine = module._siglum_checkpoint_next_line();
          const path = module.UTF8ToString(module._siglum_checkpoint_filename());
          if (path !== "/" + candidate.path || actualLine > candidate.editLine) {
            if (path === "/" + candidate.path)
              recordOvershoot(placementHints, candidate, actualLine);
            placements.set(candidate.path + ":" + candidate.line + ":" + candidate.editLine, true);
            while (placements.size > 16)
              placements.delete(placements.keys().next().value);
            log("[Checkpoint] Advance overshot edit; retaining the original checkpoint");
          } else {
            const oldPages = current.pages;
            const scratchLease = current.handle.disposeForRecapture();
            saved = null;
            const backend = await createPreferredMemoryBackend(module, { compact: exports_compact_memory, scratchLease, deduplicate: job.engine === "xelatex" });
            try {
              saved = captureAtPoint(module, vfs, {
                candidate,
                plan: editPlan,
                aux: current.aux,
                immutableRoots: current.immutableRoots,
                backend,
                fontRanges: current.fontRanges
              });
              result.promotion = { fromPages: oldPages, toPages: saved.pages, captureMs: saved.handle.captureMs };
              log("[Checkpoint] Advanced the sole checkpoint from page " + oldPages + " to " + saved.pages);
            } catch (error) {
              if (!(error instanceof CheckpointRetentionError))
                throw error;
              placements.set(candidate.path + ":" + candidate.line + ":" + candidate.editLine, true);
              while (placements.size > 16)
                placements.delete(placements.keys().next().value);
              retentionFallback = error.policy === "memory" ? {
                key: current.key,
                signature: current.signature,
                path: current.path,
                line: current.actualLine,
                editLine: current.actualLine
              } : null;
              result.retentionRejected = { policy: error.policy, bytes: error.bytes, maximumBytes };
              lastReason = error.message;
              log("[Checkpoint] Finishing the valid replay without retaining the larger checkpoint: " + error.message);
            }
          }
          const resumedAt = now2();
          result.nativeStatus = current.module._siglum_checkpoint_resume();
          result.texMs += now2() - resumedAt;
        } else if (result.accepted && candidate) {
          placements.set(candidate.path + ":" + candidate.line + ":" + candidate.editLine, true);
          while (placements.size > 16)
            placements.delete(placements.keys().next().value);
        }
        if (!result.accepted) {
          log("[Checkpoint] Guard rejected: " + result.reason);
          drop(result.reason);
          return null;
        }
        const active = saved || current;
        const status = await job.finishFonts(active.module, active.vfs, result.nativeStatus);
        if (status !== 0 || active.vfs.getPendingDeferredFiles().length) {
          drop("A resumed run needs new resources; using the normal resolver");
          return null;
        }
        const conversionStart = now2();
        if (job.finishOutput && await job.finishOutput(active.module, active.vfs) !== 0) {
          drop("Output conversion did not complete; using a full build");
          return null;
        }
        const conversionMs = now2() - conversionStart;
        active.module._flush_streams?.();
        const aux = job.collectAux(active.module.FS);
        const auxChanged = !sameAux(active.aux, aux);
        const needsConvergence = auxChanged && (job.needsRerun?.(active.module.FS, aux) ?? true);
        lastFiles = copiedFiles(job.files);
        lastKey = job.key;
        const metadata = {
          mode: "reuse",
          reason: result.retentionRejected ? "Native checkpoint reused; larger checkpoint not retained" : "Native checkpoint reused",
          retained: !!saved,
          snapshotBytes: saved?.handle.memoryBytes || 0,
          heapBytes: active.module.HEAPU8.byteLength,
          actualLine: active.actualLine,
          path: active.path,
          pagesAtCheckpoint: active.pages,
          guardMs: result.guardMs,
          restoreMs: result.restoreMs,
          texMs: result.texMs,
          conversionMs,
          totalMs: now2() - start,
          instanceId: active.module.__siglumInstanceId,
          ...result.retentionRejected ? { retentionRejected: result.retentionRejected } : {},
          ...result.promotion ? { promotion: result.promotion } : {}
        };
        log(`[Checkpoint] reuse: ${metadata.totalMs.toFixed(1)}ms; ${Math.round(metadata.snapshotBytes / 1048576)} MiB snapshot`);
        const completed = { module: active.module, aux, fontRanges: active.fontRanges, metadata, needsConvergence };
        if (auxChanged) {
          metadata.retained = false;
          metadata.snapshotBytes = 0;
          drop(needsConvergence ? "References changed; continuing from completed auxiliary files" : "Auxiliary state changed without a TeX rerun request; publishing the valid pass");
          log(needsConvergence ? "[Checkpoint] References changed; preserving this completed pass for convergence" : "[Checkpoint] Auxiliary bytes changed without a rerun request; no extra TeX pass");
        }
        return completed;
      } catch (error) {
        log("[Checkpoint] Saved state could not resume: " + error.message);
        drop("Saved state could not resume: " + error.message);
        return null;
      }
    },
    async preparePass(module, vfs, aux, eligible = true) {
      drop();
      const unavailable = !eligible ? "This pass is not checkpoint-safe" : job.forceFull ? "Explicit full build requested" : typeof module._siglum_checkpoint_arm !== "function" ? "The selected " + job.engine + " runtime has no native checkpoint exports" : job.engine === "xelatex" && module._siglum_checkpoint_engine?.() !== 2 ? "The selected runtime does not expose the XeTeX checkpoint ABI" : null;
      if (unavailable) {
        lastReason = unavailable;
        log("[Checkpoint] Full build: " + unavailable);
        return;
      }
      let focus = job.focus;
      if (!focus || focus.offset === 0) {
        const path = focus?.path && Object.hasOwn(job.files, focus.path) ? focus.path : job.main;
        focus = { path, offset: bytes3(job.files[path]).byteLength };
      }
      nextPlan ??= planner({ main: job.main, files: job.files }, {
        previousFiles: lastKey === job.key ? lastFiles : undefined,
        focus,
        maxCandidates: 3
      });
      if (!lastFiles) {
        const initial = initialCheckpointCandidate(job.main, job.files[job.main]);
        if (initial)
          nextPlan = { ...nextPlan, candidates: [initial, ...nextPlan.candidates] };
      }
      const fallback = retentionFallback?.key === job.key && retentionFallback.signature === job.signature && Object.hasOwn(job.files, retentionFallback.path) ? retentionFallback : null;
      const candidate = [...fallback ? [fallback] : [], ...placementCandidates(nextPlan, placementHints)].find((value) => !placements.has(value.path + ":" + value.line + ":" + value.editLine));
      if (!candidate) {
        lastReason = nextPlan.reason || "No safe checkpoint candidate";
        return;
      }
      const backend = await createPreferredMemoryBackend(module, { compact: exports_compact_memory, deduplicate: job.engine === "xelatex" });
      const immutableRoots = ["/texlive", "/bin", ...module.FS.__siglumNativeResourceRoots || [], ...module.__siglumDefaultMapPath ? [module.__siglumDefaultMapPath] : [], ...[...vfs.mountedFiles].filter((path) => !Object.hasOwn(job.files, path.replace(/^\/+/, "")) && !path.startsWith("/texlive/") && !path.startsWith("/bin/"))];
      const nativeRoots = module.FS.__siglumNativeResourceRoots || new Set;
      protectImmutableRoots(module.FS, immutableRoots.filter((root) => !nativeRoots.has(root)));
      trackProjectAccesses(module.FS, "/", { projectPaths: Object.keys(job.files) });
      const status = armCheckpoint(module, "/" + candidate.path, candidate.line);
      if (status !== 0) {
        lastReason = "Native checkpoint arm rejected";
        return;
      }
      module.__siglumPendingCheckpoint = { candidate, backend, aux, vfs, plan: nextPlan, immutableRoots };
    },
    afterPass(module, status) {
      const pending = module.__siglumPendingCheckpoint;
      module.__siglumPendingCheckpoint = null;
      if (!module._siglum_checkpoint_paused?.())
        return status;
      if (pending) {
        const { candidate, backend, aux, vfs, plan, immutableRoots } = pending;
        const actualLine = module._siglum_checkpoint_next_line();
        const path = module.UTF8ToString(module._siglum_checkpoint_filename());
        if (path !== "/" + candidate.path || actualLine > candidate.editLine) {
          if (path === "/" + candidate.path)
            recordOvershoot(placementHints, candidate, actualLine);
          placements.set(candidate.path + ":" + candidate.line + ":" + candidate.editLine, true);
          while (placements.size > 16)
            placements.delete(placements.keys().next().value);
          lastReason = "Native safe point overshot the edit; completing the normal pass";
          return module._siglum_checkpoint_resume();
        }
        try {
          saved = captureAtPoint(module, vfs, { candidate, plan, aux, immutableRoots, backend });
          lastReason = "Native checkpoint prepared";
        } catch (error) {
          placements.set(candidate.path + ":" + candidate.line + ":" + candidate.editLine, true);
          while (placements.size > 16)
            placements.delete(placements.keys().next().value);
          lastReason = error.message;
          if (error instanceof CheckpointRetentionError) {
            if (error.policy === "placement")
              retentionFallback = null;
            log("[Checkpoint] Completing the native pass without retaining this checkpoint: " + error.message);
            return module._siglum_checkpoint_resume();
          }
          log("[Checkpoint] Full build retained: " + error.message);
          throw Object.assign(new Error("Checkpoint capture failed: " + error.message), { checkpointCaptureFailed: true });
        }
      }
      return module._siglum_checkpoint_resume();
    },
    confirm(module, aux, fontRanges, success) {
      if (!success) {
        drop("Full compilation did not succeed");
        return this.metadata();
      }
      lastFiles = copiedFiles(job.files);
      lastKey = job.key;
      if (saved && (saved.module !== module || !sameAux(saved.aux, aux))) {
        drop("Checkpoint auxiliary state predates convergence");
      }
      if (saved)
        saved.fontRanges = fontRanges;
      return this.metadata();
    },
    metadata() {
      return {
        mode: saved ? "prepared" : "full",
        retained: !!saved,
        reason: lastReason,
        snapshotBytes: saved?.handle.memoryBytes || 0,
        actualLine: saved?.actualLine,
        path: saved?.path,
        pagesAtCheckpoint: saved?.pages,
        plannerCacheBytes: planner.cacheInfo?.retainedBytes || 0
      };
    }
  };
}
export {
  readPagePacket,
  readLiveFonts,
  createSyncInputReceiver,
  createCheckpointDriver,
  checkCachedFonts
};
