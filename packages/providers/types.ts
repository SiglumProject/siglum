// Package provider types — the normalize step's contract.
//
// A provider turns a freshly-extracted package (raw files keyed by archive path)
// into ready-to-use runtime files (.sty/.cls/.def/…). Providers form a chain
// (see ./index.ts); the first whose `canHandle` returns true runs its `build`.

// Raw extracted files, keyed by their path inside the fetched archive.
export type RawFiles = Record<string, Uint8Array>;

// Metadata about the package being normalized. Kept small and provider-agnostic.
export interface CtanMeta {
  // The package name as resolved by the proxy (after alias/parent resolution).
  pkgName: string;
  // The TeX Live year the source was fetched for, when known.
  tlYear?: number;
  // Override registry entry for this package, if any (see ./overrides.json).
  override?: OverrideEntry;
}

// A TeX build step. Implementations run `tex`/`latex` headlessly and return the
// resulting files. The docstrip/dtx builders depend only on this interface, so
// the underlying engine (busytex WASM, a system binary, a mock) is swappable
// without touching provider logic. See ./build-engine.ts.
export interface TexBuildEngine {
  name: string;
  // Run `<command> <entry>` (e.g. `tex insdljs.ins`) with `inputs` as the
  // working directory contents. Returns every file present after the run plus
  // the captured log, so the caller can diff against `inputs` to find what was
  // generated. `command` defaults to 'tex'.
  run(opts: {
    entry: string;
    inputs: RawFiles;
    command?: 'tex' | 'latex' | 'pdftex';
  }): Promise<{ files: RawFiles; log: string }>;
}

export interface BuildCtx {
  meta: CtanMeta;
  // The TeX build engine, when one is available in this environment. Undefined
  // means no engine could be created (e.g. busytex not wired up / no system
  // tex); build-requiring providers must then return an unbuildable result.
  engine?: TexBuildEngine;
}

export interface BuildResult {
  runtimeFiles: RawFiles;
  log: string;
}

export interface PackageProvider {
  name: string;
  // Cheap, synchronous predicate. Must not mutate `files`.
  canHandle(files: RawFiles, meta: CtanMeta): boolean;
  // Produce runtime files. May run a TeX build via ctx.engine.
  build(files: RawFiles, ctx: BuildCtx): Promise<BuildResult>;
}

// Declarative override registry entry (see ./overrides.json).
export interface OverrideEntry {
  // Force a specific provider by name, bypassing auto-detection.
  provider: 'prebuilt' | 'tds' | 'ins' | 'dtx' | 'manual';
  // For 'ins'/'dtx': the entry file to build (e.g. "acrotex.ins").
  entry?: string;
  // For 'manual': a URL to a pre-built .tds.zip to serve as-is.
  url?: string;
}

// Result of normalizing a package. Either runtime files (success) or a
// structured, actionable failure (never a crash). See §4.1 / Phase 3.
export type NormalizeResult =
  | {
      unbuildable?: false;
      runtimeFiles: RawFiles;
      provider: string;
      log: string;
    }
  | {
      unbuildable: true;
      provider: string;
      reason: string;
      // Files the user could supply / build manually to unblock, if known.
      additionalFiles?: string[];
      log: string;
    };
