// TdsZipProvider — handles a package whose archive *contains* a `.tds.zip`
// (a TeX Directory Structure archive). The inner zip already lays files out
// under tex/, fonts/, etc.; we unpack it and hand those paths downstream.
//
// Note: when the proxy downloads a `*.tds.zip` URL directly, the extracted map
// is already TDS-shaped and PrebuiltProvider handles it. This provider is for
// the case where a normal package zip bundles a `.tds.zip` inside it.

import { unzipSync } from 'fflate';
import type { PackageProvider, RawFiles } from './types.ts';

function findTdsZips(files: RawFiles): string[] {
  return Object.keys(files).filter((p) => p.toLowerCase().endsWith('.tds.zip'));
}

export const TdsZipProvider: PackageProvider = {
  name: 'tds',

  canHandle(files: RawFiles): boolean {
    return findTdsZips(files).length > 0;
  },

  async build(files: RawFiles) {
    const runtimeFiles: RawFiles = {};
    const logs: string[] = [];

    for (const tdsPath of findTdsZips(files)) {
      // unzipSync (not fflate async unzip) — the async path crashes under Bun.
      const inner = unzipSync(files[tdsPath]);
      let count = 0;
      for (const [innerPath, data] of Object.entries(inner)) {
        if (innerPath.endsWith('/')) continue; // directory entry
        runtimeFiles[innerPath] = data;
        count++;
      }
      logs.push(`tds: unpacked ${count} files from ${tdsPath}`);
    }

    // Also carry through any loose runtime files that sat alongside the .tds.zip
    // (rare, but harmless and keeps the provider non-lossy).
    for (const [path, data] of Object.entries(files)) {
      if (path.toLowerCase().endsWith('.tds.zip')) continue;
      if (!(path in runtimeFiles)) runtimeFiles[path] = data;
    }

    return { runtimeFiles, log: logs.join('\n') };
  },
};
