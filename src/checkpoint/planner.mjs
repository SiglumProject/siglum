/* Candidate placement only. A lexical input graph is never proof that a TeX
 * checkpoint precedes an edit: the caller must validate the actual safe point
 * and call snapshot.check(targetProbeFiles(...)) before retaining it. */
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const argumentDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function bytes(value) {
  return typeof value === 'string' ? encoder.encode(value) : new Uint8Array(value);
}

function canonical(path) {
  if (typeof path !== 'string' || !path || path.includes('\0') || path.includes('\\')) throw new Error('Invalid project path');
  if (path.startsWith('/project/')) path = path.slice('/project/'.length);
  else if (path.startsWith('/')) throw new Error('Project path escapes its root');
  const parts = [];
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!parts.length) throw new Error('Project path escapes its root');
      parts.pop();
    } else parts.push(part);
  }
  if (!parts.length) throw new Error('Invalid project file path');
  return parts.join('/');
}

// All byte encodings below are per-plan and lazy. Cached records never own
// encoded source or masked lexical text.
function fileMap(files) {
  const map = new Map();
  for (const [key, value] of Object.entries(files || {})) {
    const path = canonical(key);
    if (map.has(path)) throw new Error('Duplicate normalized project path: ' + path);
    let encoded;
    map.set(path, { key, value, get bytes() { return encoded ??= bytes(value); } });
  }
  return map;
}

// Match TextEncoder -> default UTF-8 TextDecoder semantics without allocating
// UTF-8 for unchanged immutable strings, including isolated-surrogate replacement
// and stripping one initial BOM. Valid pairs are retained exactly.
function sourceText(value) {
  if (typeof value !== 'string') return decoder.decode(bytes(value));
  let source = value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
  if (typeof source.toWellFormed === 'function') return source.toWellFormed();
  let result = '', from = 0;
  for (let i = 0; i < source.length; i++) {
    const unit = source.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = source.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) { i++; continue; }
    } else if (unit < 0xdc00 || unit > 0xdfff) continue;
    result += source.slice(from, i) + '\ufffd'; from = i + 1;
  }
  return from ? result + source.slice(from) : source;
}

