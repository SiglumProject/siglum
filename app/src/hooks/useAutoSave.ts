import { useEffect, useCallback, useRef, useState } from 'react'

interface UseAutoSaveOptions {
  delay?: number // Delay in milliseconds before saving
  onSave: (content: string) => Promise<void>
}

export interface AutoSaveStatus {
  isSaving: boolean
  lastSaved: Date | null
  error: string | null
  hasUnsavedChanges: boolean
}

export const useAutoSave = (content: string, options: UseAutoSaveOptions): AutoSaveStatus => {
  const { delay = 500, onSave } = options
  const timeoutRef = useRef<ReturnType<typeof setTimeout>>()
  const lastSavedContentRef = useRef<string>(content)
  const [status, setStatus] = useState<AutoSaveStatus>({
    isSaving: false,
    lastSaved: null,
    error: null,
    hasUnsavedChanges: false
  })

  const debouncedSave = useCallback(
    (contentToSave: string) => {
      // Clear existing timeout
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current)
      }

      // Set new timeout
      timeoutRef.current = setTimeout(async () => {
        // Only save if content has actually changed
        if (contentToSave !== lastSavedContentRef.current) {
          try {
            setStatus(prev => ({ ...prev, isSaving: true, error: null }))
            await onSave(contentToSave)
            lastSavedContentRef.current = contentToSave
            setStatus(prev => ({ 
              ...prev, 
              isSaving: false, 
              lastSaved: new Date(),
              error: null,
              hasUnsavedChanges: false
            }))
          } catch (error) {
            console.error('Auto-save failed:', error)
            setStatus(prev => ({ 
              ...prev, 
              isSaving: false,
              error: error instanceof Error ? error.message : 'Save failed'
            }))
          }
        }
      }, delay)
    },
    [delay, onSave]
  )

  useEffect(() => {
    // Mark as having unsaved changes when content differs from last saved
    if (content !== lastSavedContentRef.current) {
      setStatus(prev => ({ ...prev, hasUnsavedChanges: true }))
    }
    
    debouncedSave(content)

    // Cleanup timeout on unmount
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current)
      }
    }
  }, [content, debouncedSave])


  return status
}