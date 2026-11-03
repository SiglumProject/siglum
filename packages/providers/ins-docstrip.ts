// InsDocstripBuilder — for source-only packages that ship a docstrip installer
// (`*.ins`) plus `*.dtx` but no built `.sty`. Running `tex <pkg>.ins` executes
// docstrip and writes the usable runtime files (acrotex/insdljs is the canonical
// case; see the plan's appendix).
//
// We harvest *all* newly generated runtime files (not just `<pkg>.sty`) so the
// normal dependency retry loop can fetch anything else the build emitted.

import type {
  PackageProvider,
  RawFiles,
  BuildCtx,
  CtanMeta,
} from './types.ts';

// Extensions docstrip is expected to emit as usable runtime files (the
// ctan-core TEX_EXTENSIONS set plus docstrip-specific outputs). Kept local so
// providers don't import ctan-core (that would form a cycle — see prebuilt.ts).
const GENERATED_EXTENSIONS = new Set([
  '.sty', '.cls', '.def', '.cfg', '.tex', '.fd', '.clo', '.ldf', '.sto',
]);

function insFiles(files: RawFiles): string[] {
  return Object.keys(files).filter((p) => p.toLowerCase().endsWith('.ins'));
}

function basename(path: string): string {
  return path.split('/').pop() || path;
}

function hasGeneratedExt(name: string): boolean {
  const dot = name.lastIndexOf('.');
  return dot >= 0 && GENERATED_EXTENSIONS.has(name.slice(dot).toLowerCase());
}

// Which .ins installers to run. A bundle can ship several (acrotex has 7, one
// per sub-package), and the file a caller actually needs — e.g. `insdljs.sty` —
// may come from a different .ins than `<pkg>.ins`. So unless an override pins a
// single `entry`, we run *all* of them and harvest everything they emit; the
// normal retry loop then picks up whatever file was requested.
function insEntries(files: RawFiles, meta: CtanMeta): string[] {
  const inss = insFiles(files);
  const wanted = meta.override?.entry;
  if (wanted) {
    const hit = inss.find((p) => basename(p) === wanted || p === wanted);
    return hit ? [hit] : [];
  }
  return inss;
}

// Runtime files already shipped prebuilt in the archive (e.g. acrotex bundles a
// loose aeb-comment.sty). They'd be lost when a `manual`/override forces the ins
// provider, so carry them through alongside the generated ones.
function prebuiltRuntimeFiles(files: RawFiles): RawFiles {
  const out: RawFiles = {};
  for (const [path, data] of Object.entries(files)) {
    if (path.includes('/doc/') || path.includes('/source/')) continue;
    if (hasGeneratedExt(basename(path))) out[path] = data;
  }
  return out;
}

export const InsDocstripBuilder: PackageProvider = {
  name: 'ins',

  canHandle(files: RawFiles, meta: CtanMeta): boolean {
    return insEntries(files, meta).length > 0;
  },

  async build(files: RawFiles, ctx: BuildCtx) {
    const entries = insEntries(files, ctx.meta);
    if (entries.length === 0) {
      // canHandle gates this, but stay defensive.
      throw new Error('ins: no .ins entry file found');
    }

    if (!ctx.engine) {
      const err: any = new Error(
        `Package "${ctx.meta.pkgName}" is source-only (ships ${entries.map(basename).join(', ')} + .dtx) ` +
          `and requires a docstrip build, but no TeX build engine is available in this ` +
          `environment. Set $SIGLUM_TEX to a tex binary or enable the busytex build engine.`,
      );
      err.unbuildable = true;
      err.additionalFiles = [`${ctx.meta.pkgName}.sty`];
      throw err;
    }

    const before = new Set(Object.keys(files).map(basename));
    // Start from any prebuilt runtime files, then layer generated ones on top.
    const runtimeFiles: RawFiles = prebuiltRuntimeFiles(files);
    const harvested: string[] = [];
    const logs: string[] = [];

    // Run each installer independently (a fresh TeX job per .ins) and merge.
    // One failing installer must not abort the others.
    for (const entry of entries) {
      let after: RawFiles;
      try {
        const res = await ctx.engine.run({ entry: basename(entry), inputs: files, command: 'tex' });
        after = res.files;
        logs.push(`${basename(entry)}: ${res.log.split('\n')[0]}`);
      } catch (e: any) {
        logs.push(`${basename(entry)}: build error — ${e?.message || e}`);
        continue;
      }
      for (const [name, data] of Object.entries(after)) {
        if (before.has(name)) continue; // an input echoed back, not generated
        if (!hasGeneratedExt(name)) continue;
        if (!(name in runtimeFiles)) harvested.push(name);
        runtimeFiles[name] = data;
      }
    }

    if (Object.keys(runtimeFiles).length === 0) {
      const err: any = new Error(
        `docstrip build of ${entries.map(basename).join(', ')} produced no runtime files`,
      );
      err.unbuildable = true;
      err.buildLog = logs.join('\n');
      throw err;
    }

    return {
      runtimeFiles,
      log: `ins: built [${harvested.join(', ') || 'none new'}] from ${entries.length} installer(s)\n${logs.join('\n')}`,
    };
  },
};
