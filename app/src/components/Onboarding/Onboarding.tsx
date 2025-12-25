import React, { useState, useEffect, useRef } from 'react'
import { ChevronLeft, ChevronRight, Github, Settings } from 'lucide-react'
import './Onboarding.css'

interface OnboardingProps {
  onComplete: () => void
  onExpandSidebar: () => void
  onCollapseSidebar: () => void
  onConnectGithub: () => void
}

const steps = [
  {
    id: 'editor',
    title: 'The Editor',
    description: 'Write LaTeX with syntax highlighting, auto-completion, and smart formatting.',
    highlight: 'editor'
  },
  {
    id: 'settings',
    title: 'Compiler Settings',
    description: '',
    highlight: 'settings',
    hasSettingsDetail: true
  },
  {
    id: 'preview',
    title: 'Live Preview',
    description: 'See your compiled PDF in real-time. Adjust zoom, toggle light mode, search text, and navigate pages.',
    highlight: 'preview'
  },
  {
    id: 'project',
    title: 'Your Project',
    description: 'Manage files, folders, and sync with GitHub. Your files never touch our servers—everything stays in your browser. We only serve TeX bundles, and this site.',
    highlight: 'sidebar',
    hasFooter: true
  }
]

const Onboarding: React.FC<OnboardingProps> = ({ onComplete, onExpandSidebar, onCollapseSidebar, onConnectGithub }) => {
  const [currentStep, setCurrentStep] = useState(0)
  const [displayStep, setDisplayStep] = useState(0)
  const [isExiting, setIsExiting] = useState(false)
  const [isPulsing, setIsPulsing] = useState(false)
  const [isReady, setIsReady] = useState(false)
  const [isTransitioning, setIsTransitioning] = useState(false)
  const [editorWidth, setEditorWidth] = useState<number | null>(null)
  const [settingsButtonPos, setSettingsButtonPos] = useState<{ top: number; left: number } | null>(null)
  const overlayRef = useRef<HTMLDivElement>(null)

  const step = steps[displayStep]
  const isLastStep = currentStep === steps.length - 1

  // Calculate editor panel width and settings button position dynamically
  useEffect(() => {
    const calculatePositions = () => {
      // Find the PDF preview panel by looking for the pdf-preview-panel class
      const previewPanel = document.querySelector('.pdf-preview-panel')
      if (previewPanel) {
        const rect = previewPanel.getBoundingClientRect()
        setEditorWidth(rect.left)
      }

      // Find the settings button to position mock dropdown
      const settingsButton = document.querySelector('.compiler-settings-button')
      if (settingsButton) {
        const rect = settingsButton.getBoundingClientRect()
        setSettingsButtonPos({
          top: rect.bottom + 12,
          left: rect.left + rect.width / 2
        })
      }
    }

    // Calculate on mount and after a short delay to ensure panels are rendered
    calculatePositions()
    const timer = setTimeout(calculatePositions, 100)

    // Recalculate on resize
    window.addEventListener('resize', calculatePositions)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('resize', calculatePositions)
    }
  }, [])


  // Delay showing until positioned to prevent jump
  useEffect(() => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        setIsReady(true)
      })
    })
  }, [])

  // Handle step transitions with fade
  useEffect(() => {
    if (currentStep !== displayStep) {
      setIsTransitioning(true)
      // Wait for fade out, then update display step
      const timer = setTimeout(() => {
        setDisplayStep(currentStep)
        // Wait a frame then fade back in
        requestAnimationFrame(() => {
          setIsTransitioning(false)
        })
      }, 300)
      return () => clearTimeout(timer)
    }
  }, [currentStep, displayStep])

  useEffect(() => {
    if (currentStep === 3) {
      onExpandSidebar()
    } else {
      onCollapseSidebar()
    }
  }, [currentStep, onExpandSidebar, onCollapseSidebar])


  const handleHighlightClick = () => {
    setIsPulsing(true)
    setTimeout(() => setIsPulsing(false), 600)
  }

  const handleNext = () => {
    if (isLastStep) {
      handleComplete()
    } else {
      setCurrentStep(prev => prev + 1)
    }
  }

  const handleBack = () => {
    if (currentStep > 0) {
      setCurrentStep(prev => prev - 1)
    }
  }

  const handleComplete = () => {
    setIsExiting(true)
    localStorage.setItem('siglum-onboarding-complete', 'true')
    setTimeout(() => {
      onComplete()
    }, 300)
  }

  const handleConnectGithub = () => {
    handleComplete()
    setTimeout(() => {
      onConnectGithub()
    }, 350)
  }

  const handleSkip = () => {
    handleComplete()
  }

  // Dynamic style for preview overlay
  const darkenStyle = step.highlight === 'preview' && editorWidth !== null
    ? { width: `${editorWidth}px` }
    : undefined

  return (
    <div ref={overlayRef} className={`onboarding-overlay ${isReady ? 'ready' : ''} ${isExiting ? 'exiting' : ''} ${isTransitioning ? 'transitioning' : ''} highlight-${step.highlight}`}>
      {/* Full-screen click blocker */}
      <div className="onboarding-blocker" onClick={handleHighlightClick} />

      {/* Darkened overlay for non-highlighted area */}
      <div className="onboarding-darken" style={darkenStyle} />

      {/* Additional darken elements for settings step */}
      {step.highlight === 'settings' && (
        <>
          <div className="onboarding-darken-sidebar" />
          <div className="onboarding-darken-below-toolbar" />
        </>
      )}

      {/* Mock settings button and dropdown for settings step */}
      {step.highlight === 'settings' && settingsButtonPos && (
        <>
          <div
            className="onboarding-mock-settings-btn"
            style={{
              top: settingsButtonPos.top - 12 - 24, /* Go back up: 12px gap + ~24px button height */
              left: settingsButtonPos.left
            }}
          >
            <Settings size={14} />
          </div>
          <div
            className="onboarding-mock-dropdown"
            style={{
              top: settingsButtonPos.top,
              left: settingsButtonPos.left
            }}
          >
          <div className="mock-setting-row">
            <span className="mock-setting-label">Auto-compile</span>
            <span className="mock-toggle active">
              <span className="mock-toggle-track">
                <span className="mock-toggle-thumb" />
              </span>
            </span>
          </div>
          <div className="mock-setting-row">
            <span className="mock-setting-label">Compiler</span>
            <span className="mock-select">Auto</span>
          </div>
          <div className="mock-setting-row">
            <span className="mock-setting-label">CTAN fetch</span>
            <span className="mock-toggle active">
              <span className="mock-toggle-track">
                <span className="mock-toggle-thumb" />
              </span>
            </span>
          </div>
          <div className="mock-setting-row">
            <span className="mock-setting-label">Cache preamble</span>
            <span className="mock-toggle active">
              <span className="mock-toggle-track">
                <span className="mock-toggle-thumb" />
              </span>
            </span>
          </div>
        </div>
        </>
      )}

      {/* Content card */}
      <div className={`onboarding-card ${step.highlight}`}>
        {/* Pointer chevron */}
        <div className="onboarding-pointer">
          {step.highlight === 'editor' && <ChevronLeft size={48} strokeWidth={2} />}
          {step.highlight === 'settings' && <Settings size={24} className="onboarding-pointer-icon" />}
          {step.highlight === 'preview' && <ChevronRight size={48} strokeWidth={2} />}
          {step.highlight === 'sidebar' && <ChevronLeft size={48} strokeWidth={2} />}
        </div>

        <div className="onboarding-progress">
          {steps.map((_, index) => (
            <div
              key={index}
              className={`progress-dot ${index === currentStep ? 'active' : ''} ${index < currentStep ? 'complete' : ''}`}
            />
          ))}
        </div>

        <h2 className="onboarding-title">{step.title}</h2>
        <p className="onboarding-description">{step.description}</p>

        {step.hasSettingsDetail && (
          <div className="onboarding-settings-list">
            <div className="onboarding-setting-item">
              <span className="setting-name">Auto-compile</span>
              <span className="setting-desc">Compile automatically as you type</span>
            </div>
            <div className="onboarding-setting-item">
              <span className="setting-name">Compiler</span>
              <span className="setting-desc">Choose pdfLaTeX or XeLaTeX (for custom fonts)</span>
            </div>
            <div className="onboarding-setting-item">
              <span className="setting-name">CTAN fetch</span>
              <span className="setting-desc">Auto-download missing packages from CTAN</span>
            </div>
            <div className="onboarding-setting-item">
              <span className="setting-name">Cache preamble</span>
              <span className="setting-desc">Speed up compiles by caching your preamble</span>
            </div>
          </div>
        )}

        {step.hasFooter && (
          <div className="onboarding-footer">
            <hr className="onboarding-divider" />
            <a
              href="https://github.com/SiglumProject"
              target="_blank"
              rel="noopener noreferrer"
              className="onboarding-opensource-link"
            >
              <Github size={14} />
              Siglum is fully open source
            </a>
          </div>
        )}

        <div className="onboarding-actions">
          {currentStep > 0 && (
            <button className="onboarding-btn back" onClick={handleBack}>
              Back
            </button>
          )}
          {currentStep === 0 && (
            <button className="onboarding-btn skip" onClick={handleSkip}>
              Skip
            </button>
          )}
          <div className="onboarding-actions-right">
            {isLastStep ? (
              <>
                <button className="onboarding-btn secondary" onClick={handleConnectGithub}>
                  <Github size={16} />
                  Connect GitHub
                </button>
                <button className="onboarding-btn primary" onClick={handleComplete}>
                  Get Started
                </button>
              </>
            ) : (
              <button className={`onboarding-btn primary ${isPulsing ? 'pulse' : ''}`} onClick={handleNext}>
                Next
                <ChevronRight size={16} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

export default Onboarding
