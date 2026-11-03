// Build a font-name → package index from the TeX Live TLPDB.
//
// fontspec requests fonts by *family name* ("EB Garamond", "TeX Gyre Chorus"),
// but TeX Live ships them inside packages keyed by package name. This script
// derives, for every font file in the TLPDB, a set of normalized family keys
// from the filename and maps each key to its owning package. At compile time the
// engine normalizes the requested name, looks it up here, fetches that package,
// and lets fontconfig do the authoritative name→file match at runtime.
//
// Run with:  bun packages/build-font-index.ts [output.json]
// Default input:  busytex/source/texmfrepo/tlpkg/texlive.tlpdb
// Default output: packages/bundles/font-name-to-package.json

import fs from 'fs';
import path from 'path';

const TLPDB =
  process.env.TLPDB_PATH ||
  path.join(import.meta.dir, '..', 'busytex', 'source', 'texmfrepo', 'tlpkg', 'texlive.tlpdb');

const OUTPUT = process.argv[2] || path.join(import.meta.dir, 'bundles', 'font-name-to-package.json');

// Font file extensions fontconfig can match by name.
const FONT_EXT = /\.(otf|ttf|ttc|pfb)$/i;

// Weight/style suffixes that follow the family stem in TL font filenames, e.g.
// "EBGaramond-Regular", "texgyrechorus-mediumitalic". We strip these so the
// remaining stem maps to the family.
const STYLE_SUFFIX =
  /[-_ ]?(regular|bold|italic|oblique|medium|semibold|extrabold|extralight|light|thin|black|heavy|book|roman|condensed|cn|caption|display|text|subhead|smcp|sc|osf|lf|tlf|tosf|lining|expert|inferior|superior|initials|swash|math|sans|mono|serif|caption|nord|disp|small|micro)+$/i;

/** Lowercase, keep only [a-z0-9]. fontspec/fontconfig compare loosely. */
function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/** Family-key candidates derived from a font filename (no extension). */
function familyKeys(stem: string): string[] {
  const keys = new Set<string>();
  const full = normalize(stem);
  if (full) keys.add(full); // whole stem, e.g. "ebgaramondregular"

  // Pre-hyphen / pre-underscore segment, e.g. "EBGaramond", "texgyrechorus".
  const head = stem.split(/[-_]/)[0];
  const headNorm = normalize(head);
  if (headNorm) keys.add(headNorm);

  // Stem with trailing style words stripped, e.g. "texgyrechorus" from
  // "texgyrechorus-mediumitalic", "lmroman" hint from "lmroman10".
  let stripped = stem;
  let prev: string;
  do {
    prev = stripped;
    stripped = stripped.replace(STYLE_SUFFIX, '');
  } while (stripped !== prev && stripped.length > 0);
  const strippedNorm = normalize(stripped);
  if (strippedNorm) keys.add(strippedNorm);

  return [...keys].filter((k) => k.length >= 2);
}

// Curated overrides for families whose fontspec name diverges from the filename
// (the heuristic cannot recover these). Keys are pre-normalized. These win over
// derived keys. Extend as needed.
const OVERRIDES: Record<string, string> = {
  latinmodernroman: 'lm',
  latinmodernsans: 'lm',
  latinmodernmono: 'lm',
  latinmodernmath: 'lm-math',
  texgyrechorus: 'tex-gyre', // also derived, kept explicit for clarity
  libertinusserif: 'libertinus-fonts',
  libertinussans: 'libertinus-fonts',
  libertinusmono: 'libertinus-fonts',
  libertinusmath: 'libertinus-fonts',
};

function build(): Record<string, string> {
  const data = fs.readFileSync(TLPDB, 'utf-8');
  const lines = data.split('\n');

  const index: Record<string, string> = {};
  let currentPkg: string | null = null;
  let inRunfiles = false;

  for (const line of lines) {
    if (line.startsWith('name ')) {
      currentPkg = line.slice(5).trim();
      inRunfiles = false;
    } else if (line.startsWith('runfiles ')) {
      inRunfiles = true;
    } else if (line.startsWith(' ')) {
      if (!inRunfiles || !currentPkg || currentPkg.startsWith('00')) continue;
      const file = line.trim();
      if (!FONT_EXT.test(file)) continue;
      const base = file.split('/').pop()!;
      const stem = base.replace(FONT_EXT, '');
      for (const key of familyKeys(stem)) {
        // First package wins; keeps the result stable and deterministic.
        if (!index[key]) index[key] = currentPkg;
      }
    } else {
      inRunfiles = false;
    }
  }

  // Apply curated overrides last.
  Object.assign(index, OVERRIDES);
  return index;
}

const index = build();
fs.writeFileSync(OUTPUT, JSON.stringify(index));

const size = (fs.statSync(OUTPUT).size / 1024).toFixed(1);
console.log(`Total font keys: ${Object.keys(index).length}`);
console.log(`Written to ${OUTPUT} (${size} KB)`);
// Spot checks for the known repro fonts:
for (const name of ['EB Garamond', 'TeX Gyre Chorus', 'TeX Gyre Pagella', 'Latin Modern Roman']) {
  console.log(`  ${name} -> ${index[normalize(name)] ?? '(not found)'}`);
}
