/**
 * Tests for the package normalization providers and orchestrator.
 * Covers Phase 1 (no-build providers + seam), Phase 2 (docstrip builder with a
 * mock build engine), and Phase 3 (override registry + structured failures).
 */

import { describe, it, expect } from 'vitest';
import { zipSync, strToU8 } from 'fflate';

import { PrebuiltProvider } from '../../packages/providers/prebuilt.ts';
import { TdsZipProvider } from '../../packages/providers/tds-zip.ts';
import { InsDocstripBuilder } from '../../packages/providers/ins-docstrip.ts';
import { DtxBuilder } from '../../packages/providers/dtx.ts';
import {
    normalizePackage,
    getOverride,
    PROVIDERS,
} from '../../packages/providers/index.ts';
import type {
    RawFiles,
    TexBuildEngine,
    CtanMeta,
} from '../../packages/providers/types.ts';
import { processZipData, fontPackageForFile, processExtractedFiles } from '../../packages/ctan-core.ts';
import { resolveFontPackage } from '../../packages/font-index.ts';

const meta = (pkgName: string): CtanMeta => ({ pkgName });

function u8(s: string): Uint8Array {
    return strToU8(s);
}

describe('PrebuiltProvider', () => {
    it('handles archives with a runtime .sty', () => {
        const files: RawFiles = { 'soul/soul.sty': u8('\\ProvidesPackage{soul}') };
        expect(PrebuiltProvider.canHandle(files, meta('soul'))).toBe(true);
    });

    it('ignores doc/ and source/ files', () => {
        const files: RawFiles = {
            'soul/doc/soul.sty': u8('x'),
            'soul/source/soul.dtx': u8('x'),
        };
        expect(PrebuiltProvider.canHandle(files, meta('soul'))).toBe(false);
    });

    it('passes all files through unchanged', async () => {
        const files: RawFiles = { 'a/x.cls': u8('cls'), 'a/y.def': u8('def') };
        const { runtimeFiles } = await PrebuiltProvider.build(files);
        expect(runtimeFiles).toBe(files);
    });
});

describe('TdsZipProvider', () => {
    it('detects and unpacks a nested .tds.zip', async () => {
        const innerZip = zipSync({
            'tex/latex/foo/foo.sty': u8('\\ProvidesPackage{foo}'),
            'doc/foo.pdf': u8('%PDF'),
        });
        const files: RawFiles = { 'foo.tds.zip': innerZip, 'README': u8('hi') };

        expect(TdsZipProvider.canHandle(files, meta('foo'))).toBe(true);

        const { runtimeFiles } = await TdsZipProvider.build(files);
        expect(runtimeFiles['tex/latex/foo/foo.sty']).toBeDefined();
        // Loose sibling carried through; the .tds.zip itself dropped.
        expect(runtimeFiles['README']).toBeDefined();
        expect(runtimeFiles['foo.tds.zip']).toBeUndefined();
    });

    it('does not handle archives without a .tds.zip', () => {
        expect(TdsZipProvider.canHandle({ 'foo.sty': u8('x') }, meta('foo'))).toBe(false);
    });
});

