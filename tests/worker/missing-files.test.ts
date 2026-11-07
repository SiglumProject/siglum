import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const context = createContext({ self: {}, TextDecoder });
const worker = readFileSync(resolve(__dirname, '../../src/worker.js'), 'utf8');
runInContext(worker, context);
const missingFiles = context.extractAllMissingFiles as (log: string, fetched?: Set<string>) => string[];

describe('worker missing file diagnostics', () => {
    it('recovers Babel language definitions from wrapped package errors', () => {
        expect(missingFiles(`/texlive/texmf-dist/tex/generic/babel/babel.sty:4330: Package babel Error: Unkn
own option 'ngerman'.
! Package babel Error: Unknown option 'russian'.
! Package babel Error: Unknown option 'french'.
! Package babel Error: Unknown option 'ngerman'.`)).toEqual(['ngerman.ldf', 'russianb.ldf', 'french.ldf']);
    });

    it('recognizes file-line-error and traditional missing file messages', () => {
        expect(missingFiles("/texlive/texmf-dist/tex/generic/babel-russian/russianb.ldf:79: I can't find fil" +
            "\ne `t2aenc.def'.\n! LaTeX Error: File `latex2pydata.sty' not found.")).toEqual(['t2aenc.def', 'latex2pydata.sty']);
    });

    it('retains dots in dynamically requested code filenames', () => {
        expect(missingFiles('I looked for files named vendor.library.feature.code.tex')).toEqual(['vendor.library.feature.code.tex']);
        expect(missingFiles('I looked for files named module-extra+compat.code.tex')).toEqual(['module-extra+compat.code.tex']);
    });

    it('recovers a diagnostic whose final file-line colon wraps to the next line', () => {
        expect(missingFiles('/a/long/source.tex:12\n: Font LSB/vendor/m/n/20=Vendor-Diagram at 20.0pt not loadable: Metric (TFM) \nfile not found.')).toEqual(['Vendor-Diagram']);
    });

    it('recovers case-sensitive metric names and unquoted package diagnostics', () => {
        expect(missingFiles('/doc.tex:9: Font LSB/custom/m/\nn/20=Vendor-Diagram at 20.0pt not loadable: Metric (TFM) file not found.')).toEqual(['Vendor-Diagram']);
        expect(missingFiles('/tree/date.sty:30: Package date.sty Error\n: Package file dependency.sty not found.')).toEqual(['dependency.sty']);
    });

    it('recovers a metric named in a wrapped font diagnostic', () => {
        expect(missingFiles('/cyrillic/cyrillic.tex:9: Font T2A/cmr/m/n/10.95=larm1095 at 10.95pt not loadab' +
            '\nle: Metric (TFM) file not found.')).toEqual(['larm1095']);
    });

    it('recovers a metric when a long filename wraps before the line number', () => {
        const log = '/tikz/triangle-exteriour-angle-theorem-1/triangle-exteriour-angle-theorem-1.tex\n' +
            ':15: Font OT1/phv/m/n/10=phvr7t at 10.0pt not loadable: Metric (TFM) file not f\nound.';
        expect(missingFiles(log)).toEqual(['phvr7t']);
        expect(missingFiles(log, new Set(['phvr7t']))).toEqual([]);
    });

    it('loads only a known exact bitmap size after the pdfTeX raster diagnostic', () => {
        runInContext(`fontFileToBundle = new Map([['yinit.657pk', 'fonts-pk-yinit']]);`, context);
        const message = '!pdfTeX error: /bin/busytex (file yinit): Font yinit at 657 not foun\nd';
        expect(missingFiles(message)).toEqual(['yinit.657pk']);
        expect(missingFiles(message, new Set(['fonts-pk-yinit']))).toEqual([]);
        expect(missingFiles(message.replace('657', '600'))).not.toContain('yinit.600pk');
        runInContext(`fontFileToBundle = null;`, context);
    });

    it('accepts final font diagnostics with a source prefix and no line number', () => {
        runInContext(`fontFileToBundle = new Map([['InitialCaps.657pk', 'bitmap-assets']]);`, context);
        try {
            expect(missingFiles('/project/chapter.tex: pdfTeX error: /bin/pdflatex (file InitialCaps): Font InitialCaps at 657 not found'))
                .toEqual(['InitialCaps.657pk']);
            expect(missingFiles('/project/chapter.tex: pdfTeX error: /bin/pdflatex (file TypewriterBold): Font TypewriterBold at 600 not found'))
                .toEqual(['TypewriterBold.pfb']);
            expect(missingFiles('/project/chapter.tex: Font T2A/custom/m/n/10=CustomMetric at 10pt not loadable: Metric (TFM) file not found.'))
                .toEqual(['CustomMetric']);
        } finally {
            runInContext(`fontFileToBundle = null;`, context);
        }
    });

    it('delegates explicit Type 1 filenames to dynamic ownership', () => {
        const outline = '!pdfTeX error: /bin/busytex (file putr8a.pfb): cannot open Type 1 fo\nnt file for reading';
        expect(missingFiles(outline)).toEqual(['putr8a.pfb']);
        expect(missingFiles(outline, new Set(['putr8a.pfb']))).toEqual([]);
        expect(missingFiles(outline.replace('putr8a', 'unknown'))).toEqual(['unknown.pfb']);
        expect(missingFiles(outline.replace('cannot open', 'corrupt'))).toEqual([]);
        expect(runInContext(`['kvmacros.tex', 'putr8a.pfb', 'putr8a.tfm'].map(getPackageFromFile)`, context))
            .toEqual(['karnaugh', 'putr8a.pfb', 'putr8a.tfm']);
    });

    it('routes Type 1 diagnostics to the exact bundle only when the outline is bundled', () => {
        runInContext(`fontFileToBundle = new Map([
            ['other.tfm', 'metrics'],
            ['known.pfb', 'outlines'],
        ]);`, context);
        try {
            const outline = '!pdfTeX error: /bin/busytex (file known.pfb): cannot open Type 1 font file for reading';
            expect(missingFiles(outline)).toEqual(['known.pfb']);
            expect(missingFiles(outline.replace('known', 'other'))).toEqual(['other.pfb']);
            expect(runInContext(`getMissingFileBundle('known.pfb', 'outlines')`, context)).toBe('outlines');
        } finally {
            runInContext(`fontFileToBundle = null;`, context);
        }
    });

    it('keeps an outline request separate from an already fetched metrics bundle', () => {
        runInContext(`fontFileToBundle = new Map([['Synthetic.tfm', 'metrics']]);`, context);
        try {
            expect(missingFiles('!pdfTeX error: /bin/pdflatex (file Synthetic): Font Synthetic at 600 not found', new Set(['metrics'])))
                .toEqual(['Synthetic.pfb']);
            expect(runInContext(`getPackageFromFile('Synthetic.pfb')`, context)).toBe('Synthetic.pfb');
            expect(runInContext(`getPackageFromFile('Synthetic.tfm')`, context)).toBe('metrics');
            expect(runInContext(`getMissingFileBundle('Synthetic.pfb', 'metrics')`, context)).toBeUndefined();
        } finally {
            runInContext(`fontFileToBundle = null;`, context);
        }
    });

    it('does not let a macro-only Utopia bundle claim the outline', () => {
        const bundle = runInContext(`
            packageMap = { utopia: 'tex-latex-misc' };
            getMissingFileBundle('putr8a.pfb', 'utopia')
        `, context);
        expect(bundle).toBeUndefined();
    });

    it('leaves unrelated Babel errors and already fetched definitions alone', () => {
        expect(missingFiles("! Package babel Error: Unknown option 'ngerman'." +
            "\n! Package babel Error: You haven't defined the language 'english' yet.", new Set(['ngerman']))).toEqual([]);
    });

    it('uses only the exact manifest to route Babel language definitions to bundles', () => {
        const result = runInContext(`
            packageMap = { russianb: 'babel', english: 'babel' };
            docFileToBundle = new Map([['english.ldf', 'babel']]);
            [getMissingFileBundle('russianb.ldf', 'russianb'), getMissingFileBundle('english.ldf', 'english')]
        `, context);
        expect(result).toEqual([undefined, 'babel']);
    });
});
