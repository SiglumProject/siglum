// End-to-end check through the real MCP protocol: spawn the server over stdio,
// list its tools, compile a multi-file project from disk and a source snippet,
// and confirm a failing document reports a TeX error rather than a PDF.
// Needs network on first run (hosted runtime) and a Chromium-based browser.
//
//   node test/smoke.mjs [path/to/main.tex]

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const HERE = dirname(fileURLToPath(import.meta.url));
const main = resolve(process.argv[2] || join(HERE, 'fixtures/project/main.tex'));
const out = await mkdtemp(join(tmpdir(), 'siglum-mcp-smoke-'));

const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(HERE, '..', 'src', 'server.mjs')],
    stderr: 'inherit',
});
const client = new Client({ name: 'siglum-smoke', version: '0.0.0' });
await client.connect(transport);

try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ['clear_cache', 'compile_latex']);

    const project = await client.callTool({
        name: 'compile_latex',
        arguments: { path: main, outputPath: join(out, 'project.pdf') },
    });
    console.log(project.content[0].text.split('\n').slice(0, 2).join('\n'));
    assert.equal(project.structuredContent.success, true, project.content[0].text);
    const pdf = await readFile(project.structuredContent.pdfPath);
    assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');

    const snippet = await client.callTool({
        name: 'compile_latex',
        arguments: { source: '\\documentclass{article}\\begin{document}Hello from MCP.\\end{document}' },
    });
    assert.equal(snippet.structuredContent.success, true, snippet.content[0].text);

    const broken = await client.callTool({
        name: 'compile_latex',
        arguments: { source: '\\documentclass{article}\n\\begin{document}\n\\nosuchmacro\n\\end{document}\n', logLines: 5 },
    });
    assert.equal(broken.isError, true);
    assert.equal(broken.structuredContent.pdfPath, null);
    assert.match(broken.structuredContent.error, /Undefined control sequence/);
    // The error context must name the offending command, not just the message.
    assert.match(broken.structuredContent.errorContext, /l\.3 \\nosuchmacro/);
    assert.match(broken.content[0].text, /\\nosuchmacro/);
    assert.equal(typeof broken.structuredContent.logTail, 'string');
    console.log(`Broken document reported: ${broken.structuredContent.error}`);

    // In path mode, error locations point at the file on disk.
    const brokenPath = join(out, 'broken.tex');
    await writeFile(brokenPath, '\\documentclass{article}\n\\begin{document}\n\\nosuchmacro\n\\end{document}\n');
    const brokenFile = await client.callTool({ name: 'compile_latex', arguments: { path: brokenPath } });
    assert.equal(brokenFile.isError, true);
    assert.ok(brokenFile.structuredContent.errorContext.startsWith(`${brokenPath}:3:`), brokenFile.structuredContent.errorContext);

    console.log(`OK. PDF: ${project.structuredContent.pdfPath}`);
} finally {
    await client.close();
}
