/**
 * Build-required corpus test (plan §6/§7).
 *
 * Exercises the full extract → normalize → route pipeline (processZipData)
 * against a curated set of in-memory archives, one per package shape:
 *   - prebuilt control (soul/xcolor-like: ships .sty)
 *   - bundled .tds.zip
 *   - source-only docstrip (.ins + .dtx)   — needs a build engine
 *   - self-extracting .dtx-only            — needs a build engine
 *   - genuinely unbuildable (no recipe)
 *
 * Asserts:
 *   - build-required coverage: source-only packages produce runtime files when
 *     a (mock) engine is available;
 *   - crash rate: the pipeline NEVER throws — every failure is a structured
 *     unbuildable result;
 *   - build-once: the engine is invoked at most once per normalize.
 */

import { describe, it, expect } from 'vitest';
import { zipSync, strToU8 } from 'fflate';

import { processZipData } from '../../packages/ctan-core.ts';
import { normalizePackage } from '../../packages/providers/index.ts';
import type { RawFiles, TexBuildEngine } from '../../packages/providers/types.ts';

const u8 = (s: string) => strToU8(s);

// A mock docstrip/dtx engine: echoes inputs (by basename) and emits <pkg>.sty.
function countingEngine() {
  let calls = 0;
  const engine: TexBuildEngine = {
    name: 'mock',
    async run({ entry, inputs }) {
      calls++;
      const files: RawFiles = {};
      for (const [p, d] of Object.entries(inputs)) files[p.split('/').pop()!] = d;
      const pkg = entry.replace(/\.(ins|dtx)$/i, '');
      files[`${pkg}.sty`] = u8(`\\ProvidesPackage{${pkg}}`);
      return { files, log: `mock built ${pkg}.sty` };
    },
  };
  return { engine, calls: () => calls };
}

interface CorpusEntry {
  name: string;
  pkg: string;
  zip: Uint8Array;
  // Expected outcome WITHOUT a build engine.
  buildRequired: boolean; // needs an engine to become usable
  unbuildableWithoutEngine: boolean;
}

const CORPUS: CorpusEntry[] = [
  {
    name: 'prebuilt control (soul)',
    pkg: 'soul',
    zip: zipSync({ 'soul/soul.sty': u8('\\ProvidesPackage{soul}') }),
    buildRequired: false,
    unbuildableWithoutEngine: false,
  },
  {
    name: 'prebuilt control (xcolor, multi-file)',
    pkg: 'xcolor',
    zip: zipSync({
      'xcolor/xcolor.sty': u8('\\ProvidesPackage{xcolor}'),
      'xcolor/xcolor.def': u8('def'),
      'xcolor/doc/xcolor.pdf': u8('%PDF'),
    }),
    buildRequired: false,
    unbuildableWithoutEngine: false,
  },
  {
    name: 'bundled .tds.zip',
    pkg: 'fancytds',
    zip: zipSync({
      'fancytds.tds.zip': zipSync({
        'tex/latex/fancytds/fancytds.sty': u8('\\ProvidesPackage{fancytds}'),
      }),
    }),
    buildRequired: false,
    unbuildableWithoutEngine: false,
  },
  {
    name: 'source-only docstrip (acrotex/insdljs-like)',
    pkg: 'insdljs',
    zip: zipSync({
      'insdljs.ins': u8('\\input docstrip'),
      'insdljs.dtx': u8('%% source'),
    }),
    buildRequired: true,
    unbuildableWithoutEngine: true,
  },
  {
    name: 'self-extracting .dtx-only',
    pkg: 'selfdtx',
    zip: zipSync({ 'selfdtx.dtx': u8('%% self-extracting') }),
    buildRequired: true,
    unbuildableWithoutEngine: true,
  },
  {
    name: 'unbuildable (no recipe)',
    pkg: 'mysterypkg',
    zip: zipSync({ 'mysterypkg/README.txt': u8('no tex here') }),
    buildRequired: false,
    unbuildableWithoutEngine: true,
  },
];

describe('normalize corpus — coverage & crash-rate KPIs', () => {
  it('control set (prebuilt/tds) produces runtime files with no engine', async () => {
    for (const e of CORPUS.filter((c) => !c.unbuildableWithoutEngine)) {
      const r = await processZipData(e.zip, e.pkg, { noEngine: true });
      expect('error' in r, `${e.name} should succeed`).toBe(false);
      if (!('error' in r)) {
        expect(r.totalFiles).toBeGreaterThan(0);
      }
    }
  });

  it('build-required packages compile once an engine is available (≥90% coverage target)', async () => {
    const buildRequired = CORPUS.filter((c) => c.buildRequired);
    let covered = 0;
    for (const e of buildRequired) {
      const { engine, calls } = countingEngine();
      const r = await processZipData(e.zip, e.pkg, { engine });
      if (!('error' in r) && r.totalFiles > 0) covered++;
      // build-once: a single normalize triggers at most one build.
      expect(calls()).toBeLessThanOrEqual(1);
    }
    expect(covered / buildRequired.length).toBeGreaterThanOrEqual(0.9);
  });

  it('pipeline crash rate is zero — every failure is structured, never a throw', async () => {
    for (const e of CORPUS) {
      // No engine: build-required + recipe-less packages must fail structurally.
      const r = await processZipData(e.zip, e.pkg, { noEngine: true });
      if (e.unbuildableWithoutEngine) {
        expect('error' in r, `${e.name} should be a structured failure`).toBe(true);
        if ('error' in r && 'unbuildable' in r) {
          expect(r.unbuildable).toBe(true);
          expect(typeof r.reason).toBe('string');
          expect(r.reason.length).toBeGreaterThan(0);
        }
      }
    }
  });

  it('actionable-error rate: source-only failures name the missing artifact', async () => {
    const res = await normalizePackage(
      { 'insdljs.ins': u8('x'), 'insdljs.dtx': u8('y') },
      { pkgName: 'insdljs' },
      { noEngine: true },
    );
    expect(res.unbuildable).toBe(true);
    if (res.unbuildable) {
      expect(res.additionalFiles).toContain('insdljs.sty');
      expect(res.reason).toMatch(/source-only|build engine/i);
    }
  });
});
