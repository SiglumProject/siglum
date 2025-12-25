import React, { useState, useEffect, useCallback, useRef } from 'react'
import { Search, FileText, Plus, RotateCw, HelpCircle, File } from 'lucide-react'
import type { SearchResult } from '../types/Document'
import DocumentSearcher from '../services/DocumentSearcher'
import ProjectSearcher from '../services/ProjectSearcher'
import type { FileSearchResult } from '../services/ProjectSearcher'
import './CommandPalette.css'

interface CommandPaletteProps {
  isOpen: boolean
  isClosing?: boolean
  onClose: () => void
  onSelectDocument: (documentId: string) => void
  onSelectFile?: (filePath: string, lineNumber?: number) => void
  onCreateNew: () => void
  onOpenHelp?: () => void
}

interface Command {
  id: string
  title: string
  subtitle?: string
  icon: React.ReactNode
  action: () => void
  category?: 'action' | 'navigation'
  shortcut?: string
}

const CommandPalette: React.FC<CommandPaletteProps> = ({
  isOpen,
  isClosing = false,
  onClose,
  onSelectDocument,
  onSelectFile,
  onCreateNew,
  onOpenHelp
}) => {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [fileResults, setFileResults] = useState<FileSearchResult[]>([])
  const [commands, setCommands] = useState<Command[]>([])
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [isSearching, setIsSearching] = useState(false)
  const [internalClosing, setInternalClosing] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // Get all available commands
  const getDefaultCommands = useCallback((): Command[] => {
    const commands: Command[] = [
      {
        id: 'new-document',
        title: 'New Document',
        icon: <Plus size={16} />,
        category: 'action',
        action: () => {
          onCreateNew()
          onClose()
        }
      }
    ]

    // Add help command if handler provided
    if (onOpenHelp) {
      commands.push({
        id: 'help',
        title: 'Help',
        subtitle: 'Documentation, guides, and templates',
        icon: <HelpCircle size={16} />,
        category: 'navigation',
        action: () => {
          onOpenHelp()
          onClose()
        }
      })
    }

    return commands
  }, [onCreateNew, onClose, onOpenHelp])

  // Natural language intent detection
  const detectIntent = useCallback((query: string) => {
    const lowerQuery = query.toLowerCase().trim()
    const allCommands = getDefaultCommands()
    
    // Intent keywords mapping
    const intentMap = {
      // Creation intents
      create: ['create', 'new', 'make', 'start', 'begin', 'add'],
      help: ['help', 'docs', 'guide', 'documentation', 'tutorial', 'how', 'what', 'info', 'template', 'example', 'sample', 'starter'],

      // Direct command matching
      exact: allCommands.map(cmd => ({
        command: cmd,
        triggers: [
          cmd.title.toLowerCase(),
          ...(cmd.subtitle ? [cmd.subtitle.toLowerCase()] : [])
        ]
      }))
    }

    // Check for intent keywords
    const relevantCommands = []

    // Direct exact matches first
    for (const { command, triggers } of intentMap.exact) {
      if (triggers.some(trigger =>
        trigger.includes(lowerQuery) || lowerQuery.includes(trigger)
      )) {
        relevantCommands.push(command)
      }
    }

    // Intent-based matching
    if (intentMap.create.some(word => lowerQuery.includes(word))) {
      const newDocCmd = allCommands.find(cmd => cmd.id === 'new-document')
      if (newDocCmd && !relevantCommands.includes(newDocCmd)) {
        relevantCommands.push(newDocCmd)
      }
    }

    if (intentMap.help.some(word => lowerQuery.includes(word))) {
      const helpCmd = allCommands.find(cmd => cmd.id === 'help')
      if (helpCmd && !relevantCommands.includes(helpCmd)) {
        relevantCommands.push(helpCmd)
      }
    }

    return relevantCommands
  }, [getDefaultCommands])

  // Search for documents and commands with smart context
  const performSearch = useCallback(async (searchQuery: string) => {
    if (!searchQuery.trim()) {
      // Empty state: show recent documents and project files
      const recentResults = await DocumentSearcher.search('', { maxResults: 8 })
      setCommands([])
      setResults(recentResults)
      setFileResults([])
      return
    }

    setIsSearching(true)
    try {
      // Search for documents and project files in parallel
      const [searchResults, projectFileResults] = await Promise.all([
        DocumentSearcher.search(searchQuery, {
          maxResults: 5,
          includeContent: true,
          fuzzyMatch: true
        }),
        ProjectSearcher.search(searchQuery, {
          maxResults: 8,
          searchContent: true
        })
      ])

      // Use natural language intent detection
      const intentBasedCommands = detectIntent(searchQuery)

      setResults(searchResults)
      setFileResults(projectFileResults)
      setCommands(intentBasedCommands)
    } catch (error) {
      console.error('Search error:', error)
      setResults([])
      setFileResults([])
      setCommands([])
    } finally {
      setIsSearching(false)
    }
  }, [getDefaultCommands, detectIntent])

  // Debounced search
  useEffect(() => {
    const timeoutId = setTimeout(() => {
      performSearch(query)
    }, 150)
    
    return () => clearTimeout(timeoutId)
  }, [query, performSearch])

  // Handle close with animation (for internal triggers like ESC, overlay click)
  const handleClose = useCallback(() => {
    setInternalClosing(true)
    setTimeout(() => {
      setInternalClosing(false)
      onClose()
    }, 200) // Match animation duration
  }, [onClose])

  // Combined closing state - either external or internal
  const isCurrentlyClosing = isClosing || internalClosing

  // Reset when opening/closing
  useEffect(() => {
    if (isOpen) {
      setInternalClosing(false)
      setQuery('')
      setSelectedIndex(0)
      performSearch('')
      // Focus input after a brief delay to ensure it's rendered
      setTimeout(() => {
        inputRef.current?.focus()
      }, 100)
    }
  }, [isOpen, performSearch])

  // Update selected index when results change
  useEffect(() => {
    setSelectedIndex(0)
  }, [results, fileResults, commands])

  // Keyboard navigation
  useEffect(() => {
    if (!isOpen) return

    const handleKeyDown = (e: KeyboardEvent) => {
      const totalItems = commands.length + fileResults.length + results.length

      switch (e.key) {
        case 'Escape':
          e.preventDefault()
          handleClose()
          break

        case 'ArrowDown':
          e.preventDefault()
          setSelectedIndex(prev => (prev + 1) % totalItems)
          break

        case 'ArrowUp':
          e.preventDefault()
          setSelectedIndex(prev => (prev - 1 + totalItems) % totalItems)
          break

        case 'Enter':
          e.preventDefault()
          handleItemClick(selectedIndex)
          break
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, selectedIndex, commands, fileResults, results, handleClose, onSelectDocument, onSelectFile])

  // Scroll selected item into view
  useEffect(() => {
    if (listRef.current) {
      const selectedElement = listRef.current.children[selectedIndex] as HTMLElement
      if (selectedElement) {
        selectedElement.scrollIntoView({
          block: 'nearest',
          behavior: 'smooth'
        })
      }
    }
  }, [selectedIndex])

  const handleItemClick = (index: number) => {
    if (index < commands.length) {
      // Command item clicked
      if (commands[index]) {
        commands[index].action()
      }
    } else if (index < commands.length + fileResults.length) {
      // Project file item clicked
      const fileIndex = index - commands.length
      const result = fileResults[fileIndex]
      if (result && onSelectFile) {
        onSelectFile(result.file.path, result.lineNumber)
        handleClose()
      }
    } else {
      // Document item clicked
      const docIndex = index - commands.length - fileResults.length
      if (results[docIndex]) {
        onSelectDocument(results[docIndex].document.id)
        handleClose()
      }
    }
  }

  const formatDate = (date: Date): string => {
    const now = new Date()
    const diffTime = now.getTime() - date.getTime()
    const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24))
    
    if (diffDays === 0) return 'Today'
    if (diffDays === 1) return 'Yesterday'
    if (diffDays < 7) return `${diffDays} days ago`
    if (diffDays < 30) return `${Math.floor(diffDays / 7)} weeks ago`
    return date.toLocaleDateString()
  }

  if (!isOpen) return null

  return (
    <div className={`command-palette-overlay ${isCurrentlyClosing ? 'closing' : ''}`} onClick={handleClose}>
      <div className="command-palette-container">
        {/* Main Command Palette */}
        <div className={`command-palette-glow ${isCurrentlyClosing ? 'closing' : ''}`}>
        <div className={`command-palette ${isCurrentlyClosing ? 'closing' : ''}`} onClick={e => e.stopPropagation()}>
          <div className="command-palette-header">
            <div className="search-icon">
              <Search size={16} />
            </div>
            <input
              ref={inputRef}
              type="text"
              placeholder={query ? "Search or type a command..." : "Search documents or type a command..."}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="command-palette-input"
            />
            <div className="command-palette-hint">
              <kbd>↑</kbd><kbd>↓</kbd> navigate • <kbd>↵</kbd> select • <kbd>esc</kbd> close
            </div>
          </div>
          
          <div className="command-palette-results" ref={listRef}>
            {isSearching && (
              <div className="command-palette-loading">
                <div className="loading-spinner">
                  <RotateCw size={16} />
                </div>
                Searching...
              </div>
            )}

            {!isSearching && (
              <>
                {/* Commands Section - shown when searching */}
                {commands.length > 0 && (
                  <div className="commands-section">
                    <div className="section-header">Commands</div>
                    {commands.map((command, index) => {
                      const itemIndex = index
                      return (
                        <div
                          key={command.id}
                          className={`command-palette-item command-item ${itemIndex === selectedIndex ? 'selected' : ''}`}
                          onClick={() => handleItemClick(itemIndex)}
                        >
                          <div className="item-icon">{command.icon}</div>
                          <div className="item-content">
                            <div className="item-title">{command.title}</div>
                            {command.subtitle && (
                              <div className="item-subtitle">{command.subtitle}</div>
                            )}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}

                {/* Project Files Section */}
                {fileResults.length > 0 && (
                  <div className="files-section">
                    <div className="section-header">Project Files</div>
                    {fileResults.map((result, index) => {
                      const itemIndex = commands.length + index
                      return (
                        <div
                          key={result.file.path}
                          className={`command-palette-item file-item ${itemIndex === selectedIndex ? 'selected' : ''}`}
                          onClick={() => handleItemClick(itemIndex)}
                        >
                          <div className="item-icon">
                            <File size={16} />
                          </div>
                          <div className="item-content">
                            <div className="item-title">{result.file.name}</div>
                            <div className="item-subtitle">
                              {result.matchType === 'content' && result.lineNumber
                                ? `Line ${result.lineNumber} · ${result.file.path}`
                                : result.file.path}
                            </div>
                            {result.snippet && (
                              <div className="item-snippet">{result.snippet}</div>
                            )}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}

                {/* Document Results */}
                {results.length > 0 && (
                  <div className="documents-section">
                    <div className="section-header">
                      {query ? 'Documents' : 'Recent'}
                    </div>
                    {results.map((result, index) => {
                      const itemIndex = commands.length + fileResults.length + index
                      return (
                        <div
                          key={result.document.id}
                          className={`command-palette-item document-item ${itemIndex === selectedIndex ? 'selected' : ''}`}
                          onClick={() => handleItemClick(itemIndex)}
                        >
                          <div className="item-icon">
                            <FileText size={16} />
                          </div>
                          <div className="item-content">
                            <div className="item-title">
                              {result.highlights.length > 0 ? (
                                <span dangerouslySetInnerHTML={{ __html: result.highlights[0] }} />
                              ) : (
                                result.document.title
                              )}
                            </div>
                            <div className="item-subtitle">
                              {formatDate(result.document.lastViewedAt)}
                            </div>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}

                {/* Empty State */}
                {results.length === 0 && fileResults.length === 0 && commands.length === 0 && (
                  <div className="command-palette-empty">
                    {query ? (
                      <div className="empty-with-suggestion">
                        <div className="empty-message">No results for "{query}"</div>
                        <div className="empty-suggestion">
                          Try "new" or "help"
                        </div>
                      </div>
                    ) : (
                      <div className="empty-welcome">
                        <div className="empty-message">No recent documents</div>
                        <div className="empty-suggestion">
                          Type "new" to create a document
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
        </div>
      </div>
    </div>
  )
}

export default CommandPalette