function firstDifference(a, b) {
  if (a === b) return -1;
  const end = Math.min(a.length, b.length);
  for (let i = 0; i < end; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : end;
}

function lineAt(data, offset) {
  let line = 1;
  for (let i = 0; i < Math.min(offset, data.length); i++) if (data[i] === 10) line++;
  return line;
}

function lineOffset(data, line) {
  let current = 1;
  for (let i = 0; i < data.length; i++) {
    if (current === line) return i;
    if (data[i] === 10) current++;
  }
  return data.length;
}

const mask = text => text.replace(/[^\n]/g, ' ');

function lexicalText(source) {
  // These common literal forms are masked, without claiming a complete TeX
  // parser or support for arbitrary catcode/conditional/macro expansion.
  source = source.replace(/\\begin\{(verbatim\*?|lstlisting|minted)\}[\s\S]*?\\end\{\1\}/g, mask);
  let result = '';
  for (let i = 0; i < source.length;) {
    if (source.startsWith('\\verb', i) && !/[A-Za-z@]/.test(source[i + 5] || '')) {
      const begin = i;
      let delimiterAt = i + 5;
      if (source[delimiterAt] === '*') delimiterAt++;
      const delimiter = source[delimiterAt];
      if (delimiter && !/\s/.test(delimiter)) {
        let end = source.indexOf(delimiter, delimiterAt + 1);
        const newline = source.indexOf('\n', delimiterAt + 1);
        if (end < 0 || (newline >= 0 && newline < end)) end = newline < 0 ? source.length - 1 : newline - 1;
        i = end + 1;
        result += mask(source.slice(begin, i));
        continue;
      }
    }
    if (source[i] === '%') {
      let slashes = 0;
      for (let at = i - 1; at >= 0 && source[at] === '\\'; at--) slashes++;
      if (slashes % 2 === 0) {
        const newline = source.indexOf('\n', i);
        const end = newline < 0 ? source.length : newline;
        result += mask(source.slice(i, end)); i = end; continue;
      }
    }
    result += source[i++];
  }
  return result;
}

// On first open there is no edit history. A checkpoint near the end of the
// document cannot help its first body edit. Start after the literal preamble;
// the native safe-point and consumed-input guards remain authoritative.
export function initialCheckpointCandidate(main, value) {
  const source = sourceText(value), visible = lexicalText(source);
  const begin = /\\begin\s*\{document\}/.exec(visible);
  if (!begin) return null;
  return { path: canonical(main), line: source.slice(0, begin.index + begin[0].length).split('\n').length + 1,
    editLine: source.split('\n').length, reason: 'Initial post-preamble boundary' };
}

function resolveInput(argument, files) {
  if (!argument || /[\\#$~\s{}]/.test(argument)) return { uncertain: true };
  let path;
  try { path = canonical(argument); } catch { return { uncertain: true }; }
  const variants = [path, path + '.tex'];
  // The verified worker compiles with cwd=/project and searches that root
  // before its recursive TEXINPUTS tree, not the including file's directory.
  for (const candidate of variants) if (files.has(candidate)) return { path: candidate };
  const matches = [...files.keys()].filter(name => variants.some(candidate => name.endsWith('/' + candidate)));
  return matches.length === 1 ? { path: matches[0] } : { uncertain: matches.length > 1 };
}

function parseDirectives(value) {
  let text;
  try {
    const raw = sourceText(value);
    // Masking removes/replaces characters; it cannot create a new literal
    // input/include token. Most chapter bodies need no lexical allocation.
    if (!/\\(?:input|include)(?![A-Za-z@])/.test(raw)) return [];
    text = lexicalText(raw);
  } catch { return []; }
  const commands = /\\(input|include)(?![A-Za-z@])\s*(?:\{([^{}]*)\}|([^\s{}%]+))?/g;
  const directives = [];
  let line = 1, previous = 0;
  for (const match of text.matchAll(commands)) {
    for (let at = previous; at < match.index; at++) if (text.charCodeAt(at) === 10) line++;
    previous = match.index;
    const argument = match[2] ?? match[3];
    // Encode/decode only this small argument, so no regex slice or match array
    // can retain the full temporary lexical string in a long-lived cache.
    const copied = argument === undefined ? null : argumentDecoder.decode(encoder.encode(argument));
    directives.push({ argument: copied, line });
  }
  return directives;
}

function inputGraph(files, main, sourceCache) {
  const incoming = new Map();
  const visited = new Set();
  // Only explicitly requested target/anchor text is retained for this plan.
  // Traversal caches plain directives, never entire lexical strings.
  const sources = new Map();
  let uncertain = false;
  function source(path) {
    if (!sources.has(path)) {
      let text;
      try { text = lexicalText(sourceText(files.get(path)?.value)); } catch {}
      sources.set(path, text);
    }
    return sources.get(path);
  }
  function visit(path, ancestors) {
    if (ancestors.has(path)) { uncertain = true; return; }
    if (visited.has(path)) return;
    visited.add(path);
    const value = files.get(path);
    if (!value) return;
    const directives = sourceCache?.get(path, value.value) ?? parseDirectives(value.value);
    const nextAncestors = new Set([...ancestors, path]);
    for (const directive of directives) {
      // Resolve every cached raw argument against the CURRENT complete map.
      const resolved = resolveInput(directive.argument, files);
      if (resolved.uncertain) uncertain = true;
      if (!resolved.path) continue;
      const edge = { parent: path, child: resolved.path, line: directive.line };
      if (!incoming.has(edge.child)) incoming.set(edge.child, []);
      incoming.get(edge.child).push(edge);
      visit(edge.child, nextAncestors);
    }
  }
  visit(main, new Set());
  function chain(path, active = new Set()) {
    if (path === main) return [];
    if (active.has(path)) return null;
    const parents = incoming.get(path);
    if (parents?.length !== 1) return null;
    const edge = parents[0];
    const prefix = chain(edge.parent, new Set([...active, path]));
    return prefix && [...prefix, edge];
  }
  return { uncertain, source, chain };
}

function paragraphStart(source, targetLine) {
  if (!source) return targetLine;
  const lines = source.split('\n');
  let start = Math.max(1, Math.min(targetLine, lines.length));
  if (/^\s*\\(?:chapter|section|subsection|subsubsection|paragraph|begin|input|include)(?![A-Za-z@])/.test(lines[start - 1] || '')) return start;
  for (let line = start - 1; line >= 1; line--) {
    const text = lines[line - 1];
    if (!text.trim() || /\\par(?![A-Za-z@])\s*$/.test(text)
        || /^\s*\\(?:chapter|section|subsection|subsubsection|paragraph|begin|newpage|clearpage|cleardoublepage)(?![A-Za-z@])/.test(text)) return line + 1;
    start = line;
  }
  return start;
}

function insideDiagram(source, targetLine) {
  if (!source) return false;
  const active = [];
  for (const match of source.matchAll(/\\(begin|end)\s*\{(tikzpicture|pgfpicture)\}/g)) {
    const line = source.slice(0, match.index).split('\n').length;
    if (line > targetLine) break;
    if (match[1] === 'begin') active.push(match[2]);
    else {
      if (line === targetLine && active.includes(match[2])) return true;
      const at = active.lastIndexOf(match[2]);
      if (at >= 0) active.splice(at, 1);
    }
  }
  return active.length > 0;
}

/** focus.offset and returned target.offset use UTF-8 byte positions, not JS
 * UTF-16 positions. If previousFiles has changes, those override cursor focus.
 */
export function planCheckpoints(project, { previousFiles, focus, maxCandidates = 3, sourceCache } = {}) {
  const files = fileMap(project.files);
  const main = canonical(project.main);
  if (!files.has(main)) return { targets: [], candidates: [], reason: 'Main file is missing' };
  if (!Number.isInteger(maxCandidates) || maxCandidates < 1 || maxCandidates > 16) throw new Error('Invalid checkpoint candidate limit');
  const targets = [];
  let fileSetChanged = false;
  if (previousFiles) {
    const previous = fileMap(previousFiles);
    for (const path of [...new Set([...files.keys(), ...previous.keys()])].sort()) {
      const currentFile = files.get(path), previousFile = previous.get(path);
      // Exact immutable-string comparison precedes any source encoding. Mutable
      // byte objects always take the byte comparison path, even if identical.
      if (currentFile && previousFile && typeof currentFile.value === 'string'
          && currentFile.value === previousFile.value) continue;
      const current = currentFile?.bytes;
      const before = previousFile?.bytes;
      if (!current || !before) {
        fileSetChanged = true;
        targets.push({ path, offset: 0, line: 1 });
        continue;
      }
      const offset = firstDifference(before, current);
      if (offset >= 0) targets.push({ path, offset, line: lineAt(current, offset) });
    }
  }
  if (!targets.length && focus) {
    const path = canonical(focus.path);
    const value = files.get(path);
    if (value) {
      const requested = Number.isSafeInteger(focus.offset) && focus.offset >= 0 ? focus.offset
        : lineOffset(value.bytes, Number.isInteger(focus.line) && focus.line > 0 ? focus.line : 1);
      const offset = Math.min(requested, value.bytes.length);
      targets.push({ path, offset, line: lineAt(value.bytes, offset) });
    }
  }
  if (!targets.length) return { targets, candidates: [], reason: 'No changed source or valid focus' };
  const graph = inputGraph(files, main, sourceCache);
  const chains = targets.map(target => graph.chain(target.path));
  const candidates = [];
  const add = (path, line, editLine, reason) => {
    line = Math.max(1, line);
    if (!candidates.some(candidate => candidate.path === path && candidate.line === line)) candidates.push({ path, line, editLine, reason });
  };
  const limitAt = path => {
    let limit = Number.MAX_SAFE_INTEGER;
    targets.forEach((target, i) => {
      if (target.path === path) limit = Math.min(limit, target.line);
      else {
        const edge = chains[i]?.find(item => item.parent === path);
        if (edge) limit = Math.min(limit, edge.line);
      }
    });
    return limit;
  };
  let reason = 'Before the changed editing region';
  if (fileSetChanged || graph.uncertain || chains.some(chain => !chain)) {
    reason = fileSetChanged ? 'Project file set changed' : 'Input resolution is ambiguous or dynamic';
    add(main, 1, limitAt(main), reason + '; root fallback requires the access guard');
  } else {
    const nodePaths = targets.map((target, i) => [main, ...chains[i].map(edge => edge.child)]);
    let common = main;
    for (let depth = 1; nodePaths.every(path => path[depth] && path[depth] === nodePaths[0][depth]); depth++) common = nodePaths[0][depth];
    let anchor = common;
    let anchorLine = limitAt(anchor);
    if (targets.length === 1) {
      const target = targets[0];
      const source = graph.source(target.path);
      const isTikz = insideDiagram(source, target.line);
      if (isTikz && chains[0].length) {
        const parent = chains[0][chains[0].length - 1];
        anchor = parent.parent; anchorLine = parent.line;
        reason = 'Before the parent input of a diagram';
      } else {
        anchor = target.path; anchorLine = target.line;
      }
    } else reason = 'Before the common ancestor of changed files';
    const boundary = reason.includes('diagram') ? anchorLine : paragraphStart(graph.source(anchor), anchorLine);
    add(anchor, boundary - 1, limitAt(anchor), reason + '; validate the actual safe point');
    add(anchor, 1, limitAt(anchor), 'Earlier file start after a missed or overshot boundary');
    add(main, 1, limitAt(main), 'Root fallback requires the access guard');
  }
  return { targets, candidates: candidates.slice(0, maxCandidates), reason };
}

/** Bounded cache of context-free literal input directives. Immutable input
 * strings are shared by reference; no encoded source or lexical strings persist.
 * Budget charges the referenced UTF-16 capacity too, conservatively, even when
 * that same immutable string is already owned by the caller/controller.
 * `additionalDataBytes` is the explicit directive/key/reference capacity model,
 * not a claim about engine-specific object overhead or measured RSS.
 */
export function createCheckpointPlanner({ maxCacheBytes = 8 * 1024 * 1024, maxCacheFiles = 256 } = {}) {
  if (!Number.isSafeInteger(maxCacheBytes) || maxCacheBytes < 0
      || !Number.isSafeInteger(maxCacheFiles) || maxCacheFiles < 0) throw new Error('Invalid planner cache budget');
  const entries = new Map();
  let retainedBytes = 0, additionalDataBytes = 0, referencedSourceBytes = 0, hits = 0, misses = 0, disposed = false;
  const remove = path => {
    const entry = entries.get(path);
    if (entry) {
      retainedBytes -= entry.cost; additionalDataBytes -= entry.metadataBytes;
      referencedSourceBytes -= entry.sourceBytes;
    }
    entries.delete(path);
  };
  const sourceCache = {
    get(path, value) {
      const entry = entries.get(path);
      if (typeof value === 'string' && entry?.value === value) {
        hits++; entries.delete(path); entries.set(path, entry); return entry.directives;
      }
      misses++; remove(path);
      const directives = parseDirectives(value);
      if (typeof value !== 'string' || maxCacheFiles === 0) return directives;
      const sourceBytes = value.length * 2;
      const metadataBytes = 96 + path.length * 2 + directives.reduce((sum, item) => sum + 64 + (item.argument?.length ?? 0) * 2, 0);
      const cost = sourceBytes + metadataBytes;
      if (cost > maxCacheBytes) return directives;
      while (entries.size && (entries.size >= maxCacheFiles || retainedBytes + cost > maxCacheBytes)) remove(entries.keys().next().value);
      entries.set(path, { value, directives, cost, sourceBytes, metadataBytes });
      retainedBytes += cost; additionalDataBytes += metadataBytes; referencedSourceBytes += sourceBytes;
      return directives;
    },
  };
  const planner = (project, options = {}) => {
    if (disposed) throw new Error('Planner disposed');
    const current = fileMap(project.files);
    // Drop changed/removed entries even when they are no longer reachable.
    for (const [path, entry] of entries) if (current.get(path)?.value !== entry.value) remove(path);
    return planCheckpoints(project, { ...options, sourceCache });
  };
  planner.clear = () => { entries.clear(); retainedBytes = 0; additionalDataBytes = 0; referencedSourceBytes = 0; };
  planner.dispose = () => { planner.clear(); disposed = true; };
  Object.defineProperty(planner, 'cacheInfo', { get: () => ({ retainedBytes, additionalDataBytes, referencedSourceBytes,
    encodedSourceBytes: 0, lexicalSourceBytes: 0, files: entries.size, hits, misses, maxCacheBytes, maxCacheFiles, disposed }) });
  return planner;
}

/** A guard-only hypothetical edit at every target. Never execute this source.
 * Unchanged values are shared; each changed byte array is privately copied.
 */
export function targetProbeFiles(files, targets) {
  const map = fileMap(files);
  const result = Object.assign(Object.create(null), files);
  const edited = new Set();
  for (const target of targets) {
    const path = canonical(target.path);
    const file = map.get(path);
    if (!file) { result[path] = Uint8Array.of(33); continue; }
    const existing = bytes(result[file.key]);
    const offset = Math.max(0, Math.min(Number.isSafeInteger(target.offset) ? target.offset : lineOffset(existing, target.line), existing.length));
    const key = path + ':' + offset;
    if (edited.has(key)) continue;
    edited.add(key);
    const changed = new Uint8Array(existing.length + (offset === existing.length ? 1 : 0));
    changed.set(existing);
    changed[offset] = offset === existing.length ? 33 : existing[offset] ^ 1;
    result[file.key] = changed;
  }
  return result;
}
