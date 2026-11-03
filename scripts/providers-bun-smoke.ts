// Bun-runtime parity smoke for the normalize pipeline (plan §7).
//
// The vitest suite runs under Node/happy-dom; the original fflate crash was
// Bun-only, so we also assert the extract → normalize path under Bun here.
// Run: `bun run scripts/providers-bun-smoke.ts` (exits non-zero on failure).

import { zipSync, strToU8 } from 'fflate';
import { processZipData } from '../packages/ctan-core.ts';
import type { RawFiles, TexBuildEngine } from '../packages/providers/types.ts';

const u8 = (s: string) => strToU8(s);
let failures = 0;
function check(name: string, cond: boolean) {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}`);
  if (!cond) failures++;
}

// 1. Prebuilt
const prebuilt = await processZipData(
  zipSync({ 'soul/soul.sty': u8('\\ProvidesPackage{soul}') }),
  'soul',
);
check('prebuilt extracts', !('error' in prebuilt) && prebuilt.provider === 'prebuilt');

// 2. Nested .tds.zip (the unzipSync-under-Bun path)
const tds = await processZipData(
  zipSync({ 'x.tds.zip': zipSync({ 'tex/latex/x/x.sty': u8('\\ProvidesPackage{x}') }) }),
  'x',
);
check('nested tds.zip unpacks under Bun', !('error' in tds) && tds.provider === 'tds');

// 3. Source-only without engine → structured unbuildable (no crash)
const src = await processZipData(
  zipSync({ 'acrotex.ins': u8('x'), 'acrotex.dtx': u8('y') }),
  'acrotex',
  { noEngine: true },
);
check(
  'source-only is structured-unbuildable',
  'error' in src && 'unbuildable' in src && src.unbuildable === true,
);

// 4. Source-only WITH a mock engine → builds
const engine: TexBuildEngine = {
  name: 'mock',
  async run({ entry, inputs }) {
    const files: RawFiles = {};
    for (const [p, d] of Object.entries(inputs)) files[p.split('/').pop()!] = d;
    files['acrotex.sty'] = u8('\\ProvidesPackage{acrotex}');
    return { files, log: 'built' };
  },
};
const built = await processZipData(
  zipSync({ 'acrotex.ins': u8('x'), 'acrotex.dtx': u8('y') }),
  'acrotex',
  { engine },
);
check('source-only builds with engine', !('error' in built) && built.provider === 'ins');

// 5. END-TO-END: real headless busytex docstrip (skipped if assets absent).
const { busytexAssetsAvailable } = await import('../packages/providers/busytex-engine.ts');
if (busytexAssetsAvailable()) {
  const dtx = [
    '%<*pkg>',
    '\\ProvidesPackage{mydemo}[2026/05/25 demo]',
    '\\newcommand{\\greet}{hi}',
    '%</pkg>',
  ].join('\n');
  const ins = [
    '\\input docstrip.tex',
    '\\keepsilent',
    '\\generate{\\file{mydemo.sty}{\\from{mydemo.dtx}{pkg}}}',
    '\\endbatchfile',
  ].join('\n');
  const r = await processZipData(
    zipSync({ 'mydemo.ins': u8(ins), 'mydemo.dtx': u8(dtx) }),
    'mydemo',
  );
  const ok =
    !('error' in r) &&
    r.provider === 'ins' &&
    Object.keys(r.files).some((p) => p.endsWith('mydemo.sty'));
  check('real busytex docstrip generates mydemo.sty', ok);
} else {
  console.log('skip real busytex docstrip (assets not present)');
}

// 6. Normalized-artifact cache loads under Bun (the proxies' runtime). The
// committed acrotex artifact is produced by scripts/prebuild-packages.js.
const { loadPrebuilt } = await import('../packages/prebuilt-cache.ts');
const prebuiltArtifact = await loadPrebuilt('acrotex');
check(
  'prebuilt acrotex artifact loads under Bun with insdljs.sty',
  !!prebuiltArtifact &&
    prebuiltArtifact.provider === 'ins' &&
    Object.keys(prebuiltArtifact.files).some((p) => p.endsWith('/insdljs.sty')),
);
check(
  'prebuilt missing-package returns null',
  (await loadPrebuilt('definitely-not-a-real-package-xyz')) === null,
);

if (failures > 0) {
  console.error(`\n${failures} parity check(s) failed`);
  process.exit(1);
}
console.log('\nBun parity OK');
