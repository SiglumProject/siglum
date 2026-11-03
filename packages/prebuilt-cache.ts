// Normalized-artifact cache.
//
// "Normalize once, globally; cache the output; serve the cached artifact." A
// build-required package (source-only .ins/.dtx, .tds.zip, …) is normalized one
// time by the offline prebuild (scripts/prebuild-packages.js) into a committed
// artifact under packages/bundles/prebuilt/<pkg>.json. Both servers consult this
// cache *before* the live CTAN/TeXLive flow and serve the artifact verbatim, so
// no TeX build ever runs in a request — which is what lets a serverless host that
// cannot run TeX in-request still serve these packages.
//
// The engine is host-agnostic: it emits the artifacts; how a deployment serves
// them is the deployment's concern. A serverless host adapter consults its own
// object store rather than this fs-backed loader (the Cloudflare worker under
// cloudflare/ is one such adapter — kept outside the engine, not a dependency
// of it).
//
// Node/Bun only (uses fs). Imported by serve-local.ts and ctan-proxy.ts — NOT by
// ctan-core.ts, so the provider core stays browser/worker-safe.

import { readFile, readdir } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { ProcessedPackage } from './ctan-core.ts';

// Current artifact schema. Reuses ProcessedPackage verbatim (a client that
// understands a fetched package understands this) plus provenance fields.
export const PREBUILT_SCHEMA = 1;

export interface PrebuiltArtifact extends ProcessedPackage {
  builtFrom?: string; // CTAN archive the source came from (provenance)
  tlYear?: number; // TeX Live year the source was fetched for
  schema?: number; // PREBUILT_SCHEMA
}

// Decision (plan §9 — version keying): key by package name only. docstrip output
// is version-stable, and name-only keys keep the cache small and the lookup
// trivial; the tlYear field records provenance without multiplying artifacts.
export const PREBUILT_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  'bundles',
  'prebuilt',
);

export function prebuiltPath(pkgName: string): string {
  return join(PREBUILT_DIR, `${pkgName}.json`);
}

// A package name safe to interpolate into a file path / object-store key.
// parentPkg comes from the (untrusted) CTAN response and flows into loadPrebuilt,
// so this guard is load-bearing: it blocks path traversal ("../…") and
// separators. Matches the charset the proxies (and any host adapter) enforce on
// package names.
const SAFE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
export function isSafePrebuiltName(name: string): boolean {
  return typeof name === 'string' && name.length <= 64 && SAFE_NAME.test(name);
}

// Minimal structural validation: a corrupt or truncated artifact must degrade to
// a cache miss (→ live fetch), never be served as if valid.
export function isValidArtifact(a: any): a is PrebuiltArtifact {
  return (
    !!a &&
    typeof a === 'object' &&
    typeof a.name === 'string' &&
    !!a.files &&
    typeof a.files === 'object' &&
    typeof a.totalFiles === 'number' &&
    a.totalFiles > 0 &&
    Object.keys(a.files).length === a.totalFiles
  );
}

// In-process caches. Both live for the process lifetime: committed artifacts do
// not change while a server runs (the prebuild is an offline step).
//   memo:  pkg → artifact|null, so repeated requests never re-read disk.
//   index: the set of package names that HAVE a committed artifact, read once
//          (one readdir) so a lookup for a non-prebuilt package — the vast
//          majority — costs a Set.has() and zero disk I/O.
const memo = new Map<string, PrebuiltArtifact | null>();
let index: Set<string> | null = null;

async function getIndex(): Promise<Set<string>> {
  if (index) return index;
  try {
    const entries = await readdir(PREBUILT_DIR);
    index = new Set(
      entries
        .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
        .map((f) => f.slice(0, -'.json'.length)),
    );
  } catch {
    index = new Set(); // dir absent → no prebuilt artifacts
  }
  return index;
}

// Read the committed prebuilt artifact for a package, or null if there is none
// (or it is unsafe/corrupt). Never throws.
export async function loadPrebuilt(
  pkgName: string,
): Promise<PrebuiltArtifact | null> {
  if (!isSafePrebuiltName(pkgName)) return null;
  if (memo.has(pkgName)) return memo.get(pkgName)!;

  const names = await getIndex();
  if (!names.has(pkgName)) {
    memo.set(pkgName, null); // no artifact — remember so we don't readdir-miss again
    return null;
  }

  let artifact: PrebuiltArtifact | null = null;
  try {
    const raw = await readFile(prebuiltPath(pkgName), 'utf-8');
    const parsed = JSON.parse(raw);
    artifact = isValidArtifact(parsed) ? parsed : null;
    if (!artifact) {
      console.warn(`[prebuilt-cache] ignoring malformed artifact: ${pkgName}.json`);
    }
  } catch (e) {
    console.warn(`[prebuilt-cache] failed to read ${pkgName}.json:`, e);
    artifact = null; // ENOENT / parse error → treat as cache miss
  }
  memo.set(pkgName, artifact);
  return artifact;
}

// Clear the in-process caches (tests; or after a prebuild run in a long process).
export function clearPrebuiltCache(): void {
  memo.clear();
  index = null;
}

// Deterministic serialization of an artifact (plan §7: re-running the prebuild
// must produce identical bytes). Sorts object keys at every level — most
// importantly the `files` map, whose insertion order is otherwise build-order
// dependent — and pretty-prints for a readable, diff-friendly committed file.
export function stablePrebuiltJson(artifact: PrebuiltArtifact): string {
  return JSON.stringify(sortKeysDeep(artifact), null, 2) + '\n';
}

function sortKeysDeep(value: any): any {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === 'object') {
    const out: Record<string, any> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = sortKeysDeep(value[key]);
    }
    return out;
  }
  return value;
}
