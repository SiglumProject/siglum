#!/usr/bin/env bun
/**
 * Update bundles with TL2025 content from texmfrepo archive
 *
 * This script:
 * 1. Reads file-manifest.json to get file offsets
 * 2. Extracts bundle data using those offsets
 * 3. Overlays TL2025 package content from texmfrepo/archive
 * 4. Repacks the bundles and updates file-manifest.json
 */

import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { execSync } from 'child_process';

const BUNDLES_DIR = './bundles';
const TEXMFREPO = '../busytex/source/texmfrepo/archive';

// Packages to update and which bundles they affect
const PACKAGE_UPDATES: Record<string, string[]> = {
    // Package name (without .rXXXX.tar.xz) -> bundles it affects
    'latex': ['core'],  // tex/latex/base/* goes to core bundle
    'l3kernel': ['l3'],
    'l3backend': ['l3'],
    'l3packages': ['l3'],
    'tools': ['core'],  // tex/latex/tools/*
    'amsmath': ['amsmath'],  // tex/latex/amsmath/*
    'amscls': ['amsmath'],   // tex/latex/amscls/*
    'amsfonts': ['amsmath'], // tex/latex/amsfonts/*
    'tcolorbox': ['boxes'],  // tex/latex/tcolorbox/* - downgrade to avoid tagging commands
};

// File manifest entry format
interface ManifestEntry {
    bundle: string;
    start: number;
    end: number;
}

type FileManifest = Record<string, ManifestEntry>;

// Bundles.json format
interface BundleInfo {
    files: number;
    size: number;
    requires?: string[];
}

interface BundlesJson {
    version: number;
    bundles: Record<string, BundleInfo>;
    engines: Record<string, { required: string[] }>;
    packages: Record<string, string>;
    deferred: string[];
}

async function findPackageArchive(pkgName: string): Promise<string | null> {
    const files = fs.readdirSync(TEXMFREPO);
    // Find latest version (highest revision number)
    const matches = files.filter(f =>
        f.startsWith(`${pkgName}.r`) && f.endsWith('.tar.xz')
    ).sort().reverse();

    if (matches.length === 0) return null;
    return path.join(TEXMFREPO, matches[0]);
}

async function extractBundle(bundleName: string, manifest: FileManifest): Promise<Map<string, Buffer>> {
    const dataPath = path.join(BUNDLES_DIR, `${bundleName}.data.gz`);

    if (!fs.existsSync(dataPath)) {
        throw new Error(`Bundle not found: ${bundleName}`);
    }

    const compressedData = fs.readFileSync(dataPath);
    const data = zlib.gunzipSync(compressedData);

    // Get files for this bundle from manifest
    const files = new Map<string, Buffer>();
    for (const [filePath, entry] of Object.entries(manifest)) {
        if (entry.bundle === bundleName) {
            const content = data.subarray(entry.start, entry.end);
            files.set(filePath, Buffer.from(content));
        }
    }

    console.log(`Extracted ${bundleName}: ${files.size} files`);
    return files;
}

async function extractPackage(archivePath: string): Promise<Map<string, Buffer>> {
    const tempDir = `/tmp/tl2025-pkg-${Date.now()}`;
    fs.mkdirSync(tempDir, { recursive: true });

    try {
        execSync(`tar -xf "${archivePath}" -C "${tempDir}"`, { stdio: 'pipe' });

        const files = new Map<string, Buffer>();

        function walkDir(dir: string, prefix: string = '') {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;

                if (entry.isDirectory()) {
                    walkDir(fullPath, relativePath);
                } else if (entry.isFile()) {
                    files.set(relativePath, fs.readFileSync(fullPath));
                }
            }
        }

        walkDir(tempDir);
        return files;
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
}

async function repackBundle(
    bundleName: string,
    files: Map<string, Buffer>,
    manifest: FileManifest,
    bundlesJson: BundlesJson
): Promise<void> {
    const chunks: Buffer[] = [];
    let offset = 0;

    // Sort files by path for consistency
    const sortedPaths = [...files.keys()].sort();

    for (const fullPath of sortedPaths) {
        const content = files.get(fullPath)!;

        // Update manifest entry
        manifest[fullPath] = {
            bundle: bundleName,
            start: offset,
            end: offset + content.length
        };

        chunks.push(content);
        offset += content.length;
    }

    const bundleData = Buffer.concat(chunks);
    const compressedData = zlib.gzipSync(bundleData, { level: 9 });

    const dataPath = path.join(BUNDLES_DIR, `${bundleName}.data.gz`);
    fs.writeFileSync(dataPath, compressedData);

    // Update bundles.json entry
    bundlesJson.bundles[bundleName] = {
        ...bundlesJson.bundles[bundleName],
        files: files.size,
        size: bundleData.length
    };

    console.log(`Repacked ${bundleName}: ${files.size} files, ${(compressedData.length / 1024 / 1024).toFixed(2)}MB`);
}

