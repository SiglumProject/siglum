/**
 * LaTeX content parsing utilities
 *
 * Shared functions for extracting title, searchable text, and word count
 * from LaTeX documents.
 */

/**
 * Extract a title from LaTeX content
 * Tries common patterns like \title{}, \chapter{}, \section{}, etc.
 */
export function extractTitle(content: string): string {
  const titlePatterns = [
    /\\title\{([^}]+)\}/,
    /\\chapter\{([^}]+)\}/,
    /\\section\{([^}]+)\}/,
    /\\begin\{center\}[\s\S]*?\{\\Huge[^}]*\{([^}]+)\}\}/,
    /\{\\Huge[^}]*\{([^}]+)\}\}/,
    /\{\\Large[^}]*\{([^}]+)\}\}/,
    /#\s+(.+)/,
  ]

  for (const pattern of titlePatterns) {
    const match = content.match(pattern)
    if (match && match[1]) {
      const title = match[1]
        .replace(/\\[a-zA-Z]+/g, '')
        .replace(/[{}]/g, '')
        .trim()

      if (title.length > 2) {
        return title.substring(0, 60) + (title.length > 60 ? '...' : '')
      }
    }
  }

  const lines = content.split('\n')
  for (const line of lines) {
    if (line.includes('\\documentclass') ||
        line.includes('\\usepackage') ||
        line.includes('\\newcommand') ||
        line.includes('\\begin{document}') ||
        line.includes('\\vspace') ||
        line.includes('\\hspace') ||
        line.trim().startsWith('%')) {
      continue
    }

    const cleaned = line
      .replace(/\\[a-zA-Z]+\{([^}]*)\}/g, '$1')
      .replace(/\\[a-zA-Z]+/g, '')
      .replace(/[{}]/g, '')
      .replace(/^\s*%.*$/gm, '')
      .trim()

    if (cleaned.length > 3) {
      return cleaned.substring(0, 60) + (cleaned.length > 60 ? '...' : '')
    }
  }

  return `Untitled ${new Date().toLocaleDateString()}`
}

/**
 * Extract searchable text from LaTeX content
 * Removes LaTeX commands and normalizes whitespace
 */
export function extractSearchableText(content: string): string {
  return content
    .replace(/\\[a-zA-Z]+\{([^}]*)\}/g, '$1')
    .replace(/\\[a-zA-Z]+/g, '')
    .replace(/[{}]/g, '')
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .trim()
}

/**
 * Count words in text
 */
export function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(word => word.length > 0).length
}
