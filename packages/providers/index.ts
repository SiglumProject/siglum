// Normalize step — the provider chain + orchestrator that sits between extract
// and cache:
//
//   fetch → extract → normalize(providers, overrides) → cache → serve
//
// Adding support for a new package type is meant to be a localized change: a new
// provider module appended to PROVIDERS, and/or one line in overrides.json.

import overridesData from './overrides.json';

import { PrebuiltProvider } from './prebuilt.ts';
import { TdsZipProvider } from './tds-zip.ts';
import { InsDocstripBuilder } from './ins-docstrip.ts';
import { DtxBuilder } from './dtx.ts';
import type {
  PackageProvider,
  RawFiles,
  CtanMeta,
  NormalizeResult,
  OverrideEntry,
  TexBuildEngine,
} from './types.ts';

export * from './types.ts';
export { PrebuiltProvider } from './prebuilt.ts';
export { TdsZipProvider } from './tds-zip.ts';
export { InsDocstripBuilder } from './ins-docstrip.ts';
export { DtxBuilder } from './dtx.ts';

// build-engine.ts pulls in node built-ins (child_process/fs); it is imported
// lazily (only when a build-requiring provider is actually selected) so this
// module — and the no-build providers (prebuilt/tds) — stay runnable in a
// browser/worker with no bundler shims (Phase 5: client pre-pass parity).

// Cheapest-first. The first provider whose canHandle() returns true runs.
// TdsZip before Prebuilt: a bundled .tds.zip is authoritative even if loose
// runtime files also sit in the archive. Ins last among detectors so a package
// that ships both source and a built .sty uses the built one.
export const PROVIDERS: PackageProvider[] = [
  TdsZipProvider,
  PrebuiltProvider,
  InsDocstripBuilder,
  DtxBuilder,
  // MakefileBuilder, // later, opt-in, sandboxed
];

const OVERRIDES = overridesData as Record<string, OverrideEntry>;

export function getOverride(pkgName: string): OverrideEntry | undefined {
  return OVERRIDES[pkgName];
}

function providerByName(name: string): PackageProvider | undefined {
  return PROVIDERS.find((p) => p.name === name);
}

export interface NormalizeOptions {
  // Inject a build engine (tests). When omitted, one is created on demand only
  // if a build-requiring provider is selected.
  engine?: TexBuildEngine;
  // Skip lazy engine creation entirely (e.g. environments with no TeX).
  noEngine?: boolean;
}

// Run the provider chain for one package. Never throws for the "unbuildable"
// case — it returns a structured result the caller turns into an actionable
// error (Phase 3).
export async function normalizePackage(
  files: RawFiles,
  meta: CtanMeta,
  opts: NormalizeOptions = {},
): Promise<NormalizeResult> {
  const override = meta.override ?? getOverride(meta.pkgName);
  const metaWithOverride: CtanMeta = { ...meta, override };

  // 'manual' override: serve a hand-built artifact instead of building.
  if (override?.provider === 'manual') {
    if (!override.url) {
      return {
        unbuildable: true,
        provider: 'manual',
        reason: `Override for "${meta.pkgName}" is "manual" but has no url.`,
        log: '',
      };
    }
    try {
      const res = await fetch(override.url, { redirect: 'follow' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = new Uint8Array(await res.arrayBuffer());
      // Reuse TdsZip to unpack the manual artifact (manual urls are .tds.zip).
      const built = await TdsZipProvider.build({ 'manual.tds.zip': buf }, {
        meta: metaWithOverride,
      });
      return {
        runtimeFiles: built.runtimeFiles,
        provider: 'manual',
        log: `manual: fetched ${override.url}\n${built.log}`,
      };
    } catch (e: any) {
      return {
        unbuildable: true,
        provider: 'manual',
        reason: `Failed to fetch manual artifact for "${meta.pkgName}" from ${override.url}: ${e.message || e}`,
        log: '',
      };
    }
  }

  // Pick the provider: forced by override, else first matching in the chain.
  let provider: PackageProvider | undefined;
  if (override?.provider) {
    provider = providerByName(override.provider);
    if (!provider) {
      return {
        unbuildable: true,
        provider: override.provider,
        reason: `Override names unknown provider "${override.provider}" for "${meta.pkgName}".`,
        log: '',
      };
    }
  } else {
    provider = PROVIDERS.find((p) => p.canHandle(files, metaWithOverride));
  }

  if (!provider) {
    return {
      unbuildable: true,
      provider: 'none',
      reason:
        `No provider can build "${meta.pkgName}": the archive has no runtime ` +
        `files and no recognized build recipe (.tds.zip / .ins). ` +
        `Add an entry to providers/overrides.json or build it manually.`,
      log: '',
    };
  }

  // Lazily obtain a build engine only when the chosen provider may need one.
  // The dynamic import keeps node-only code out of the browser/worker path.
  const needsEngine = provider.name === 'ins' || provider.name === 'dtx';
  let engine = opts.engine;
  if (!engine && needsEngine && !opts.noEngine) {
    const { createBuildEngine } = await import('./build-engine.ts');
    engine = await createBuildEngine();
  }

  try {
    const { runtimeFiles, log } = await provider.build(files, {
      meta: metaWithOverride,
      engine,
    });
    return { runtimeFiles, provider: provider.name, log };
  } catch (e: any) {
    // Providers signal recoverable "can't build this" via err.unbuildable;
    // anything else is a real bug and should propagate.
    if (e?.unbuildable) {
      return {
        unbuildable: true,
        provider: provider.name,
        reason: e.message || String(e),
        additionalFiles: e.additionalFiles,
        log: e.buildLog || '',
      };
    }
    throw e;
  }
}
