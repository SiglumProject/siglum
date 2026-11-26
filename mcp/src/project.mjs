// Turns files on disk into a Siglum compile request, and results back into files.

import { readdir, readFile, stat, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep, extname, basename } from 'node:path';

/** Read as UTF-8 so the engine can scan them for package/class/bibliography dependencies. */
const TEXT_EXTENSIONS = new Set([
    '.tex', '.ltx', '.sty', '.cls', '.clo', '.cfg', '.def', '.fd', '.dtx', '.ins',
    '.bib', '.bst', '.bbl', '.bbx', '.cbx', '.lbx', '.ist', '.txt', '.csv', '.dat',
    '.lua', '.mp', '.tikz', '.pgf', '.pgf-plot', '.table', '.md',
]);

/** Build output that should never be fed back into a compile. */
const SKIPPED_EXTENSIONS = new Set([
    '.aux', '.log', '.out', '.toc', '.lof', '.lot', '.fls', '.fdb_latexmk', '.blg',
    '.synctex', '.gz', '.nav', '.snm', '.vrb', '.xdv', '.idx', '.ilg', '.ind',
    '.run.xml', '.bcf',
]);

const SKIPPED_DIRS = new Set(['node_modules', '__pycache__']);

export const LIMITS = {
    maxFiles: 2000,
    maxFileBytes: 50 * 1024 * 1024,
    maxTotalBytes: 200 * 1024 * 1024,
};

function toProjectPath(root, file) {
    return relative(root, file).split(sep).join('/');
}

function isInside(root, file) {
    return file.startsWith(root + sep);
}

async function walk(dir, out) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
            if (!SKIPPED_DIRS.has(entry.name)) await walk(full, out);
        } else if (entry.isFile()) {
            out.push(full);
        }
    }
}

/**
 * Load a LaTeX project from disk.
 *
 * @param {object} options
 * @param {string} options.mainPath - Path to the main .tex file
 * @param {string} [options.projectRoot] - Directory whose files are made available (defaults to the main file's directory)
 * @param {string} [options.outputPdf] - Output PDF, excluded from inputs if it lives in the project
 * @returns {Promise<{root: string, mainFile: string, source: string, files: Array<{path: string, text?: string, base64?: string}>, skipped: string[]}>}
 */
export async function loadProject({ mainPath, projectRoot, outputPdf }) {
    const main = resolve(mainPath);
    const root = resolve(projectRoot || dirname(main));
    if (!isInside(root, main)) {
        throw new Error(`Main file ${main} is not inside project root ${root}`);
    }
    const source = await readFile(main, 'utf8');
    const output = outputPdf ? resolve(outputPdf) : null;

    const candidates = [];
    await walk(root, candidates);

    const files = [];
    const skipped = [];
    let totalBytes = 0;
    for (const file of candidates.sort()) {
        const path = toProjectPath(root, file);
        const ext = extname(file).toLowerCase();
        if (file === main || file === output) continue;
        if (SKIPPED_EXTENSIONS.has(ext) || file.endsWith('.synctex.gz') || file.endsWith('.run.xml')) continue;
        // A previous build of the main document is output, not input.
        if (ext === '.pdf' && basename(file, ext) === basename(main, extname(main)) && dirname(file) === dirname(main)) continue;

        const { size } = await stat(file);
        if (size > LIMITS.maxFileBytes || totalBytes + size > LIMITS.maxTotalBytes || files.length >= LIMITS.maxFiles) {
            skipped.push(path);
            continue;
        }
        totalBytes += size;
        const bytes = await readFile(file);
        files.push(TEXT_EXTENSIONS.has(ext)
            ? { path, text: bytes.toString('utf8') }
            : { path, base64: bytes.toString('base64') });
    }

    return { root, mainFile: toProjectPath(root, main), source, files, skipped };
}

/** Default PDF location: next to the main file, like pdflatex. */
export function defaultOutputPath(mainPath) {
    const main = resolve(mainPath);
    return join(dirname(main), basename(main, extname(main)) + '.pdf');
}

export async function writeOutputs({ pdfPath, pdf, log }) {
    await mkdir(dirname(pdfPath), { recursive: true });
    const logPath = pdfPath.replace(/\.pdf$/i, '') + '.log';
    await writeFile(logPath, log || '');
    if (pdf) await writeFile(pdfPath, pdf);
    return { pdfPath: pdf ? pdfPath : null, logPath };
}

export function tail(text, lines) {
    if (!text || lines <= 0) return '';
    const all = text.split('\n');
    return all.slice(Math.max(0, all.length - lines)).join('\n');
}

const ERROR_START = /^(!\s|\S+:\d+:\s)/;
const WARNING_START = /^(LaTeX|Package|Class)\s+(\S+\s+)?Warning:|^(Overfull|Underfull) \\[hv]box/;

/**
 * Pull what an agent needs to act on out of a TeX log: the first error with
 * its `l.N` context lines (which name the offending command), and warnings
 * such as overfull boxes or "Rerun to get ... right" that do not fail a build.
 * In path mode, `root` maps the engine's virtual `/main.tex:3:` locations to
 * the file on disk.
 *
 * @param {string} log
 * @param {{root?: string, maxWarnings?: number}} [options]
 * @returns {{errorContext: string|null, warnings: string[], rerunSuggested: boolean}}
 */
export function diagnose(log, { root, maxWarnings = 20 } = {}) {
    const lines = (log || '').split('\n');
    let errorContext = null;
    const start = lines.findIndex((line) => ERROR_START.test(line));
    if (start !== -1) {
        const block = [lines[start]];
        for (let i = start + 1; i < Math.min(lines.length, start + 12); i++) {
            block.push(lines[i]);
            // TeX prints the source line split at the error point: "l.N <before>"
            // then the remainder on the next line.
            if (/^l\.\d+/.test(lines[i])) {
                if (i + 1 < lines.length && lines[i + 1].trim()) block.push(lines[i + 1]);
                break;
            }
        }
        errorContext = mapPaths(block.join('\n'), root);
    }

    const warnings = [];
    for (let i = 0; i < lines.length && warnings.length < maxWarnings; i++) {
        if (!WARNING_START.test(lines[i])) continue;
        const parts = [lines[i]];
        // Package warnings continue on lines prefixed with "(pkgname)".
        while (i + 1 < lines.length && /^\([\w-]+\)\s/.test(lines[i + 1])) {
            parts.push(lines[++i].replace(/^\([\w-]+\)\s+/, ''));
        }
        warnings.push(mapPaths(parts.join(' ').replace(/\s+/g, ' ').trim(), root));
    }
    const rerunSuggested = warnings.some((w) => /Rerun to get|may have changed|Rerun LaTeX/i.test(w));
    return { errorContext, warnings, rerunSuggested };
}

/** Rewrite `/rel/path.tex:12:` engine locations to absolute paths under `root`. */
export function mapPaths(text, root) {
    if (!text || !root) return text;
    return text.replace(/(^|\s)\/([^\s:]+\.(?:tex|sty|cls|bib|bbl|ltx|def)):(\d+):/g,
        (_, lead, rel, line) => `${lead}${join(root, rel)}:${line}:`);
}