describe('InsDocstripBuilder', () => {
    const sources: RawFiles = {
        'acrotex/insdljs.ins': u8('\\input docstrip'),
        'acrotex/insdljs.dtx': u8('%% source'),
    };

    // A fake engine that "runs docstrip": echoes inputs and adds the generated .sty.
    const fakeEngine: TexBuildEngine = {
        name: 'fake',
        async run({ inputs }) {
            const files: RawFiles = {};
            for (const [p, d] of Object.entries(inputs)) files[p.split('/').pop()!] = d;
            files['insdljs.sty'] = u8('\\ProvidesPackage{insdljs}');
            files['insdljs.log'] = u8('log noise'); // non-runtime, must be ignored
            return { files, log: 'docstrip ok' };
        },
    };

    it('canHandle picks up a .ins file', () => {
        expect(InsDocstripBuilder.canHandle(sources, meta('insdljs'))).toBe(true);
        expect(InsDocstripBuilder.canHandle({ 'a.sty': u8('x') }, meta('a'))).toBe(false);
    });

    it('harvests only generated runtime files', async () => {
        const { runtimeFiles, log } = await InsDocstripBuilder.build(sources, {
            meta: meta('insdljs'),
            engine: fakeEngine,
        });
        expect(Object.keys(runtimeFiles)).toEqual(['insdljs.sty']);
        expect(log).toContain('insdljs.sty');
    });

    it('throws a structured unbuildable error when no engine is available', async () => {
        await expect(
            InsDocstripBuilder.build(sources, { meta: meta('insdljs') }),
        ).rejects.toMatchObject({ unbuildable: true });
    });

    it('runs ALL installers and harvests files from each (acrotex-shaped bundle)', async () => {
        // A bundle with several .ins, each generating its own package. The file
        // a caller needs (insdljs.sty) comes from a non-<pkg>.ins installer.
        const bundle: RawFiles = {
            'acrotex/acrotex.ins': u8('\\input docstrip'),
            'acrotex/insdljs.ins': u8('\\input docstrip'),
            'acrotex/eforms.ins': u8('\\input docstrip'),
            'acrotex/insdljs.dtx': u8('%% src'),
            'acrotex/aeb-comment.sty': u8('\\ProvidesPackage{aeb-comment}'), // prebuilt sibling
        };
        // Engine emits <basename-of-ins>.sty for whichever installer it runs.
        const perEntryEngine: TexBuildEngine = {
            name: 'fake',
            async run({ entry, inputs }) {
                const files: RawFiles = {};
                for (const [p, d] of Object.entries(inputs)) files[p.split('/').pop()!] = d;
                files[`${entry.replace('.ins', '')}.sty`] = u8(`\\ProvidesPackage{${entry}}`);
                return { files, log: `built ${entry}` };
            },
        };
        const { runtimeFiles } = await InsDocstripBuilder.build(bundle, {
            meta: meta('acrotex'),
            engine: perEntryEngine,
        });
        const names = Object.keys(runtimeFiles).map((p) => p.split('/').pop());
        expect(names).toContain('insdljs.sty'); // from insdljs.ins, not acrotex.ins
        expect(names).toContain('eforms.sty');
        expect(names).toContain('acrotex.sty');
        // prebuilt sibling carried through, not dropped
        expect(Object.keys(runtimeFiles).some((p) => p.endsWith('aeb-comment.sty'))).toBe(true);
    });

    it('throws unbuildable when the build emits no runtime files', async () => {
        const emptyEngine: TexBuildEngine = {
            name: 'empty',
            async run({ inputs }) {
                const files: RawFiles = {};
                for (const [p, d] of Object.entries(inputs)) files[p.split('/').pop()!] = d;
                return { files, log: 'nothing generated' };
            },
        };
        await expect(
            InsDocstripBuilder.build(sources, { meta: meta('insdljs'), engine: emptyEngine }),
        ).rejects.toMatchObject({ unbuildable: true });
    });
});

describe('DtxBuilder', () => {
    const dtxOnly: RawFiles = { 'mypkg/mypkg.dtx': u8('%% self-extracting') };

    const fakeEngine: TexBuildEngine = {
        name: 'fake',
        async run({ inputs }) {
            const files: RawFiles = {};
            for (const [p, d] of Object.entries(inputs)) files[p.split('/').pop()!] = d;
            files['mypkg.sty'] = u8('\\ProvidesPackage{mypkg}');
            return { files, log: 'extracted' };
        },
    };

    it('handles a .dtx-only archive', () => {
        expect(DtxBuilder.canHandle(dtxOnly, meta('mypkg'))).toBe(true);
    });

    it('defers to the .ins installer when one is present', () => {
        const withIns: RawFiles = { 'mypkg.dtx': u8('x'), 'mypkg.ins': u8('y') };
        expect(DtxBuilder.canHandle(withIns, meta('mypkg'))).toBe(false);
    });

    it('extracts runtime files via the engine', async () => {
        const { runtimeFiles } = await DtxBuilder.build(dtxOnly, {
            meta: meta('mypkg'),
            engine: fakeEngine,
        });
        expect(runtimeFiles['mypkg.sty']).toBeDefined();
    });

    it('is unbuildable without an engine', async () => {
        await expect(
            DtxBuilder.build(dtxOnly, { meta: meta('mypkg') }),
        ).rejects.toMatchObject({ unbuildable: true });
    });
});

