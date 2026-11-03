import { SiglumCompiler } from '@siglum/engine'

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
