/**
 * ProjectStore - Singleton service for managing project files
 *
 * Provides a central place for file tree state that can be accessed
 * by any component or service (e.g., sidebar, autocomplete provider)
 */

export interface FileItem {
  id: string
  name: string
  /** Full path relative to git root (e.g., '/src/main.tex') */
  path: string
  type: 'file' | 'folder'
  children?: FileItem[]
}

type Listener = (files: FileItem[]) => void

class ProjectStore {
  private files: FileItem[] = []
  private listeners: Set<Listener> = new Set()

  /**
   * Get current files
   */
  getFiles(): FileItem[] {
    return this.files
  }

  /**
   * Update files and notify listeners
   */
  setFiles(files: FileItem[]): void {
    this.files = files
    this.notifyListeners()
  }

  /**
   * Subscribe to file changes
   * Returns unsubscribe function
   */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private notifyListeners(): void {
    this.listeners.forEach(listener => listener(this.files))
  }

  /**
   * Get all files flattened (useful for search/autocomplete)
   */
  getAllFiles(): FileItem[] {
    const result: FileItem[] = []

    const flatten = (items: FileItem[]) => {
      for (const item of items) {
        if (item.type === 'file') {
          result.push(item)
        }
        if (item.children) {
          flatten(item.children)
        }
      }
    }

    flatten(this.files)
    return result
  }

  /**
   * Get files by extension (e.g., 'png', 'tex', 'bib')
   */
  getFilesByExtension(...extensions: string[]): FileItem[] {
    const allFiles = this.getAllFiles()
    const extSet = new Set(extensions.map(e => e.toLowerCase().replace(/^\./, '')))

    return allFiles.filter(file => {
      const ext = file.path.split('.').pop()?.toLowerCase()
      return ext && extSet.has(ext)
    })
  }

  /**
   * Get image files (.png, .jpg, .jpeg, .pdf, .eps)
   */
  getImageFiles(): FileItem[] {
    return this.getFilesByExtension('png', 'jpg', 'jpeg', 'pdf', 'eps', 'svg')
  }

  /**
   * Get TeX files (.tex)
   */
  getTexFiles(): FileItem[] {
    return this.getFilesByExtension('tex')
  }

  /**
   * Get bibliography files (.bib)
   */
  getBibFiles(): FileItem[] {
    return this.getFilesByExtension('bib')
  }

  /**
   * Get style/class files (.sty, .cls)
   */
  getStyleFiles(): FileItem[] {
    return this.getFilesByExtension('sty', 'cls')
  }
}

// Export singleton instance
export default new ProjectStore()
