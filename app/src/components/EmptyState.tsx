import React, { useState } from 'react'
import { Github } from 'lucide-react'
import DocumentationModal from './DocumentationModal'
import { useIsMobile } from '../hooks/useIsMobile'
import './EmptyState.css'

interface EmptyStateProps {
  onOpenCommandPalette: () => void
}

const EmptyState: React.FC<EmptyStateProps> = ({ onOpenCommandPalette }) => {
  const [showDocumentation, setShowDocumentation] = useState(false)
  const [defaultTab, setDefaultTab] = useState<'guide' | 'templates'>('guide')
  const isMobile = useIsMobile()

  const handleCreateWithTemplate = async () => {
    // Create document directly with the template using DocumentManager
    const DocumentManager = (await import('../services/DocumentManager')).default

    const starterTemplate = `\\documentclass{article}
\\usepackage{amsmath}

\\begin{document}

Hello, world!

$E = mc^2$

\\end{document}`

    await DocumentManager.createNew(starterTemplate)
  }

  const handleCreateFromTemplate = async (template: string) => {
    const DocumentManager = (await import('../services/DocumentManager')).default
    await DocumentManager.createNew(template)
  }

  const openTemplates = () => {
    setDefaultTab('templates')
    setShowDocumentation(true)
  }

  const openHelp = () => {
    setDefaultTab('guide')
    setShowDocumentation(true)
  }

  return (
    <div className="empty-state">
      <div className="empty-state-content">
        <h1 className="empty-state-title">Siglum</h1>
        <p className="empty-state-subtitle">
          Write like nobody's watching
        </p>
        <p className="empty-state-description">
          A LaTeX editor for work that needs your full attention. Works offline. No accounts. No compilation queues. Everything runs in your browser.
        </p>

        <div className="empty-state-actions">
          <button
            className="primary-cta"
            onClick={handleCreateWithTemplate}
          >
            <span>Start writing</span>
          </button>
        </div>

        <div className="empty-state-secondary">
          <button
            className="link-button"
            onClick={openTemplates}
          >
            Templates
          </button>
          <span className="separator">·</span>
          <button
            className="link-button"
            onClick={openHelp}
          >
            {isMobile ? 'Help' : <>Help <kbd>⌘H</kbd></>}
          </button>
          <span className="separator">·</span>
          <button
            className="link-button search-button"
            onClick={onOpenCommandPalette}
          >
            {isMobile ? 'Search' : <>Search <kbd>⌘K</kbd></>}
          </button>
        </div>

        {isMobile && (
          <p className="mobile-hint">
            Swipe left to view PDF · Menu ☰ for files
          </p>
        )}

        <a
          href="https://github.com/SiglumProject"
          target="_blank"
          rel="noopener noreferrer"
          className="github-link-bottom"
        >
          <Github size={16} />
          <span>GitHub</span>
        </a>
      </div>

      <DocumentationModal
        isOpen={showDocumentation}
        onClose={() => setShowDocumentation(false)}
        onCreateFromTemplate={handleCreateFromTemplate}
        defaultTab={defaultTab}
      />
    </div>
  )
}

export default EmptyState
