import React, { useState } from 'react'
import BaseModal from './BaseModal'
import {
  FileText,
  MessageCircle,
  LifeBuoy,
  Bug,
  Github,
  ArrowRight,
  ArrowLeft,
  LayoutTemplate
} from 'lucide-react'
import './DocumentationModal.css'

interface DocumentationModalProps {
  isOpen: boolean
  isClosing?: boolean
  onClose: () => void
  onBack?: () => void
  onCreateFromTemplate?: (template: string) => void
  defaultTab?: TabId
}

type TabId = 'guide' | 'templates' | 'faq' | 'support'

const templates = [
  {
    id: 'article',
    title: 'Academic Article',
    description: 'Research paper with abstract, sections, and bibliography',
    template: `\\documentclass[11pt]{article}
\\usepackage[margin=1in]{geometry}
\\usepackage{amsmath,amsfonts,amssymb}
\\usepackage[utf8]{inputenc}
\\usepackage{cite}

\\title{Your Research Title}
\\author{Your Name\\\\Your Institution}
\\date{\\today}

\\begin{document}

\\maketitle

\\begin{abstract}
Write your abstract here. This should be a concise summary of your research, methodology, and key findings.
\\end{abstract}

\\section{Introduction}

Introduce your research problem and provide background context.

\\section{Methodology}

Describe your research methods and approach.

\\section{Results}

Present your findings with equations like $E = mc^2$ and references \\cite{example}.

\\section{Conclusion}

Summarize your contributions and future work.

\\bibliographystyle{plain}
\\bibliography{references}

\\end{document}`
  },
  {
    id: 'resume',
    title: 'Professional Resume',
    description: 'Clean CV template with sections for experience and education',
    template: `\\documentclass[11pt,a4paper]{article}
\\usepackage[margin=0.75in]{geometry}
\\usepackage{enumitem}
\\usepackage{titlesec}
\\usepackage{hyperref}

% Custom commands
\\newcommand{\\header}[1]{\\section*{\\large #1}\\hrule\\vspace{0.5em}}
\\newcommand{\\school}[4]{\\textbf{#1} \\hfill #2 \\\\ #3 \\hfill #4}
\\newcommand{\\employer}[4]{\\textbf{#1} \\hfill #2 \\\\ \\textit{#3} \\hfill #4}

\\pagestyle{empty}
\\setlength{\\parindent}{0pt}

\\begin{document}

\\begin{center}
{\\Huge \\textbf{Your Name}}\\\\
\\vspace{0.25em}
your.email@example.com $|$ (555) 123-4567 $|$ City, State
\\end{center}

\\header{Education}
\\school{University Name}{City, State}{Bachelor of Science in Computer Science}{2020-2024}

\\header{Experience}
\\employer{Software Engineer}{Company Name}{Full-time Position}{2024-Present}
\\begin{itemize}[leftmargin=1em]
\\item Developed and maintained web applications using modern technologies
\\item Collaborated with cross-functional teams to deliver high-quality software
\\item Participated in code reviews and mentored junior developers
\\end{itemize}

\\header{Skills}
\\textbf{Programming:} Python, JavaScript, Java, C++\\\\
\\textbf{Technologies:} React, Node.js, Docker, AWS\\\\
\\textbf{Tools:} Git, Linux, VS Code

\\header{Projects}
\\textbf{Project Name} - Brief description of your project and technologies used.

\\end{document}`
  },
  {
    id: 'letter',
    title: 'Formal Letter',
    description: 'Professional letter template with proper formatting',
    template: `\\documentclass[11pt]{letter}
\\usepackage[margin=1in]{geometry}

\\address{Your Name\\\\Your Address\\\\City, State ZIP}
\\signature{Your Name}

\\begin{document}

\\begin{letter}{Recipient Name\\\\Recipient Title\\\\Company Name\\\\Address\\\\City, State ZIP}

\\opening{Dear Mr./Ms. Last Name,}

Write your letter content here. This template provides proper formatting for a professional letter with appropriate spacing and layout.

You can include multiple paragraphs to organize your thoughts clearly. Each paragraph should focus on a specific point or topic.

\\closing{Sincerely,}

\\end{letter}

\\end{document}`
  },
  {
    id: 'math',
    title: 'Math Problem Set',
    description: 'Template for mathematical assignments and homework',
    template: `\\documentclass[11pt]{article}
\\usepackage[margin=1in]{geometry}
\\usepackage{amsmath,amsfonts,amssymb,amsthm}
\\usepackage{enumitem}

\\title{Math Assignment}
\\author{Your Name}
\\date{\\today}

\\newtheorem{problem}{Problem}

\\begin{document}

\\maketitle

\\begin{problem}
Solve the following equation for $x$:
\\[2x^2 + 5x - 3 = 0\\]
\\end{problem}

\\textbf{Solution:} Using the quadratic formula:
\\begin{align}
x &= \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}\\\\
x &= \\frac{-5 \\pm \\sqrt{25 + 24}}{4}\\\\
x &= \\frac{-5 \\pm 7}{4}
\\end{align}

Therefore, $x = \\frac{1}{2}$ or $x = -3$.

\\begin{problem}
Prove that $\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}$ for all positive integers $n$.
\\end{problem}

\\textbf{Proof:} By mathematical induction...

\\begin{problem}
Find the derivative of $f(x) = x^3 \\sin(x)$.
\\end{problem}

\\textbf{Solution:} Using the product rule:
\\[f'(x) = 3x^2\\sin(x) + x^3\\cos(x)\\]

\\end{document}`
  },
  {
    id: 'report',
    title: 'Technical Report',
    description: 'Structured report template with table of contents',
    template: `\\documentclass[11pt]{report}
\\usepackage[margin=1in]{geometry}
\\usepackage{graphicx}
\\usepackage{hyperref}

\\title{Technical Report Title}
\\author{Your Name\\\\Your Organization}
\\date{\\today}

\\begin{document}

\\maketitle

\\tableofcontents
\\newpage

\\chapter{Executive Summary}

Provide a brief overview of your report's key findings and recommendations.

\\chapter{Introduction}

\\section{Background}
Explain the context and motivation for this report.

\\section{Objectives}
List the main objectives and goals of your analysis.

\\chapter{Methodology}

Describe the methods, tools, and approaches used in your analysis.

\\chapter{Results and Analysis}

\\section{Key Findings}
Present your main findings with supporting data.

\\section{Data Analysis}
Provide detailed analysis of your results.

\\chapter{Conclusions and Recommendations}

\\section{Conclusions}
Summarize your key conclusions.

\\section{Recommendations}
Provide actionable recommendations based on your findings.

\\chapter{Appendices}

Include additional supporting materials, data, or detailed calculations.

\\end{document}`
  },
  {
    id: 'presentation',
    title: 'Presentation Slides',
    description: 'Beamer template for academic or professional presentations',
    template: `\\documentclass{beamer}
\\usetheme{Madrid}
\\usecolortheme{default}

\\title{Your Presentation Title}
\\author{Your Name}
\\institute{Your Institution}
\\date{\\today}

\\begin{document}

\\frame{\\titlepage}

\\begin{frame}
\\frametitle{Outline}
\\tableofcontents
\\end{frame}

\\section{Introduction}
\\begin{frame}
\\frametitle{Introduction}
\\begin{itemize}
\\item Welcome to your presentation
\\item This template provides a clean, professional layout
\\item Easy to customize and extend
\\end{itemize}
\\end{frame}

\\section{Main Content}
\\begin{frame}
\\frametitle{Key Points}
\\begin{enumerate}
\\item First important point
\\item Second key insight
\\item Supporting evidence
\\end{enumerate}
\\end{frame}

\\begin{frame}
\\frametitle{Mathematical Content}
Here's an equation:
\\[E = mc^2\\]

And here's a theorem:
\\begin{theorem}
For any triangle with sides $a$, $b$, and $c$:
\\[a^2 + b^2 = c^2\\]
(if it's a right triangle)
\\end{theorem}
\\end{frame}

\\section{Conclusion}
\\begin{frame}
\\frametitle{Conclusion}
\\begin{itemize}
\\item Summarize your main points
\\item Highlight key takeaways
\\item Thank your audience
\\end{itemize}
\\end{frame}

\\end{document}`
  }
]

