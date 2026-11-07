const classVersion = /^Document Class:\s+(scrartcl|scrbook|scrreprt|scrlttr2)\s+2026\/02\/02\s+v3\.49\.2\b/m;
const oldFontError = /Cl\s*ass\s+(scrartcl|scrbook|scrreprt|scrlttr2)\s+Error:\s+u\s*n\s*d\s*e\s*f\s*i\s*n\s*e\s*d\s+old\s+font\s+command\s+[\x60']\\(?:rm|sf|tt|bf|it|sl|sc|sfb)'/;
const classLine = /^([ \t]*)\\documentclass[ \t]*(?:\[([A-Za-z0-9=,.\- \t]*)\][ \t]*)?\{(scrartcl|scrbook|scrreprt|scrlttr2)\}[ \t]*(?:%[^\r\n]*)?$/gm;
const classOverride = /(?:^|\/)(?:scrartcl|scrbook|scrreprt|scrlttr2)\.cls$/i;

export function enableLegacyKomaFonts(source, projectPaths, log) {
    const className = log?.match(oldFontError)?.[1];
    if (!className || log.match(classVersion)?.[1] !== className
        || projectPaths.some(path => classOverride.test(path))) return null;

    const documentStart = source.search(/^[ \t]*\\begin\s*\{document\}/m);
    if (documentStart < 0) return null;
    const preamble = source.slice(0, documentStart);
    if (/\\begin\s*\{(?:filecontents\*?|verbatim\*?|Verbatim|lstlisting|minted|comment)\}/.test(preamble)) return null;
    if (/\\PassOptionsToClass\b/.test(preamble)) return null;

    const classes = [...preamble.matchAll(classLine)];
    if (classes.length !== 1 || classes[0][3] !== className) return null;
    const [, indent, options] = classes[0];
    if (options?.split(',').some(option => /^\s*(?:version\s*=|enabledeprecatedfontcommands\s*$)/.test(option))) return null;
    const insertAt = classes[0].index + indent.length;
    return source.slice(0, insertAt) + '\\PassOptionsToClass{enabledeprecatedfontcommands}{' + className + '}'
        + source.slice(insertAt);
}
