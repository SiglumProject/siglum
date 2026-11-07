const currentTkz = /Package:\s+tkz-euclide\s+2026\/01\/25\s+5\.13c\b/;
const tkzFct = /Package:\s+tkz-fct\s+2022\/01\/27\s+1\.7c\b/;
const currentTkzBase = /Package:\s+tkz-base\s+2024\/01\/16\s+4\.21c\b/;
const legacySelector = /^[ \t]*\\usetkzobj\s*\{all\}[ \t]*$/m;
const ownSelector = /\\(?:newcommand|renewcommand|providecommand|NewDocumentCommand|RenewDocumentCommand|ProvideDocumentCommand|[gex]?def|let)\*?\s*\{?\s*\\usetkzobj\b/;
const localTkz = /(?:^|\/)tkz-(?:(?:euclide|base)(?:\/|\.sty$)|(?:obj-|tools-|lib-symbols)[^/]*\.tex$)/;
const oldTkzCommand = /Undefined control\s+s\s*equence\.?\s*(?:<recently read>\s*|l\.\d+\s*)\\(?:usetkzobj|tkzAxeXY|tkzTangent)\b/;
const missingLegacyObject = /^(?:!|[^\r\n]*:\d+:)[ \t]*I\s*can't\s*find\s*file\s*[\x60']([a-z.\r\n-]{1,64})'[\s\S]{0,240}\nl\.\d+[ \t]+\\usetkzobj\s*\{all\}/m;
// A file-line prefix can leave only the first letter of Error on the line.
const wrappedLegacyRadius = /^(?:!|[^\r\n]*:\d+:)[ \t]*Package pgf (?:Error[ \t]*\r?\n[ \t]*:|E\r?\nrror:)[ \t]*No shape named [\x60'](?:1|\d+(?:\.\d+)?(?:cm|mm|pt))' is known\.[\s\S]{0,320}\nl\.\d+[^\r\n]*Circle\s*\[[^\r\n]*\bR\b/m;
const missingLegacyMacro = /^(?:!|[^\r\n]*:\d+:)[ \t]*Undefined control[ \t]+([a-z]+(?:\r?\n[a-z]+)?)\.[ \t]*\r?\n(<recently read>|<argument>)[ \t]*(\\tkzAxeXY|\\FPpi)\b[ \t]*$/m;

export function legacyTkzSource(source, projectPaths) {
    if (!source.includes('\\usetkzobj') || projectPaths.some(path => localTkz.test(path))) return null;
    // The legacy selector is a statement in the document, not a quoted example.
    const code = source
        .replace(/\\begin\{(verbatim\*?|Verbatim|lstlisting|minted|comment)\}[\s\S]*?\\end\{\1\}/g, '')
        .replace(/(^|[^\\])%[^\n]*/g, '$1');
    if (!legacySelector.test(code) || ownSelector.test(code)) return null;

    const packages = [...code.matchAll(/\\(?:usepackage|RequirePackage)\s*(?:\[([^\]]*)\]\s*)?\{([^{}]+)\}/g)]
        .filter(([, , names]) => names.split(',').some(name => /^tkz-(?:euclide|base)$/.test(name.trim())));
    if (!packages.some(([, , names]) => names.split(',').some(name => name.trim() === 'tkz-euclide'))
        || packages.some(([, options]) => options?.trim())) return null;
    if (/\\PassOptionsToPackage\s*\{[^{}]+\}\s*\{[^{}]*tkz-(?:euclide|base)\b/.test(code)) return null;
    return code;
}

export function shouldRetryLegacyTkz(code, log) {
    if (!code || !log || !currentTkz.test(log)) return false;
    if (oldTkzCommand.test(log) || /Package PGF Math Error:[\s\S]{0,180}\dcm\s*cm/.test(log)
        || /Package pgfkeys Error:[\s\S]{0,160}\/tikz\/orthogonal through\b/.test(log)) return true;

    // tkz-fct loads tkz-base's real selector before modern tkz-euclide. The
    // selector then requests the removed legacy object from the modern tree.
    if (tkzFct.test(log) && currentTkzBase.test(log)
        && log.match(missingLegacyObject)?.[1].replace(/\r?\n/g, '') === 'tkz-obj-angles.tex') return true;

    const macro = log.match(missingLegacyMacro);
    if (macro?.[1].replace(/\r?\n/g, '') === 'sequence') {
        if (macro[2] === '<recently read>' && macro[3] === '\\tkzAxeXY' && /\\tkzAxeXY\b/.test(code)) return true;
        // The historical tkz-base loaded fp, which defines FPpi.
        if (macro[2] === '<argument>' && macro[3] === '\\FPpi' && /\\tkzDefPoint\b[^\r\n]*\\FPpi\b/.test(code)
            && !/\\(?:usepackage|RequirePackage)\s*(?:\[[^\]]*\]\s*)?\{[^{}]*\bfp\b/.test(code)) return true;
    }

    if (wrappedLegacyRadius.test(log) && /\\tkzDrawCircle\s*\[[^\]]*\bR\b/.test(code)) return true;

    const oldRadius = /\\tkz(?:DrawCircle|InterLC|InterCC)\s*\[[^\]]*\bR\b/.test(code);
    return oldRadius && (/Package pgf Error:[\s\S]{0,70}No shape named [`']\d+' is known/.test(log)
        || /Missing number, treated as zero\.[\s\S]{0,120}\\pgfmath@acos/.test(log));
}

const historicalFctPath = '/texlive/texmf-dist/tex/latex/tkz-fct/tkz-fct.sty';
const localFct = /(?:^|\/)tkz-fct(?:\/|\.sty$)/;
const plainFctImport = /^[ \t]*\\(?:usepackage|RequirePackage)[ \t]*\{tkz-fct\}[ \t]*$/m;
const plainEuclideImport = /^[ \t]*\\(?:usepackage|RequirePackage)[ \t]*\{tkz-euclide\}[ \t]*$/m;
const fctOrderError = /^\/texlive\/texmf-dist\/tex\/latex\/tkz-fct\/tkz-fct\.sty:22:[ \t]*Package tkz-fct Error:([^\r\n]*(?:\r?\n[^\r\n]+)?)/m;

export function shouldRetryLegacyTkzFct(code, log, projectPaths) {
    if (!code || !log || !tkzFct.test(log) || !currentTkz.test(log)
        || projectPaths.some(path => localFct.test(path))) return false;
    const euclideImport = code.search(plainEuclideImport);
    const fctImport = code.search(plainFctImport);
    if (euclideImport < 0 || fctImport <= euclideImport) return false;
    if (/\\PassOptionsToPackage\s*\{[^{}]+\}\s*\{[^{}]*tkz-fct\b/.test(code)) return false;
    const message = log.match(fctOrderError)?.[1].replace(/\r?\n/g, '').trim();
    if (message !== 'tkz-base must be loaded before tkz-euclide.') return false;

    // A second plain import cannot authorize changing an earlier explicit
    // package request. Those requests may contain options or a minimum date.
    const names = [...code.matchAll(/\\(?:usepackage|RequirePackage)\s*(?:\[[^\]]*\]\s*)?\{([^{}]+)\}/g)]
        .flatMap(([, list]) => list.split(',').map(name => name.trim()));
    return names.filter(name => name === 'tkz-euclide').length === 1
        && names.filter(name => name === 'tkz-fct').length === 1;
}

let filesPromise;

export function loadLegacyTkzFiles(includeFct = false) {
    filesPromise ??= (async () => {
        const response = await fetch(new URL('./legacy-tkz-2018.bin', import.meta.url));
        if (!response.ok || !response.body) throw new Error(`Legacy tkz package bundle unavailable (${response.status})`);
        const decoded = response.body.pipeThrough(new DecompressionStream('gzip'));
        const entries = await new Response(decoded).json();
        return entries.map(([path, base64]) => [path, Uint8Array.from(atob(base64), byte => byte.charCodeAt(0))]);
    })().catch(error => {
        filesPromise = null;
        throw error;
    });
    return filesPromise.then(files => {
        if (!includeFct) return files.filter(([path]) => path !== historicalFctPath);
        if (!files.some(([path]) => path === historicalFctPath)) {
            throw new Error('Historical tkz-fct is missing from the legacy package bundle.');
        }
        return files;
    });
}