interface Tab {
  id: TabId
  label: string
  icon: React.ReactNode
}

const tabs: Tab[] = [
  { id: 'guide', label: 'Getting Started', icon: <FileText size={16} /> },
  { id: 'templates', label: 'Templates', icon: <LayoutTemplate size={16} /> },
  { id: 'faq', label: 'FAQ', icon: <MessageCircle size={16} /> },
  { id: 'support', label: 'Support', icon: <LifeBuoy size={16} /> }
]

const DocumentationModal: React.FC<DocumentationModalProps> = ({ isOpen, isClosing = false, onClose, onBack, onCreateFromTemplate, defaultTab = 'guide' }) => {
  const [activeTab, setActiveTab] = useState<TabId>(defaultTab)
  const [selectedTemplate, setSelectedTemplate] = useState<string | null>(null)

  // Update active tab when defaultTab changes (e.g., opening from different links)
  React.useEffect(() => {
    if (isOpen) {
      setActiveTab(defaultTab)
    }
  }, [isOpen, defaultTab])

  const handleSelectTemplate = (templateId: string) => {
    setSelectedTemplate(selectedTemplate === templateId ? null : templateId)
  }

  const handleUseTemplate = (template: string) => {
    if (onCreateFromTemplate) {
      onCreateFromTemplate(template)
      onClose()
    }
  }

  const backButton = onBack ? (
    <button
      onClick={onBack}
      style={{
        background: 'rgba(255, 255, 255, 0.08)',
        border: 'none',
        borderRadius: '8px',
        padding: '6px',
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: 'rgba(255, 255, 255, 0.7)',
        transition: 'all 0.15s ease'
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = 'rgba(255, 255, 255, 0.12)'
        e.currentTarget.style.color = 'rgba(255, 255, 255, 0.9)'
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'rgba(255, 255, 255, 0.08)'
        e.currentTarget.style.color = 'rgba(255, 255, 255, 0.7)'
      }}
      aria-label="Go back"
    >
      <ArrowLeft size={18} />
    </button>
  ) : null

  const renderContent = () => {
    switch (activeTab) {
      case 'guide':
        return (
          <div className="doc-content">
            <h2>Shortcuts</h2>
            <p className="doc-lead">The keyboard shortcuts worth memorizing.</p>

            <div className="shortcuts-group">
              <h3>Navigation</h3>
              <div className="shortcut-list">
                <div className="shortcut-item">
                  <div className="shortcut-keys">
                    <kbd>⌘</kbd><kbd>K</kbd>
                  </div>
                  <span>Open command palette (this is the big one)</span>
                </div>
                <div className="shortcut-item">
                  <div className="shortcut-keys">
                    <kbd>⌘</kbd><kbd>S</kbd>
                  </div>
                  <span>Compile document</span>
                </div>
                <div className="shortcut-item">
                  <div className="shortcut-keys">
                    <kbd>⌘</kbd><kbd>N</kbd>
                  </div>
                  <span>New document</span>
                </div>
              </div>
            </div>

            <div className="shortcuts-group">
              <h3>Layout</h3>
              <div className="shortcut-list">
                <div className="shortcut-item">
                  <div className="shortcut-keys">
                    <kbd>⌘</kbd><kbd>1</kbd>
                  </div>
                  <span>Editor only</span>
                </div>
                <div className="shortcut-item">
                  <div className="shortcut-keys">
                    <kbd>⌘</kbd><kbd>2</kbd>
                  </div>
                  <span>Editor + PDF side by side</span>
                </div>
                <div className="shortcut-item">
                  <div className="shortcut-keys">
                    <kbd>⌘</kbd><kbd>\</kbd>
                  </div>
                  <span>Toggle PDF preview</span>
                </div>
              </div>
            </div>

            <div className="shortcuts-group">
              <h3>Formatting</h3>
              <div className="shortcut-list">
                <div className="shortcut-item">
                  <div className="shortcut-keys">
                    <kbd>⌘</kbd><kbd>B</kbd>
                  </div>
                  <span>Wrap in \textbf{"{"}...{"}"}</span>
                </div>
                <div className="shortcut-item">
                  <div className="shortcut-keys">
                    <kbd>⌘</kbd><kbd>I</kbd>
                  </div>
                  <span>Wrap in \textit{"{"}...{"}"}</span>
                </div>
                <div className="shortcut-item">
                  <div className="shortcut-keys">
                    <kbd>⌘</kbd><kbd>⇧</kbd><kbd>M</kbd>
                  </div>
                  <span>Wrap in $...$</span>
                </div>
              </div>
            </div>

            <p className="doc-note">On Windows/Linux, use Ctrl instead of ⌘</p>
          </div>
        )

      case 'templates':
        return (
          <div className="doc-content">
            <h2>Templates</h2>
            <p className="doc-lead">Start with a professional LaTeX template.</p>

            <div className="templates-grid">
              {templates.map((t) => (
                <div
                  key={t.id}
                  className={`template-card ${selectedTemplate === t.id ? 'selected' : ''}`}
                  onClick={() => handleSelectTemplate(t.id)}
                >
                  <div className="template-content">
                    <h3>{t.title}</h3>
                    <p>{t.description}</p>
                  </div>
                  {selectedTemplate === t.id && (
                    <button
                      className="use-template-button"
                      onClick={(e) => {
                        e.stopPropagation()
                        handleUseTemplate(t.template)
                      }}
                    >
                      Use Template
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        )

      case 'faq':
        return (
          <div className="doc-content">
            <h2>FAQ</h2>
            <p className="doc-lead">Questions people sometimes ask.</p>

            <div className="faq-list">
              <div className="faq-item">
                <h3>Do you store my documents on your server?</h3>
                <p>
                  No. Your documents stay in your browser - they don't touch our server. Your browser will reach out to our server to download the TeX engine and any packages needed. Then, everything runs locally on your machine.
                </p>
              </div>

              <div className="faq-item">
                <h3>Is my work saved?</h3>
                <p>
                  Yes, automatically. Everything saves to your browser's local storage. If you've connected GitHub and enabled auto-push, it will also sync there.
                </p>
              </div>

              <div className="faq-item">
                <h3>Can I use [obscure package]?</h3>
                <p>
                  Probably! We bundle the most common packages, and anything else gets fetched from CTAN automatically.
                </p>
              </div>

              <div className="faq-item">
                <h3>Can I use custom fonts?</h3>
                <p>
                  Yes. Drop a .ttf or .otf file in your project and use fontspec. We include Latin Modern, TeX Gyre, and STIX2 by default. Note: Custom fonts require XeLaTeX.
                </p>
              </div>

              <div className="faq-item">
                <h3>How is this different from Overleaf?</h3>
                <p>
                  Overleaf sends your documents to their servers to compile. Siglum compiles everything locally—nothing leaves your machine. It's usually faster (no network round-trip), works offline, and your documents stay private.
                </p>
              </div>

              <div className="faq-item">
                <h3>Is this free?</h3>
                <p>
                  Yes. Local editing, compiling, and saving are free forever - no account needed. If we add cloud sync or collaboration features someday, those might have a small fee, but the core editor will always be free.
                </p>
              </div>

              <div className="faq-item">
                <h3>What engines are supported?</h3>
                <p>
                  pdfLaTeX and XeLaTeX. Pick whichever you prefer. XeLaTeX is better for Unicode and custom fonts.
                </p>
              </div>

              <div className="faq-item">
                <h3>Why is the first compile slow?</h3>
                <p>
                  The first compilation downloads the TeX engine (~15MB), then additional packages load on-demand. After that, compiles are fast—usually under a second.
                </p>
              </div>

              <div className="faq-item">
                <h3>Does it work offline?</h3>
                <p>
                  Yes. Downloaded bundles cache to your browser's storage. Once loaded, Siglum works without an internet connection. Write on a plane, in a cabin, wherever.
                </p>
              </div>

              <div className="faq-item">
                <h3>Is this open source?</h3>
                <p>
                  Yes. The editor is MIT licensed. The underlying TeX distribution is a mix of LPPL, GPL, and public domain (same as any TeX installation).
                </p>
              </div>
            </div>
          </div>
        )

      case 'support':
        return (
          <div className="doc-content">
            <h2>Support</h2>
            <p className="doc-lead">Something broken? Here's how to get help.</p>

            <div className="help-section">
              <h3>Found a bug?</h3>
              <p>
                Open an issue on GitHub. Tell us what you did, what happened, and what you expected. Screenshots help a lot.
              </p>
              <a
                href="https://github.com/siglum/siglum/issues/new"
                target="_blank"
                rel="noopener noreferrer"
                className="help-link"
              >
                <Bug size={16} />
                <span>Report issue</span>
                <ArrowRight size={14} className="help-link-arrow" />
              </a>
            </div>

            <div className="help-section">
              <h3>Something not working?</h3>
              <p>
                The usual fixes:
              </p>
              <ul className="help-list">
                <li>Hard refresh (Cmd+Shift+R or Ctrl+Shift+R)</li>
                <li>Try incognito/private mode</li>
                <li>Make sure your browser is up to date</li>
              </ul>
            </div>

            <div className="help-section">
              <h3>View the source</h3>
              <p>
                Siglum is open source. Poke around, fork it, submit a PR.
              </p>
              <a
                href="https://github.com/SiglumProject"
                target="_blank"
                rel="noopener noreferrer"
                className="help-link"
              >
                <Github size={16} />
                <span>GitHub</span>
                <ArrowRight size={14} className="help-link-arrow" />
              </a>
            </div>

            <div className="help-section">
              <h3>Privacy</h3>
              <p>
                Your documents stay in your browser unless you explicitly share them. We can't see them.
              </p>
              <p>
                We use Cloudflare Analytics to see basic usage stats (page views, not people). Unlike Google Analytics, Cloudflare doesn't use cookies, doesn't fingerprint you, doesn't build ad profiles, and doesn't track you across the web. They just count visits.
              </p>
            </div>
          </div>
        )

      default:
        return null
    }
  }

  return (
    <BaseModal 
      isOpen={isOpen}
      isClosing={isClosing}
      onClose={onClose} 
      title="Help"
      maxWidth="820px"
      className="documentation-modal"
      overlayClassName="documentation-modal-overlay"
      headerContent={backButton}
    >
      <div className="doc-modal-container">
        <div className="doc-sidebar">
          <nav className="doc-nav">
            {tabs.map(tab => (
              <button
                key={tab.id}
                className={`doc-nav-item ${activeTab === tab.id ? 'active' : ''}`}
                onClick={() => setActiveTab(tab.id)}
              >
                <span className="doc-nav-icon">{tab.icon}</span>
                <span className="doc-nav-label">{tab.label}</span>
              </button>
            ))}
          </nav>
        </div>
        <div className="doc-main">
          {renderContent()}
        </div>
      </div>
    </BaseModal>
  )
}

export default DocumentationModal