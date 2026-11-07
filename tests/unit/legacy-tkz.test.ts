import { describe, expect, it } from 'vitest';
import { legacyTkzSource, shouldRetryLegacyTkz, shouldRetryLegacyTkzFct } from '../../src/legacy-tkz.js';

const source = [
    '\\documentclass{article}',
    '\\usepackage{tkz-fct}',
    '\\usepackage{tkz-euclide}',
    '\\usetkzobj{all} % legacy selector',
    '\\begin{document}Geometry\\end{document}',
].join('\n');
const log = [
    'Package: tkz-fct 2022/01/27 1.7c function',
    'Package: tkz-base 2024/01/16 4.21c tkz-base',
    'Package: tkz-euclide  2026/01/25 5.13c for pure Euclidean Geometry',
    "/documents/GeoTopo/definitions/mathe-vorlage.tex:33: I can't find file \x60tkz-obj",
    "-angles.tex'.",
    '<argument> ...\\input tkz-obj-\\tkz@temp .tex',
    'l.33 \\usetkzobj{all}',
].join('\n');

describe('legacy tkz object lookup', () => {
    it('accepts the missing legacy object at the selector, including a wrapped filename', () => {
        const code = legacyTkzSource(source, []);
        expect(shouldRetryLegacyTkz(code, log)).toBe(true);
        expect(shouldRetryLegacyTkz(code, log.replace('obj\n-', 'obj-'))).toBe(true);
        expect(shouldRetryLegacyTkz(code, log.replace('obj\n-', 'ob\nj-'))).toBe(true);
        expect(shouldRetryLegacyTkz(code, log.replace('obj\n-', 'ob\r\nj-'))).toBe(true);
        expect(shouldRetryLegacyTkz(code, log.replace('obj\n-', 'ob j-'))).toBe(false);
        expect(shouldRetryLegacyTkz(code, log.replace('/documents/GeoTopo/definitions/mathe-vorlage.tex:33: ', ''))).toBe(false);
    });

    it('keeps user overrides, other versions and unrelated errors out of the retry', () => {
        const code = legacyTkzSource(source, []);
        expect(shouldRetryLegacyTkz(legacyTkzSource(source, ['local/tkz-base.sty']), log)).toBe(false);
        expect(shouldRetryLegacyTkz(code, log.replace('1.7c', '1.8'))).toBe(false);
        expect(shouldRetryLegacyTkz(code, log.replace('4.21c', '4.22'))).toBe(false);
        expect(shouldRetryLegacyTkz(code, log.replace('5.13c', '5.14'))).toBe(false);
        expect(shouldRetryLegacyTkz(code, log.replace('angles.tex', 'other.tex'))).toBe(false);
        expect(shouldRetryLegacyTkz(code, log.replace('l.33 \\usetkzobj{all}', 'l.33 \\input{tkz-obj-angles}'))).toBe(false);
        expect(shouldRetryLegacyTkz(code, 'Package tkz-fct Error: tkz-base must be loaded before tkz-euclide')).toBe(false);
    });
});

