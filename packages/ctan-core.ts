// Shared CTAN package extraction logic
// Used by both ctan-proxy.ts (server) and serve-local.ts (dev)

import { unzipSync } from 'fflate';
import { normalizePackage, type NormalizeOptions } from './providers/index.ts';

// ============================================================================
// Types
// ============================================================================

export interface ProcessedFile {
  path: string;
  content: string;
  encoding?: 'base64';
}

export interface ProcessedPackage {
  name: string;
  files: Record<string, ProcessedFile>;
  totalFiles: number;
  dependencies: string[];
  source?: string;
  // Which normalize provider produced these files (prebuilt/tds/ins/…).
  provider?: string;
}

export interface ExtractionResult {
  files: Record<string, ProcessedFile>;
  fileCount: number;
  dependencies: string[];
}

// ============================================================================
// Constants
// ============================================================================

export const TEX_EXTENSIONS = ['.sty', '.cls', '.def', '.cfg', '.tex', '.fd', '.clo'];
export const FONT_EXTENSIONS = ['.pfb', '.pfm', '.afm', '.tfm', '.vf', '.map', '.enc'];
export const REQUIRE_PACKAGE_REGEX = /\\RequirePackage(?:\[[^\]]*\])?\{([^}]+)\}/g;
export const VALID_PACKAGE_NAME_REGEX = /^[a-zA-Z][a-zA-Z0-9\-]*$/;

// Reusable TextDecoder instance
export const textDecoder = new TextDecoder();

// ============================================================================
// LRU Cache - bounded memory with eviction
// ============================================================================

export class LRUCache<T> {
  private cache = new Map<string, T>();
  private maxSize: number;

  constructor(maxSize: number) {
    this.maxSize = maxSize;
  }

  get(key: string): T | undefined {
    const value = this.cache.get(key);
    if (value !== undefined) {
      // Move to end (most recently used)
      this.cache.delete(key);
      this.cache.set(key, value);
    }
    return value;
  }

  set(key: string, value: T): void {
    // Delete first to update position if exists
    this.cache.delete(key);

    // Evict oldest if at capacity
    if (this.cache.size >= this.maxSize) {
      const oldest = this.cache.keys().next().value;
      if (oldest) this.cache.delete(oldest);
    }

    this.cache.set(key, value);
  }

  has(key: string): boolean {
    return this.cache.has(key);
  }

  entries(): IterableIterator<[string, T]> {
    return this.cache.entries();
  }

  get size(): number {
    return this.cache.size;
  }
}

// ============================================================================
// Utilities
// ============================================================================

export function isValidPackageName(name: string): boolean {
  if (!name || name.length === 0) return false;
  return VALID_PACKAGE_NAME_REGEX.test(name);
}

