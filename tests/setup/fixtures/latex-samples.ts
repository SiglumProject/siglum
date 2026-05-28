/**
 * Sample LaTeX documents for testing.
 * Various document types and edge cases.
 */

// Simple minimal document
export const SIMPLE_DOCUMENT = `\\documentclass{article}
\\begin{document}
Hello, World!
\\end{document}`;

// Document with one package
export const DOCUMENT_WITH_PACKAGE = `\\documentclass{article}
\\usepackage{amsmath}
\\begin{document}
$E = mc^2$
\\end{document}`;

// Document with multiple packages
export const DOCUMENT_WITH_MULTIPLE_PACKAGES = `\\documentclass{article}
\\usepackage{amsmath}
\\usepackage{graphicx}
\\usepackage{hyperref}
\\begin{document}
Hello with packages.
\\end{document}`;

// Document with packages on single line
export const DOCUMENT_WITH_COMBINED_PACKAGES = `\\documentclass{article}
\\usepackage{amsmath,amssymb,amsthm}
\\begin{document}
Math symbols.
\\end{document}`;

// Document with package options
export const DOCUMENT_WITH_PACKAGE_OPTIONS = `\\documentclass[12pt,a4paper]{article}
\\usepackage[utf8]{inputenc}
\\usepackage[T1]{fontenc}
\\usepackage[margin=1in]{geometry}
\\begin{document}
Options test.
\\end{document}`;

// Document with cross-references (needs multiple runs)
export const DOCUMENT_WITH_REFS = `\\documentclass{article}
\\begin{document}
\\section{Introduction}
\\label{sec:intro}
See Section~\\ref{sec:methods}.

\\section{Methods}
\\label{sec:methods}
Back to Section~\\ref{sec:intro}.
\\end{document}`;

// Document with table of contents
export const DOCUMENT_WITH_TOC = `\\documentclass{article}
\\begin{document}
\\tableofcontents
\\section{First}
Content.
\\section{Second}
More content.
\\end{document}`;

// Document with bibliography
export const DOCUMENT_WITH_BIBLIOGRAPHY = `\\documentclass{article}
\\begin{document}
Citation~\\cite{knuth1984}.

\\begin{thebibliography}{9}
\\bibitem{knuth1984}
Donald Knuth.
\\textit{The TeXbook}.
1984.
\\end{thebibliography}
\\end{document}`;

// XeLaTeX document with fontspec
export const XELATEX_DOCUMENT = `\\documentclass{article}
\\usepackage{fontspec}
\\setmainfont{Times New Roman}
\\begin{document}
XeLaTeX document with system fonts.
\\end{document}`;

// XeLaTeX with unicode-math
export const XELATEX_UNICODE_MATH = `\\documentclass{article}
\\usepackage{unicode-math}
\\begin{document}
Unicode math: $\\alpha + \\beta = \\gamma$
\\end{document}`;

// Document requiring CTAN package (not in bundles)
export const DOCUMENT_WITH_CTAN_PACKAGE = `\\documentclass{article}
\\usepackage{tikz}
\\usepackage{pgfplots}
\\begin{document}
TikZ graphics.
\\end{document}`;

// Document with RequirePackage (for .sty files)
export const DOCUMENT_WITH_REQUIRE = `\\documentclass{article}
\\RequirePackage{xcolor}
\\begin{document}
\\textcolor{red}{Red text}
\\end{document}`;

// Document with custom class
export const DOCUMENT_WITH_CUSTOM_CLASS = `\\documentclass{beamer}
\\begin{document}
\\begin{frame}
\\frametitle{Slide}
Content
\\end{frame}
\\end{document}`;

// Document with no preamble packages
export const DOCUMENT_MINIMAL = `\\documentclass{minimal}
\\begin{document}
Minimal.
\\end{document}`;

// Document with comments and edge cases
export const DOCUMENT_WITH_COMMENTS = `\\documentclass{article}
% \\usepackage{notloaded}
\\usepackage{amsmath} % real package
\\begin{document}
% Comment line
Content.
\\end{document}`;

