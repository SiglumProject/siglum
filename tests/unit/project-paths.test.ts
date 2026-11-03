import { describe, expect, it } from 'vitest'
import { normalizeProjectPath } from '../../src/project-paths.js'

describe('project paths', () => {
 it('normalizes root aliases and internal relative segments', () => {
  expect(normalizeProjectPath('/revision/./figures/../main.tex')).toBe('revision/main.tex')
 })
 it('rejects paths that escape the virtual project root or cannot name files', () => {
  for (const path of ['../logo.jpeg','/../../secret','/', 'bad\\name.tex', 'bad\0name.tex']) {
   expect(()=>normalizeProjectPath(path)).toThrow()
  }
 })
})
