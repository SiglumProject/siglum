import {describe,expect,it,vi} from 'vitest'
import {fetchTexLiveArchive} from '../../src/texlive.js'
describe('TeX Live package year isolation',()=>{
 it('checks the 2026 marker before using rolling tlnet',async()=>{
  const fetcher=vi.fn().mockResolvedValue(new Response('ok'))
  await fetchTexLiveArchive('amsmath',2026,fetcher)
  expect(fetcher.mock.calls[0][0]).toContain('/TEXLIVE_2026')
  expect(fetcher.mock.calls[1][0]).toContain('/tlnet/archive/amsmath.tar.xz')
 })
 it('uses the historic 2026 archive when tlnet rolls into the next year',async()=>{
  const fetcher=vi.fn().mockResolvedValueOnce(new Response(null,{status:404})).mockResolvedValue(new Response('ok'))
  await fetchTexLiveArchive('amsmath',2026,fetcher)
  expect(fetcher.mock.calls[1][0]).toContain('/2026/tlnet-final/archive/')
 })
 it('never uses rolling tlnet for an explicit older-year request',async()=>{
  const fetcher=vi.fn().mockResolvedValue(new Response('ok'))
  await fetchTexLiveArchive('amsmath',2025,fetcher)
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(fetcher.mock.calls[0][0]).toContain('/2025/tlnet-final/archive/')
 })
})
