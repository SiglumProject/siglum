/**
 * UndoManager - In-memory undo/redo for document editing
 *
 * Manages undo/redo stacks per document. State is session-only,
 * not persisted across page reloads.
 */

import type { UndoState } from '../types/Document'

const MAX_HISTORY = 100

interface DocumentUndoState {
  undoStack: UndoState[]
  redoStack: UndoState[]
  lastSavedContent: string
}

class UndoManager {
  private documents = new Map<string, DocumentUndoState>()
  private saveTimer: ReturnType<typeof setTimeout> | null = null

  /**
   * Get or create undo state for a document
   */
  private getState(documentId: string, initialContent: string = ''): DocumentUndoState {
    let state = this.documents.get(documentId)
    if (!state) {
      state = {
        undoStack: [],
        redoStack: [],
        lastSavedContent: initialContent
      }
      this.documents.set(documentId, state)
    }
    return state
  }

  /**
   * Initialize undo state for a document
   */
  init(documentId: string, content: string): void {
    this.documents.set(documentId, {
      undoStack: [],
      redoStack: [],
      lastSavedContent: content
    })
    this.clearTimer()
  }

  /**
   * Clear any pending save timer
   */
  private clearTimer(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
  }

  /**
   * Record a state for potential undo
   * Call this before content changes
   */
  saveState(
    documentId: string,
    content: string,
    cursorPosition: { start: number; end: number }
  ): void {
    const state = this.getState(documentId, content)

    state.undoStack.push({
      content,
      cursorPosition,
      timestamp: Date.now()
    })

    // Clear redo when new changes are made
    state.redoStack = []

    // Limit history size
    if (state.undoStack.length > MAX_HISTORY) {
      state.undoStack = state.undoStack.slice(-MAX_HISTORY)
    }

    state.lastSavedContent = content
  }

  /**
   * Check if content has changed enough to warrant saving undo state
   * Debounces small changes, saves large changes immediately
   */
  onContentChange(
    documentId: string,
    oldContent: string,
    newContent: string,
    cursorPosition: { start: number; end: number },
    onSave?: () => void
  ): void {
    const state = this.getState(documentId, oldContent)
    const diff = Math.abs(newContent.length - state.lastSavedContent.length)
    const isDifferent = newContent !== state.lastSavedContent

    if (!isDifferent) return

    // Large changes (>50 chars) - save immediately
    if (diff > 50) {
      this.saveState(documentId, oldContent, cursorPosition)
      onSave?.()
      return
    }

    // Small changes - debounce
    if (diff > 10 || state.lastSavedContent === '') {
      this.clearTimer()
      this.saveTimer = setTimeout(() => {
        this.saveState(documentId, oldContent, cursorPosition)
        onSave?.()
      }, 1000)
    }
  }

  /**
   * Undo last change
   * Returns the state to restore, or null if nothing to undo
   */
  undo(
    documentId: string,
    currentContent: string,
    currentCursor: { start: number; end: number }
  ): UndoState | null {
    const state = this.getState(documentId)

    if (state.undoStack.length === 0) return null

    const previousState = state.undoStack.pop()!

    // Save current state to redo stack
    state.redoStack.push({
      content: currentContent,
      cursorPosition: currentCursor,
      timestamp: Date.now()
    })

    return previousState
  }

  /**
   * Redo last undone change
   * Returns the state to restore, or null if nothing to redo
   */
  redo(
    documentId: string,
    currentContent: string,
    currentCursor: { start: number; end: number }
  ): UndoState | null {
    const state = this.getState(documentId)

    if (state.redoStack.length === 0) return null

    const nextState = state.redoStack.pop()!

    // Save current state to undo stack
    state.undoStack.push({
      content: currentContent,
      cursorPosition: currentCursor,
      timestamp: Date.now()
    })

    return nextState
  }

  /**
   * Check if undo is available
   */
  canUndo(documentId: string): boolean {
    return (this.documents.get(documentId)?.undoStack.length ?? 0) > 0
  }

  /**
   * Check if redo is available
   */
  canRedo(documentId: string): boolean {
    return (this.documents.get(documentId)?.redoStack.length ?? 0) > 0
  }

  /**
   * Clear undo/redo history for a document
   */
  clear(documentId: string): void {
    this.documents.delete(documentId)
  }

  /**
   * Flush any pending undo saves (call before page unload)
   */
  flush(
    documentId: string,
    currentContent: string,
    cursorPosition: { start: number; end: number }
  ): void {
    if (this.saveTimer) {
      this.clearTimer()
      const state = this.getState(documentId)
      if (currentContent !== state.lastSavedContent) {
        this.saveState(documentId, currentContent, cursorPosition)
      }
    }
  }
}

export default new UndoManager()
