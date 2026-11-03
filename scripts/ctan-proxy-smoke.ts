import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

const dir = await mkdtemp(join(tmpdir(), 'siglum-proxy-test-'))
process.env.CTAN_PROXY_CACHE_DIR = join(dir, 'cache')
process.env.CTAN_TEXLIVE_ARCHIVE_DIR = join(dir, 'archive')
const originalFetch = globalThis.fetch
let requests: string[] = []
globalThis.fetch = (async (url: string) => {
  requests.push(String(url))
  if (String(url).includes('/json/2.0/pkg/')) return Response.json({id:'example',name:'example',contained_in:'container'})
  if (String(url).includes('/missing.tar.xz')) return new Response(null,{status:404})
  return new Response(new Uint8Array([253,55,122,88,90,0]))
}) as typeof fetch
try {
 const { handleRequest } = await import('../packages/ctan-proxy')
 const request = (path: string) => handleRequest(new Request('http://localhost'+path))
 const canonical=await request('/api/ctan-pkg/example')
 const alias=await request('/api/pkg/example')
 assert.equal(canonical.status,200)
 assert.deepEqual(await canonical.json(),await alias.json())
 const raw=await request('/api/texlive/example?tlYear=2024')
 assert.equal(raw.headers.get('content-type'),'application/x-xz')
 assert.equal(raw.headers.get('access-control-allow-origin'),'*')
 assert.deepEqual(new Uint8Array(await raw.arrayBuffer()),new Uint8Array([253,55,122,88,90,0]))
 assert.ok(requests.some(url=>url.includes('/2024/tlnet-final/archive/example.tar.xz')))
 assert.equal((await request('/api/texlive/missing')).status,404)
 assert.equal((await request('/api/texlive/example?tlYear=1900')).status,400)
 assert.equal((await request('/api/texlive/bad%2Fname')).status,400)
 await mkdir(process.env.CTAN_TEXLIVE_ARCHIVE_DIR!,{recursive:true})
 await writeFile(join(process.env.CTAN_TEXLIVE_ARCHIVE_DIR!,'example.r123.tar.xz'),new Uint8Array([1,2,3]))
 requests=[]
 const local=await request('/api/texlive/example')
 assert.deepEqual(new Uint8Array(await local.arrayBuffer()),new Uint8Array([1,2,3]))
 assert.equal(requests.length,0)
 console.log('CTAN proxy route parity passed: metadata alias, raw archive, local archive, year selection, CORS, and error statuses.')
} finally {
 globalThis.fetch=originalFetch
 await rm(dir,{recursive:true,force:true})
}
