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
    const rel = relative(root, file);
    return rel !== '' && !rel.startsWith('..') && !resolve(root, rel).startsWith('..');
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
