// DtxBuilder — for packages that ship a self-extracting `.dtx` and no `.ins`.
// Running `tex <pkg>.dtx` (the .dtx begins with a docstrip preamble that writes
// the runtime files) extracts the usable `.sty`/`.cls`/…
//
// Ordered after InsDocstripBuilder: when both a `.ins` and `.dtx` are present,
// the `.ins` is the intended installer, so the ins builder wins.

import type {
  PackageProvider,
  RawFiles,
  BuildCtx,
  CtanMeta,
} from './types.ts';

const GENERATED_EXTENSIONS = new Set([
  '.sty', '.cls', '.def', '.cfg', '.tex', '.fd', '.clo', '.ldf', '.sto',
]);

function basename(path: string): string {
  return path.split('/').pop() || path;
}

function dtxFiles(files: RawFiles): string[] {
  return Object.keys(files).filter((p) => p.toLowerCase().endsWith('.dtx'));
}

function hasIns(files: RawFiles): boolean {
  return Object.keys(files).some((p) => p.toLowerCase().endsWith('.ins'));
}

function hasGeneratedExt(name: string): boolean {
  const dot = name.lastIndexOf('.');
  return dot >= 0 && GENERATED_EXTENSIONS.has(name.slice(dot).toLowerCase());
}

function pickEntry(files: RawFiles, meta: CtanMeta): string | undefined {
  const dtxs = dtxFiles(files);
  if (dtxs.length === 0) return undefined;
  const wanted = meta.override?.entry;
  if (wanted) {
    const hit = dtxs.find((p) => basename(p) === wanted || p === wanted);
    if (hit) return hit;
  }
  const byPkg = dtxs.find((p) => basename(p) === `${meta.pkgName}.dtx`);
  return byPkg || dtxs[0];
}

export const DtxBuilder: PackageProvider = {
  name: 'dtx',

  canHandle(files: RawFiles, meta: CtanMeta): boolean {
    // Only when there is no .ins installer to prefer (unless forced via override).
    if (meta.override?.provider === 'dtx') return pickEntry(files, meta) !== undefined;
    return !hasIns(files) && pickEntry(files, meta) !== undefined;
  },

  async build(files: RawFiles, ctx: BuildCtx) {
    const entry = pickEntry(files, ctx.meta);
    if (!entry) throw new Error('dtx: no .dtx entry file found');

    if (!ctx.engine) {
      const err: any = new Error(
        `Package "${ctx.meta.pkgName}" ships a self-extracting ${basename(entry)} ` +
          `and requires a TeX build, but no build engine is available. ` +
          `Set $SIGLUM_TEX to a tex binary or enable the busytex build engine.`,
      );
      err.unbuildable = true;
      err.additionalFiles = [`${ctx.meta.pkgName}.sty`];
      throw err;
    }

    const before = new Set(Object.keys(files).map(basename));
    const { files: after, log } = await ctx.engine.run({
      entry: basename(entry),
      inputs: files,
      command: 'tex',
    });

    const runtimeFiles: RawFiles = {};
    const harvested: string[] = [];
    for (const [name, data] of Object.entries(after)) {
      if (before.has(name)) continue;
      if (!hasGeneratedExt(name)) continue;
      runtimeFiles[name] = data;
      harvested.push(name);
    }

    if (harvested.length === 0) {
      const err: any = new Error(
        `self-extraction of ${basename(entry)} produced no runtime files`,
      );
      err.unbuildable = true;
      err.buildLog = log;
      throw err;
    }

    return {
      runtimeFiles,
      log: `dtx: extracted ${harvested.join(', ')} from ${basename(entry)}`,
    };
  },
};
