// Align local tests and release artifacts with the runtime served by serve-local.ts.
import { readFile, writeFile, mkdir, readdir, rename, copyFile } from 'node:fs/promises'
import { dirname, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const backup = resolve(root, '.local-runtime-backups', new Date().toISOString().replaceAll(':', '-'))
const hash = data => createHash('sha256').update(data).digest('hex')
let changed = 0
async function sync(source, destination) {
  const bytes = await readFile(source)
  let previous
  try { previous = await readFile(destination) } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (previous && hash(previous) === hash(bytes)) return
  if (previous) {
    const saved = resolve(backup, relative(root, destination))
    await mkdir(dirname(saved), { recursive: true })
    await copyFile(destination, saved)
  }
  await mkdir(dirname(destination), { recursive: true })
  const temporary = destination + '.sync-' + process.pid
  await writeFile(temporary, bytes)
  // Rename breaks old hardlinks without modifying another runtime copy in place.
  await rename(temporary, destination)
  changed++
}
async function syncTree(source, destination) {
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.isDirectory()) await syncTree(resolve(source, entry.name), resolve(destination, entry.name))
    else if (entry.isFile()) await sync(resolve(source, entry.name), resolve(destination, entry.name))
  }
}
for (const engine of ['busytex', 'pdftex', 'xetex']) {
  for (const extension of ['js', 'wasm']) {
    const name = `${engine}.${extension}`
    const source = resolve(root, 'busytex/build/wasm', name)
    await sync(source, resolve(root, name))
    await sync(source, resolve(root, 'dist', name))
  }
}
await syncTree(resolve(root, 'packages/bundles'), resolve(root, 'dist/bundles'))
console.log(`Runtime aligned: ${changed} files updated.`)
if (changed) console.log(`Replaced files retained under ${backup}`)