async function updateBundle(
    bundleName: string,
    packageFiles: Map<string, Buffer>,
    manifest: FileManifest,
    bundlesJson: BundlesJson
): Promise<number> {
    // Extract existing bundle
    const bundleFiles = await extractBundle(bundleName, manifest);

    let updatedCount = 0;

    // Update files from package
    for (const [pkgPath, content] of packageFiles) {
        // Try direct mapping: tex/... -> /texlive/texmf-dist/tex/...
        if (pkgPath.startsWith('tex/') || pkgPath.startsWith('fonts/') || pkgPath.startsWith('makeindex/')) {
            const bundlePath = `/texlive/texmf-dist/${pkgPath}`;
            if (bundleFiles.has(bundlePath)) {
                const oldSize = bundleFiles.get(bundlePath)!.length;
                bundleFiles.set(bundlePath, content);
                console.log(`  Updated: ${bundlePath} (${oldSize} -> ${content.length})`);
                updatedCount++;
            }
        }
    }

    // Repack the bundle (updates manifest in place)
    await repackBundle(bundleName, bundleFiles, manifest, bundlesJson);

    return updatedCount;
}

async function main() {
    console.log('=== Updating bundles with TL2025 content ===\n');

    // Load manifest and bundles.json
    const manifestPath = path.join(BUNDLES_DIR, 'file-manifest.json');
    const bundlesJsonPath = path.join(BUNDLES_DIR, 'bundles.json');

    if (!fs.existsSync(manifestPath)) {
        throw new Error(`Manifest not found: ${manifestPath}`);
    }
    if (!fs.existsSync(bundlesJsonPath)) {
        throw new Error(`Bundles.json not found: ${bundlesJsonPath}`);
    }

    const manifest: FileManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const bundlesJson: BundlesJson = JSON.parse(fs.readFileSync(bundlesJsonPath, 'utf8'));

    console.log(`Loaded manifest with ${Object.keys(manifest).length} files`);
    console.log(`Loaded bundles.json with ${Object.keys(bundlesJson.bundles).length} bundles\n`);

    // Track which bundles need updating
    const bundlesToUpdate = new Set<string>();
    const bundlePackageFiles = new Map<string, Map<string, Buffer>>();

    // Process each package
    for (const [pkgName, affectedBundles] of Object.entries(PACKAGE_UPDATES)) {
        const archivePath = await findPackageArchive(pkgName);
        if (!archivePath) {
            console.log(`Package not found: ${pkgName}, skipping`);
            continue;
        }

        console.log(`Processing package: ${pkgName}`);
        console.log(`Archive: ${path.basename(archivePath)}`);

        const packageFiles = await extractPackage(archivePath);
        console.log(`Extracted ${packageFiles.size} files from package\n`);

        // Merge package files into bundle-specific maps
        for (const bundleName of affectedBundles) {
            bundlesToUpdate.add(bundleName);
            if (!bundlePackageFiles.has(bundleName)) {
                bundlePackageFiles.set(bundleName, new Map());
            }
            const bundlePkgFiles = bundlePackageFiles.get(bundleName)!;
            for (const [path, content] of packageFiles) {
                bundlePkgFiles.set(path, content);
            }
        }
    }

    // Update each affected bundle
    for (const bundleName of bundlesToUpdate) {
        console.log(`\n=== Updating bundle: ${bundleName} ===`);
        const packageFiles = bundlePackageFiles.get(bundleName)!;
        const count = await updateBundle(bundleName, packageFiles, manifest, bundlesJson);
        console.log(`Updated ${count} files in ${bundleName}`);
    }

    // Save updated manifest and bundles.json
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    fs.writeFileSync(bundlesJsonPath, JSON.stringify(bundlesJson, null, 2));

    console.log('\n=== Updated manifest and bundles.json ===');
    console.log('Done!');
}

main().catch(console.error);
