import { SiglumCompiler, resolveRuntime } from '@siglum/engine'
import type { ResolvedRuntime, ResolveRuntimeOptions } from '@siglum/engine'

export async function configureRuntime(): Promise<SiglumCompiler> {
  const options: ResolveRuntimeOptions = { baseUrl: 'https://packages.siglum.org', cacheStorage: null }
  const runtime: ResolvedRuntime = await resolveRuntime(options)
  const releaseId: string = runtime.releaseId
  const texLiveYear: number = runtime.texLiveYear
  // @ts-expect-error Runtime settings are typed URLs, not binary assets.
  const invalid: Uint8Array = runtime.wasmUrl
  return new SiglumCompiler({ ...runtime, onLog: () => console.log(releaseId, texLiveYear) })
}

export async function compileBlob(compiler: SiglumCompiler, source: string): Promise<Blob> {
  const result = await compiler.compile(source)
  if (result.success) {
    const bytes: Uint8Array<ArrayBuffer> = result.pdf
    return new Blob([bytes], { type: 'application/pdf' })
  }
  const message: string = result.error
  // @ts-expect-error A failed result has no PDF bytes.
  const invalid: Uint8Array<ArrayBuffer> = result.pdf
  throw new Error(message)
}