// Document missing \\begin{document}
export const DOCUMENT_NO_BEGIN = `\\documentclass{article}
\\usepackage{amsmath}
Content without begin document.`;

// Empty document
export const EMPTY_DOCUMENT = '';

// Just preamble
export const PREAMBLE_ONLY = `\\documentclass{article}
\\usepackage{amsmath}
\\usepackage{graphicx}`;

// Unicode content
export const DOCUMENT_WITH_UNICODE = `\\documentclass{article}
\\usepackage[utf8]{inputenc}
\\begin{document}
Привет мир. 你好世界. مرحبا بالعالم.
\\end{document}`;

// Large preamble
export const DOCUMENT_LARGE_PREAMBLE = `\\documentclass{article}
\\usepackage{amsmath}
\\usepackage{amssymb}
\\usepackage{amsthm}
\\usepackage{graphicx}
\\usepackage{hyperref}
\\usepackage{xcolor}
\\usepackage{geometry}
\\usepackage{fancyhdr}
\\usepackage{booktabs}
\\usepackage{array}
\\usepackage{multirow}
\\usepackage{longtable}
\\usepackage{listings}
\\usepackage{algorithm}
\\usepackage{algorithmic}

\\newtheorem{theorem}{Theorem}
\\newtheorem{lemma}{Lemma}
\\newtheorem{definition}{Definition}

\\newcommand{\\R}{\\mathbb{R}}
\\newcommand{\\N}{\\mathbb{N}}
\\newcommand{\\Z}{\\mathbb{Z}}

\\begin{document}
Large preamble document.
\\end{document}`;

// Document with LoadClass
export const DOCUMENT_WITH_LOAD_CLASS = `\\documentclass{myclass}
\\LoadClass{article}
\\begin{document}
Custom class.
\\end{document}`;

// Multi-file document (main file)
export const MULTI_FILE_MAIN = `\\documentclass{article}
\\usepackage{amsmath}
\\begin{document}
\\input{chapter1}
\\input{chapter2}
\\end{document}`;

// Multi-file document (chapter file)
export const MULTI_FILE_CHAPTER = `\\section{Chapter One}
\\usepackage{graphicx}
This is chapter content.`;

// Document with setmainfont/setsansfont (XeLaTeX detection)
export const DOCUMENT_WITH_SET_FONTS = `\\documentclass{article}
\\setmainfont{Arial}
\\setsansfont{Helvetica}
\\setmonofont{Courier}
\\begin{document}
Font test.
\\end{document}`;

// Document with error-prone syntax
export const DOCUMENT_WITH_ERRORS = `\\documentclass{article}
\\begin{document}
$\\frac{1}{2$
\\end{document}`;

// Extract test utilities

/**
 * Get expected packages from a document.
 * Returns list of package names that should be detected.
 */
export function getExpectedPackages(source: string): string[] {
    const packages: string[] = [];

    // Extract documentclass
    const docclassMatch = source.match(/\\documentclass(?:\[[^\]]*\])?\{([^}]+)\}/);
    if (docclassMatch) packages.push(docclassMatch[1]);

    // Extract usepackage
    const usePackageRegex = /\\usepackage(?:\[[^\]]*\])?\{([^}]+)\}/g;
    let match;
    while ((match = usePackageRegex.exec(source)) !== null) {
        const pkgList = match[1].split(',').map(p => p.trim());
        packages.push(...pkgList);
    }

    // Extract RequirePackage
    const requireRegex = /\\RequirePackage(?:\[[^\]]*\])?\{([^}]+)\}/g;
    while ((match = requireRegex.exec(source)) !== null) {
        const pkgList = match[1].split(',').map(p => p.trim());
        packages.push(...pkgList);
    }

    return packages;
}

/**
 * Get expected engine for a document.
 */
export function getExpectedEngine(source: string): 'pdflatex' | 'xelatex' {
    if (source.includes('\\usepackage{fontspec}') ||
        source.includes('\\usepackage{unicode-math}') ||
        source.includes('\\setmainfont') ||
        source.includes('\\setsansfont') ||
        source.includes('\\setmonofont')) {
        return 'xelatex';
    }
    return 'pdflatex';
}
