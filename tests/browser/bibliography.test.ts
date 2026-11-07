import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { SiglumCompiler } from '../../src/compiler.js'
let compiler: SiglumCompiler
const logs: string[] = []
const bib = '@article{chris2026, author={Chris Example}, title={Verified bibliography \\typeout{BIBLIOGRAPHY-TYPESET}}, journal={Test Journal}, year={2026}}'
const source = '\\documentclass{article}\n\\begin{document}\nReference: \\cite{chris2026}.\n\\bibliographystyle{plain}\n\\bibliography{references}\n\\end{document}'
beforeAll(async () => {
 const base = window.location.origin + '/dist'
 compiler = new SiglumCompiler({ wasmUrl: base+'/busytex.wasm', jsUrl: base+'/busytex.js', bundlesUrl: base+'/bundles', enableCtan: true, ctanProxyUrl: window.location.origin+'/fixtures', xzwasmUrl: window.location.origin+'/fixtures/xzwasm.js', enableLazyFS: false, onLog: message => logs.push(message) })
 await compiler.init()
})
afterAll(() => compiler?.terminate())
describe('real BibTeX pipeline', () => {
 for (const engine of ['pdflatex','xelatex'] as const) it(`typesets .bib citations with ${engine}`, async () => {
  const result = await compiler.compile(source, {engine, mainFile:'main.tex', additionalFiles:{'references.bib':bib}, useCache:false})
  expect(result.success, result.error+'\n'+result.log).toBe(true)
  expect(result.log).toContain('BIBLIOGRAPHY-TYPESET')
  expect(result.log).not.toMatch(/Citation .*undefined|There were undefined references/)
  expect(logs).toContain('BibTeX completed.')
 })
 it('preserves nested cwd and chapter aux files across BibTeX and reruns', async () => {
  const nested = source.replace('Reference: \\cite{chris2026}.','\\include{chapters/intro}').replace('{references}','{../references}')
  const result = await compiler.compile(nested,{mainFile:'revision/main.tex', additionalFiles:{'references.bib':bib,'revision/chapters/intro.tex':'Reference: \\cite{chris2026}.'},useCache:false})
  expect(result.success, result.error+'\n'+result.log).toBe(true)
  expect(result.log).toContain('BIBLIOGRAPHY-TYPESET')
  expect(result.log).not.toMatch(/Citation .*undefined|There were undefined references/)
 })
 it('rebuilds changed bibliography data instead of reusing a stale bbl', async () => {
  const result = await compiler.compile(source,{mainFile:'main.tex',additionalFiles:{'references.bib':bib.replace('BIBLIOGRAPHY-TYPESET','BIBLIOGRAPHY-UPDATED')},useCache:false})
  expect(result.success,result.error+'\n'+result.log).toBe(true)
  expect(result.log).toContain('BIBLIOGRAPHY-UPDATED')
  expect(result.log).not.toContain('BIBLIOGRAPHY-TYPESET')
 })
 it('typesets a freshly generated bibliography when BibTeX reports only warnings', async () => {
  const warningBib = bib.replace(', journal={Test Journal}', '')
  const result = await compiler.compile(source, {
   mainFile: 'warnings.tex', additionalFiles: { 'references.bib': warningBib }, useCache: false,
  })
  expect(result.success, result.error + '\n' + result.log).toBe(true)
  expect(result.log).toContain('BIBLIOGRAPHY-TYPESET')
  expect(result.log).toContain('Warning--empty journal')
  expect(result.log).not.toMatch(/Citation .*undefined|There were undefined references/)
 })
 it('supports biblatex with the BibTeX backend', async () => {
  const source='\\documentclass{article}\n\\usepackage[backend=bibtex]{biblatex}\n\\addbibresource{references.bib}\n\\begin{document}\nReference: \\cite{chris2026}.\n\\printbibliography\n\\end{document}'
  const result=await compiler.compile(source,{mainFile:'biblatex.tex',additionalFiles:{'references.bib':bib},useCache:false})
  expect(result.success,result.error+'\n'+result.log).toBe(true)
  expect(result.log).toContain('BIBLIOGRAPHY-TYPESET')
  expect(result.log).not.toMatch(/Citation .*undefined|Empty bibliography/)
 })
 it('fails clearly when a document needs the unbundled Biber backend', async () => {
  const source='\\documentclass{article}\n\\usepackage{biblatex}\n\\addbibresource{references.bib}\n\\begin{document}\nReference: \\cite{chris2026}.\n\\printbibliography\n\\end{document}'
  const result=await compiler.compile(source,{mainFile:'biber.tex',additionalFiles:{'references.bib':bib},useCache:false})
  expect(result.success).toBe(false)
  expect(result.error).toContain('requires Biber')
 })
 it('returns an error for missing bib files instead of a successful unresolved PDF', async () => {
  const result = await compiler.compile(source.replace('{references}','{missing-library}'), {
   mainFile: 'missing.tex', additionalFiles: {
    'missing.bbl': '\\begin{thebibliography}{1}\\bibitem{chris2026} Stale entry.\\end{thebibliography}',
   }, useCache: false,
  })
  expect(result.success).toBe(false)
  expect(result.error).toContain('BibTeX failed')
  expect(result.log).toContain('missing-library')
 })
})

it('builds a nested MakeIndex index again when aux data changes its page numbers', async () => {
 const source = String.raw`\documentclass{article}
\usepackage{makeidx}
\makeindex
\newcommand{\indexcheckpage}[1]{\typeout{INDEX-PAGE=#1}#1}
\makeatletter
\begin{document}
\ifdefined\siglumnewpage
 First page.\newpage
\fi
\immediate\write\@auxout{\string\gdef\string\siglumnewpage{1}}
Indexed text.\index{Zebra|indexcheckpage}
\printindex
\end{document}`
 const result = await compiler.compile(source, { mainFile: 'index/nested.tex', useCache: false })
 expect(result.success, result.error + '\n' + result.log).toBe(true)
 expect(result.log).toContain('INDEX-PAGE=2')
 expect(result.log).not.toContain('INDEX-PAGE=1')
 expect(result.log).not.toContain('No file nested.ind')
})
