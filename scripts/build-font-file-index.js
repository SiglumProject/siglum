// Build a font-file-stem → package index from the TeX Live package database.
//
// When TeX can't find a font it asks for it by *file stem* — `phvr8t` for the
// Helvetica T1 metrics, `ec-lmr10`, `cmr10`, `qplr`, … — which names no CTAN /
// TeX Live *package*. This index maps every such stem to the package that ships
// it, so the on-demand fetcher (dev server, Cloudflare proxy, and the browser
// worker) can resolve it without parsing the 20 MB TLPDB at runtime. It is the
// font-file counterpart of scripts/build-file-index.js (which indexes
// .sty/.cls/… ) and ships as a committed bundle artifact like the others.
//
// Run:  bun scripts/build-font-file-index.js [output.json]
// Default input:  busytex/source/texmfrepo/tlpkg/texlive.tlpdb  ($TLPDB_PATH)
// Default output: packages/bundles/font-file-to-package.json

import fs from 'fs';
import path from 'path';

const TLPDB =
  process.env.TLPDB_PATH ||
  path.join(import.meta.dir, '..', 'busytex', 'source', 'texmfrepo', 'tlpkg', 'texlive.tlpdb');

const OUTPUT =
  process.argv[2] || path.join(import.meta.dir, '..', 'packages', 'bundles', 'font-file-to-package.json');

// Font file types TeX requests by name when missing: metrics (.tfm), virtual
// fonts (.vf), Type1 programs (.pfb), AFM, and the OpenType/TrueType files
// fontspec uses. Maps/encodings are intentionally excluded — they are pulled in
// with their font package, not requested standalone.
const FONT_FILE_EXT = /\.(tfm|vf|pfb|afm|otf|ttf|ttc)$/i;

function build(tlpdb) {
  const index = {};
  let pkg = null;
  let inRunfiles = false;

  for (const line of tlpdb.split('\n')) {
    if (line.startsWith('name ')) {
      pkg = line.slice(5).trim();
      inRunfiles = false;
    } else if (line.startsWith('runfiles ')) {
      inRunfiles = true;
    } else if (line.startsWith('docfiles ') || line.startsWith('srcfiles ') || line === '') {
      inRunfiles = false;
    } else if (inRunfiles && line.startsWith(' ')) {
      const file = line.trim();
      if (!FONT_FILE_EXT.test(file)) continue;
      if (!pkg || pkg.startsWith('00')) continue; // skip collection/scheme meta-packages
      const base = file.split('/').pop();
      const stem = base.replace(FONT_FILE_EXT, '');
      // First package to claim a stem wins (matches build-file-index.js).
      if (index[stem] === undefined) index[stem] = pkg;
    }
  }
  return index;
}

const tlpdb = fs.readFileSync(TLPDB, 'utf-8');
const index = build(tlpdb);
const json = JSON.stringify(index);
fs.writeFileSync(OUTPUT, json);

console.log(`Indexed ${Object.keys(index).length} font-file stems`);
for (const probe of ['phvr8t', 'ptmr8t', 'pcrr8t', 'ec-lmr10', 'cmr10', 'qplr', 'SourceSansPro-Regular']) {
  console.log(`  ${probe} -> ${index[probe] ?? '(not found)'}`);
}
console.log(`Written to ${OUTPUT} (${(fs.statSync(OUTPUT).size / 1024).toFixed(0)} KB)`);
