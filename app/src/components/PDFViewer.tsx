/**
 * PDFViewer - Full-featured PDF viewer using pdf.js
 *
 * Features:
 * - Search with highlight
 * - Light/dark mode
 * - Zoom presets dropdown
 * - Fit-width mode
 * - Text selection
 */

import React, { useState, useRef, useEffect, useCallback } from 'react'
import { ChevronLeft, ChevronRight, Search, Sun, Moon, ChevronUp, ChevronDown, X, Download } from 'lucide-react'
import * as pdfjsLib from 'pdfjs-dist'
import type { TextItem } from 'pdfjs-dist/types/src/display/api'
import './PDFViewer.css'

// Set worker path
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url
).toString()

interface PDFViewerProps {
  pdfUrl?: string
  pdfData?: ArrayBuffer
  onCompile?: () => void
  isCompiling?: boolean
}

interface SearchMatch {
  pageNum: number
  itemIndex: number
  text: string
  startIndex: number
  endIndex: number
}

interface TextItemWithTransform extends TextItem {
  transform: number[]
}

const ZOOM_PRESETS = [
  { label: '50%', value: 0.5 },
  { label: '75%', value: 0.75 },
  { label: '100%', value: 1.0 },
  { label: '125%', value: 1.25 },
  { label: '150%', value: 1.5 },
  { label: '200%', value: 2.0 },
]