describe('legacy tkz-fct load order', () => {
    const original = source.replace('\\usepackage{tkz-fct}\n\\usepackage{tkz-euclide}',
        '\\usepackage{tkz-euclide}\n\\usepackage{tkz-fct}');
    const diagnostic = [
        'Package: tkz-euclide 2026/01/25 5.13c',
        'Package: tkz-fct 2022/01/27 1.7c',
        '/texlive/texmf-dist/tex/latex/tkz-fct/tkz-fct.sty:22: Package tkz-fct Error: tk',
        'z-base must be loaded before tkz-euclide.',
        '',
    ].join('\n');

    it('selects the historical combination only for the exact versions and error', () => {
        const code = legacyTkzSource(original, []);
        expect(shouldRetryLegacyTkzFct(code, diagnostic, [])).toBe(true);
        expect(shouldRetryLegacyTkzFct(code, diagnostic.replace('tk\nz-', 'tkz-'), [])).toBe(true);
        expect(shouldRetryLegacyTkzFct(code, diagnostic.replace('1.7c', '1.8'), [])).toBe(false);
        expect(shouldRetryLegacyTkzFct(code, diagnostic.replace('5.13c', '5.14'), [])).toBe(false);
        expect(shouldRetryLegacyTkzFct(code, diagnostic.replace('must be loaded', 'was not loaded'), [])).toBe(false);
        expect(shouldRetryLegacyTkzFct(code, diagnostic.replace('/texlive/texmf-dist/tex/latex/tkz-fct/', './vendor/'), [])).toBe(false);
        expect(shouldRetryLegacyTkzFct(code, diagnostic.replace('/texlive/texmf-dist/tex/latex/tkz-fct/tkz-fct.sty:22: ', ''), [])).toBe(false);
    });

    it('retains ordinary package order, explicit options and project packages', () => {
        const code = legacyTkzSource(original, []);
        expect(shouldRetryLegacyTkzFct(legacyTkzSource(source, []), diagnostic, [])).toBe(false);
        expect(shouldRetryLegacyTkzFct(code, diagnostic, ['lib/tkz-fct.sty'])).toBe(false);
        expect(shouldRetryLegacyTkzFct(code.replace('\\usepackage{tkz-fct}', '\\usepackage[local]{tkz-fct}'), diagnostic, [])).toBe(false);
        expect(shouldRetryLegacyTkzFct('\\PassOptionsToPackage{local}{tkz-fct}\n' + code, diagnostic, [])).toBe(false);
        expect(shouldRetryLegacyTkzFct('\\RequirePackage[local]{tkz-fct}\n' + code, diagnostic, [])).toBe(false);
        expect(shouldRetryLegacyTkzFct('\\RequirePackage{tkz-fct}[2022/01/27]\n' + code, diagnostic, [])).toBe(false);
    });
});

describe('wrapped historical geometry diagnostics', () => {
    const packageIdentity = 'Package: tkz-euclide 2026/01/25 5.13c';
    const diagnostic = (lines: string[]) => [packageIdentity, ...lines].join('\n');
    const codeWith = (statement: string) => legacyTkzSource(source + '\n' + statement, []);

    it('requires the radius syntax and the failed Circle call for a wrapped PGF error', () => {
        const code = codeWith('\\tkzDrawCircle[R,color=red](M,\\rIN pt)');
        const log = diagnostic([
            '/tikz/triangle.tex:35: Package pgf Error',
            ": No shape named `1' is known.",
            'See the pgf package documentation for explanation.',
            'l.35 ...Circle[R,color=red](M,\\rIN pt)',
        ]);
        expect(shouldRetryLegacyTkz(code, log)).toBe(true);
        expect(shouldRetryLegacyTkz(code, log.replace('...Circle', '...Segment'))).toBe(false);
        expect(shouldRetryLegacyTkz(code, log.replace("`1'", "`2'"))).toBe(false);
        expect(shouldRetryLegacyTkz(codeWith('\\tkzDrawCircle(M,N)'), log)).toBe(false);
        expect(shouldRetryLegacyTkz(code, log.replace('5.13c', '5.14'))).toBe(false);
        const dimensionalRadius = log.replace('Error\n:', 'E\nrror:').replace("`1'", "`3cm'");
        expect(shouldRetryLegacyTkz(codeWith('\\tkzDrawCircle[R](M,3cm)'), dimensionalRadius)).toBe(true);
        expect(shouldRetryLegacyTkz(code, dimensionalRadius.replace("`3cm'", "`PointA'"))).toBe(false);
    });

    it('recovers only the confirmed axis command and the implicit fp dependency', () => {
        const axes = diagnostic([
            '/tikz/triangle.tex:19: Undefined control seque',
            'nce.',
            '<recently read> \\tkzAxeXY',
        ]);
        const fp = diagnostic([
            '/tikz/triangle.tex:21: Undefined control seq',
            'uence.',
            '<argument> \\FPpi',
        ]);
        const point = '\\tkzDefPoint(45:{cos(45*\\FPpi/180)}){C}';
        expect(shouldRetryLegacyTkz(codeWith('\\tkzAxeXY[ticks=false]'), axes)).toBe(true);
        expect(shouldRetryLegacyTkz(codeWith('\\tkzGrid'), axes)).toBe(false);
        expect(shouldRetryLegacyTkz(codeWith(point), fp)).toBe(true);
        expect(shouldRetryLegacyTkz(codeWith(point + '\n\\usepackage{fp}'), fp)).toBe(false);
        expect(shouldRetryLegacyTkz(codeWith('\\typeout{\\FPpi}'), fp)).toBe(false);
        expect(shouldRetryLegacyTkz(codeWith(point), fp.replace('\\FPpi', '\\FPcos'))).toBe(false);
    });
});
