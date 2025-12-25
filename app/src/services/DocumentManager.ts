/**
 * DocumentManager - Runtime document state management
 *
 * Handles:
 * - Current document tracking
 * - Document switching with caching
 * - Subscriber notifications
 * - URL state sync
 *
 * Delegates to:
 * - DocumentService for persistence
 * - UndoManager for undo/redo
 * - DocumentSearcher for search indexing
 */

import type { SiglumDocument } from '../types/Document'
import DocumentService from './DocumentService'
import DocumentSearcher from './DocumentSearcher'
import UndoManager from './UndoManager'

export interface DocumentState {
  document: SiglumDocument
  cursorPosition?: { start: number; end: number }
  lastAccessed: Date
}

const MAX_CACHE_SIZE = 20
const MAX_RECENT = 10
const RECENT_STORAGE_KEY = 'siglum_recent_documents'

class DocumentManager {
  private currentDocument: SiglumDocument | null = null
  private cache = new Map<string, DocumentState>()
  private recentIds: string[] = []
  private initialized = false
  private listeners = new Set<(doc: SiglumDocument | null) => void>()

  // Initialization

  async initialize(): Promise<void> {
    if (this.initialized) return

    await DocumentService.initialize()
    this.recentIds = this.loadRecent()

    // Preload top 3 recent docs
    await Promise.allSettled(
      this.recentIds.slice(0, 3).map(id => this.preload(id))
    )

    this.initialized = true
  }

  // Subscriptions

  subscribe(listener: (doc: SiglumDocument | null) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private notify(): void {
    this.listeners.forEach(fn => fn(this.currentDocument))
  }

  // Document Access

  getCurrentDocument(): SiglumDocument | null {
    return this.currentDocument
  }

  getCursorPosition(): { start: number; end: number } | undefined {
    if (!this.currentDocument) return undefined
    return this.cache.get(this.currentDocument.id)?.cursorPosition
  }

  setCursorPosition(position: { start: number; end: number }): void {
    if (!this.currentDocument) return
    const state = this.cache.get(this.currentDocument.id)
    if (state) state.cursorPosition = position
  }

  // Document Operations

  async switchTo(documentId: string, updateURL = true): Promise<void> {
    // Get from cache or load
    let state = this.cache.get(documentId)

    if (!state) {
      const doc = await DocumentService.getById(documentId)
      if (!doc) throw new Error(`Document ${documentId} not found`)

      state = { document: doc, lastAccessed: new Date() }
      this.addToCache(documentId, state)
    }

    state.lastAccessed = new Date()
    this.currentDocument = state.document

    // Initialize undo for this document
    UndoManager.init(documentId, state.document.content)

    // Update tracking
    this.updateRecent(documentId)
    await DocumentService.updateLastViewed(documentId)
    await DocumentSearcher.updateDocument(state.document)

    if (updateURL) this.setURLParam(documentId)

    this.notify()
  }

  async createNew(content: string = ''): Promise<SiglumDocument> {
    const doc = await DocumentService.create(content)
    this.addToCache(doc.id, { document: doc, lastAccessed: new Date() })
    await this.switchTo(doc.id)
    return doc
  }

  async updateContent(content: string): Promise<void> {
    if (!this.currentDocument) return

    const cursor = this.getCursorPosition() || { start: 0, end: 0 }

    // Track for undo
    UndoManager.onContentChange(
      this.currentDocument.id,
      this.currentDocument.content,
      content,
      cursor
    )

    // Persist
    const updated = await DocumentService.update(this.currentDocument.id, { content })
    this.currentDocument = updated

    // Update cache
    const state = this.cache.get(updated.id)
    if (state) {
      state.document = updated
      state.lastAccessed = new Date()
    }

    await DocumentSearcher.updateDocument(updated)
    this.notify()
  }

  // Undo/Redo

  async undo(): Promise<{ content: string; cursorPosition: { start: number; end: number } } | null> {
    if (!this.currentDocument) return null

    const cursor = this.getCursorPosition() || { start: 0, end: 0 }
    const prev = UndoManager.undo(this.currentDocument.id, this.currentDocument.content, cursor)

    if (!prev) return null

    await DocumentService.update(this.currentDocument.id, { content: prev.content })
    this.currentDocument.content = prev.content

    const state = this.cache.get(this.currentDocument.id)
    if (state) {
      state.document.content = prev.content
      state.cursorPosition = prev.cursorPosition
    }

    this.notify()
    return prev
  }

  async redo(): Promise<{ content: string; cursorPosition: { start: number; end: number } } | null> {
    if (!this.currentDocument) return null

    const cursor = this.getCursorPosition() || { start: 0, end: 0 }
    const next = UndoManager.redo(this.currentDocument.id, this.currentDocument.content, cursor)

    if (!next) return null

    await DocumentService.update(this.currentDocument.id, { content: next.content })
    this.currentDocument.content = next.content

    const state = this.cache.get(this.currentDocument.id)
    if (state) {
      state.document.content = next.content
      state.cursorPosition = next.cursorPosition
    }

    this.notify()
    return next
  }

  // Cache Management

  private addToCache(id: string, state: DocumentState): void {
    // Evict oldest if full
    if (this.cache.size >= MAX_CACHE_SIZE) {
      const entries = [...this.cache.entries()]
        .filter(([key]) => key !== this.currentDocument?.id)
        .sort((a, b) => a[1].lastAccessed.getTime() - b[1].lastAccessed.getTime())

      if (entries.length > 0) {
        this.cache.delete(entries[0][0])
      }
    }
    this.cache.set(id, state)
  }

  private async preload(id: string): Promise<void> {
    if (this.cache.has(id)) return
    try {
      const doc = await DocumentService.getById(id)
      if (doc) this.addToCache(id, { document: doc, lastAccessed: new Date() })
    } catch { /* ignore */ }
  }

  // Recent Documents

  getRecentDocuments(): SiglumDocument[] {
    return this.recentIds
      .map(id => this.cache.get(id)?.document)
      .filter((d): d is SiglumDocument => !!d)
  }

  private updateRecent(id: string): void {
    this.recentIds = [id, ...this.recentIds.filter(x => x !== id)].slice(0, MAX_RECENT)
    this.saveRecent()
  }

  private loadRecent(): string[] {
    try {
      return JSON.parse(localStorage.getItem(RECENT_STORAGE_KEY) || '[]')
    } catch {
      return []
    }
  }

  private saveRecent(): void {
    try {
      localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify(this.recentIds))
    } catch { /* ignore */ }
  }