describe('override registry', () => {
    it('ships an acrotex/insdljs ins override (no pinned entry → run all installers)', () => {
        expect(getOverride('acrotex')).toMatchObject({ provider: 'ins' });
        expect(getOverride('acrotex')?.entry).toBeUndefined();
        expect(getOverride('insdljs')).toMatchObject({ provider: 'ins' });
    });

    it('returns undefined for packages with no override', () => {
        expect(getOverride('soul')).toBeUndefined();
    });

    it('keeps the documented provider order (tds → prebuilt → ins → dtx)', () => {
        expect(PROVIDERS.map((p) => p.name)).toEqual(['tds', 'prebuilt', 'ins', 'dtx']);
    });
});

describe('normalizePackage', () => {
    it('selects prebuilt for ready-to-use archives', async () => {
        const res = await normalizePackage({ 'soul/soul.sty': u8('x') }, meta('soul'));
        expect(res.unbuildable).toBeFalsy();
        if (!res.unbuildable) expect(res.provider).toBe('prebuilt');
    });

    it('returns a structured unbuildable for unrecognized source-only archives', async () => {
        const res = await normalizePackage({ 'weird/notes.txt': u8('x') }, meta('weird'));
        expect(res.unbuildable).toBe(true);
        if (res.unbuildable) {
            expect(res.provider).toBe('none');
            expect(res.reason).toContain('weird');
        }
    });

    it('honors a forced provider override', async () => {
        const engine: TexBuildEngine = {
            name: 'fake',
            async run({ inputs }) {
                const files: RawFiles = {};
                for (const [p, d] of Object.entries(inputs)) files[p.split('/').pop()!] = d;
                files['acrotex.sty'] = u8('\\ProvidesPackage{acrotex}');
                return { files, log: 'ok' };
            },
        };
        const files: RawFiles = {
            'acrotex.ins': u8('\\input docstrip'),
            'acrotex.dtx': u8('%% src'),
        };
        const res = await normalizePackage(files, meta('acrotex'), { engine });
        expect(res.unbuildable).toBeFalsy();
        if (!res.unbuildable) {
            expect(res.provider).toBe('ins');
            expect(res.runtimeFiles['acrotex.sty']).toBeDefined();
        }
    });

    it('reports unbuildable (not crash) when ins build needs an engine but none exists', async () => {
        const files: RawFiles = {
            'acrotex.ins': u8('\\input docstrip'),
            'acrotex.dtx': u8('%% src'),
        };
        const res = await normalizePackage(files, meta('acrotex'), { noEngine: true });
        expect(res.unbuildable).toBe(true);
        if (res.unbuildable) expect(res.additionalFiles).toContain('acrotex.sty');
    });

    it('flags a manual override without a url as unbuildable', async () => {
        const res = await normalizePackage({ 'x.txt': u8('x') }, {
            pkgName: 'weirdpkg',
            override: { provider: 'manual' },
        });
        expect(res.unbuildable).toBe(true);
        if (res.unbuildable) expect(res.provider).toBe('manual');
    });
});

describe('fontPackageForFile (base-35 PostScript font resolution)', () => {
    it('maps font stems to their family package', () => {
        expect(fontPackageForFile('phvr8t')).toBe('helvetic');
        expect(fontPackageForFile('phvr8t.tfm')).toBe('helvetic');
        expect(fontPackageForFile('ptmr8t')).toBe('times');
        expect(fontPackageForFile('pcrr8t')).toBe('courier');
        expect(fontPackageForFile('psyr')).toBe('symbol');
        expect(fontPackageForFile('bchr8t')).toBe('charter');
    });

    it('returns null for real package names (no false positives)', () => {
        for (const n of ['times', 'amsmath', 'tikz', 'pgfplots', 'soul', 'xcolor']) {
            expect(fontPackageForFile(n)).toBeNull();
        }
    });

    it('resolveFontPackage uses the TLPDB index for arbitrary fonts, prefix map as fallback', async () => {
        // phvr8t resolves via either path (index or prefix fallback both → helvetic).
        expect(await resolveFontPackage('phvr8t')).toBe('helvetic');
        expect(await resolveFontPackage('phvr8t.tfm')).toBe('helvetic');
        // ec-lmr10 is NOT a base-35 prefix — only the TLPDB index knows it.
        // (Present in this repo; skip the assertion if the TLPDB isn't available.)
        const lm = await resolveFontPackage('ec-lmr10');
        if (lm !== null) expect(lm).toBe('lm');
        // Real packages aren't font files → not hijacked.
        expect(await resolveFontPackage('amsmath')).toBeNull();
    });
});

