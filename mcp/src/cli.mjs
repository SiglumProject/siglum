#!/usr/bin/env node
// siglum-compile main.tex [-o out.pdf] [--engine pdflatex|xelatex|auto] [--root dir]
// Same headless engine as the MCP server, for scripts and agents without MCP.

import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { HeadlessSiglum } from './headless.mjs';
import { loadProject, defaultOutputPath, writeOutputs, diagnose, mapPaths } from './project.mjs';

const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
        output: { type: 'string', short: 'o' },
        engine: { type: 'string', default: 'auto' },
        root: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
    },
});

if (values.help || positionals.length !== 1) {
    process.stderr.write('Usage: siglum-compile <main.tex> [-o out.pdf] [--engine auto|pdflatex|xelatex] [--root dir]\n');
    process.exit(values.help ? 0 : 2);
}

const main = resolve(positionals[0]);
const pdfPath = values.output ? resolve(values.output) : defaultOutputPath(main);
const project = await loadProject({ mainPath: main, projectRoot: values.root, outputPdf: pdfPath });
const siglum = new HeadlessSiglum();
try {
    const result = await siglum.compile({
        source: project.source,
        mainFile: project.mainFile,
        engine: values.engine,
        files: project.files,
    });
    const written = await writeOutputs({ pdfPath, pdf: result.pdf, log: result.log });
    if (result.success) {
        process.stdout.write(`${written.pdfPath}\n`);
    } else {
        const { errorContext } = diagnose(result.log, { root: project.root });
        process.stderr.write(`${errorContext || mapPaths(result.error, project.root) || 'Compilation failed'}\nLog: ${written.logPath}\n`);
        process.exitCode = 1;
    }
} finally {
    await siglum.close();
}
