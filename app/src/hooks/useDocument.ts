import { useState, useEffect, useCallback } from 'react'
import type { SiglumDocument } from '../types/Document'
import DocumentManager from '../services/DocumentManager'
import DocumentService from '../services/DocumentService'

interface UseDocumentReturn {
  currentDocument: SiglumDocument | null
  isLoading: boolean
  error: string | null
  updateContent: (content: string) => Promise<void>
  createNewDocument: () => Promise<void>
  loadDocument: (id: string) => Promise<void>
}

const CURRENT_DOCUMENT_KEY = 'siglum_current_document_id'

export const useDocument = (): UseDocumentReturn => {
  const [currentDocument, setCurrentDocument] = useState<SiglumDocument | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Initialize DocumentManager and load initial document
  useEffect(() => {
    const initializeDocument = async () => {
      try {
        setIsLoading(true)
        setError(null)
        
        // Initialize DocumentManager
        await DocumentManager.initialize()
        
        // Subscribe to document changes
        const unsubscribe = DocumentManager.subscribe((document) => {
          setCurrentDocument(document)
        })

        // Check URL for document ID first
        const urlDocumentId = DocumentManager.getDocumentIdFromURL()
        if (urlDocumentId) {
          try {
            await DocumentManager.switchTo(urlDocumentId, false)
            setIsLoading(false)
            return
          } catch {
            // Document from URL not found, clear it and continue
            DocumentManager.clearURLDocument()
          }
        }

        // Try to restore last document from localStorage
        const lastDocumentId = localStorage.getItem(CURRENT_DOCUMENT_KEY)
        if (lastDocumentId) {
          try {
            await DocumentManager.switchTo(lastDocumentId)
            setIsLoading(false)
            return
          } catch {
            // Document not found, continue to fallbacks
            localStorage.removeItem(CURRENT_DOCUMENT_KEY)
          }
        }

        // Try to get most recent document
        const recentDocuments = await DocumentService.getRecent(1)
        if (recentDocuments.length > 0) {
          await DocumentManager.switchTo(recentDocuments[0].id)
        }
        // Don't auto-create - let empty state handle first-time experience

        return () => unsubscribe()
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to initialize document')
      } finally {
        setIsLoading(false)
      }
    }

    initializeDocument()
  }, [])

  // Update content using DocumentManager
  const updateContent = useCallback(async (content: string) => {
    try {
      setError(null)
      await DocumentManager.updateContent(content)
      localStorage.setItem(CURRENT_DOCUMENT_KEY, currentDocument?.id || '')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save document')
    }
  }, [currentDocument])

  // Create new document using DocumentManager
  const createNewDocument = useCallback(async () => {
    try {
      setError(null)
      const newDocument = await DocumentManager.createNew('')
      localStorage.setItem(CURRENT_DOCUMENT_KEY, newDocument.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create document')
    }
  }, [])

  // Load document using DocumentManager for instant switching
  const loadDocument = useCallback(async (id: string) => {
    try {
      setError(null)
      setIsLoading(true)
      
      await DocumentManager.switchTo(id, true)
      
      localStorage.setItem(CURRENT_DOCUMENT_KEY, id)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load document')
    } finally {
      setIsLoading(false)
    }
  }, [])

  return {
    currentDocument,
    isLoading,
    error,
    updateContent,
    createNewDocument,
    loadDocument
  }
}