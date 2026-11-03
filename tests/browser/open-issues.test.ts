import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { SiglumCompiler } from '../../src/compiler.js'

const logs: string[] = []
let compiler: SiglumCompiler
const minimal = '\\documentclass{article}\n\\begin{document}Hello\\end{document}'
beforeAll(async () => {
 const base = window.location.origin + '/dist'
 compiler = new SiglumCompiler({wasmUrl:base+'/busytex.wasm',jsUrl:base+'/busytex.js',bundlesUrl:base+'/bundles',enableCtan:true,enableLazyFS:false,onLog:message=>logs.push(message)})
 await compiler.init()
})
afterAll(() => compiler?.terminate())

describe('open issue regressions', () => {
 it('#8 returns Blob-safe bytes on a successful compile', async () => {
  const result=await compiler.compile(minimal,{mainFile:'blob.tex',useCache:false})
  expect(result.success).toBe(true)
  if (!result.success) throw new Error(result.error)
  const blob=new Blob([result.pdf],{type:'application/pdf'})
  expect(await blob.slice(0,5).text()).toBe('%PDF-')
 })
 it('#11 resolves parent and nested inputs/figures from the main directory', async () => {
  const image=await compiler.compile(minimal,{mainFile:'figure.tex',useCache:false})
  if (!image.success) throw new Error(image.error)
  const source='\\documentclass{article}\n\\usepackage{graphicx}\n\\begin{document}\n\\input{../shared}\n\\input{sections/section}\n\\includegraphics[width=1cm]{../figures/plot.pdf}\n\\includegraphics[width=1cm]{figures/plot.pdf}\n\\end{document}'
  const result=await compiler.compile(source,{mainFile:'revision/main.tex',additionalFiles:{
   'shared.tex':'\\typeout{ROOT-INPUT-FOUND}Root text.',
   'revision/sections/section.tex':'\\typeout{NESTED-INPUT-FOUND}Nested text.',
   'figures/plot.pdf':image.pdf,
   'revision/figures/plot.pdf':image.pdf,
  }})
  expect(result.success,result.error+'\n'+result.log).toBe(true)
  expect(result.log).toContain('ROOT-INPUT-FOUND')
  expect(result.log).toContain('NESTED-INPUT-FOUND')
  expect(result.log).toContain('main.pdf')
 })
 it('#12 preserves the main filename for XeLaTeX and later root compiles', async () => {
  const result=await compiler.compile(minimal,{engine:'xelatex',mainFile:'revision/thesis.tex',useCache:false})
  expect(result.success,result.error+'\n'+result.log).toBe(true)
  expect(result.log).toContain('thesis')
  const root=await compiler.compile(minimal,{mainFile:'root.tex',useCache:false})
  expect(root.success,root.error).toBe(true)
  expect(root.log).toContain('root')
 })
 it('#14 names the included file and line when an error is outside the main source', async () => {
  const result=await compiler.compile('\\documentclass{article}\n\\begin{document}\n\\input{chapters/bad}\n\\end{document}', {
   mainFile:'revision/main.tex', additionalFiles:{'revision/chapters/bad.tex':'Text\n\\buggy'}
  })
  expect(result.success).toBe(false)
  expect(result.error).toContain('chapters/bad.tex:2: Undefined control sequence')
 })
 it('#14 propagates the original undefined-command error without shimming or retrying', async () => {
  logs.length=0
  const source='\\documentclass[11pt]{article}\n\n\\usepackage{amsmath}\n\n\\begin{document}\nHello World in \\LaTeX!\n\n\\buggy}   %% should result in an error message!\n\n$$ a^2 + b^2 = c^2 $$\n\n\\end{document}'
  const result=await compiler.compile(source,{mainFile:'my.tex',useCache:false})
  expect(result.success).toBe(false)
  expect(result.error).toContain('/my.tex:8: Undefined control sequence')
  expect(result.log).toContain('l.8 \\buggy')
  expect(logs.some(line=>line.includes('Auto-shimming')||line.startsWith('Retry #'))).toBe(false)
 })
})
