// PrebuiltProvider — the common case: the archive already ships usable runtime
// files (.sty/.cls/.def/…). No build; pass everything through unchanged so the
// existing processExtractedFiles step routes them into TDS paths.

import type { PackageProvider, RawFiles } from './types.ts';

// Runtime TeX file extensions (mirrors ctan-core's TEX_EXTENSIONS). Kept local
// so providers carry no dependency on ctan-core — that import direction would
// form a cycle, since ctan-core's processZipData calls into this module.
const TEX_EXTENSIONS = ['.sty', '.cls', '.def', '.cfg', '.tex', '.fd', '.clo'];

function hasExt(path: string, exts: string[]): boolean {
  const dot = path.lastIndexOf('.');
  if (dot < 0) return false;
  return exts.includes(path.slice(dot).toLowerCase());
}

export const PrebuiltProvider: PackageProvider = {
  name: 'prebuilt',

  canHandle(files: RawFiles): boolean {
    // Any runtime TeX file present (ignoring docs/source, which the later
    // extraction step drops anyway) means there is something ready to use.
    for (const path of Object.keys(files)) {
      if (path.includes('/doc/') || path.includes('/source/')) continue;
      if (hasExt(path, TEX_EXTENSIONS)) return true;
    }
    return false;
  },

  async build(files: RawFiles) {
    return { runtimeFiles: files, log: 'prebuilt: passthrough' };
  },
};