export function unzipAsync(data: Uint8Array): Promise<Record<string, Uint8Array>> {
  // Use unzipSync, NOT fflate's async unzip(). The async path spawns Web Workers
  // for parallel inflate, and under Bun (the proxy's runtime) those workers crash
  // with "undefined is not an object (evaluating 'dat.length')". unzipSync runs in
  // the calling thread and is reliable on every runtime; package zips are small
  // enough (a few MB) that synchronous inflate is not a concern for a local proxy.
  return new Promise((resolve, reject) => {
    try {
      resolve(unzipSync(data));
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Extract dependencies from TeX file content
 */
export function extractDependencies(content: string, excludePkg?: string): string[] {
  const deps = new Set<string>();
  REQUIRE_PACKAGE_REGEX.lastIndex = 0;
  for (const match of content.matchAll(REQUIRE_PACKAGE_REGEX)) {
    match[1].split(',').map(d => d.trim()).filter(isValidPackageName).forEach(d => deps.add(d));
  }
  if (excludePkg) {
    deps.delete(excludePkg);
  }
  return [...deps];
}

// Standard 35 PostScript fonts: their Karl-Berry / Fontname filename prefixes
// map to the TeX Live package that ships the metrics (.tfm), virtual fonts
// (.vf) and maps. TeX requests these by file stem (e.g. `phvr8t`), which names
// no CTAN/TeX Live *package*, so a direct fetch 404s; this resolves the stem to
// its family package (verified present in the TeX Live archive). Used only as a
// fallback when normal package resolution fails — these stems are never real
// package names, so there are no false positives.
export const PS_FONT_PACKAGE_BY_PREFIX: Record<string, string> = {
  phv: 'helvetic',  // Helvetica / Nimbus Sans
  ptm: 'times',     // Times / Nimbus Roman
  pcr: 'courier',   // Courier / Nimbus Mono
  ppl: 'palatino',  // Palatino / URW Palladio
  pbk: 'bookman',   // Bookman / URW Bookman
  pag: 'avantgar',  // Avant Garde / URW Gothic
  pnc: 'ncntrsbk',  // New Century Schoolbook
  psy: 'symbol',    // Symbol
  pzd: 'zapfding',  // Zapf Dingbats
  put: 'utopia',    // Utopia
  bch: 'charter',   // Bitstream Charter
};

const FONT_STEM_EXTENSIONS = /\.(tfm|vf|pfb|pfm|afm|map|enc)$/i;

/**
 * Resolve a base-35 PostScript font file stem (e.g. `phvr8t`, `ptmr8t.tfm`) to
 * the TeX Live package that provides it, or null if it isn't one.
 */
export function fontPackageForFile(name: string): string | null {
  const stem = name.replace(FONT_STEM_EXTENSIONS, '').toLowerCase();
  const prefix = stem.slice(0, 3);
  return PS_FONT_PACKAGE_BY_PREFIX[prefix] ?? null;
}

/**
 * Validate ZIP magic bytes
 */
export function isValidZip(data: Uint8Array): boolean {
  return data.length >= 4 && data[0] === 0x50 && data[1] === 0x4B;
}

/**
 * Build the ordered list of candidate CTAN download URLs for a package from its
 * CTAN info JSON (the response of ctan.org/json/2.0/pkg/<name>). Preference
 * order: the `install` zip, then the path-based `.zip`, a package-named nested
 * `.zip`, and the `.tds.zip`. Shared by both proxies (ctan-proxy.ts,
 * serve-local.ts) and the offline prebuild (scripts/prebuild-packages.js) so the
 * CTAN path conventions live in exactly one place and can't drift between them.
 */
export function ctanDownloadUrls(info: any, pkgName: string): string[] {
  const urls: string[] = [];
  let ctanPath: string = info?.ctan?.path || '';
  // Strip a trailing filename only when CTAN marks this a file AND the path
  // actually ends in an extension (CTAN sometimes sets file:true for directories).
  if (info?.ctan?.file === true && /\.[a-z]{2,4}$/i.test(ctanPath)) {
    ctanPath = ctanPath.substring(0, ctanPath.lastIndexOf('/'));
  }
  if (info?.install) {
    urls.push(`https://mirrors.ctan.org/install${info.install}`);
  }
  if (ctanPath) {
    urls.push(`https://mirrors.ctan.org${ctanPath}.zip`);
    urls.push(`https://mirrors.ctan.org${ctanPath}/${pkgName}.zip`);
    urls.push(`https://mirrors.ctan.org${ctanPath}.tds.zip`);
  }
  return urls;
}

// ============================================================================
// Core extraction functions
// ============================================================================

/**
 * Process extracted files (from ZIP or TAR) into the standard format
 */
export function processExtractedFiles(
  files: Record<string, Uint8Array>,
  pkgName: string
): ExtractionResult {
  const result: Record<string, ProcessedFile> = {};
  const deps = new Set<string>();

  for (const [filePath, content] of Object.entries(files)) {
    const ext = filePath.substring(filePath.lastIndexOf('.')).toLowerCase();
    const fileName = filePath.split('/').pop() || '';

    // Skip docs and source
    if (filePath.includes('/doc/') || filePath.includes('/source/')) continue;

    if (TEX_EXTENSIONS.includes(ext)) {
      let targetDir = `/texlive/texmf-dist/tex/latex/${pkgName}`;

      // Anchor with (?:^|/) so paths whose TDS root is at the top level — as in
      // TeX Live archive tars (`tex/latex/...`, not `texmf-dist/tex/latex/...`) —
      // still route to their real subdirectory, not just the pkgName default.
      const latexMatch = filePath.match(/(?:^|\/)tex\/latex\/([^/]+)/);
      const genericMatch = filePath.match(/(?:^|\/)tex\/generic\/([^/]+)/);
      if (latexMatch) {
        targetDir = `/texlive/texmf-dist/tex/latex/${latexMatch[1]}`;
      } else if (genericMatch) {
        targetDir = `/texlive/texmf-dist/tex/generic/${genericMatch[1]}`;
      }

      const textContent = textDecoder.decode(content);
      result[`${targetDir}/${fileName}`] = { path: targetDir, content: textContent };

      // Scan dependencies
      for (const dep of extractDependencies(textContent)) {
        deps.add(dep);
      }
    } else if (FONT_EXTENSIONS.includes(ext)) {
      // Preserve the full TDS font path (fonts/tfm/…, fonts/vf/…, fonts/map/…)
      // so each file lands where kpathsea searches for its type. The (?:^|/)
      // anchor is essential: TeX Live tars put `fonts/` at the top level, and a
      // `/fonts/`-only regex misses that and dumps everything into type1/, where
      // TeX never finds .tfm/.vf/.map. (This is what broke on-demand fonts.)
      const fontsMatch = filePath.match(/(?:^|\/)(fonts\/[^/]+(?:\/[^/]+)*)\//);
      let targetDir = fontsMatch
        ? `/texlive/texmf-dist/${fontsMatch[1]}`
        : `/texlive/texmf-dist/fonts/type1/public/${pkgName}`;

      // Use Buffer for base64 encoding (available in Bun/Node)
      result[`${targetDir}/${fileName}`] = {
        path: targetDir,
        content: Buffer.from(content).toString('base64'),
        encoding: 'base64'
      };
    }
  }

  // Remove self from dependencies
  deps.delete(pkgName);

  return {
    files: result,
    fileCount: Object.keys(result).length,
    dependencies: [...deps]
  };
}

/**
 * Process a single raw file (for single-file CTAN packages)
 */
export function processRawFileData(
  ctanPath: string,
  content: string,
  pkgName: string
): ProcessedPackage {
  const fileName = ctanPath.split('/').pop() || `${pkgName}.sty`;
  const targetDir = `/texlive/texmf-dist/tex/latex/${pkgName}`;

  const files: Record<string, ProcessedFile> = {
    [`${targetDir}/${fileName}`]: { path: targetDir, content }
  };

  const dependencies = extractDependencies(content, pkgName);

  return {
    name: pkgName,
    files,
    totalFiles: 1,
    dependencies,
    source: 'ctan-raw'
  };
}

// Structured failure for a package that was fetched but cannot be made into
// runtime files (source-only with no build engine, no recognized recipe, …).
// Surfaced to the user as an actionable error rather than a crash (Phase 3).
export interface UnbuildableResult {
  error: string;
  unbuildable: true;
  reason: string;
  provider: string;
  additionalFiles?: string[];
}

/**
 * Process ZIP data into a ProcessedPackage.
 *
 * Runs the normalize step (provider chain + override registry) on the freshly
 * extracted files before routing them into TDS paths, so source-only packages
 * (.ins/.dtx), bundled .tds.zip, etc. become usable. Returns a structured
 * error/unbuildable result on failure instead of throwing.
 */
export async function processZipData(
  zipData: Uint8Array,
  pkgName: string,
  opts: NormalizeOptions = {}
): Promise<ProcessedPackage | { error: string } | UnbuildableResult> {
  // Validate ZIP magic bytes
  if (!isValidZip(zipData)) {
    const preview = textDecoder.decode(zipData.slice(0, 100));
    return { error: `Not a ZIP file: ${preview.slice(0, 60)}...` };
  }

  const files = await unzipAsync(zipData);

  const norm = await normalizePackage(files, { pkgName }, opts);
  if (norm.unbuildable) {
    return {
      error: norm.reason,
      unbuildable: true,
      reason: norm.reason,
      provider: norm.provider,
      additionalFiles: norm.additionalFiles,
    };
  }

  const result = processExtractedFiles(norm.runtimeFiles, pkgName);

  if (result.fileCount === 0) {
    return { error: 'No usable files found in ZIP' };
  }

  return {
    name: pkgName,
    files: result.files,
    totalFiles: result.fileCount,
    dependencies: result.dependencies,
    provider: norm.provider,
  };
}