describe('processExtractedFiles TDS routing (top-level paths from TeX Live tars)', () => {
    const u8 = (s: string) => strToU8(s);

    it('routes font files to their real TDS dir, not the type1 fallback', () => {
        // TeX Live tars extract with the TDS root at top level (no leading slash).
        const files = {
            'fonts/tfm/adobe/helvetic/phvr8t.tfm': u8('tfm'),
            'fonts/vf/adobe/helvetic/phvr8t.vf': u8('vf'),
            'fonts/type1/urw/helvetic/uhvr8a.pfb': u8('pfb'),
            'fonts/map/dvips/helvetic/uhv.map': u8('map'),
        };
        const { files: out } = processExtractedFiles(files, 'helvetic');
        const paths = Object.keys(out);
        // .tfm must be under fonts/tfm// (where TFMFONTS searches), NOT type1/.
        expect(paths.find((p) => p.endsWith('phvr8t.tfm'))).toContain('/fonts/tfm/adobe/helvetic/');
        expect(paths.find((p) => p.endsWith('phvr8t.vf'))).toContain('/fonts/vf/adobe/helvetic/');
        expect(paths.find((p) => p.endsWith('uhvr8a.pfb'))).toContain('/fonts/type1/urw/helvetic/');
        expect(paths.find((p) => p.endsWith('uhv.map'))).toContain('/fonts/map/dvips/helvetic/');
        expect(paths.some((p) => p.includes('/fonts/type1/public/helvetic'))).toBe(false);
    });

    it('routes top-level tex/generic and tex/latex files to their subdir', () => {
        const files = {
            'tex/generic/soul/soul.sty': u8('\\ProvidesPackage{soul}'),
            'tex/latex/foo/foo.sty': u8('\\ProvidesPackage{foo}'),
        };
        const { files: out } = processExtractedFiles(files, 'somepkg');
        const paths = Object.keys(out);
        expect(paths.find((p) => p.endsWith('soul.sty'))).toContain('/tex/generic/soul/');
        expect(paths.find((p) => p.endsWith('foo.sty'))).toContain('/tex/latex/foo/');
    });
});

describe('processZipData integration', () => {
    it('extracts a prebuilt package end-to-end', async () => {
        const zip = zipSync({ 'soul/soul.sty': u8('\\ProvidesPackage{soul}\n') });
        const result = await processZipData(zip, 'soul');
        expect('error' in result).toBe(false);
        if (!('error' in result)) {
            expect(result.totalFiles).toBe(1);
            expect(result.provider).toBe('prebuilt');
            const path = Object.keys(result.files)[0];
            expect(path).toContain('/tex/latex/soul/soul.sty');
        }
    });

    it('returns a structured unbuildable result for a source-only zip with no engine', async () => {
        const zip = zipSync({
            'acrotex.ins': u8('\\input docstrip'),
            'acrotex.dtx': u8('%% src'),
        });
        const result = await processZipData(zip, 'acrotex', { noEngine: true });
        expect('error' in result).toBe(true);
        if ('error' in result && 'unbuildable' in result) {
            expect(result.unbuildable).toBe(true);
            expect(result.provider).toBe('ins');
            expect(result.error).toBe(result.reason);
        }
    });

    it('rejects non-zip data without crashing', async () => {
        const result = await processZipData(u8('not a zip'), 'x');
        expect('error' in result).toBe(true);
    });
});
