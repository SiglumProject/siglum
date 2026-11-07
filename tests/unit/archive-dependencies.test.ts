import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { planArchiveDependencies } from '../../src/bundles.js';
const directory = mkdtempSync(join(tmpdir(), 'siglum-archive-deps-'));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
const graph = (archives: any) => ({ archiveDependencySource: { format: 1 }, archiveDependencies: archives });
describe('bounded archive dependency lookahead', () => {
    it('walks cycles once, preserves explicit roots and leaves large optional dependencies lazy', () => {
        const metadata = graph({
            root: { bytes: 2000000, requires: ['tiny', 'large', 'binary.ARCH', 'tiny'] },
            tiny: { bytes: 1200, requires: ['leaf', 'root'] },
            leaf: { bytes: 800, requires: [] },
            large: { bytes: 65000000, requires: ['unneeded'] },
            unneeded: { bytes: 100, requires: [] },
        });
        expect(planArchiveDependencies(['root'], metadata)).toEqual(['tiny', 'leaf']);
    });
    it('bounds both archive count and transfer hints, even for malformed metadata', () => {
        const requires = Array.from({ length: 40 }, (_, i) => `pkg${i}`);
        const small = Object.fromEntries(requires.map(name => [name, { bytes: 1, requires: [] }]));
        expect(planArchiveDependencies(['root'], graph({ root: { requires }, ...small }))).toHaveLength(12);
        const medium = Object.fromEntries(requires.map(name => [name, { bytes: 32768, requires: [] }]));
        expect(planArchiveDependencies(['root'], graph({ root: { requires }, ...medium }))).toHaveLength(4);
        expect(planArchiveDependencies(['root'], graph({ root: { requires: ['bad', 'zero'] }, bad: { bytes: NaN }, zero: { bytes: 0 } }))).toEqual([]);
        expect(planArchiveDependencies(['root'], {})).toEqual([]);
    });
    it('generates runtime-only hints reproducibly without replacing existing package metadata', () => {
        const input = join(directory, 'texlive.tlpdb'), output = join(directory, 'package-deps.json');
        writeFileSync(input, `name root
category Package
depend leaf
depend root.ARCH
depend leaf
containersize 100
runfiles size=1
 RELOC/tex/latex/root/root.sty

name leaf
category Package
containersize 50
runfiles size=1
 RELOC/fonts/tfm/public/leaf/leaf.tfm

name docs
category Package
containersize 20
docfiles size=1
 RELOC/tex/latex/docs/docs.sty

name collection-all
category Collection
containersize 10
runfiles size=1
 RELOC/tex/latex/all/all.sty

`);
        writeFileSync(output, JSON.stringify({ packages: { existing: ['kept'] } }));
        const run = () => execFileSync('bun', [resolve(__dirname, '../../scripts/build-archive-dependencies.js'), output], { env: { ...process.env, TLPDB_PATH: input }, stdio: 'pipe' });
        run();
        const first = readFileSync(output, 'utf8');
        const meta = JSON.parse(first);
        expect(meta.packages).toEqual({ existing: ['kept'] });
        expect(meta.archiveDependencies).toEqual({ leaf: { bytes: 50, requires: [] }, root: { bytes: 100, requires: ['leaf'] } });
        expect(meta.archiveDependencySource.tlpdbSha256).toMatch(/^[a-f0-9]{64}$/);
        run();
        expect(readFileSync(output, 'utf8')).toBe(first);
    });
});
