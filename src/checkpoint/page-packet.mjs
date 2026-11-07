/* Environment-neutral readers for the isolated exact-page native ABI. The
 * returned buffers belong to the host, and survive continuation/heap restore.
 */
const infoNames = ['baseIndex', 'objectNumber', 'sizeSp', 'designSizeSp', 'pdfSizeSp',
  'mapType', 'slant', 'extend', 'platformId', 'encodingId', 'noBuiltinToUnicode',
  'firstChar', 'lastChar', 'tfmChecksum', 'descriptorFlags'];
const stringNames = ['tfm', 'fontFile', 'encodingFile', 'postscriptName', 'subfontFile'];
const copy = (mod, pointer, length, maximum) => {
  if (!Number.isSafeInteger(length) || length < 0 || length > maximum ||
      (!pointer && length) || pointer < 0 || pointer + length > mod.HEAPU8.length)
    throw new Error('Invalid native packet buffer');
  return mod.HEAPU8.slice(pointer, pointer + length);
};

export const packetGuardFlags = Object.freeze({ image: 1, form: 2, rawObject: 4,
  annotation: 8, link: 16, pageAttributes: 32, customResources: 64, pageGroup: 128,
  fontOverflow: 256, missingCapture: 512, bufferFailure: 1024, compilerError: 2048 });

export function readLiveFonts(mod) {
  const maximum = mod._siglum_preview_font_max_index();
  if (!Number.isSafeInteger(maximum) || maximum < 0 || maximum > 100000)
    throw new Error('Invalid live font maximum');
  const fonts = [];
  for (let index = 1; index <= maximum; index++) {
    if (mod._siglum_preview_font_info(index, 0) < 0) continue;
    const row = { index };
    for (let field = 0; field < infoNames.length; field++)
      row[infoNames[field]] = mod._siglum_preview_font_info(index, field);
    for (let field = 0; field < stringNames.length; field++) {
      const pointer = mod._siglum_preview_font_string(index, field);
      row[stringNames[field]] = pointer ? mod.UTF8ToString(pointer) : null;
    }
    row.usedCharacters = copy(mod, mod._siglum_preview_font_bits(index), 32, 32);
    row.attributes = copy(mod, mod._siglum_preview_font_attr_data(index),
      mod._siglum_preview_font_attr_length(index), 65536);
    fonts.push(row);
  }
  return fonts;
}

export function readPagePacket(mod) {
  if (mod._siglum_preview_api_version?.() !== 1 || !mod._siglum_preview_paused())
    throw new Error('Engine is not paused with an exact page packet');
  const count = mod._siglum_preview_font_count();
  if (!Number.isSafeInteger(count) || count < 0 || count > 512) throw new Error('Invalid page font count');
  const fonts = readLiveFonts(mod);
  const pageFonts = Array.from({ length: count }, (_, index) => mod._siglum_preview_font_index(index));
  return {
    kind: 'engine-page-preview', provisional: true,
    page: mod._siglum_preview_page(), widthSp: mod._siglum_preview_width_sp(),
    heightSp: mod._siglum_preview_height_sp(), flags: mod._siglum_preview_guard_flags(),
    content: copy(mod, mod._siglum_preview_content_data(), mod._siglum_preview_content_length(), 2 * 1024 * 1024),
    resources: copy(mod, mod._siglum_preview_resources_data(), mod._siglum_preview_resources_length(), 64 * 1024),
    pageFonts, fonts,
    inputStateAtYield: mod._siglum_checkpoint_input_state(),
    totalPagesAtYield: mod._siglum_checkpoint_total_pages(),
  };
}

const equalBytes = (a, b) => a.length === b.length && a.every((value, index) => value === b[index]);
const fontIdentity = font => JSON.stringify(Object.fromEntries([
  ...infoNames.filter(name => !['baseIndex', 'objectNumber'].includes(name)), ...stringNames,
].map(name => [name, font[name]])));

/** A necessary font gate, NOT a proof of arbitrary resource-graph equivalence.
 * Callers must additionally guard source semantics, assets, page geometry,
 * annotations and the complete baseline PDF resource closure. New PDF commands
 * or unknown resources require a full build, even if this gate accepts fonts.
 */
export function checkCachedFonts(packet, baselineFonts) {
  const union = (fonts, base) => {
    const bits = new Uint8Array(32);
    for (const font of fonts) if (font.baseIndex === base)
      for (let index = 0; index < bits.length; index++) bits[index] |= font.usedCharacters[index];
    return bits;
  };
  for (const base of packet.pageFonts) {
    const current = packet.fonts.find(font => font.index === base);
    const previous = baselineFonts.find(font => font.index === base);
    if (!current || !previous || current.mapType < 0 || (current.mapType & 0x80) || current.subfontFile)
      return { accepted: false, reason: 'Unknown, bitmap or subfont resource', font: base };
    if (current.objectNumber !== previous.objectNumber || fontIdentity(current) !== fontIdentity(previous)
        || !equalBytes(current.attributes, previous.attributes))
      return { accepted: false, reason: 'Font metadata changed', font: base };
    const before = union(baselineFonts, base), after = union(packet.fonts, base);
    for (let index = 0; index < before.length; index++) if (after[index] & ~before[index])
      return { accepted: false, reason: 'New character outside cached font subset', font: base, byte: index };
  }
  return { accepted: true };
}
