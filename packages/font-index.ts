// Font-file → package resolution (server-side).
//
// TeX requests fonts it can't find by *file stem* (e.g. `phvr8t` for the
// Helvetica T1 metrics), which names no CTAN / TeX Live package, so a direct
// fetch 404s. The authoritative stem→package map is derived from the TeX Live
// package database (TLPDB) at build time by scripts/build-font-file-index.js and
// shipped as the committed bundle artifact `bundles/font-file-to-package.json`
// (like file-to-package.json / font-name-to-package.json). Loading the committed
// index means this works in every runtime — dev server, any host's CTAN proxy,
// fresh clone, CI — with no 20 MB TLPDB present at runtime.
//
// `PS_FONT_PACKAGE_BY_PREFIX` in ctan-core (the standard-35 prefixes) remains as
// a last-resort fallback for the degenerate case where even the index is absent.

import { readFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { fontPackageForFile } from './ctan-core.ts';

const HERE = dirname(fileURLToPath(import.meta.url)); // packages/

// The committed index. Overridable for deployment/testing.
const INDEX_PATH =
  process.env.SIGLUM_FONT_FILE_INDEX || join(HERE, 'bundles', 'font-file-to-package.json');

let indexPromise: Promise<Record<string, string>> | null = null;

function loadIndex(): Record<string, string> {
  if (!existsSync(INDEX_PATH)) return {};
  try {
    return JSON.parse(readFileSync(INDEX_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

async function getIndex(): Promise<Record<string, string>> {
  if (!indexPromise) indexPromise = Promise.resolve().then(loadIndex);
  return indexPromise;
}

// Font/metric file extensions whose stem we look up.
const FONT_FILE_EXT = /\.(tfm|vf|pfb|pfm|afm|otf|ttf|ttc|map|enc)$/i;

/**
 * Resolve a font file name or stem (e.g. `phvr8t`, `phvr8t.tfm`, `ec-lmr10`) to
 * the TeX Live package that provides it. Consults the committed font-file index
 * first, then falls back to the standard base-35 prefix table. Returns null if
 * neither knows it.
 */
export async function resolveFontPackage(name: string): Promise<string | null> {
  const index = await getIndex();
  const stem = name.replace(FONT_FILE_EXT, '');
  return index[name] || index[stem] || fontPackageForFile(name);
}

// Test/diagnostic helper: number of indexed stems (0 if the index is absent).
export async function fontIndexSize(): Promise<number> {
  return Object.keys(await getIndex()).length;
}
