import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
let directory: string;
let index: Record<string, string>;
beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), 'siglum-font-index-'));
    const input = join(directory, 'texlive.tlpdb');
    const output = join(directory, 'index.json');
    writeFileSync(input, `name metrics
runfiles size=1
 RELOC/fonts/tfm/public/example/Shared.tfm
 RELOC/fonts/tfm/public/example/Same.tfm
 RELOC/fonts/type1/public/example/Same.pfb
 RELOC/fonts/tfm/public/example/Case.tfm

name helper.windows
runfiles size=1
 tlpkg/private/Shared.pfb

name outlines
runfiles size=1
 RELOC/fonts/type1/public/example/Shared.pfb
 texmf-dist/fonts/opentype/example/Independent.otf
 RELOC/fonts/type1/public/example/Case.PFB
docfiles size=1
 RELOC/fonts/type1/public/example/DocumentationOnly.pfb

name 00meta
runfiles size=1
 RELOC/fonts/tfm/public/example/Meta.tfm

`);
    execFileSync('bun', [resolve(__dirname, '../../scripts/build-font-file-index.js'), output], {
        env: { ...process.env, TLPDB_PATH: input }, stdio: 'pipe',
    });
    index = JSON.parse(readFileSync(output, 'utf8'));
});
afterAll(() => { if (directory) rmSync(directory, { recursive: true, force: true }); });
describe('generated font resource ownership', () => {
    it('preserves the metric provider for legacy bare stems', () => {
        expect(index.Shared).toBe('metrics');
    });
    it('resolves a different outline provider using the explicit extension', () => {
        expect(index['Shared.pfb']).toBe('outlines');
    });
    it('does not let platform-private files claim portable font resources', () => {
        expect(index['Shared.pfb']).not.toBe('helper.windows');
    });
    it('omits redundant exact aliases and retains case-sensitive resource names', () => {
        expect(index['Same.pfb']).toBeUndefined();
        expect(index['Case.PFB']).toBe('outlines');
        expect(index['case.PFB']).toBeUndefined();
        expect(index.Independent).toBe('outlines');
    });
    it('does not index documentation or collection metadata as runtime fonts', () => {
        expect(index.DocumentationOnly).toBeUndefined();
        expect(index.Meta).toBeUndefined();
    });
});