const PDFViewer: React.FC<PDFViewerProps> = ({ pdfUrl, pdfData, onCompile, isCompiling }) => {
  const [pdf, setPdf] = useState<pdfjsLib.PDFDocumentProxy | null>(null)
  const [currentPage, setCurrentPage] = useState(1)
  const [pageCount, setPageCount] = useState(0)
  const [scale, setScale] = useState(1)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [isLightMode, setIsLightMode] = useState(false)
  const [fitWidth, setFitWidth] = useState(true)
  const [showZoomPresets, setShowZoomPresets] = useState(false)

  // Search state
  const [searchQuery, setSearchQuery] = useState('')
  const [searchMatches, setSearchMatches] = useState<SearchMatch[]>([])
  const [currentMatchIndex, setCurrentMatchIndex] = useState(0)
  const [showSearch, setShowSearch] = useState(false)

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const documentRef = useRef<HTMLDivElement>(null)
  const renderTaskRef = useRef<pdfjsLib.RenderTask | null>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const textLayerRef = useRef<HTMLDivElement>(null)
  const highlightLayerRef = useRef<HTMLDivElement>(null)
  const zoomButtonRef = useRef<HTMLButtonElement>(null)

  // Load PDF document
  useEffect(() => {
    // No source provided - show empty state
    if (!pdfData && !pdfUrl) {
      setPdf(null)
      setIsLoading(false)
      return
    }

    const loadPdf = async () => {
      try {
        // Only show loading on initial load, not on updates (to prevent flash)
        if (!pdf) {
          setIsLoading(true)
        }
        setError(null)

        let loadingTask: pdfjsLib.PDFDocumentLoadingTask

        if (pdfData) {
          loadingTask = pdfjsLib.getDocument({ data: pdfData })
        } else if (pdfUrl) {
          loadingTask = pdfjsLib.getDocument(pdfUrl)
        } else {
          return
        }

        const pdfDoc = await loadingTask.promise
        setPdf(pdfDoc)
        setPageCount(pdfDoc.numPages)
        setIsLoading(false)
      } catch (err) {
        console.error('Failed to load PDF:', err)
        setError('Failed to load PDF')
        setIsLoading(false)
      }
    }

    loadPdf()

    return () => {
      if (renderTaskRef.current) {
        renderTaskRef.current.cancel()
      }
    }
  }, [pdfUrl, pdfData])

  // Render current page
  const renderPage = useCallback(async () => {
    if (!pdf || !canvasRef.current) return

    // Cancel any ongoing render and wait for it
    if (renderTaskRef.current) {
      try {
        renderTaskRef.current.cancel()
        await renderTaskRef.current.promise
      } catch {
        // Ignore cancellation errors
      }
      renderTaskRef.current = null
    }

    try {
      const page = await pdf.getPage(currentPage)
      const viewport = page.getViewport({ scale })

      const canvas = canvasRef.current
      const context = canvas.getContext('2d')
      if (!context) return

      // Set canvas size
      const pixelRatio = window.devicePixelRatio || 1
      canvas.width = viewport.width * pixelRatio
      canvas.height = viewport.height * pixelRatio
      canvas.style.width = `${viewport.width}px`
      canvas.style.height = `${viewport.height}px`

      // Clear canvas before rendering
      context.clearRect(0, 0, canvas.width, canvas.height)
      context.scale(pixelRatio, pixelRatio)

      renderTaskRef.current = page.render({
        canvasContext: context,
        viewport: viewport,
        canvas: canvas,
      })
      await renderTaskRef.current.promise

      // Render text layer for selection
      await renderTextLayer(page, viewport)

      // Render search highlights if there are matches
      if (searchMatches.length > 0) {
        renderSearchHighlights(page, viewport)
      }
    } catch (err: unknown) {
      // Ignore cancelled renders
      if (err instanceof Error && err.name !== 'RenderingCancelledException') {
        console.error('Render error:', err)
      }
    }
  }, [pdf, currentPage, scale, searchMatches])

  // Render text layer for selection
  // Uses scaleX transform to match text width to PDF bounding box (same approach as pdf.js)
  const renderTextLayer = async (page: pdfjsLib.PDFPageProxy, viewport: pdfjsLib.PageViewport) => {
    if (!textLayerRef.current) return

    const textContent = await page.getTextContent()
    const textLayerDiv = textLayerRef.current
    textLayerDiv.innerHTML = ''
    textLayerDiv.style.width = `${viewport.width}px`
    textLayerDiv.style.height = `${viewport.height}px`

    // Create a canvas context for measuring text
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    textContent.items.forEach((item) => {
      if (!('str' in item) || !item.str) return
      const textItem = item as TextItemWithTransform

      const span = document.createElement('span')
      span.textContent = textItem.str

      const tx = textItem.transform[4] * scale
      const ty = textItem.transform[5] * scale
      const fontSize = Math.sqrt(textItem.transform[0] ** 2 + textItem.transform[1] ** 2) * scale
      const fontFamily = 'sans-serif'

      // Get the width from PDF (if available) or estimate from transform
      const pdfWidth = (textItem.width || 0) * scale

      // Measure the text as it will render in the browser
      ctx.font = `${fontSize}px ${fontFamily}`
      const measuredWidth = ctx.measureText(textItem.str).width

      // Calculate scaleX to fit the PDF bounding box
      const scaleX = pdfWidth > 0 && measuredWidth > 0 ? pdfWidth / measuredWidth : 1

      // ty is baseline from bottom of page in PDF coords
      // Convert to top-left CSS coords, accounting for ascender (text above baseline)
      span.style.left = `${tx}px`
      span.style.top = `${viewport.height - ty - fontSize * 0.3}px`
      span.style.fontSize = `${fontSize}px`
      span.style.fontFamily = fontFamily
      span.style.position = 'absolute'
      span.style.whiteSpace = 'pre'
      span.style.pointerEvents = 'auto'
      span.style.cursor = 'text'
      span.style.transformOrigin = '0% 0%'
      span.style.transform = `scaleX(${scaleX})`

      textLayerDiv.appendChild(span)
    })
  }

  // Render search highlights
  const renderSearchHighlights = async (page: pdfjsLib.PDFPageProxy, viewport: pdfjsLib.PageViewport) => {
    if (!highlightLayerRef.current) return

    const highlightLayer = highlightLayerRef.current
    highlightLayer.innerHTML = ''
    highlightLayer.style.width = `${viewport.width}px`
    highlightLayer.style.height = `${viewport.height}px`

    const textContent = await page.getTextContent()
    const pageMatches = searchMatches.filter(m => m.pageNum === currentPage)

    pageMatches.forEach((match) => {
      const globalIdx = searchMatches.findIndex(
        m => m.pageNum === match.pageNum && m.itemIndex === match.itemIndex && m.startIndex === match.startIndex
      )
      const isActive = globalIdx === currentMatchIndex

      const item = textContent.items[match.itemIndex]
      if (!item || !('str' in item)) return
      const textItem = item as TextItemWithTransform

      const [, , , , tx, ty] = textItem.transform
      const fontSize = Math.sqrt(textItem.transform[0] ** 2 + textItem.transform[1] ** 2)

      // Create highlight element
      const highlight = document.createElement('div')
      highlight.className = `search-highlight${isActive ? ' active' : ''}`

      // Approximate position and width
      const charWidth = (textItem.width || fontSize * 0.6) / textItem.str.length
      const left = tx + match.startIndex * charWidth
      const width = (match.endIndex - match.startIndex) * charWidth

      highlight.style.position = 'absolute'
      highlight.style.left = `${left * scale}px`
      highlight.style.top = `${(viewport.height / scale - ty) * scale - fontSize * scale}px`
      highlight.style.width = `${width * scale}px`
      highlight.style.height = `${fontSize * scale * 1.2}px`

      highlightLayer.appendChild(highlight)
    })
  }

  useEffect(() => {
    renderPage()
  }, [renderPage])

  // Fit width calculation
  const calculateFitWidth = useCallback(async () => {
    if (!pdf || !containerRef.current) return

    const page = await pdf.getPage(1)
    const viewport = page.getViewport({ scale: 1 })
    const containerWidth = containerRef.current.clientWidth - 48 // padding
    const optimalScale = containerWidth / viewport.width
    return Math.min(optimalScale, 3) // Cap at 300%
  }, [pdf])

  // Fit width on initial load - wait for container to have size
  useEffect(() => {
    if (!pdf || !fitWidth || !containerRef.current) return

    const doFitWidth = async () => {
      // Wait a frame for container to be sized
      await new Promise(resolve => requestAnimationFrame(resolve))
      const optimalScale = await calculateFitWidth()
      if (optimalScale) setScale(optimalScale)
    }

    doFitWidth()
  }, [pdf, fitWidth, calculateFitWidth])

  // Resize handler - always fit to container width
  useEffect(() => {
    if (!pdf || !containerRef.current) return

    const resizeObserver = new ResizeObserver(async () => {
      const optimalScale = await calculateFitWidth()
      if (optimalScale) {
        // If fitWidth is enabled, always use optimal scale
        // If not, cap the current scale to not exceed container
        if (fitWidth) {
          setScale(optimalScale)
        } else if (scale > optimalScale) {
          setScale(optimalScale)
        }
      }
    })

    resizeObserver.observe(containerRef.current)
    return () => resizeObserver.disconnect()
  }, [pdf, fitWidth, scale, calculateFitWidth])

  // Search functionality
  const performSearch = useCallback(async () => {
    if (!pdf || !searchQuery.trim()) {
      setSearchMatches([])
      return
    }

    const matches: SearchMatch[] = []
    const query = searchQuery.toLowerCase()

    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      const page = await pdf.getPage(pageNum)
      const textContent = await page.getTextContent()

      textContent.items.forEach((item, itemIndex) => {
        if (!('str' in item)) return
        const text = item.str.toLowerCase()
        let startIndex = 0

        while (true) {
          const idx = text.indexOf(query, startIndex)
          if (idx === -1) break

          matches.push({
            pageNum,
            itemIndex,
            text: item.str.substring(idx, idx + query.length),
            startIndex: idx,
            endIndex: idx + query.length,
          })

          startIndex = idx + 1
        }
      })
    }

    setSearchMatches(matches)
    setCurrentMatchIndex(0)

    // Navigate to first match
    if (matches.length > 0) {
      setCurrentPage(matches[0].pageNum)
    }
  }, [pdf, searchQuery])

  // Handle search on Enter
  const handleSearchKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      if (e.shiftKey) {
        goToPrevMatch()
      } else {
        if (searchMatches.length === 0) {
          performSearch()
        } else {
          goToNextMatch()
        }
      }
    } else if (e.key === 'Escape') {
      setShowSearch(false)
      setSearchQuery('')
      setSearchMatches([])
    }
  }

  // Navigate matches
  const goToNextMatch = () => {
    if (searchMatches.length === 0) return
    const nextIndex = (currentMatchIndex + 1) % searchMatches.length
    setCurrentMatchIndex(nextIndex)
    setCurrentPage(searchMatches[nextIndex].pageNum)
  }

  const goToPrevMatch = () => {
    if (searchMatches.length === 0) return
    const prevIndex = (currentMatchIndex - 1 + searchMatches.length) % searchMatches.length
    setCurrentMatchIndex(prevIndex)
    setCurrentPage(searchMatches[prevIndex].pageNum)
  }

  // Navigation
  const goToPrev = () => setCurrentPage(p => Math.max(1, p - 1))
  const goToNext = () => setCurrentPage(p => Math.min(pageCount, p + 1))

  const setZoomPreset = (value: number) => {
    setFitWidth(false)
    setScale(value)
    setShowZoomPresets(false)
  }

  const toggleFitWidth = async () => {
    setFitWidth(true)
    const optimalScale = await calculateFitWidth()
    if (optimalScale) setScale(optimalScale)
    setShowZoomPresets(false)
  }

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Cmd/Ctrl + F to open search
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault()
        setShowSearch(true)
        setTimeout(() => searchInputRef.current?.focus(), 0)
        return
      }

      // Don't handle if search input is focused
      if (document.activeElement === searchInputRef.current) return

      if (e.key === 'ArrowLeft') goToPrev()
      if (e.key === 'ArrowRight') goToNext()
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [pageCount])

  // Close zoom presets when clicking outside
  useEffect(() => {
    if (!showZoomPresets) return

    const handleClick = (e: MouseEvent) => {
      if (zoomButtonRef.current && !zoomButtonRef.current.contains(e.target as Node)) {
        setShowZoomPresets(false)
      }
    }

    document.addEventListener('click', handleClick)
    return () => document.removeEventListener('click', handleClick)
  }, [showZoomPresets])

  return (
    <div className={`pdf-viewer${isLightMode ? '' : ' pdf-dark-mode'}`} ref={containerRef}>
      {/* Top toolbar */}
      <div className="pdf-combined-controls">
        <div className="controls-left">
          {showSearch ? (
            <div className="control-group search-group">
              <input
                ref={searchInputRef}
                type="text"
                className="search-input"
                placeholder="Search..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={handleSearchKeyDown}
                autoFocus
              />
              {searchMatches.length > 0 && (
                <>
                  <span className="search-count">
                    {currentMatchIndex + 1}/{searchMatches.length}
                  </span>
                  <button
                    className="control-button search-nav"
                    onClick={goToPrevMatch}
                    title="Previous match (Shift+Enter)"
                  >
                    <ChevronUp size={12} />
                  </button>
                  <button
                    className="control-button search-nav"
                    onClick={goToNextMatch}
                    title="Next match (Enter)"
                  >
                    <ChevronDown size={12} />
                  </button>
                </>
              )}
              <button
                className="control-button"
                onClick={() => {
                  setShowSearch(false)
                  setSearchQuery('')
                  setSearchMatches([])
                }}
                title="Close search (Esc)"
              >
                <X size={14} />
              </button>
            </div>
          ) : (
            <button
              className="control-button"
              onClick={() => {
                setShowSearch(true)
                setTimeout(() => searchInputRef.current?.focus(), 0)
              }}
              title="Search (Cmd/Ctrl+F)"
            >
              <Search size={14} />
            </button>
          )}
        </div>

        <div className="controls-center">
          {pageCount > 1 && (
            <div className="control-group">
              <button
                className="control-button"
                onClick={goToPrev}
                disabled={currentPage === 1}
                title="Previous page"
              >
                <ChevronLeft size={14} />
              </button>
              <span className="page-info">
                {currentPage} / {pageCount}
              </span>
              <button
                className="control-button"
                onClick={goToNext}
                disabled={currentPage === pageCount}
                title="Next page"
              >
                <ChevronRight size={14} />
              </button>
            </div>
          )}

          <div className="control-group" style={{ position: 'relative' }}>
            <button
              ref={zoomButtonRef}
              className="zoom-level"
              onClick={() => setShowZoomPresets(!showZoomPresets)}
              title="Zoom presets"
            >
              {fitWidth ? 'Fit' : `${Math.round(scale * 100)}%`}
            </button>

            {showZoomPresets && (
              <div className="zoom-presets">
                <button
                  className={`zoom-preset${fitWidth ? ' active' : ''}`}
                  onClick={toggleFitWidth}
                >
                  Fit Width
                </button>
                <div className="zoom-presets-separator" />
                {ZOOM_PRESETS.map((preset) => (
                  <button
                    key={preset.value}
                    className={`zoom-preset${!fitWidth && Math.abs(scale - preset.value) < 0.01 ? ' active' : ''}`}
                    onClick={() => setZoomPreset(preset.value)}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="control-separator" />

          <button
            className={`control-button${isLightMode ? ' active' : ''}`}
            onClick={() => setIsLightMode(!isLightMode)}
            title={isLightMode ? 'Switch to dark mode' : 'Switch to light mode'}
          >
            {isLightMode ? <Moon size={14} /> : <Sun size={14} />}
          </button>
        </div>

        <div className="controls-right">
          <button
            className="control-button"
            onClick={() => {
              if (pdfData) {
                const blob = new Blob([pdfData], { type: 'application/pdf' })
                const url = URL.createObjectURL(blob)
                const a = document.createElement('a')
                a.href = url
                a.download = 'document.pdf'
                a.click()
                URL.revokeObjectURL(url)
              } else {
                window.open(pdfUrl, '_blank')
              }
            }}
            title="Download PDF"
          >
            <Download size={14} />
          </button>
        </div>
      </div>

      {/* PDF content */}
      <div className="pdf-document" ref={documentRef}>
        {isLoading ? (
          <div className="pdf-loading">Loading PDF...</div>
        ) : error ? (
          <div className="pdf-error">{error}</div>
        ) : !pdf ? (
          <div className="pdf-empty">
            {isCompiling ? (
              <span>Downloading Compiler...</span>
            ) : (
              onCompile && (
                <button
                  className="pdf-compile-button"
                  onClick={onCompile}
                >
                  Compile
                </button>
              )
            )}
          </div>
        ) : (
          <div className="pdf-page-wrapper">
            <div className={`pdf-page-filter ${isLightMode ? 'light' : 'dark'}`}>
              <canvas ref={canvasRef} className="pdf-page-canvas" />
            </div>
            <div ref={textLayerRef} className="pdf-text-layer" />
            <div ref={highlightLayerRef} className="pdf-search-highlight-layer" />
          </div>
        )}
      </div>
    </div>
  )
}

export default PDFViewer
