// Offline prebuild for the normalized-artifact cache (Phase 1 cache-warm).
//
// For each curated build-required package: fetch the source archive from CTAN,
// run the same normalize pipeline the proxy uses (processZipData → provider
// chain → headless busytex docstrip/build), and write the resulting runtime
// files to a committed artifact at packages/bundles/prebuilt/<pkg>.json. Any
// host then serves that artifact verbatim — the dev servers read it from disk; a
// serverless host adapter ships it to its object store and serves it there — so
// no TeX build runs in a request and the build cost is paid once, globally.
//
// Run: `bun scripts/prebuild-packages.js [pkg ...]`
//   no args  → build the full curated list (build-required.json + overrides ins/dtx)
//   pkg ...  → build only the named packages (still must be build-required)
//
// Idempotent and deterministic: re-running with no source change rewrites byte-
// identical files (stablePrebuiltJson sorts keys). Exits non-zero if any
// requested package fails to build.

import { mkdir, writeFile, rename, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';

import { processZipData, isValidZip, ctanDownloadUrls } from '../packages/ctan-core.ts';
import {
  PREBUILT_DIR,
  PREBUILT_SCHEMA,
  prebuiltPath,
  stablePrebuiltJson,
} from '../packages/prebuilt-cache.ts';
import { busytexAssetsAvailable } from '../packages/providers/busytex-engine.ts';
import buildRequired from '../packages/providers/build-required.json';

const TL_YEAR = 2025;
const UA = { 'User-Agent': 'siglum-engine-prebuild/1.0' };

// The curated set is build-required.json alone — list the *bundle* (e.g. acrotex),
// not its sub-packages. A request for a sub-package (insdljs) resolves to the
// bundle's artifact via the proxy/worker parent-resolution path, so prebuilding
// the sub-package separately would just duplicate the bundle. (overrides.json
// sub-package entries like insdljs are runtime normalize hints, not prebuild
// targets, and are intentionally NOT auto-included here.)
function curatedPackages() {
  return [...new Set(buildRequired.packages || [])].sort();
}

// Resolve a package to its downloadable CTAN archive(s) using the same
// candidate-URL builder the proxies use (ctanDownloadUrls in ctan-core.ts), so
// the prebuild can't drift from how packages are fetched at runtime.
async function ctanZipUrls(pkgName) {
  try {
    const info = await (await fetch(`https://ctan.org/json/2.0/pkg/${pkgName}`, { headers: UA })).json();
    if (info.errors) return [];
    return ctanDownloadUrls(info, pkgName);
  } catch (e) {
    console.warn(`  CTAN info lookup failed for ${pkgName}: ${e.message || e}`);
    return [];
  }
}

// Write atomically (temp file + rename) so a crash mid-write can never leave a
// truncated artifact that a server would then try to serve.
async function writeAtomic(path, contents) {
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, contents);
  await rename(tmp, path);
}

// Regenerate _index.json — a manifest of the prebuilt package names that a host
// adapter can use to gate lookups (so a non-prebuilt package costs no storage
// read). Derived from whatever artifacts are actually present, so it stays
// correct after partial runs.
async function writeIndex() {
  const entries = await readdir(PREBUILT_DIR);
  const names = entries
    .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
    .map((f) => f.slice(0, -'.json'.length))
    .sort();
  await writeAtomic(join(PREBUILT_DIR, '_index.json'), JSON.stringify(names, null, 2) + '\n');
  return names.length;
}

// Fetch + normalize one package. Returns the artifact object, or throws.
async function buildPackage(pkgName) {
  const urls = await ctanZipUrls(pkgName);
  if (urls.length === 0) throw new Error('no CTAN download URL');

  let lastReason = 'no archive yielded usable files';
  for (const url of urls) {
    const res = await fetch(url, { redirect: 'follow', headers: UA });
    if (!res.ok) continue;
    const zip = new Uint8Array(await res.arrayBuffer());
    if (!isValidZip(zip)) continue;

    console.log(`  building from ${url}`);
    const result = await processZipData(zip, pkgName);

    if (!('error' in result) && result.totalFiles > 0) {
      return {
        ...result,
        // Tag provenance so a served artifact is distinguishable in logs from a
        // live fetch (plan §4): prebuilt-ins / prebuilt-tds / prebuilt-dtx / ….
        source: `prebuilt-${result.provider}`,
        builtFrom: url.split('/').pop(),
        tlYear: TL_YEAR,
        schema: PREBUILT_SCHEMA,
      };
    }
    if ('reason' in result && result.reason) lastReason = result.reason;
    else if ('error' in result) lastReason = result.error;
  }
  throw new Error(lastReason);
}

async function main() {
  if (!busytexAssetsAvailable()) {
    console.error(
      'busytex assets not available — cannot run docstrip builds. Set ' +
        '$SIGLUM_BUSYTEX_JS / $SIGLUM_BUSYTEX_WASM / $SIGLUM_BUSYTEX_TEXMF or ' +
        'ensure busytex/build/wasm/busytex.wasm is present.',
    );
    process.exit(1);
  }

  const requested = process.argv.slice(2);
  const targets = requested.length > 0 ? requested : curatedPackages();

  if (targets.length === 0) {
    console.log('No build-required packages to prebuild (curated list is empty).');
    return;
  }

  if (!existsSync(PREBUILT_DIR)) await mkdir(PREBUILT_DIR, { recursive: true });

  console.log(`Prebuilding ${targets.length} package(s): ${targets.join(', ')}\n`);

  const failed = [];
  for (const pkgName of targets) {
    const t0 = Date.now();
    console.log(`==> ${pkgName}`);
    try {
      const artifact = await buildPackage(pkgName);
      const json = stablePrebuiltJson(artifact);
      await writeAtomic(prebuiltPath(pkgName), json);
      console.log(
        `  ok: ${artifact.totalFiles} files via ${artifact.provider} ` +
          `(${((Date.now() - t0) / 1000).toFixed(1)}s) → ${prebuiltPath(pkgName)}`,
      );
    } catch (e) {
      console.error(`  FAIL: ${e.message || e}`);
      failed.push(pkgName);
    }
  }

  const indexCount = await writeIndex();
  console.log(`\n${targets.length - failed.length}/${targets.length} prebuilt; _index.json lists ${indexCount}.`);
  if (failed.length > 0) {
    console.error(`Failed: ${failed.join(', ')}`);
    process.exit(1);
  }
}

main();
