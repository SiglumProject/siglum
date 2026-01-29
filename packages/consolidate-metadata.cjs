#!/usr/bin/env node
/**
 * Consolidate bundle metadata files into a single bundles.json
 *
 * Merges:
 * - registry.json (bundle list with file counts and sizes)
 * - bundle-deps.json (engine requirements, bundle dependencies, deferred list)
 * - package-map.json (package name -> bundle name mapping)
 *
 * Into: bundles.json
 */

const fs = require('fs');
const path = require('path');

const BUNDLES_DIR = path.join(__dirname, 'bundles');

function main() {
    console.log('Consolidating bundle metadata files...\n');

    // Load existing files
    const registry = JSON.parse(fs.readFileSync(path.join(BUNDLES_DIR, 'registry.json'), 'utf-8'));
    const bundleDeps = JSON.parse(fs.readFileSync(path.join(BUNDLES_DIR, 'bundle-deps.json'), 'utf-8'));
    const packageMap = JSON.parse(fs.readFileSync(path.join(BUNDLES_DIR, 'package-map.json'), 'utf-8'));

    console.log(`Loaded registry.json: ${registry.length} bundles`);
    console.log(`Loaded bundle-deps.json: ${Object.keys(bundleDeps.engines || {}).length} engines, ${Object.keys(bundleDeps.bundles || {}).length} bundle deps`);
    console.log(`Loaded package-map.json: ${Object.keys(packageMap).length} packages\n`);

    // Build consolidated bundles.json
    const bundles = {};

    // Add registry info (file count, size) and merge with bundle deps (requires)
    for (const entry of registry) {
        const name = typeof entry === 'string' ? entry : entry.name;
        const bundleInfo = {
            files: entry.files || 0,
            size: entry.size || 0,
        };

        // Add requires from bundle-deps if present
        const deps = bundleDeps.bundles?.[name];
        if (deps?.requires && deps.requires.length > 0) {
            bundleInfo.requires = deps.requires;
        }

        bundles[name] = bundleInfo;
    }

    // Build final structure
    const consolidated = {
        version: 1,
        bundles,
        engines: bundleDeps.engines || {},
        packages: packageMap,
        deferred: bundleDeps.deferred || [],
    };

    // Write bundles.json
    const outputPath = path.join(BUNDLES_DIR, 'bundles.json');
    fs.writeFileSync(outputPath, JSON.stringify(consolidated, null, 2));
    console.log(`Created: bundles.json`);
    console.log(`  - ${Object.keys(bundles).length} bundles`);
    console.log(`  - ${Object.keys(consolidated.engines).length} engines`);
    console.log(`  - ${Object.keys(consolidated.packages).length} packages`);
    console.log(`  - ${consolidated.deferred.length} deferred bundles\n`);

    // List files to delete
    const metaFiles = fs.readdirSync(BUNDLES_DIR).filter(f => f.endsWith('.meta.json'));
    console.log(`Found ${metaFiles.length} *.meta.json files to delete`);

    // Delete old files
    const filesToDelete = [
        'registry.json',
        'bundle-deps.json',
        'package-map.json',
        ...metaFiles,
    ];

    console.log(`\nDeleting ${filesToDelete.length} old files...`);
    for (const file of filesToDelete) {
        const filePath = path.join(BUNDLES_DIR, file);
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            console.log(`  Deleted: ${file}`);
        }
    }

    console.log('\nDone! Consolidated metadata into bundles.json');
}

main();