  // URL State

  getDocumentIdFromURL(): string | null {
    return new URL(window.location.href).searchParams.get('doc')
  }

  clearURLDocument(): void {
    const url = new URL(window.location.href)
    url.searchParams.delete('doc')
    window.history.replaceState(null, '', url.toString())
  }

  private setURLParam(id: string): void {
    const url = new URL(window.location.href)
    url.searchParams.set('doc', id)
    window.history.replaceState(null, '', url.toString())
  }

  // Export

  exportDocument(id?: string): void {
    const doc = id ? this.cache.get(id)?.document : this.currentDocument
    if (!doc) return

    const blob = new Blob([doc.content], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)

    const a = document.createElement('a')
    a.href = url
    a.download = `${doc.title.replace(/[^a-zA-Z0-9]/g, '_')}.tex`
    a.click()

    URL.revokeObjectURL(url)
  }

  // Cleanup

  async deleteOldDocuments(daysOld = 90): Promise<number> {
    const cutoff = Date.now() - daysOld * 24 * 60 * 60 * 1000
    const all = await DocumentService.getAll()
    let count = 0

    for (const doc of all) {
      if (doc.lastViewedAt.getTime() < cutoff && doc.id !== this.currentDocument?.id) {
        await DocumentService.delete(doc.id)
        await DocumentSearcher.removeDocument(doc.id)
        this.cache.delete(doc.id)
        this.recentIds = this.recentIds.filter(id => id !== doc.id)
        count++
      }
    }

    if (count > 0) this.saveRecent()
    return count
  }
}

export default new DocumentManager()
