/**
 * ProjectSearcher - Search across project files
 *
 * Searches file names and content in the current project.
 * Uses ProjectStore for file tree and GitService for reading content.
 */

import ProjectStore from './ProjectStore'
import type { FileItem } from './ProjectStore'
import GitService from './GitService'

export interface FileSearchResult {
  file: FileItem
  /** Type of match: 'name' for filename, 'content' for content match */
  matchType: 'name' | 'content'
  /** For content matches: the line number (1-indexed) */
  lineNumber?: number
  /** Snippet of matching content with context */
  snippet?: string
  /** Relevance score for sorting */
  score: number
}

export interface SearchOptions {
  /** Maximum results to return */
  maxResults?: number
  /** Search file contents (slower for large projects) */
  searchContent?: boolean
  /** File extensions to search (e.g., ['tex', 'bib', 'sty']) */
  extensions?: string[]
  /** Case-sensitive search */
  caseSensitive?: boolean
}

const TEXT_EXTENSIONS = new Set([
  'tex', 'bib', 'sty', 'cls', 'dtx', 'ins',
  'txt', 'md', 'json', 'yaml', 'yml',
  'bst', 'bbx', 'cbx', 'lbx'
])

class ProjectSearcher {
  private contentCache: Map<string, string> = new Map()
  private cacheTimestamp: number = 0
  private readonly CACHE_TTL = 30000 // 30 seconds

  /**
   * Search project files by name and optionally content
   */
  async search(query: string, options: SearchOptions = {}): Promise<FileSearchResult[]> {
    const {
      maxResults = 20,
      searchContent = true,
      extensions,
      caseSensitive = false
    } = options

    if (!query.trim()) {
      return []
    }

    const allFiles = ProjectStore.getAllFiles()
    const results: FileSearchResult[] = []
    const searchQuery = caseSensitive ? query : query.toLowerCase()

    // Filter files by extension if specified
    const filesToSearch = extensions
      ? allFiles.filter(f => {
          const ext = f.path.split('.').pop()?.toLowerCase()
          return ext && extensions.includes(ext)
        })
      : allFiles

    // Search file names first (fast)
    for (const file of filesToSearch) {
      const fileName = caseSensitive ? file.name : file.name.toLowerCase()
      const filePath = caseSensitive ? file.path : file.path.toLowerCase()

      if (fileName.includes(searchQuery) || filePath.includes(searchQuery)) {
        // Score based on match quality
        let score = 10
        if (fileName === searchQuery) score = 100 // Exact match
        else if (fileName.startsWith(searchQuery)) score = 50 // Prefix match
        else if (fileName.includes(searchQuery)) score = 30 // Contains in name
        else score = 10 // Contains in path

        results.push({
          file,
          matchType: 'name',
          score
        })
      }
    }

    // Search file contents if enabled
    if (searchContent && GitService.getStatus().isConnected) {
      const textFiles = filesToSearch.filter(f => {
        const ext = f.path.split('.').pop()?.toLowerCase()
        return ext && TEXT_EXTENSIONS.has(ext)
      })

      for (const file of textFiles) {
        // Skip if already matched by name with high score
        const existingMatch = results.find(r => r.file.path === file.path)
        if (existingMatch && existingMatch.score >= 50) continue

        try {
          const content = await this.getFileContent(file.path)
          if (!content) continue

          const searchableContent = caseSensitive ? content : content.toLowerCase()
          const lines = content.split('\n')

          let lineIndex = 0
          let charIndex = 0

          // Find first match in content
          const matchIndex = searchableContent.indexOf(searchQuery)
          if (matchIndex !== -1) {
            // Find line number
            for (let i = 0; i < lines.length; i++) {
              if (charIndex + lines[i].length >= matchIndex) {
                lineIndex = i
                break
              }
              charIndex += lines[i].length + 1 // +1 for newline
            }

            // Create snippet with context
            const startLine = Math.max(0, lineIndex - 1)
            const endLine = Math.min(lines.length - 1, lineIndex + 1)
            const snippet = lines.slice(startLine, endLine + 1).join('\n')

            // If already matched by name, update the match
            if (existingMatch) {
              existingMatch.matchType = 'content'
              existingMatch.lineNumber = lineIndex + 1
              existingMatch.snippet = this.truncateSnippet(snippet, searchQuery)
              existingMatch.score += 5
            } else {
              results.push({
                file,
                matchType: 'content',
                lineNumber: lineIndex + 1,
                snippet: this.truncateSnippet(snippet, searchQuery),
                score: 5
              })
            }
          }
        } catch (err) {
          // Skip files that can't be read
          console.warn(`[ProjectSearcher] Could not read ${file.path}:`, err)
        }
      }
    }

    // Sort by score (descending) and return top results
    return results
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults)
  }

  /**
   * Search only file names (fast, no content reading)
   */
  searchFileNames(query: string, maxResults = 20): FileSearchResult[] {
    if (!query.trim()) {
      return []
    }

    const allFiles = ProjectStore.getAllFiles()
    const searchQuery = query.toLowerCase()
    const results: FileSearchResult[] = []

    for (const file of allFiles) {
      const fileName = file.name.toLowerCase()
      const filePath = file.path.toLowerCase()

      if (fileName.includes(searchQuery) || filePath.includes(searchQuery)) {
        let score = 10
        if (fileName === searchQuery) score = 100
        else if (fileName.startsWith(searchQuery)) score = 50
        else if (fileName.includes(searchQuery)) score = 30
        else score = 10

        results.push({
          file,
          matchType: 'name',
          score
        })
      }
    }

    return results
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults)
  }

  /**
   * Get file content with caching
   */
  private async getFileContent(path: string): Promise<string | null> {
    // Invalidate cache if stale
    if (Date.now() - this.cacheTimestamp > this.CACHE_TTL) {
      this.contentCache.clear()
      this.cacheTimestamp = Date.now()
    }

    // Return cached content if available
    if (this.contentCache.has(path)) {
      return this.contentCache.get(path)!
    }

    // Read and cache content
    const content = await GitService.readFile(path)
    if (content !== null) {
      this.contentCache.set(path, content)
    }
    return content
  }

  /**
   * Truncate snippet to reasonable length
   */
  private truncateSnippet(snippet: string, query: string): string {
    const maxLength = 150
    if (snippet.length <= maxLength) return snippet

    // Try to center on the query
    const lowerSnippet = snippet.toLowerCase()
    const queryIndex = lowerSnippet.indexOf(query.toLowerCase())

    if (queryIndex === -1) {
      return snippet.substring(0, maxLength) + '...'
    }

    const start = Math.max(0, queryIndex - 40)
    const end = Math.min(snippet.length, queryIndex + query.length + 60)

    let result = snippet.substring(start, end)
    if (start > 0) result = '...' + result
    if (end < snippet.length) result = result + '...'

    return result
  }

  /**
   * Clear the content cache
   */
  clearCache(): void {
    this.contentCache.clear()
    this.cacheTimestamp = 0
  }
}

export default new ProjectSearcher()
