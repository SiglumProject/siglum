#!/usr/bin/env npx ts-node
/**
 * Split BusyTeX Bundle
 *
 * Takes the monolithic texlive-basic.data (100MB) and splits it into
 * smaller, on-demand loadable bundles (~5MB each).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { decompressPackage } from './decompress-lz4';

interface FileEntry {
  filename: string;
  start: number;
  end: number;
}

interface BundleDefinition {
  name: string;
  patterns: string[];  // glob-like patterns to match
  priority: number;    // lower = loaded first
  fileFilter?: (filename: string, path: string) => boolean;  // optional exact file matching
}

// Define how to split files into bundles - granular to keep each ~5MB
const BUNDLE_DEFINITIONS: BundleDefinition[] = [
  // Core bundle - minimal essentials WITHOUT format files
  {
    name: 'core',
    priority: 0,
    patterns: [
      '/bin/',
      '/etc/',
      '/texlive/LICENSE',
      '/texlive/README',
      '/texlive/release',
      '/texlive/tex/generic/tex-ini-files/',
      '/texlive/tex/latex/latexconfig/',
      '/texlive/tex/latex/base/',
      '/texlive/texmf-dist/tex/latex/base/',
      '/texlive/texmf-dist/tex/latex/tools/',
      '/texlive/texmf-dist/tex/generic/iftex/',
      '/texlive/texmf-dist/web2c/',
      // ls-R database files - kpathsea needs these to find files (!! prefix in texmf.cnf)
      '/texlive/texmf-dist/ls-R',
      '/texlive/texmf-dist/texmf-config/ls-R',
      '/texlive/texmf-dist/texmf-var/ls-R',
      '/texlive/texmf-dist/fonts/enc/',
      '/texlive/texmf-dist/fonts/map/',
      // Essential fonts (Computer Modern subset)
      '/texlive/texmf-dist/fonts/tfm/public/cm/',
      '/texlive/texmf-dist/fonts/type1/public/cm-super/',
    ],
  },
  // Engine-specific format files - only load what you need
  {
    name: 'fmt-xelatex',
    priority: 0,
    patterns: [
      // Match xelatex.fmt but not xelatex-dev.fmt
    ],
    // Use a custom filter for exact filename matching
    fileFilter: (filename: string, path: string) =>
      filename === 'xelatex.fmt' || filename === 'xetex.fmt',
  },
  {
    name: 'fmt-pdflatex',
    priority: 0,
    patterns: [],
    fileFilter: (filename: string, path: string) =>
      filename === 'pdflatex.fmt' || filename === 'pdftex.fmt' || filename === 'pdfetex.fmt',
  },
  {
    name: 'fmt-lualatex',
    priority: 0,
    patterns: [],
    fileFilter: (filename: string, path: string) =>
      filename === 'luahblatex.fmt' || filename === 'luahbtex.fmt',
  },
  {
    name: 'fmt-latex',
    priority: 0,
    patterns: [],
    fileFilter: (filename: string, path: string) =>
      filename === 'latex.fmt' || filename === 'etex.fmt',
  },
  {
    name: 'fonts-cm',
    priority: 1,
    patterns: [
      '/texlive/texmf-dist/fonts/afm/public/amsfonts/cm/',
      '/texlive/texmf-dist/fonts/tfm/public/amsfonts/',
      '/texlive/texmf-dist/fonts/type1/public/amsfonts/',
      '/texlive/texmf-dist/fonts/afm/public/cm/',
      '/texlive/texmf-dist/fonts/pk/',
      '/texlive/texmf-dist/fonts/source/public/cm/',
    ],
  },
  // Split Latin Modern into smaller pieces by font format
  {
    name: 'fonts-lm-otf',
    priority: 2,
    patterns: [
      '/texlive/texmf-dist/fonts/opentype/public/lm/',
    ],
  },
  {
    name: 'fonts-lm-type1',
    priority: 3,
    patterns: [
      '/texlive/texmf-dist/fonts/type1/public/lm/',
    ],
  },
  {
    name: 'fonts-lm-afm',
    priority: 4,
    patterns: [
      '/texlive/texmf-dist/fonts/afm/public/lm/',
    ],
  },
  {
    name: 'fonts-lm-tfm',
    priority: 5,
    patterns: [
      '/texlive/texmf-dist/fonts/tfm/public/lm/',
      '/texlive/texmf-dist/fonts/enc/dvips/lm/',
      '/texlive/texmf-dist/fonts/map/dvips/lm/',
    ],
  },
  {
    name: 'amsmath',
    priority: 6,
    patterns: [
      '/texlive/texmf-dist/tex/latex/amsmath/',
      '/texlive/texmf-dist/tex/latex/amscls/',
      '/texlive/texmf-dist/tex/latex/amsfonts/',
    ],
  },
  {
    name: 'graphics',
    priority: 7,
    patterns: [
      '/texlive/texmf-dist/tex/latex/graphics/',
      '/texlive/texmf-dist/tex/latex/graphics-cfg/',
      '/texlive/texmf-dist/tex/latex/graphics-def/',
      '/texlive/texmf-dist/tex/latex/xcolor/',
    ],
  },
  {
    name: 'hyperref',
    priority: 8,
    patterns: [
      '/texlive/texmf-dist/tex/latex/hyperref/',
      '/texlive/texmf-dist/tex/latex/url/',
      '/texlive/texmf-dist/tex/generic/bitset/',
      '/texlive/texmf-dist/tex/generic/atbegshi/',
      '/texlive/texmf-dist/tex/latex/kvoptions/',
      '/texlive/texmf-dist/tex/latex/kvsetkeys/',
      '/texlive/texmf-dist/tex/generic/kvdefinekeys/',
      '/texlive/texmf-dist/tex/generic/pdftexcmds/',
      '/texlive/texmf-dist/tex/generic/ltxcmds/',
      '/texlive/texmf-dist/tex/generic/infwarerr/',
    ],
  },
  {
    name: 'babel',
    priority: 9,
    patterns: [
      '/texlive/texmf-dist/tex/generic/babel/',
      '/texlive/texmf-dist/tex/generic/babel-english/',
      '/texlive/texmf-dist/tex/generic/hyphen/',
    ],
  },
  {
    name: 'bibtex',
    priority: 10,
    patterns: [
      '/texlive/texmf-dist/bibtex/',
    ],
  },
  {
    name: 'dvips',
    priority: 11,
    patterns: [
      '/texlive/texmf-dist/dvips/',
      '/texlive/texmf-dist/dvipdfmx/',
    ],
  },
  {
    name: 'l3',
    priority: 12,
    patterns: [
      '/texlive/texmf-dist/tex/latex/l3kernel/',
      '/texlive/texmf-dist/tex/latex/l3packages/',
      '/texlive/texmf-dist/tex/latex/l3backend/',
    ],
  },
  // Split the "extra" catch-all into more specific bundles
  {
    name: 'fonts-euler',
    priority: 13,
    patterns: [
      '/texlive/texmf-dist/fonts/afm/public/amsfonts/euler/',
      '/texlive/texmf-dist/fonts/tfm/public/amsfonts/euler/',
      '/texlive/texmf-dist/fonts/type1/public/amsfonts/euler/',
    ],
  },
  {
    name: 'fonts-cyrillic',
    priority: 14,
    patterns: [
      '/texlive/texmf-dist/fonts/afm/public/amsfonts/cyrillic/',
      '/texlive/texmf-dist/fonts/tfm/public/amsfonts/cyrillic/',
      '/texlive/texmf-dist/fonts/type1/public/amsfonts/cyrillic/',
    ],
  },
  {
    name: 'fonts-cmextra',
    priority: 15,
    patterns: [
      '/texlive/texmf-dist/fonts/afm/public/amsfonts/cmextra/',
      '/texlive/texmf-dist/fonts/tfm/public/amsfonts/cmextra/',
      '/texlive/texmf-dist/fonts/type1/public/amsfonts/cmextra/',
    ],
  },
  {
    name: 'fonts-symbols',
    priority: 16,
    patterns: [
      '/texlive/texmf-dist/fonts/afm/public/amsfonts/symbols/',
      '/texlive/texmf-dist/fonts/tfm/public/amsfonts/symbols/',
      '/texlive/texmf-dist/fonts/type1/public/amsfonts/symbols/',
      '/texlive/texmf-dist/fonts/afm/adobe/symbol/',
      '/texlive/texmf-dist/fonts/afm/adobe/zapfding/',
    ],
  },
  // Font maps generated by updmap (needed by pdfTeX and dvips)
  {
    name: 'extra-maps',
    priority: 16,
    patterns: [
      '/texlive/texmf-dist/texmf-var/fonts/map/',
    ],
  },
  // XeTeX language/font mapping files
  {
    name: 'extra-xetex-lang',
    priority: 16,
    patterns: [
      '/texlive/texmf-dist/fonts/misc/xetex/',
    ],
  },
  {
    name: 'fonts-misc',
    priority: 17,
    patterns: [
      '/texlive/texmf-dist/fonts/afm/',
      '/texlive/texmf-dist/fonts/tfm/',
      '/texlive/texmf-dist/fonts/type1/',
      '/texlive/texmf-dist/fonts/opentype/',
      '/texlive/texmf-dist/fonts/truetype/',
      '/texlive/texmf-dist/fonts/vf/',
    ],
  },
  // Utility packages (etoolbox, etc)
  {
    name: 'utils',
    priority: 17,
    patterns: [
      '/texlive/texmf-dist/tex/latex/etoolbox/',
      '/texlive/texmf-dist/tex/latex/auxhook/',
      '/texlive/texmf-dist/tex/latex/refcount/',
      '/texlive/texmf-dist/tex/latex/rerunfilecheck/',
      '/texlive/texmf-dist/tex/latex/intcalc/',
      '/texlive/texmf-dist/tex/generic/uniquecounter/',
    ],
  },
  {
    name: 'tex-generic',
    priority: 18,
    patterns: [
      '/texlive/texmf-dist/tex/generic/',
    ],
  },
  {
    name: 'tex-latex-misc',
    priority: 19,
    patterns: [
      '/texlive/texmf-dist/tex/latex/',
    ],
  },
  {
    name: 'tex-xetex',
    priority: 20,
    patterns: [
      '/texlive/texmf-dist/tex/xetex/',
    ],
  },
  {
    name: 'tex-xelatex',
    priority: 21,
    patterns: [
      '/texlive/texmf-dist/tex/xelatex/',
    ],
  },
  {
    name: 'tex-luatex',
    priority: 22,
    patterns: [
      '/texlive/texmf-dist/tex/luatex/',
    ],
  },
  {
    name: 'tex-lualatex',
    priority: 23,
    patterns: [
      '/texlive/texmf-dist/tex/lualatex/',
    ],
  },
  {
    name: 'scripts',
    priority: 24,
    patterns: [
      '/texlive/texmf-dist/scripts/',
    ],
  },
  {
    name: 'doc',
    priority: 25,
    patterns: [
      '/texlive/texmf-dist/doc/',
    ],
  },
  // Source files - rarely needed at runtime, can skip or load on demand
  {
    name: 'source-latex',
    priority: 26,
    patterns: [
      '/texlive/texmf-dist/source/latex/',
      '/texlive/texmf-dist/source/latex-dev/',
    ],
  },
  {
    name: 'source-misc',
    priority: 27,
    patterns: [
      '/texlive/texmf-dist/source/',
    ],
  },
  // latex-dev is development/beta versions
  {
    name: 'tex-latex-dev',
    priority: 28,
    patterns: [
      '/texlive/texmf-dist/tex/latex-dev/',
    ],
  },
  // Font source files (METAFONT)
  {
    name: 'fonts-source',
    priority: 29,
    patterns: [
      '/texlive/texmf-dist/fonts/source/',
    ],
  },
  // Context and plain TeX
  {
    name: 'tex-context',
    priority: 30,
    patterns: [
      '/texlive/texmf-dist/tex/context/',
    ],
  },
  {
    name: 'tex-plain',
    priority: 31,
    patterns: [
      '/texlive/texmf-dist/tex/plain/',
    ],
  },
  {
    name: 'tex-optex',
    priority: 32,
    patterns: [
      '/texlive/texmf-dist/tex/optex/',
    ],
  },
];

function parseMetadata(jsContent: string): FileEntry[] {
  // Find the loadPackage call with file metadata
  const match = jsContent.match(/loadPackage\(\{"files":\s*\[([\s\S]*?)\],\s*"remote_package_size"/);
  if (!match) {
    throw new Error('Could not find file metadata in JS file');
  }

  const filesJson = '[' + match[1] + ']';
  const files: FileEntry[] = JSON.parse(filesJson);

  return files;
}

function matchBundle(filename: string, definitions: BundleDefinition[]): string {
  // Extract just the file basename for fileFilter matching
  const basename = filename.split('/').pop() || '';
  const dirpath = filename.slice(0, filename.lastIndexOf('/'));

  for (const def of definitions) {
    // First check fileFilter (for exact filename matching)
    if (def.fileFilter && def.fileFilter(basename, dirpath)) {
      return def.name;
    }
    // Then check patterns
    for (const pattern of def.patterns) {
      if (filename.startsWith(pattern) || filename.includes(pattern)) {
        return def.name;
      }
    }
  }
  return 'extra'; // Catch-all bundle
}

function groupFilesByBundle(files: FileEntry[], definitions: BundleDefinition[]): Map<string, FileEntry[]> {
  const bundles = new Map<string, FileEntry[]>();

  // Initialize all bundles
  for (const def of definitions) {
    bundles.set(def.name, []);
  }
  bundles.set('extra', []);

  // Assign files to bundles
  for (const file of files) {
    const bundleName = matchBundle(file.filename, definitions);
    bundles.get(bundleName)!.push(file);
  }

  return bundles;
}

interface OutputBundle {
  name: string;
  files: Array<{
    path: string;
    name: string;
    start: number;
    end: number;
  }>;
  totalSize: number;
}

async function splitBundle(
  jsPath: string,
  dataPath: string,
  outputDir: string
): Promise<void> {
  console.log('Reading metadata from', jsPath);
  const jsContent = fs.readFileSync(jsPath, 'utf-8');
  const files = parseMetadata(jsContent);
  console.log(`Found ${files.length} files in bundle`);

  console.log('\nReading data from', dataPath);
  const compressedData = fs.readFileSync(dataPath);
  console.log(`Compressed data size: ${(compressedData.length / 1024 / 1024).toFixed(2)} MB`);

  // Parse LZ4 metadata from JS file
  const offsetsMatch = jsContent.match(/"offsets":\[([0-9,]+)\]/);
  const successesMatch = jsContent.match(/"successes":\[([01,]+)\]/);
  if (!offsetsMatch || !successesMatch) {
    throw new Error('Could not find LZ4 metadata in JS file');
  }
  const offsets = offsetsMatch[1].split(',').map(n => parseInt(n, 10));
  const successes = successesMatch[1].split(',').map(n => parseInt(n, 10));
  console.log(`Found ${offsets.length} LZ4 chunks (${successes.filter(s => s === 0).length} uncompressed)`);

  // Decompress LZ4 data
  console.log('Decompressing LZ4 data...');
  const data = decompressPackage(compressedData, offsets, successes);
  console.log(`Decompressed: ${(data.length / 1024 / 1024).toFixed(2)} MB`);

  // Group files by bundle
  const bundleGroups = groupFilesByBundle(files, BUNDLE_DEFINITIONS);

  // Create output directory
  fs.mkdirSync(outputDir, { recursive: true });

  const registry: OutputBundle[] = [];

  // Process each bundle
  for (const [bundleName, bundleFiles] of bundleGroups) {
    if (bundleFiles.length === 0) continue;

    console.log(`\nProcessing bundle: ${bundleName} (${bundleFiles.length} files)`);

    // Sort files by original position for sequential reading
    bundleFiles.sort((a, b) => a.start - b.start);

    // Build new data buffer and metadata
    const chunks: Buffer[] = [];
    const newFiles: OutputBundle['files'] = [];
    let offset = 0;

    for (const file of bundleFiles) {
      const fileData = data.slice(file.start, file.end);
      const dir = path.dirname(file.filename);
      const name = path.basename(file.filename);

      newFiles.push({
        path: dir,
        name: name,
        start: offset,
        end: offset + fileData.length,
      });

      chunks.push(fileData);
      offset += fileData.length;
    }

    const bundleData = Buffer.concat(chunks);
    const compressedData = zlib.gzipSync(bundleData, { level: 9 });

    // Write data file
    const dataOutPath = path.join(outputDir, `${bundleName}.data.gz`);
    fs.writeFileSync(dataOutPath, compressedData);

    // Write metadata
    const metadata: OutputBundle = {
      name: bundleName,
      files: newFiles,
      totalSize: bundleData.length,
    };

    const metaOutPath = path.join(outputDir, `${bundleName}.meta.json`);
    fs.writeFileSync(metaOutPath, JSON.stringify(metadata, null, 2));

    registry.push(metadata);

    console.log(`  Uncompressed: ${(bundleData.length / 1024 / 1024).toFixed(2)} MB`);
    console.log(`  Compressed:   ${(compressedData.length / 1024 / 1024).toFixed(2)} MB`);
    console.log(`  Files:        ${newFiles.length}`);
  }

  // Write registry
  const registryPath = path.join(outputDir, 'registry.json');
  const registrySummary = registry.map(b => ({
    name: b.name,
    files: b.files.length,
    size: b.totalSize,
  }));
  fs.writeFileSync(registryPath, JSON.stringify(registrySummary, null, 2));

  // Generate file-manifest.json from all bundles
  // This maps every file path to {bundle, start, end} for the browser to use
  const fileManifest: Record<string, { bundle: string; start: number; end: number }> = {};
  for (const bundle of registry) {
    for (const file of bundle.files) {
      const fullPath = `${file.path}/${file.name}`;
      fileManifest[fullPath] = {
        bundle: bundle.name,
        start: file.start,
        end: file.end,
      };
    }
  }
  // Merge in entries from external bundles (e.g. cm-super) that have .meta.json
  // files but weren't part of this split run
  const registryNames = new Set(registry.map(b => b.name));
  const metaFiles = fs.readdirSync(outputDir).filter(f => f.endsWith('.meta.json'));
  for (const metaFile of metaFiles) {
    const bundleName = metaFile.replace('.meta.json', '');
    if (registryNames.has(bundleName)) continue; // already in registry
    const dataFile = path.join(outputDir, `${bundleName}.data.gz`);
    if (!fs.existsSync(dataFile)) continue; // no data file, skip
    const meta: OutputBundle = JSON.parse(fs.readFileSync(path.join(outputDir, metaFile), 'utf-8'));
    for (const file of meta.files) {
      const fullPath = `${file.path}/${file.name}`;
      fileManifest[fullPath] = {
        bundle: meta.name,
        start: file.start,
        end: file.end,
      };
    }
    console.log(`  Merged ${meta.files.length} entries from external bundle: ${bundleName}`);
  }

  const manifestPath = path.join(outputDir, 'file-manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(fileManifest, null, 2));
  console.log(`\nGenerated file-manifest.json with ${Object.keys(fileManifest).length} entries`);

  // Update bundles.json if it exists (preserve engines, packages, deferred; update bundle sizes)
  const bundlesJsonPath = path.join(outputDir, 'bundles.json');
  if (fs.existsSync(bundlesJsonPath)) {
    const bundlesJson = JSON.parse(fs.readFileSync(bundlesJsonPath, 'utf-8'));
    // Update bundle entries with new file counts and sizes
    for (const bundle of registry) {
      bundlesJson.bundles[bundle.name] = {
        ...bundlesJson.bundles[bundle.name],
        files: bundle.files.length,
        size: bundle.totalSize,
      };
    }
    // Remove bundles that no longer exist — but preserve external bundles
    // that have .data.gz files on disk (e.g. cm-super from bundle-cm-super.ts)
    for (const name of Object.keys(bundlesJson.bundles)) {
      if (registryNames.has(name)) continue; // in registry, keep
      const dataFile = path.join(outputDir, `${name}.data.gz`);
      if (fs.existsSync(dataFile)) continue; // external bundle with data, keep
      delete bundlesJson.bundles[name];
    }
    // Regenerate packages map from file-manifest.json
    // Maps LaTeX package name → bundle name (for the retry loop to resolve missing .sty files)
    const packagesMap: Record<string, string> = {};
    // Primary: map .sty/.cls filenames (without extension) to their bundle
    for (const [filePath, info] of Object.entries(fileManifest) as [string, { bundle: string }][]) {
      if (filePath.endsWith('.sty') || filePath.endsWith('.cls')) {
        const basename = filePath.substring(filePath.lastIndexOf('/') + 1);
        const pkgName = basename.substring(0, basename.lastIndexOf('.'));
        if (!packagesMap[pkgName]) {
          packagesMap[pkgName] = info.bundle;
        }
      }
    }
    // Secondary: add directory-based mappings for packages not yet covered
    const packageDirPattern = /\/tex(?:mf-dist)?\/tex\/(?:latex|generic|xelatex|lualatex|xetex|luatex|plain)\/([^/]+)\//;
    for (const [filePath, info] of Object.entries(fileManifest) as [string, { bundle: string }][]) {
      const match = filePath.match(packageDirPattern);
      if (match && !packagesMap[match[1]]) {
        packagesMap[match[1]] = info.bundle;
      }
    }
    bundlesJson.packages = packagesMap;
    console.log(`Regenerated packages map: ${Object.keys(packagesMap).length} entries`);

    fs.writeFileSync(bundlesJsonPath, JSON.stringify(bundlesJson, null, 2));
    console.log(`Updated bundles.json`);
  }

  // Print summary
  console.log('\n=== Bundle Summary ===');
  let totalUncompressed = 0;
  let totalCompressed = 0;

  for (const bundle of registry) {
    const compressedPath = path.join(outputDir, `${bundle.name}.data.gz`);
    const compressedSize = fs.statSync(compressedPath).size;
    totalUncompressed += bundle.totalSize;
    totalCompressed += compressedSize;

    console.log(
      `${bundle.name.padEnd(15)} ` +
      `${(bundle.totalSize / 1024 / 1024).toFixed(2).padStart(8)} MB → ` +
      `${(compressedSize / 1024 / 1024).toFixed(2).padStart(8)} MB ` +
      `(${bundle.files.length} files)`
    );
  }

  console.log(`${'TOTAL'.padEnd(15)} ${(totalUncompressed / 1024 / 1024).toFixed(2).padStart(8)} MB → ${(totalCompressed / 1024 / 1024).toFixed(2).padStart(8)} MB`);
  console.log(`\nOutput written to: ${outputDir}`);
}

// CLI
const args = process.argv.slice(2);
if (args.length < 2) {
  console.log(`
Usage: npx ts-node split-bundle.ts <texlive-basic.js> <texlive-basic.data> [output-dir]

Example:
  npx ts-node split-bundle.ts ../texlive-basic.js ../texlive-basic.data ./bundles
`);
  process.exit(1);
}

const jsPath = args[0];
const dataPath = args[1];
const outputDir = args[2] || './bundles';

splitBundle(jsPath, dataPath, outputDir).catch(console.error);
