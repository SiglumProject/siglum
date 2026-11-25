import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadProject, defaultOutputPath, tail } from '../src/project.mjs';

async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'siglum-mcp-project-'));
    await mkdir(join(root, 'chapters'));
    await mkdir(join(root, '.git'));
    await mkdir(join(root, 'node_modules'));
    await writeFile(join(root, 'main.tex'), '\\documentclass{article}\\begin{document}\\input{chapters/a}\\end{document}');
    await writeFile(join(root, 'chapters', 'a.tex'), 'Chapter A');
    await writeFile(join(root, 'refs.bib'), '@misc{x, title={X}}');
    await writeFile(join(root, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await writeFile(join(root, 'main.aux'), 'stale');
    await writeFile(join(root, 'main.log'), 'stale');
    await writeFile(join(root, 'main.pdf'), '%PDF-old');
    await writeFile(join(root, '.git', 'HEAD'), 'ref');
    await writeFile(join(root, 'node_modules', 'x.js'), '');
    return root;
}

test('loads siblings as project files and skips build output and hidden dirs', async () => {
    const root = await fixture();
    const project = await loadProject({ mainPath: join(root, 'main.tex') });
    assert.equal(project.mainFile, 'main.tex');
    assert.match(project.source, /\\input\{chapters\/a\}/);
    const byPath = Object.fromEntries(project.files.map((f) => [f.path, f]));
    assert.deepEqual(Object.keys(byPath).sort(), ['chapters/a.tex', 'logo.png', 'refs.bib']);
    assert.equal(byPath['chapters/a.tex'].text, 'Chapter A');
    assert.equal(byPath['logo.png'].base64, Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'));
});

test('a nested main file keeps its project-relative path', async () => {
    const root = await fixture();
    const project = await loadProject({ mainPath: join(root, 'chapters', 'a.tex'), projectRoot: root });
    assert.equal(project.mainFile, 'chapters/a.tex');
    assert.ok(project.files.some((f) => f.path === 'main.tex'));
    assert.ok(!project.files.some((f) => f.path === 'chapters/a.tex'));
});

test('rejects a main file outside the project root', async () => {
    const root = await fixture();
    await assert.rejects(
        loadProject({ mainPath: join(root, 'main.tex'), projectRoot: join(root, 'chapters') }),
        /not inside project root/,
    );
});

test('defaultOutputPath and tail', () => {
    assert.equal(defaultOutputPath('/a/b/thesis.tex'), '/a/b/thesis.pdf');
    assert.equal(tail('1\n2\n3\n4', 2), '3\n4');
    assert.equal(tail('1\n2', 0), '');
});
