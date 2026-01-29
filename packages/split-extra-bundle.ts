#!/usr/bin/env npx ts-node
/**
 * Split the "extra" bundle into smaller, more targeted bundles:
 * - extra-maps: Font maps needed by both engines (pdftex.map, psfonts.map, etc.)
 * - extra-xetex: XeTeX-specific font mappings (arabxetex, tibetan, itrans)
 * - extra-cjk: CMap files for CJK support
 * - extra-misc: Everything else that's actually needed
 *
 * Files to DELETE (not needed):
 * - xelatex-dev.fmt (8.7MB - duplicate/dev version)
 * - All *.log files (build logs, not needed at runtime)
 * - xdvi files (X11 DVI viewer, not relevant for browser)
 */

import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';

interface FileEntry {
  path: string;
  name: string;
  start: number;
  end: number;
}

interface BundleMeta {
  name: string;
  files: FileEntry[];
  totalSize: number;
}

// Categorize files into new bundles
function categorizeFile(filePath: string, fileName: string): string | null {
  const fullPath = `${filePath}/${fileName}`;

  // DELETE: Log files
  if (fileName.endsWith('.log')) {
    return null;
  }

  // DELETE: xelatex-dev.fmt (huge, not needed - we have fmt-xelatex bundle)
  if (fileName === 'xelatex-dev.fmt') {
    return null;
  }

  // DELETE: xdvi files (X11 viewer, not for browser)
  if (filePath.includes('/xdvi')) {
    return null;
  }

  // CJK: CMap files for dvipdfmx
  if (filePath.includes('/fonts/cmap/')) {
    return 'extra-cjk';
  }

  // XETEX: XeTeX font mappings
  if (filePath.includes('/fonts/misc/xetex/fontmapping/')) {
    // Base mappings (tex-text.tec) are needed for basic XeTeX
    if (filePath.includes('/fontmapping/base/')) {
      return 'extra-xetex-base';
    }
    // Language-specific mappings (Arabic, Tibetan, Indic) can be lazy loaded
    return 'extra-xetex-lang';
  }

  // MAPS: Font map files (pdftex.map, psfonts.map, etc.)
  if (filePath.includes('/fonts/map/') || filePath.includes('/updmap/')) {
    return 'extra-maps';
  }

  // MAPS: Language config files (needed for hyphenation)
  // Note: path may not have trailing slash
  if (filePath.includes('/tex/generic/config') || fileName.startsWith('language.')) {
    return 'extra-maps';
  }

  // MAPS: texmf.cnf and texmfcnf.lua
  if (fileName === 'texmf.cnf' || fileName === 'texmfcnf.lua') {
    return 'extra-maps';
  }

  // MAPS: fontconfig
  if (filePath.includes('/fonts/conf/')) {
    return 'extra-maps';
  }

  // MISC: makeindex files
  if (filePath.includes('/makeindex/')) {
    return 'extra-misc';
  }

  // MISC: metafont/metapost files
  if (filePath.includes('/metafont/') || filePath.includes('/metapost/') || filePath.includes('/mft/')) {
    return 'extra-misc';
  }

  // MISC: mptopdf.fmt (for MetaPost to PDF conversion)
  if (fileName === 'mptopdf.fmt') {
    return 'extra-misc';
  }

  // Fallback to misc
  return 'extra-misc';
}

async function splitExtraBundle(bundlesDir: string): Promise<void> {
  const extraMetaPath = path.join(bundlesDir, 'extra.meta.json');
  const extraDataPath = path.join(bundlesDir, 'extra.data.gz');

  console.log('Reading extra.meta.json...');
  const meta: BundleMeta = JSON.parse(fs.readFileSync(extraMetaPath, 'utf-8'));
  console.log(`Found ${meta.files.length} files, total size: ${(meta.totalSize / 1024 / 1024).toFixed(2)} MB`);

  console.log('\nReading and decompressing extra.data.gz...');
  const compressedData = fs.readFileSync(extraDataPath);
  const data = zlib.gunzipSync(compressedData);
  console.log(`Decompressed: ${(data.length / 1024 / 1024).toFixed(2)} MB`);

  // Group files by new bundle
  const bundles = new Map<string, FileEntry[]>();
  const deletedFiles: string[] = [];
  let deletedSize = 0;

  for (const file of meta.files) {
    const category = categorizeFile(file.path, file.name);

    if (category === null) {
      deletedFiles.push(`${file.path}/${file.name}`);
      deletedSize += (file.end - file.start);
      continue;
    }

    if (!bundles.has(category)) {
      bundles.set(category, []);
    }
    bundles.get(category)!.push(file);
  }

  console.log(`\nDeleting ${deletedFiles.length} files (${(deletedSize / 1024 / 1024).toFixed(2)} MB):`);
  for (const f of deletedFiles.slice(0, 10)) {
    console.log(`  - ${f}`);
  }
  if (deletedFiles.length > 10) {
    console.log(`  ... and ${deletedFiles.length - 10} more`);
  }

  // Create new bundles
  console.log('\nCreating new bundles:');

  for (const [bundleName, files] of bundles) {
    if (files.length === 0) continue;

    // Build new data buffer
    const chunks: Buffer[] = [];
    const newFiles: FileEntry[] = [];
    let offset = 0;

    for (const file of files) {
      const fileData = data.slice(file.start, file.end);

      newFiles.push({
        path: file.path,
        name: file.name,
        start: offset,
        end: offset + fileData.length,
      });

      chunks.push(fileData);
      offset += fileData.length;
    }

    const bundleData = Buffer.concat(chunks);
    const compressedBundle = zlib.gzipSync(bundleData, { level: 9 });

    // Write data file
    const dataOutPath = path.join(bundlesDir, `${bundleName}.data.gz`);
    fs.writeFileSync(dataOutPath, compressedBundle);

    // Write metadata
    const newMeta: BundleMeta = {
      name: bundleName,
      files: newFiles,
      totalSize: bundleData.length,
    };

    const metaOutPath = path.join(bundlesDir, `${bundleName}.meta.json`);
    fs.writeFileSync(metaOutPath, JSON.stringify(newMeta, null, 2));

    console.log(`  ${bundleName}: ${files.length} files, ${(bundleData.length / 1024 / 1024).toFixed(2)} MB -> ${(compressedBundle.length / 1024).toFixed(0)} KB compressed`);
  }

  // Backup original extra bundle
  const backupDataPath = path.join(bundlesDir, 'extra.data.gz.bak');
  const backupMetaPath = path.join(bundlesDir, 'extra.meta.json.bak');

  if (!fs.existsSync(backupDataPath)) {
    console.log('\nBacking up original extra bundle...');
    fs.copyFileSync(extraDataPath, backupDataPath);
    fs.copyFileSync(extraMetaPath, backupMetaPath);
  }

  // Delete original extra bundle
  console.log('\nRemoving original extra.data.gz and extra.meta.json...');
  fs.unlinkSync(extraDataPath);
  fs.unlinkSync(extraMetaPath);

  console.log('\nDone! New bundles created:');
  for (const bundleName of bundles.keys()) {
    const stat = fs.statSync(path.join(bundlesDir, `${bundleName}.data.gz`));
    console.log(`  ${bundleName}.data.gz: ${(stat.size / 1024).toFixed(0)} KB`);
  }

  console.log('\nNext steps:');
  console.log('1. Update bundle-deps.json to use the new bundle names');
  console.log('2. Test compilation with pdflatex and xelatex');
}

// CLI
const bundlesDir = process.argv[2] || './bundles';
splitExtraBundle(bundlesDir).catch(console.error);
