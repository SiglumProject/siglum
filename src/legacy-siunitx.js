const version = /^Package:\s+siunitx\s+2025-07-09\s+v3\.4\.14\b/m;
const unknownPer = /LaTeX Error:\s+Unknown\s+op\s*tion\s+'per'\s+for\s+package\s+siunitx\b/;
const packageLine = /^([ \t]*\\(?:usepackage|RequirePackage)[ \t]*\[)([A-Za-z0-9=,.\- \t]*)(\][ \t]*\{[ \t]*siunitx[ \t]*\}[ \t]*(?:%[^\r\n]*)?)$/gm;
const slashOption = /^([ \t]*)per[ \t]*=[ \t]*slash([ \t]*)$/;
const vendoredPackage = /(?:^|\/)siunitx(?:-v2|-version-1)?\.(?:sty|cfg)$/i;

// A candidate one-shot retry for literal package options. Keep the source on
// disk unchanged. A compiled source with explicit version pinning or project
// overrides should continue using the options it declared.
export function translateLegacySiunitxOptions(source, projectPaths, log) {
    if (!log || !version.test(log) || !unknownPer.test(log)
        || projectPaths.some(path => vendoredPackage.test(path))) return null;

    const documentStart = source.search(/^[ \t]*\\begin\s*\{document\}/m);
    if (documentStart < 0) return null;
    const preamble = source.slice(0, documentStart);
    if (/\\begin\s*\{(?:filecontents\*?|verbatim\*?|Verbatim|lstlisting|minted|comment)\}/.test(preamble)) return null;
    const matches = [...preamble.matchAll(packageLine)]
        .filter(([, , options]) => options.split(',').some(option => slashOption.test(option)));
    if (matches.length !== 1) return null;

    const [line, open, options, close] = matches[0];
    const normalized = options.split(',').map(option => option.replace(slashOption, '$1per-mode=symbol$2')).join(',');
    return source.slice(0, matches[0].index) + open + normalized + close
        + source.slice(matches[0].index + line.length);
}
