import { describe, expect, it } from 'vitest';
import { translateLegacyChemfig } from '../../src/legacy-chemfig.js';

const source = [
    '\\documentclass{article}',
    '\\usepackage{chemfig}',
    '\\begin{document}',
    '  \\small\\setatomsep{1.5em} % preserve this comment',
    '  \\chemfig{A-\\lewis{0.,O}}',
    '\\end{document}',
].join('\n');
const log = [
    'Package: chemfig 2025/10/30 v1.71 Draw molecule with an easy syntax (CT)',
    '/document.tex:4: Undefined control sequence.',
    'l.4   \\small\\setatomsep',
    '                       {1.5em}',
].join('\n');

describe('legacy Chemfig', () => {
    it('uses the current atom separation key and shipped Lewis support on the original source lines', () => {
        const revised = translateLegacyChemfig(source, [], log);
        expect(revised?.split('\n')).toEqual([
            '\\documentclass{article}',
            '\\usepackage{chemfig}',
            '\\ifdefined\\lewis\\else\\ifdefined\\Lewis\\else\\input{chemfig-lewis.tex}\\fi\\fi\\begin{document}',
            '  \\small\\setchemfig{atom sep=1.5em} % preserve this comment',
            '  \\chemfig{A-\\lewis{0.,O}}',
            '\\end{document}',
        ]);
    });

    it('does not fetch or load optional Lewis support for comments or an existing explicit input', () => {
        const comment = source.replace('  \\chemfig', '  % \\chemfig');
        expect(translateLegacyChemfig(comment, [], log)).toBe(comment.replace('\\setatomsep{1.5em}', '\\setchemfig{atom sep=1.5em}'));
        const explicit = source.replace('\\begin{document}', '\\input{chemfig-lewis.tex}\n\\begin{document}');
        expect(translateLegacyChemfig(explicit, [], log)).toBe(explicit.replace('\\setatomsep{1.5em}', '\\setchemfig{atom sep=1.5em}'));
    });

    it.each([
        ['another package version', source, log.replace('v1.71', 'v1.72')],
        ['another undefined command', source, log.replace('\\setatomsep', '\\missingCommand')],
        ['an unrelated failure', source, log.replace('Undefined control sequence.', 'Missing number.')],
        ['an explicit date', source.replace('{chemfig}', '{chemfig}[2025/10/30]'), log],
        ['an explicit package option', source.replace('{chemfig}', '[custom]{chemfig}'), log],
        ['an authored definition', source.replace('\\begin{document}', '\\def\\Lewis{custom}\n\\begin{document}'), log],
        ['a nonliteral dimension', source.replace('1.5em', '\\mySpacing'), log],
        ['an obsolete Lewis coefficient', source.replace('\\lewis{', '\\lewis[1]{'), log],
    ])('skips %s', (_reason, input, diagnostic) => {
        expect(translateLegacyChemfig(input, [], diagnostic)).toBeNull();
    });

    it('leaves user-supplied packages and multi-file inputs outside the recovery', () => {
        expect(translateLegacyChemfig(source, ['vendor/chemfig.sty'], log)).toBeNull();
        expect(translateLegacyChemfig(source, ['chapters/chemistry.tex'], log)).toBeNull();
    });
});
