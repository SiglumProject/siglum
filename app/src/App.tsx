import React, { useState, useCallback, useEffect, useRef, Suspense, lazy } from 'react'
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels'
import type { ImperativePanelHandle } from 'react-resizable-panels'
import CommandPalette from './components/CommandPalette'
import LaTeXEditor from './components/LaTeXEditor/LaTeXEditor'
import EmptyState from './components/EmptyState'

// Lazy load PDF viewer - only loads when preview is shown
const PDFViewer = lazy(() => import('./components/PDFViewer'))
import DocumentationModal from './components/DocumentationModal'
import ProjectSidebar from './components/ProjectSidebar'
import Onboarding from './components/Onboarding/Onboarding'
import type { FileItem } from './components/ProjectSidebar'
import { useDocument } from './hooks/useDocument'
import { useAutoSave } from './hooks/useAutoSave'
import DocumentManager from './services/DocumentManager'
import GitService from './services/GitService'
import CompilerService from './services/CompilerService'
import type { CompileStatus } from './services/CompilerService'
import './App.css'

// Make DocumentManager available globally in development
if (import.meta.env.DEV) {
  (window as any).DocumentManager = DocumentManager;
}

const App: React.FC = () => {
  const { currentDocument, isLoading, error, updateContent, loadDocument, createNewDocument } = useDocument()
  const [latexCode, setLatexCode] = useState('')
  const [showPreview, setShowPreview] = useState(false)
  const [showDesktopPreview, setShowDesktopPreview] = useState(true)
  const [isLoaded, setIsLoaded] = useState(false)
  const [touchStart, setTouchStart] = useState({ x: 0, y: 0 })
  const [showCommandPalette, setShowCommandPalette] = useState(false)

  // Compiler state
  const [pdfData, setPdfData] = useState<ArrayBuffer | null>(null)
  const [compileStatus, setCompileStatus] = useState<CompileStatus>('idle')
  const [compileTimeMs, setCompileTimeMs] = useState<number | null>(null)
  const compileTimeoutRef = useRef<number | null>(null)

  // Compiler settings (shared with editor)
  const [compilerSettings, setCompilerSettings] = useState({
    autoCompile: true,
    compiler: 'auto' as 'auto' | 'pdflatex' | 'xelatex',
    ctanFetch: true,
    cachePreamble: true,
  })
  
  const [isClosingCommandPalette, setIsClosingCommandPalette] = useState(false)
  const [showDocumentation, setShowDocumentation] = useState(false)
  const [isClosingDocumentation, setIsClosingDocumentation] = useState(false)
  const [documentationOpenedFromPalette, setDocumentationOpenedFromPalette] = useState(false)
  const [sidebarExpanded, setSidebarExpanded] = useState(() => {
    const saved = localStorage.getItem('siglum-sidebar-expanded')
    return saved === 'true'
  })
  const [projectFiles, setProjectFiles] = useState<FileItem[]>(() => {
    // Load from localStorage on init
    const saved = localStorage.getItem('siglum-project-files')
    return saved ? JSON.parse(saved) : []
  })
  const [selectedFileId, setSelectedFileId] = useState<string | undefined>()
  const [selectedFilePath, setSelectedFilePath] = useState<string | undefined>()
  const [showOnboarding, setShowOnboarding] = useState(() => {
    return !localStorage.getItem('siglum-onboarding-complete')
  })
  const [triggerGitConnect, setTriggerGitConnect] = useState(false)
  const [showConflictModal, setShowConflictModal] = useState(false)
  const editorPanelRef = useRef<ImperativePanelHandle>(null)
  const previewPanelRef = useRef<ImperativePanelHandle>(null)

  // Sync local state with current document and update browser title
  useEffect(() => {
    if (currentDocument) {
      setLatexCode(currentDocument.content)
      // Update browser tab title with document title
      const titlePrefix = currentDocument.title === `Untitled ${new Date().toLocaleDateString()}` 
        ? 'Untitled' 
        : currentDocument.title
      document.title = `${titlePrefix} - Siglum`
    } else {
      // Default title when no document
      document.title = 'Siglum - LaTeX Editor'
    }
  }, [currentDocument])

  // Trigger loading animation after initial render
  useEffect(() => {
    const timer = setTimeout(() => {
      setIsLoaded(true)
    }, 100)
    return () => clearTimeout(timer)
  }, [])

  // Eagerly initialize compiler so it's ready when user starts editing
  useEffect(() => {
    CompilerService.initialize().catch(() => {
      // Initialization errors will be handled when compile is called
    })
  }, [])

  // Also update title when content changes (for auto-generated titles)
  useEffect(() => {
    if (currentDocument && latexCode !== currentDocument.content) {
      // Title might have changed due to content update
      const titlePrefix = currentDocument.title === `Untitled ${new Date().toLocaleDateString()}`
        ? 'Untitled'
        : currentDocument.title
      document.title = `${titlePrefix} - Siglum`
    }
  }, [currentDocument, latexCode])

  // Save project files to localStorage when they change
  useEffect(() => {
    localStorage.setItem('siglum-project-files', JSON.stringify(projectFiles))
  }, [projectFiles])

  // Save sidebar state to localStorage
  useEffect(() => {
    localStorage.setItem('siglum-sidebar-expanded', String(sidebarExpanded))
  }, [sidebarExpanded])

  // Subscribe to git status for remote change detection
  const hasShownRemoteModal = useRef(false)
  useEffect(() => {
    const unsubscribe = GitService.subscribeStatus((status) => {
      // Show modal when remote has changes and we haven't shown it yet this session
      if (status.behind > 0 && !showConflictModal && !hasShownRemoteModal.current) {
        hasShownRemoteModal.current = true
        setShowConflictModal(true)
      }
      // Reset the flag when we're caught up
      if (status.behind === 0) {
        hasShownRemoteModal.current = false
      }
    })
    return unsubscribe
  }, [showConflictModal])

  const handleUseRemote = useCallback(async () => {
    await GitService.forcePull()
    // Reload the current file content
    if (selectedFilePath) {
      const content = await GitService.getFileContent(selectedFilePath)
      if (content !== null) {
        setLatexCode(content)
      }
    }
    setShowConflictModal(false)
  }, [selectedFilePath])

  const handleKeepLocal = useCallback(() => {
    setShowConflictModal(false)
    // User will continue editing, conflict resolved on next push
  }, [])

  const handleFileSelect = useCallback(async (file: FileItem) => {
    // Use path if available, otherwise fall back to name (for backwards compatibility)
    const filePath = file.path || `/${file.name}`
    setSelectedFileId(file.id)
    setSelectedFilePath(filePath)

    // Load file content from GitService using the full path
    if (GitService.getStatus().isConnected) {
      const content = await GitService.readFile(filePath)
      if (content !== null) {
        setLatexCode(content)
        // Trigger immediate compile on document switch if auto-compile is enabled
        if (autoCompileRef.current) {
          // Clear any pending debounced compile
          if (compileTimeoutRef.current) {
            clearTimeout(compileTimeoutRef.current)
          }
          // Defer compile to allow state to update
          setTimeout(() => compileRef.current(), 0)
        }
      }
    }
  }, [])

  const handleLatexCodeChange = useCallback((newContent: string) => {
    setLatexCode(newContent)
  }, [])

  // Sync editor changes to git filesystem
  useEffect(() => {
    if (selectedFilePath && GitService.getStatus().isConnected && latexCode) {
      GitService.writeFile(selectedFilePath, latexCode)
    }
  }, [latexCode, selectedFilePath])

  // Compile function
  const compile = useCallback(async () => {
    // Use CompilerService.getStatus() directly to avoid stale closure issues
    const currentStatus = CompilerService.getStatus()
    console.log('[Compile] Called, latexCode length:', latexCode?.length, 'status:', currentStatus)
    if (!latexCode || currentStatus === 'compiling' || currentStatus === 'initializing') {
      console.log('[Compile] Skipped - no content or already compiling')
      return
    }

    try {
      console.log('[Compile] Starting compilation...')
      const result = await CompilerService.compile(latexCode, {
        engine: compilerSettings.compiler,
      })
      console.log('[Compile] Result:', result.success, result.error, result.pdf?.length)
      if (result.success && result.pdf) {
        // Copy the buffer to avoid "detached ArrayBuffer" issues from worker transfers
        const pdfCopy = result.pdf.slice().buffer
        setPdfData(pdfCopy as ArrayBuffer)
        setCompileTimeMs(result.timeMs ?? null)

        // Generate format (cache preamble) after successful compile if enabled
        if (compilerSettings.cachePreamble) {
          CompilerService.generateFormat(latexCode, {
            engine: compilerSettings.compiler,
          }).catch(() => {
            // Format generation errors are logged but don't affect the user
          })
        }
      } else if (!result.success) {
        console.error('[Compile] Failed:', result.error, result.log)
      }
    } catch (e) {
      console.error('[Compile] Exception:', e)
    }
  }, [latexCode, compilerSettings.compiler, compilerSettings.cachePreamble])

  // Wrapper for compiler settings that clears format cache when cachePreamble is toggled off
  const handleCompilerSettingsChange = useCallback((newSettings: typeof compilerSettings) => {
    // If cachePreamble was just turned off, clear the format cache
    if (compilerSettings.cachePreamble && !newSettings.cachePreamble) {
      CompilerService.clearCache()
    }
    setCompilerSettings(newSettings)
  }, [compilerSettings.cachePreamble])

  // Keep refs to avoid stale closures in callbacks
  const compileRef = useRef(compile)
  const latexCodeRef = useRef(latexCode)
  const autoCompileRef = useRef(compilerSettings.autoCompile)
  useEffect(() => {
    compileRef.current = compile
  }, [compile])
  useEffect(() => {
    latexCodeRef.current = latexCode
  }, [latexCode])
  useEffect(() => {
    autoCompileRef.current = compilerSettings.autoCompile
  }, [compilerSettings.autoCompile])

  // Subscribe to compiler status
  const prevStatusRef = useRef<CompileStatus>('idle')
  useEffect(() => {
    return CompilerService.onStatus((status) => {
      const prevStatus = prevStatusRef.current
      prevStatusRef.current = status
      setCompileStatus(status)

      // Trigger compile when initialization completes and we have content
      if (prevStatus === 'initializing' && status === 'idle' && latexCodeRef.current && autoCompileRef.current) {
        console.log('[Compile] Triggering after init complete')
        // Defer to allow React state to update
        setTimeout(() => compileRef.current(), 0)
      }
    })
  }, [])

  // Listen for triggerCompile event from editor (Cmd+S)
  useEffect(() => {
    const handleTriggerCompile = () => {
      compile()
    }
    window.addEventListener('triggerCompile', handleTriggerCompile)
    return () => window.removeEventListener('triggerCompile', handleTriggerCompile)
  }, [compile])

  // Auto-compile on content change (debounced)
  useEffect(() => {
    // Skip if auto-compile disabled, no content, or during initial load
    if (!compilerSettings.autoCompile || !latexCode || !isLoaded) return

    // Clear previous timeout
    if (compileTimeoutRef.current) {
      clearTimeout(compileTimeoutRef.current)
    }

    // Debounce compile by 1 second
    compileTimeoutRef.current = window.setTimeout(() => {
      compileRef.current()
    }, 1000)

    return () => {
      if (compileTimeoutRef.current) {
        clearTimeout(compileTimeoutRef.current)
      }
    }
  }, [latexCode, isLoaded, compilerSettings.autoCompile])

  // Auto-save with debouncing
  const saveStatus = useAutoSave(latexCode, {
    delay: 500,
    onSave: updateContent
  })

  // Warn before closing if there are unsaved changes
  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (saveStatus.hasUnsavedChanges || saveStatus.isSaving) {
        e.preventDefault()
        e.returnValue = 'You have unsaved changes. Are you sure you want to leave?'
        return 'You have unsaved changes. Are you sure you want to leave?'
      }
    }

    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [saveStatus.hasUnsavedChanges, saveStatus.isSaving])

  // DocumentManager now handles search index updates automatically

  // Listen for command palette event from Monaco Editor
  React.useEffect(() => {
    const handleToggleCommandPalette = () => {
      setShowCommandPalette(prev => !prev)
    }

    window.addEventListener('toggleCommandPalette', handleToggleCommandPalette)
    return () => window.removeEventListener('toggleCommandPalette', handleToggleCommandPalette)
  }, [showCommandPalette])

  // Animated close handler for command palette
  const handleCloseCommandPalette = useCallback(() => {
    setIsClosingCommandPalette(true)
    setTimeout(() => {
      setIsClosingCommandPalette(false)
      setShowCommandPalette(false)
    }, 200) // Match animation duration
  }, [])

  // Animated close handler for documentation modal
  const handleCloseDocumentation = useCallback(() => {
    setIsClosingDocumentation(true)
    setTimeout(() => {
      setIsClosingDocumentation(false)
      setShowDocumentation(false)
      setDocumentationOpenedFromPalette(false)
    }, 200) // Match animation duration
  }, [])

  // Listen for toggleHelp event from editor toolbar
  useEffect(() => {
    const handleToggleHelp = () => {
      if (showDocumentation) {
        handleCloseDocumentation()
      } else {
        setShowDocumentation(true)
      }
    }

    window.addEventListener('toggleHelp', handleToggleHelp)
    return () => window.removeEventListener('toggleHelp', handleToggleHelp)
  }, [showDocumentation, handleCloseDocumentation])

  // Command palette handlers
  const handleSelectDocument = useCallback(async (documentId: string) => {
    await loadDocument(documentId)
  }, [loadDocument])

  const handleSelectFile = useCallback(async (filePath: string, lineNumber?: number) => {
    // Find the file in projectFiles by path
    const file = projectFiles.find(f => f.path === filePath)
    if (file) {
      await handleFileSelect(file)
      // After file loads, jump to line if specified
      if (lineNumber) {
        // Delay to let the editor update with new content
        setTimeout(() => {
          window.dispatchEvent(new CustomEvent('goToLine', { detail: { line: lineNumber } }))
        }, 100)
      }
    }
  }, [projectFiles, handleFileSelect])

  const handleCreateNewDocument = useCallback(async () => {
    await createNewDocument()
  }, [createNewDocument])

  const handleCloseCurrentDocument = useCallback(async () => {
    const recentDocs = DocumentManager.getRecentDocuments()
    if (recentDocs.length > 1) {
      // Switch to the second most recent document (first is current)
      await loadDocument(recentDocs[1].id)
    } else {
      // Create a new document if no other documents exist
      await createNewDocument()
    }
  }, [loadDocument, createNewDocument])

  // Keyboard shortcuts
  React.useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Command palette shortcuts (global)
      if ((e.metaKey || e.ctrlKey) && e.key === 'k' && !e.shiftKey && !e.altKey) {
        e.preventDefault()
        e.stopPropagation()

        if (showCommandPalette) {
          handleCloseCommandPalette()
        } else {
          // Close any open modals when opening command palette
          if (showDocumentation) {
            handleCloseDocumentation()
          } else {
            setShowDocumentation(false)
          }
          setIsClosingCommandPalette(false)
          setShowCommandPalette(true)
        }
        return
      }

      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'F') {
        e.preventDefault()
        if (showCommandPalette) {
          // Close with animation
          handleCloseCommandPalette()
        } else {
          // Close any open modals when opening command palette
          if (showDocumentation) {
            handleCloseDocumentation()
          } else {
            setShowDocumentation(false)
          }
          setIsClosingCommandPalette(false)
          setShowCommandPalette(true)
        }
        return
      }
      
      if ((e.metaKey || e.ctrlKey) && e.key === 'n') {
        e.preventDefault()
        handleCreateNewDocument()
        return
      }
      
      if ((e.metaKey || e.ctrlKey) && e.key === 'w') {
        e.preventDefault()
        // Close current document (go to most recent)
        handleCloseCurrentDocument()
        return
      }
      
      // Undo/Redo shortcuts
      if ((e.metaKey || e.ctrlKey) && e.key === 'z' && !e.shiftKey) {
        e.preventDefault()
        // Perform undo
        DocumentManager.undo().then(result => {
          if (result) {
            setLatexCode(result.content)
            // TODO: Restore cursor position in editor
          }
        })
        return
      }
      
      if ((e.metaKey || e.ctrlKey) && ((e.shiftKey && e.key === 'z') || e.key === 'y')) {
        e.preventDefault()
        // Perform redo
        DocumentManager.redo().then(result => {
          if (result) {
            setLatexCode(result.content)
            // TODO: Restore cursor position in editor
          }
        })
        return
      }
      
      if ((e.metaKey || e.ctrlKey) && e.key === 'h') {
        e.preventDefault()

        if (showDocumentation) {
          handleCloseDocumentation()
        } else {
          if (showCommandPalette) {
            setDocumentationOpenedFromPalette(true)
            handleCloseCommandPalette()
          } else {
            setDocumentationOpenedFromPalette(false)
          }
          setShowDocumentation(true)
        }
        return
      }
      
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'E') {
        e.preventDefault()
        // Export current document
        DocumentManager.exportDocument()
        return
      }
      
      // Cmd+. or Ctrl+. - toggle project sidebar
      if ((e.metaKey || e.ctrlKey) && e.key === '.') {
        e.preventDefault()
        setSidebarExpanded(prev => !prev)
        return
      }

      // Cmd+1 or Ctrl+1 - show only editor
      if ((e.metaKey || e.ctrlKey) && e.key === '1') {
        e.preventDefault()
        if (window.innerWidth >= 768) {
          setShowDesktopPreview(false)
        } else {
          setShowPreview(false) // For mobile
        }
      }
      // Cmd+2 or Ctrl+2 - show editor and preview
      else if ((e.metaKey || e.ctrlKey) && e.key === '2') {
        e.preventDefault()
        if (window.innerWidth >= 768) {
          setShowDesktopPreview(true)
          setTimeout(() => {
            editorPanelRef.current?.resize(50)
            previewPanelRef.current?.resize(50)
          }, 0)
        } else {
          setShowPreview(true) // For mobile
        }
      }
      // Cmd+\ or Ctrl+\ - toggle/balance panels
      else if ((e.metaKey || e.ctrlKey) && e.key === '\\') {
        e.preventDefault()
        if (window.innerWidth >= 768) {
          setShowDesktopPreview(prev => !prev)
          if (showDesktopPreview) {
            setTimeout(() => {
              editorPanelRef.current?.resize(50)
              previewPanelRef.current?.resize(50)
            }, 0)
          }
        } else {
          setShowPreview(prev => !prev) // For mobile
        }
      }
    }

    document.addEventListener('keydown', handleKeyDown, true)
    return () => document.removeEventListener('keydown', handleKeyDown, true)
  }, [showCommandPalette, showDesktopPreview, showDocumentation, handleCloseCommandPalette, handleCloseDocumentation, handleCreateNewDocument, handleCloseCurrentDocument, createNewDocument, loadDocument])

  // Mobile swipe gestures  
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    if (window.innerWidth >= 768) return
    setTouchStart({ x: e.touches[0].clientX, y: e.touches[0].clientY })
  }, [])

  const handleTouchEnd = useCallback((e: React.TouchEvent) => {
    if (window.innerWidth >= 768) return
    
    const deltaX = e.changedTouches[0].clientX - touchStart.x
    const deltaY = e.changedTouches[0].clientY - touchStart.y
    
    if (Math.abs(deltaX) > Math.abs(deltaY) && Math.abs(deltaX) > 100) {
      if (deltaX > 0) {
        setShowPreview(false) // Swipe right - show code
      } else {
        setShowPreview(true) // Swipe left - show preview
      }
    }
  }, [touchStart])

  // Handle text selection from editor - placeholder for future cross-highlighting
  const handleEditorSelection = useCallback((_start: number, _end: number, _selectedText: string) => {
    // Selection handling - could be used for cross-highlighting with PDF
  }, [])

  // Modal handlers for command palette integration
  const handleOpenHelp = useCallback(() => {
    if (showCommandPalette) {
      setDocumentationOpenedFromPalette(true)
      handleCloseCommandPalette() // Close command palette with animation
    } else {
      setDocumentationOpenedFromPalette(false)
    }
    setShowDocumentation(true)
  }, [showCommandPalette, handleCloseCommandPalette])

  const handleBackFromDocumentation = useCallback(() => {
    setIsClosingDocumentation(true)
    setTimeout(() => {
      setIsClosingDocumentation(false)
      setShowDocumentation(false)
      setDocumentationOpenedFromPalette(false)
      setShowCommandPalette(true)
    }, 200) // Match animation duration
  }, [])

  const handleCreateFromTemplate = useCallback(async (template: string) => {
    const DocumentManager = (await import('./services/DocumentManager')).default
    await DocumentManager.createNew(template)
    // Reload the current document to reflect the new creation
    const currentDoc = DocumentManager.getCurrentDocument()
    if (currentDoc) {
      await loadDocument(currentDoc.id)
    }
  }, [loadDocument])

  // Loading state with improved design
  if (isLoading) {
    return (
      <div className="app">
        <div className="main-content" style={{ 
          display: 'flex', 
          alignItems: 'center', 
          justifyContent: 'center',
          minHeight: '100vh',
          color: '#f5f5f7',
          fontSize: '17px',
          fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif',
          fontWeight: 500,
          letterSpacing: '-0.01em'
        }}>
          <div style={{ 
            textAlign: 'center',
            opacity: 0,
            transform: 'translateY(12px)',
            animation: 'fadeInUp 0.6s cubic-bezier(0.23, 1, 0.32, 1) forwards'
          }}>
            <div style={{ 
              marginBottom: '20px', 
              fontSize: '28px',
              opacity: 0.4,
              animation: 'spin 2s linear infinite'
            }}>
              ⟳
            </div>
            Initializing Siglum...
          </div>
        </div>
      </div>
    )
  }

  // Error state with better design
  if (error) {
    return (
      <div className="app">
        <div className="main-content" style={{ 
          display: 'flex', 
          alignItems: 'center', 
          justifyContent: 'center',
          minHeight: '100vh',
          color: '#f0f0f0',
          fontSize: '16px',
          fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif'
        }}>
          <div style={{ textAlign: 'center' }}>
            <div style={{ 
              marginBottom: '16px', 
              fontSize: '32px',
              color: '#ff6b6b' 
            }}>
              ⚠
            </div>
            <div style={{ color: '#ff6b6b' }}>Error: {error}</div>
            <button 
              onClick={() => window.location.reload()} 
              style={{
                marginTop: '20px',
                padding: '8px 16px',
                background: '#2a2a2a',
                color: '#f0f0f0',
                border: '1px solid #333',
                borderRadius: '6px',
                cursor: 'pointer'
              }}
            >
              Reload
            </button>
          </div>
        </div>
      </div>
    )
  }

  // Empty state for first-time users
  if (!currentDocument) {
      return (
        <div className="app">
          <CommandPalette
            isOpen={showCommandPalette}
            isClosing={isClosingCommandPalette}
            onClose={() => setShowCommandPalette(false)}
            onSelectDocument={handleSelectDocument}
            onSelectFile={handleSelectFile}
            onCreateNew={handleCreateNewDocument}
            onOpenHelp={handleOpenHelp}
          />
          <EmptyState
            onOpenCommandPalette={() => setShowCommandPalette(true)}
          />
          <DocumentationModal
            isOpen={showDocumentation}
            isClosing={isClosingDocumentation}
            onClose={handleCloseDocumentation}
            onBack={documentationOpenedFromPalette ? handleBackFromDocumentation : undefined}
            onCreateFromTemplate={handleCreateFromTemplate}
          />
        </div>
      )
  }

  return (
    <div 
      className="app" 
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
    >
      <CommandPalette
        isOpen={showCommandPalette}
        isClosing={isClosingCommandPalette}
        onClose={() => setShowCommandPalette(false)}
        onSelectDocument={handleSelectDocument}
        onSelectFile={handleSelectFile}
        onCreateNew={handleCreateNewDocument}
        onOpenHelp={handleOpenHelp}
      />
      <div className="main-content">
        {/* Desktop: Side-by-side panels */}
        <div className={`desktop-view ${isLoaded ? 'loaded' : ''}`}>
          <PanelGroup direction="horizontal" autoSaveId="editor-preview-panels">
            <Panel ref={editorPanelRef} defaultSize={showDesktopPreview ? 55 : 100} minSize={20}>
              <div className="editor-with-sidebar">
                <ProjectSidebar
                  isExpanded={sidebarExpanded}
                  onToggle={() => setSidebarExpanded(prev => !prev)}
                  files={projectFiles}
                  onFilesChange={setProjectFiles}
                  onFileSelect={handleFileSelect}
                  selectedFileId={selectedFileId}
                  triggerGitConnect={triggerGitConnect}
                  onGitConnectTriggered={() => setTriggerGitConnect(false)}
                />
                <LaTeXEditor
                  value={latexCode}
                  onChange={handleLatexCodeChange}
                  onSelectionChange={handleEditorSelection}
                  compilerSettings={compilerSettings}
                  onCompilerSettingsChange={handleCompilerSettingsChange}
                  compileStatus={compileStatus}
                  compileTimeMs={compileTimeMs}
                  onCompile={compile}
                />
              </div>
            </Panel>
            
            {showDesktopPreview && (
              <>
                <PanelResizeHandle className="resize-handle" />

                <Panel ref={previewPanelRef} defaultSize={45} minSize={20}>
                  <div className={`pdf-preview-panel ${isLoaded ? 'loaded' : ''}`}>
                    <Suspense fallback={<div className="pdf-loading">Loading preview...</div>}>
                      <PDFViewer pdfData={pdfData ?? undefined} onCompile={compile} isCompiling={compileStatus === 'compiling' || compileStatus === 'initializing'} />
                    </Suspense>
                  </div>
                </Panel>
              </>
            )}
          </PanelGroup>
        </div>

        {/* Mobile: Single panel view */}
        <div className={`mobile-view ${isLoaded ? 'loaded' : ''}`}>
          <ProjectSidebar
            isExpanded={sidebarExpanded}
            onToggle={() => setSidebarExpanded(prev => !prev)}
            files={projectFiles}
            onFilesChange={setProjectFiles}
            onFileSelect={handleFileSelect}
            selectedFileId={selectedFileId}
            triggerGitConnect={triggerGitConnect}
            onGitConnectTriggered={() => setTriggerGitConnect(false)}
          />
          {sidebarExpanded && (
            <div
              className="mobile-sidebar-overlay"
              onClick={() => setSidebarExpanded(false)}
            />
          )}
          {!showPreview ? (
            <LaTeXEditor
              value={latexCode}
              onChange={handleLatexCodeChange}
              onSelectionChange={handleEditorSelection}
              onMenuClick={() => setSidebarExpanded(true)}
              compilerSettings={compilerSettings}
              onCompilerSettingsChange={handleCompilerSettingsChange}
              compileStatus={compileStatus}
              compileTimeMs={compileTimeMs}
              onCompile={compile}
            />
          ) : (
            <div className={`pdf-preview-panel ${isLoaded ? 'loaded' : ''}`}>
              <Suspense fallback={<div className="pdf-loading">Loading preview...</div>}>
                <PDFViewer pdfData={pdfData ?? undefined} onCompile={compile} isCompiling={compileStatus === 'compiling' || compileStatus === 'initializing'} />
              </Suspense>
            </div>
          )}
        </div>
      </div>
      
      <DocumentationModal
        isOpen={showDocumentation}
        isClosing={isClosingDocumentation}
        onClose={handleCloseDocumentation}
        onBack={documentationOpenedFromPalette ? handleBackFromDocumentation : undefined}
        onCreateFromTemplate={handleCreateFromTemplate}
      />
      {showOnboarding && (
        <Onboarding
          onComplete={() => setShowOnboarding(false)}
          onExpandSidebar={() => setSidebarExpanded(true)}
          onCollapseSidebar={() => setSidebarExpanded(false)}
          onConnectGithub={() => {
            setTriggerGitConnect(true)
            setSidebarExpanded(true)
          }}
        />
      )}

      {showConflictModal && (
        <div className="conflict-modal-overlay">
          <div className="conflict-modal">
            <h3 className="conflict-modal-title">Remote Changes Detected</h3>
            <a
              href={`https://github.com/${GitService.getConfig()?.repoUrl}/commits`}
              target="_blank"
              rel="noopener noreferrer"
              className="conflict-modal-repo"
            >
              {GitService.getConfig()?.repoUrl}
            </a>
            <p className="conflict-modal-description">
              The remote repository has been updated since you started editing.
              You can pull the remote changes (your local edits will be lost) or
              continue editing (your changes will overwrite remote on next sync).
            </p>
            <div className="conflict-modal-actions">
              <button className="conflict-modal-btn secondary" onClick={handleKeepLocal}>
                Continue Editing
              </button>
              <button className="conflict-modal-btn primary" onClick={handleUseRemote}>
                Use Remote Version
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default App