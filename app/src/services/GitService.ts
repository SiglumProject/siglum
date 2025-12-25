/**
 * GitService - Re-exports from @siglum/git package
 *
 * This module configures and exports the git service instance,
 * wiring it up to the app's ProjectStore for file tree updates.
 */

import { getGitService } from '@siglum/git'
import ProjectStore from './ProjectStore'

// Create and export the configured git service instance
const gitService = getGitService({
  corsProxy: 'https://cors.isomorphic-git.org',
  storageKey: 'siglum-git-config',
  onFileTreeChange: (files) => {
    ProjectStore.setFiles(files)
  }
})

// Re-export types from package
export type {
  GitConfig,
  GitStatus,
  FileChange,
  FileItem,
  GitStatusListener,
  FileTreeListener
} from '@siglum/git'

export default gitService
