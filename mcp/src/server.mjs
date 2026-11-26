#!/usr/bin/env node
// MCP server (stdio) exposing the Siglum LaTeX compiler to agents.
// stdout is the protocol channel: all diagnostics go to stderr.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, isAbsolute } from 'node:path';
import { z } from 'zod';

import { HeadlessSiglum } from './headless.mjs';
import { loadProject, defaultOutputPath, writeOutputs, tail, diagnose, mapPaths } from './project.mjs';

const siglum = new HeadlessSiglum();

const server = new McpServer({ name: 'siglum', version: '0.1.0' }, {
    instructions:
        'Compiles LaTeX to PDF with the Siglum engine (TeX Live 2026, pdfLaTeX/XeLaTeX, packages fetched on demand). ' +
        'Prefer compile_latex with `path` for documents on disk: sibling files (images, .bib, \\input chapters) are included ' +
        'and the PDF and full log are written next to the main file. Use `source` for quick snippets. ' +
        'The first compile downloads the engine runtime and can take a minute; later ones are cached.',
});

function absolute(path) {
    return isAbsolute(path) ? path : resolve(process.cwd(), path);
}

server.registerTool('compile_latex', {
    title: 'Compile LaTeX',
    description:
        'Compile a LaTeX document to PDF. Pass `path` to compile a .tex file on disk (its directory, or `projectRoot`, ' +
        'supplies \\input files, images and bibliographies), or pass `source` with optional inline `files`. ' +
        'Returns `success`; on failure `error` plus `errorContext` (the TeX error with its `l.N` source line, naming ' +
        'the offending command); `warnings` (overfull boxes, undefined references, rerun hints); the PDF and log paths; ' +
        'and `logTail`, the last `logLines` lines of the TeX log. The same fields appear in the text result.',
    inputSchema: {
        path: z.string().optional().describe('Main .tex file on disk. Mutually exclusive with `source`.'),
        projectRoot: z.string().optional().describe('Project directory made available to TeX. Defaults to the main file\'s directory.'),
        source: z.string().optional().describe('LaTeX source of the main document, when not compiling from disk.'),
        files: z.record(z.string(), z.string()).optional()
            .describe('Extra text files for `source` mode, keyed by project-relative path (e.g. {"refs.bib": "..."}).'),
        engine: z.enum(['auto', 'pdflatex', 'xelatex']).default('auto').describe('TeX engine. `auto` detects fontspec etc.'),
        outputPath: z.string().optional()
            .describe('Where to write the PDF. Defaults to <main>.pdf next to `path`, or a temp file in `source` mode.'),
        logLines: z.number().int().min(0).max(2000).default(40).describe('How many trailing TeX log lines to return.'),
    },
    outputSchema: {
        success: z.boolean(),
        error: z.string().nullable(),
        pdfPath: z.string().nullable(),
        pdfBytes: z.number(),
        logPath: z.string(),
        elapsedMs: z.number(),
        skippedFiles: z.array(z.string()),
        errorContext: z.string().nullable(),
        warnings: z.array(z.string()),
        rerunSuggested: z.boolean(),
        logTail: z.string(),
    },
}, async ({ path, projectRoot, source, files, engine, outputPath, logLines }) => {
    if (!!path === (source !== undefined)) {
        return { isError: true, content: [{ type: 'text', text: 'Provide exactly one of `path` or `source`.' }] };
    }

    let request;
    let pdfPath;
    let skipped = [];
    let root;
    if (path) {
        const main = absolute(path);
        pdfPath = outputPath ? absolute(outputPath) : defaultOutputPath(main);
        const project = await loadProject({
            mainPath: main,
            projectRoot: projectRoot ? absolute(projectRoot) : undefined,
            outputPdf: pdfPath,
        });
        skipped = project.skipped;
        root = project.root;
        request = { source: project.source, mainFile: project.mainFile, engine, files: project.files };
    } else {
        pdfPath = outputPath ? absolute(outputPath) : join(await mkdtemp(join(tmpdir(), 'siglum-')), 'document.pdf');
        request = {
            source,
            engine,
            files: Object.entries(files || {}).map(([p, text]) => ({ path: p, text })),
        };
    }

    let result;
    try {
        result = await siglum.compile(request);
    } catch (error) {
        return { isError: true, content: [{ type: 'text', text: `Siglum engine failure: ${error.message}` }] };
    }

    const written = await writeOutputs({ pdfPath, pdf: result.pdf, log: result.log });
    const { errorContext, warnings, rerunSuggested } = diagnose(result.log, { root });
    const logTail = tail(result.log, logLines);
    const structured = {
        success: result.success,
        error: mapPaths(result.error, root),
        pdfPath: written.pdfPath,
        pdfBytes: result.pdf ? result.pdf.length : 0,
        logPath: written.logPath,
        elapsedMs: result.elapsedMs,
        skippedFiles: skipped,
        errorContext: result.success ? null : errorContext,
        warnings,
        rerunSuggested,
        logTail,
    };
    const summary = result.success
        ? `Compiled successfully in ${result.elapsedMs} ms → ${written.pdfPath} (${structured.pdfBytes} bytes).`
        : `Compilation failed: ${structured.error || 'unknown error'}`;
    // Clients may show either the text or the structured result, so both carry
    // the same information.
    const text = [
        summary,
        structured.errorContext && structured.errorContext !== structured.error
            ? `--- error context ---\n${structured.errorContext}` : null,
        warnings.length ? `--- warnings (${warnings.length}) ---\n${warnings.join('\n')}` : null,
        rerunSuggested ? 'Note: TeX still asked for a rerun after the final pass; cross-references or outlines may be stale.' : null,
        `Full log: ${written.logPath}`,
        skipped.length ? `Skipped (size/count limits): ${skipped.join(', ')}` : null,
        logTail ? `--- last ${logLines} log lines ---\n${logTail}` : null,
    ].filter(Boolean).join('\n');

    return { isError: !result.success, structuredContent: structured, content: [{ type: 'text', text }] };
});

server.registerTool('clear_cache', {
    title: 'Clear Siglum caches',
    description: 'Delete cached TeX packages and compiled PDFs. Use only if a package seems stale or corrupted.',
    inputSchema: {},
}, async () => {
    await siglum.clearCache();
    return { content: [{ type: 'text', text: 'Siglum caches cleared.' }] };
});

async function shutdown() {
    await siglum.close();
    process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.stdin.on('close', shutdown);

await server.connect(new StdioServerTransport());
if (process.env.SIGLUM_MCP_WARM) siglum.start().catch((e) => process.stderr.write(`[siglum-mcp] warm-up failed: ${e.message}\n`));
