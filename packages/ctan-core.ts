// Shared CTAN package extraction logic
// Used by both ctan-proxy.ts (server) and serve-local.ts (dev)

import { unzip } from 'fflate';

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
  return new Promise((resolve, reject) => {
    unzip(data, (err, result) => {
      if (err) reject(err);
      else resolve(result);
    });
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

/**
 * Validate ZIP magic bytes
 */
export function isValidZip(data: Uint8Array): boolean {
  return data.length >= 4 && data[0] === 0x50 && data[1] === 0x4B;
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

      if (filePath.includes('/tex/latex/')) {
        const match = filePath.match(/\/tex\/latex\/([^/]+)/);
        if (match) targetDir = `/texlive/texmf-dist/tex/latex/${match[1]}`;
      } else if (filePath.includes('/tex/generic/')) {
        const match = filePath.match(/\/tex\/generic\/([^/]+)/);
        if (match) targetDir = `/texlive/texmf-dist/tex/generic/${match[1]}`;
      }

      const textContent = textDecoder.decode(content);
      result[`${targetDir}/${fileName}`] = { path: targetDir, content: textContent };

      // Scan dependencies
      for (const dep of extractDependencies(textContent)) {
        deps.add(dep);
      }
    } else if (FONT_EXTENSIONS.includes(ext)) {
      const fontsMatch = filePath.match(/\/(fonts\/[^/]+(?:\/[^/]+)*)\//);
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

/**
 * Process ZIP data into a ProcessedPackage
 * Returns null with error message if invalid
 */
export async function processZipData(
  zipData: Uint8Array,
  pkgName: string
): Promise<ProcessedPackage | { error: string }> {
  // Validate ZIP magic bytes
  if (!isValidZip(zipData)) {
    const preview = textDecoder.decode(zipData.slice(0, 100));
    return { error: `Not a ZIP file: ${preview.slice(0, 60)}...` };
  }

  const files = await unzipAsync(zipData);
  const result = processExtractedFiles(files, pkgName);

  if (result.fileCount === 0) {
    return { error: 'No usable files found in ZIP' };
  }

  return {
    name: pkgName,
    files: result.files,
    totalFiles: result.fileCount,
    dependencies: result.dependencies
  };
}
