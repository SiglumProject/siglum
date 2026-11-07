// Only byte-identical duplicate rows are removed, preserving first-row order.
// Use the result solely for pdfTeX's initial FM_DUPIGNORE map. Keep every
// original map intact for explicit replacement/deletion operations in TeX.
export function compactDefaultMap(text) {
  const seen = new Set(); let removed = 0;
  const lines = text.split('\n').filter(line => {
    if (!line.trim() || line.trimStart().startsWith('%')) return true;
    if (seen.has(line)) { removed++; return false; }
    seen.add(line); return true;
  });
  return { text: lines.join('\n'), removed };
}


export function prepareDefaultMap(module) {
  if (!module._siglum_configure_default_map) return 0;
  const source = '/texlive/texmf-dist/texmf-var/fonts/map/pdftex/updmap/pdftex.map';
  const target = '/tmp/siglum-default-font-map.map';
  // An authored file at the reserved temporary name keeps the normal path.
  if (module.FS.analyzePath(target).exists) return 0;
  let original;
  try {
    original = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(module.FS.readFile(source));
  } catch { return 0; }
  const compact = compactDefaultMap(original);
  if (!compact.removed) return 0;
  module.FS.writeFile(target, compact.text);
  const pointer = module._malloc(target.length + 1);
  try {
    module.stringToUTF8(target, pointer, target.length + 1);
    if (module._siglum_configure_default_map(pointer) !== 0) {
      module.FS.unlink(target);
      return 0;
    }
  } finally { module._free(pointer); }
  module.__siglumDefaultMapPath = target;
  return compact.removed;
}
