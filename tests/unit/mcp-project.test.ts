import { describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadProject, defaultOutputPath, tail } from '../../mcp/src/project.mjs'

async function fixture() {
 const root = await mkdtemp(join(tmpdir(), 'siglum-mcp-project-'))
 await mkdir(join(root, 'chapters'))
 await mkdir(join(root, '.git'))
 await mkdir(join(root, 'node_modules'))
 await writeFile(join(root, 'main.tex'), '\\documentclass{article}\\begin{document}\\input{chapters/a}\\end{document}')
 await writeFile(join(root, 'chapters', 'a.tex'), 'Chapter A')
 await writeFile(join(root, 'refs.bib'), '@misc{x, title={X}}')
 await writeFile(join(root, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
 for (const name of ['main.aux', 'main.log', 'main.pdf', 'main.synctex.gz']) await writeFile(join(root, name), 'stale')
 await writeFile(join(root, '.git', 'HEAD'), 'ref')
 await writeFile(join(root, 'node_modules', 'x.js'), '')
 return root
}

describe('MCP project loading', () => {
 it('sends siblings to TeX and leaves out build output, hidden and dependency directories', async () => {
  const root = await fixture()
  const project = await loadProject({ mainPath: join(root, 'main.tex') })
  expect(project.mainFile).toBe('main.tex')
  expect(project.source).toContain('\\input{chapters/a}')
  const byPath = Object.fromEntries(project.files.map((file: { path: string }) => [file.path, file]))
  expect(Object.keys(byPath).sort()).toEqual(['chapters/a.tex', 'logo.png', 'refs.bib'])
  expect(byPath['chapters/a.tex'].text).toBe('Chapter A')
  expect(byPath['logo.png'].base64).toBe(Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'))
 })

 it('keeps a nested main file at its project-relative path', async () => {
  const root = await fixture()
  const project = await loadProject({ mainPath: join(root, 'chapters', 'a.tex'), projectRoot: root })
  expect(project.mainFile).toBe('chapters/a.tex')
  expect(project.files.map((file: { path: string }) => file.path)).toContain('main.tex')
  expect(project.files.map((file: { path: string }) => file.path)).not.toContain('chapters/a.tex')
 })

 it('rejects a main file outside the project root', async () => {
  const root = await fixture()
  await expect(loadProject({ mainPath: join(root, 'main.tex'), projectRoot: join(root, 'chapters') }))
   .rejects.toThrow(/not inside project root/)
  await expect(loadProject({ mainPath: join(root, 'main.tex'), projectRoot: root + 'x' }))
   .rejects.toThrow(/not inside project root/)
 })

 it('writes the PDF next to the source and trims logs from the end', () => {
  expect(defaultOutputPath('/a/b/thesis.tex')).toBe('/a/b/thesis.pdf')
  expect(tail('1\n2\n3\n4', 2)).toBe('3\n4')
  expect(tail('1\n2', 0)).toBe('')
 })
})
