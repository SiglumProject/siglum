const pinnedVersion = /^Package:\s+chemfig\s+2025\/10\/30\s+v1\.71\b/m;
const unknownSetter = /Undefined\s+control\s+s\s*equence\.\s*(?:<recently read>\s*\\setatomsep\b|l\.\d+\s+[^\r\n]*\\setatomsep[ \t]*$)/m;
const literalSetter = /^([ \t]*(?:\\(?:tiny|scriptsize|footnotesize|small|normalsize|large|Large|LARGE|huge|Huge)[ \t]*)?)\\setatomsep[ \t]*\{([ \t]*(?:\d+(?:\.\d*)?|\.\d+)[ \t]*(?:pt|pc|in|bp|cm|mm|dd|cc|sp|ex|em)[ \t]*)\}([ \t]*(?:%[^\r\n]*)?)$/m;
const userDefinitions = /\\(?:newcommand|renewcommand|providecommand|DeclareRobustCommand|NewDocumentCommand|RenewDocumentCommand|ProvideDocumentCommand|[gex]?def|let)\*?\s*\{?\s*\\(?:setatomsep|lewis|Lewis)\b/;

export function translateLegacyChemfig(source, projectPaths, log) {
    if (!log || !pinnedVersion.test(log) || !unknownSetter.test(log)) return null;
    if (projectPaths.length > 0) return null;
    const bodyStart = source.search(/^[ \t]*\\begin\s*\{document\}/m);
    if (bodyStart < 0) return null;

    const preamble = source.slice(0, bodyStart);
    const body = source.slice(bodyStart);
    const usesChemfig = [...preamble.matchAll(/^[ \t]*\\usepackage[ \t]*\{([^{}]+)\}[ \t]*(?:%[^\r\n]*)?$/gm)]
        .some(([, packages]) => packages.split(',').some(name => name.trim() === 'chemfig'));
    if (!usesChemfig || userDefinitions.test(source) || /\\begin\s*\{(?:filecontents\*?|verbatim\*?|Verbatim|lstlisting|minted|comment)\}/.test(source)) return null;
    if (/\\PassOptionsToPackage\s*\{[^{}]*\}\s*\{[^{}]*\bchemfig\b[^{}]*\}/.test(preamble)) return null;
    const bodyCode = body.replace(/(^|[^\\])%[^\r\n]*/g, '$1');
    if ([...source.matchAll(/\\setatomsep\b/g)].length !== 1 || /\\(?:lewis|Lewis)\s*\[/.test(bodyCode)) return null;

    if (!literalSetter.test(body)) return null;
    const hasLewisInput = /\\input\s*\{?\s*chemfig-lewis\b/.test(source);
    const needsLewis = !hasLewisInput && /\\(?:lewis|Lewis)\s*\{/.test(bodyCode);
    const lewis = needsLewis ? '\\ifdefined\\lewis\\else\\ifdefined\\Lewis\\else\\input{chemfig-lewis.tex}\\fi\\fi' : '';
    return preamble + lewis + body.replace(literalSetter, '$1\\setchemfig{atom sep=$2}$3');
}
