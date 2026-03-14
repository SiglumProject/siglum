/**
 * Test project definitions for comprehensive compilation testing.
 * Each project defines source files and expected results.
 */

export interface TestProject {
    name: string;
    description: string;
    files: Record<string, string | Uint8Array>;
    mainFile: string;
    engine?: 'pdflatex' | 'xelatex';
    expectedHash?: string; // SHA-256 of expected PDF (first 16 chars)
    maxTimeMs?: number; // Maximum allowed compilation time
    shouldSucceed: boolean;
    tags: string[]; // For filtering tests: 'basic', 'math', 'graphics', 'fonts', 'multifile', 'slow'
}

// Simple hello world - baseline test
export const PROJECT_HELLO_WORLD: TestProject = {
    name: 'hello-world',
    description: 'Minimal document - baseline compilation test',
    files: {
        'document.tex': `\\documentclass{article}
\\begin{document}
Hello, World!
\\end{document}`,
    },
    mainFile: 'document.tex',
    engine: 'pdflatex',
    maxTimeMs: 5000,
    shouldSucceed: true,
    tags: ['basic', 'fast'],
};

// Math-heavy document with AMS packages
export const PROJECT_MATH_PAPER: TestProject = {
    name: 'math-paper',
    description: 'Mathematical paper with equations and theorems',
    files: {
        'document.tex': `\\documentclass{article}
\\usepackage{amsmath}
\\usepackage{amssymb}
\\usepackage{amsthm}

\\newtheorem{theorem}{Theorem}
\\newtheorem{lemma}[theorem]{Lemma}

\\title{On the Properties of Prime Numbers}
\\author{Test Author}

\\begin{document}
\\maketitle

\\begin{abstract}
This paper explores fundamental properties of prime numbers.
\\end{abstract}

\\section{Introduction}
The study of prime numbers has fascinated mathematicians for millennia.
The fundamental theorem of arithmetic states that every integer greater
than 1 can be uniquely factored into primes.

\\section{Main Results}

\\begin{theorem}[Euclid]
There are infinitely many prime numbers.
\\end{theorem}

\\begin{proof}
Suppose there are only finitely many primes $p_1, p_2, \\ldots, p_n$.
Consider the number:
\\[
N = p_1 \\cdot p_2 \\cdot \\ldots \\cdot p_n + 1
\\]
This number $N$ is not divisible by any $p_i$, since dividing $N$ by
$p_i$ leaves remainder 1. Therefore $N$ must have a prime factor not
in our list, contradicting our assumption.
\\end{proof}

\\begin{lemma}
For $n > 1$, there exists a prime $p$ such that $n < p < 2n$.
\\end{lemma}

The quadratic formula gives roots of $ax^2 + bx + c = 0$:
\\begin{equation}
x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}
\\end{equation}

Some important series:
\\begin{align}
e &= \\sum_{n=0}^{\\infty} \\frac{1}{n!} \\\\
\\pi &= 4 \\sum_{n=0}^{\\infty} \\frac{(-1)^n}{2n+1} \\\\
\\zeta(2) &= \\sum_{n=1}^{\\infty} \\frac{1}{n^2} = \\frac{\\pi^2}{6}
\\end{align}

\\end{document}`,
    },
    mainFile: 'document.tex',
    engine: 'pdflatex',
    maxTimeMs: 8000,
    shouldSucceed: true,
    tags: ['math', 'amsmath'],
};

// Document with cross-references (needs multiple passes)
export const PROJECT_CROSS_REFS: TestProject = {
    name: 'cross-refs',
    description: 'Document with cross-references requiring multiple passes',
    files: {
        'document.tex': `\\documentclass{article}
\\usepackage{hyperref}

\\begin{document}

\\tableofcontents

\\section{Introduction}
\\label{sec:intro}

This document demonstrates cross-references. See Section~\\ref{sec:methods}
for the methodology and Section~\\ref{sec:results} for results.

The total is shown in Table~\\ref{tab:data} and illustrated in
Figure~\\ref{fig:chart} (referenced but not included).

\\section{Methods}
\\label{sec:methods}

Our methodology builds on the introduction in Section~\\ref{sec:intro}.
We use Equation~\\ref{eq:main} as our primary formula.

\\begin{equation}
\\label{eq:main}
f(x) = \\int_0^x t^2 \\, dt = \\frac{x^3}{3}
\\end{equation}

\\section{Results}
\\label{sec:results}

Results are based on methods from Section~\\ref{sec:methods}.

\\begin{table}[h]
\\centering
\\begin{tabular}{|c|c|}
\\hline
Item & Value \\\\
\\hline
A & 10 \\\\
B & 20 \\\\
\\hline
\\end{tabular}
\\caption{Sample data}
\\label{tab:data}
\\end{table}

\\section{Conclusion}
As shown in Sections~\\ref{sec:intro}--\\ref{sec:results}, our approach works.

\\end{document}`,
    },
    mainFile: 'document.tex',
    engine: 'pdflatex',
    maxTimeMs: 10000,
    shouldSucceed: true,
    tags: ['refs', 'toc', 'hyperref'],
};

// Multi-file project with includes
export const PROJECT_MULTI_FILE: TestProject = {
    name: 'multi-file',
    description: 'Multi-file project with \\input and \\include',
    files: {
        'main.tex': `\\documentclass{book}
\\usepackage{amsmath}

\\title{Multi-File Document}
\\author{Test Author}

\\begin{document}
\\maketitle
\\tableofcontents

\\input{chapters/intro}
\\input{chapters/methods}
\\input{chapters/conclusion}

\\end{document}`,
        'chapters/intro.tex': `\\chapter{Introduction}
\\label{ch:intro}

This is the introduction chapter. It provides background and motivation
for the work presented in this document.

\\section{Background}
Some background information here.

\\section{Motivation}
Why this work matters.`,
        'chapters/methods.tex': `\\chapter{Methods}
\\label{ch:methods}

This chapter describes our methodology.

\\section{Approach}
Our approach uses the following equation:
\\begin{equation}
E = mc^2
\\end{equation}

\\section{Implementation}
Details of implementation.`,
        'chapters/conclusion.tex': `\\chapter{Conclusion}
\\label{ch:conclusion}

In conclusion, we have demonstrated the concepts from Chapter~\\ref{ch:intro}
using the methods from Chapter~\\ref{ch:methods}.`,
    },
    mainFile: 'main.tex',
    engine: 'pdflatex',
    maxTimeMs: 12000,
    shouldSucceed: true,
    tags: ['multifile', 'book'],
};

// Code listings document
export const PROJECT_CODE_LISTINGS: TestProject = {
    name: 'code-listings',
    description: 'Document with code listings',
    files: {
        'document.tex': `\\documentclass{article}
\\usepackage{listings}
\\usepackage{xcolor}

\\lstset{
    basicstyle=\\ttfamily\\small,
    keywordstyle=\\color{blue},
    commentstyle=\\color{green!60!black},
    stringstyle=\\color{red},
    numbers=left,
    numberstyle=\\tiny,
    frame=single,
    breaklines=true
}

\\title{Code Examples}
\\begin{document}
\\maketitle

\\section{Python Example}
\\begin{lstlisting}[language=Python]
def fibonacci(n):
    """Calculate the nth Fibonacci number."""
    if n <= 1:
        return n
    return fibonacci(n-1) + fibonacci(n-2)

# Print first 10 Fibonacci numbers
for i in range(10):
    print(f"F({i}) = {fibonacci(i)}")
\\end{lstlisting}

\\section{JavaScript Example}
\\begin{lstlisting}[language=JavaScript]
// Async function example
async function fetchData(url) {
    const response = await fetch(url);
    const data = await response.json();
    return data;
}
\\end{lstlisting}

\\end{document}`,
    },
    mainFile: 'document.tex',
    engine: 'pdflatex',
    maxTimeMs: 8000,
    shouldSucceed: true,
    tags: ['listings', 'code'],
};

// Tables and formatting
export const PROJECT_TABLES: TestProject = {
    name: 'tables',
    description: 'Document with complex tables',
    files: {
        'document.tex': `\\documentclass{article}
\\usepackage{booktabs}
\\usepackage{multirow}
\\usepackage{array}
\\usepackage{longtable}

\\title{Table Examples}
\\begin{document}
\\maketitle

\\section{Simple Table}
\\begin{table}[h]
\\centering
\\begin{tabular}{lrr}
\\toprule
Item & Quantity & Price \\\\
\\midrule
Apples & 10 & \\$2.50 \\\\
Oranges & 15 & \\$3.00 \\\\
Bananas & 8 & \\$1.75 \\\\
\\bottomrule
\\end{tabular}
\\caption{Fruit inventory}
\\end{table}

\\section{Complex Table}
\\begin{table}[h]
\\centering
\\begin{tabular}{|l|c|c|c|}
\\hline
\\multirow{2}{*}{Category} & \\multicolumn{3}{c|}{Years} \\\\
\\cline{2-4}
 & 2021 & 2022 & 2023 \\\\
\\hline
Revenue & 100 & 120 & 150 \\\\
Expenses & 80 & 90 & 100 \\\\
Profit & 20 & 30 & 50 \\\\
\\hline
\\end{tabular}
\\caption{Financial summary}
\\end{table}

\\end{document}`,
    },
    mainFile: 'document.tex',
    engine: 'pdflatex',
    maxTimeMs: 6000,
    shouldSucceed: true,
    tags: ['tables', 'booktabs'],
};

// Beamer presentation
export const PROJECT_BEAMER: TestProject = {
    name: 'beamer',
    description: 'Beamer presentation slides',
    files: {
        'slides.tex': `\\documentclass{beamer}
\\usetheme{Madrid}
\\usecolortheme{default}

\\title{Sample Presentation}
\\author{Test Author}
\\date{\\today}

\\begin{document}

\\begin{frame}
\\titlepage
\\end{frame}

\\begin{frame}{Outline}
\\tableofcontents
\\end{frame}

\\section{Introduction}
\\begin{frame}{Introduction}
\\begin{itemize}
\\item First point
\\item Second point
\\item Third point
\\end{itemize}
\\end{frame}

\\section{Main Content}
\\begin{frame}{Mathematics}
The quadratic formula:
\\[
x = \\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}
\\]
\\end{frame}

\\begin{frame}{Lists}
\\begin{enumerate}
\\item Numbered item one
\\item Numbered item two
\\begin{itemize}
\\item Sub-item A
\\item Sub-item B
\\end{itemize}
\\item Numbered item three
\\end{enumerate}
\\end{frame}

\\section{Conclusion}
\\begin{frame}{Conclusion}
\\begin{block}{Summary}
This is a summary block.
\\end{block}

\\begin{alertblock}{Important}
This is important!
\\end{alertblock}
\\end{frame}

\\end{document}`,
    },
    mainFile: 'slides.tex',
    engine: 'pdflatex',
    maxTimeMs: 15000, // Beamer is slow
    shouldSucceed: true,
    tags: ['beamer', 'presentation', 'slow'],
};

// Bibliography with BibTeX style
export const PROJECT_BIBLIOGRAPHY: TestProject = {
    name: 'bibliography',
    description: 'Document with bibliography',
    files: {
        'document.tex': `\\documentclass{article}
\\usepackage{natbib}

\\title{Document with Citations}
\\author{Test Author}

\\begin{document}
\\maketitle

\\section{Introduction}
The study of algorithms has a rich history. Knuth's seminal work
\\citep{knuth1997} laid the foundation for modern computer science.
The concept of NP-completeness was introduced by \\citet{cook1971}.

\\section{Related Work}
Many researchers have contributed to this field. See \\citep{cormen2009}
for a comprehensive overview.

\\bibliographystyle{plainnat}
\\begin{thebibliography}{9}
\\bibitem[Knuth(1997)]{knuth1997}
Donald E. Knuth.
\\textit{The Art of Computer Programming, Volume 1: Fundamental Algorithms}.
Addison-Wesley, 3rd edition, 1997.

\\bibitem[Cook(1971)]{cook1971}
Stephen A. Cook.
The complexity of theorem-proving procedures.
In \\textit{Proceedings of the 3rd Annual ACM Symposium on Theory of Computing},
pages 151--158, 1971.

\\bibitem[Cormen et~al.(2009)]{cormen2009}
Thomas H. Cormen, Charles E. Leiserson, Ronald L. Rivest, and Clifford Stein.
\\textit{Introduction to Algorithms}.
MIT Press, 3rd edition, 2009.
\\end{thebibliography}

\\end{document}`,
    },
    mainFile: 'document.tex',
    engine: 'pdflatex',
    maxTimeMs: 8000,
    shouldSucceed: true,
    tags: ['bibliography', 'natbib'],
};

// Unicode and international text
export const PROJECT_UNICODE: TestProject = {
    name: 'unicode',
    description: 'Document with international text and Unicode',
    files: {
        'document.tex': `\\documentclass{article}
\\usepackage[utf8]{inputenc}
\\usepackage[T1]{fontenc}
\\usepackage{lmodern}

\\title{International Text}
\\begin{document}
\\maketitle

\\section{European Languages}
\\textbf{German:} Gr\\"{u}\\ss{} Gott! Sch\\"{o}ne Gr\\"{u}\\ss{}e.

\\textbf{French:} Bonjour! \\c{C}a va? Tr\\`{e}s bien, merci.

\\textbf{Spanish:} \\textexclamdown{}Hola! \\textquestiondown{}C\\'{o}mo est\\'{a}s?

\\textbf{Polish:} Dzie\\'{n} dobry! Jak si\\k{e} masz?

\\section{Special Characters}
Currencies: \\$100, \\pounds50, \\texteuro{}75

Math: $\\alpha, \\beta, \\gamma, \\delta, \\epsilon$

Symbols: \\textcopyright{} \\textregistered{} \\texttrademark{}

\\section{Accented Characters}
\\'{a} \\`{a} \\^{a} \\"{a} \\~{a} \\={a} \\.{a} \\u{a} \\v{a} \\H{a} \\c{c} \\d{a} \\b{a} \\t{aa}

\\end{document}`,
    },
    mainFile: 'document.tex',
    engine: 'pdflatex',
    maxTimeMs: 6000,
    shouldSucceed: true,
    tags: ['unicode', 'international'],
};

// XeLaTeX with fontspec
export const PROJECT_XELATEX_FONTS: TestProject = {
    name: 'xelatex-fonts',
    description: 'XeLaTeX document with fontspec',
    files: {
        'document.tex': `\\documentclass{article}
\\usepackage{fontspec}

\\title{XeLaTeX Font Test}
\\begin{document}
\\maketitle

\\section{Default Font}
This text uses the default font configuration.

\\section{Font Features}
Testing various font features available in XeLaTeX.

The quick brown fox jumps over the lazy dog.

\\textbf{Bold text} and \\textit{italic text} and \\textsc{Small Caps}.

\\end{document}`,
    },
    mainFile: 'document.tex',
    engine: 'xelatex',
    maxTimeMs: 15000, // XeLaTeX is slower
    shouldSucceed: true,
    tags: ['xelatex', 'fontspec', 'slow'],
};

// Syntax error - should fail
export const PROJECT_SYNTAX_ERROR: TestProject = {
    name: 'syntax-error',
    description: 'Document with syntax error - should fail',
    files: {
        'document.tex': `\\documentclass{article}
\\begin{document}
This has an unclosed math: $x = \\frac{1}{2
\\end{document}`,
    },
    mainFile: 'document.tex',
    engine: 'pdflatex',
    shouldSucceed: false,
    tags: ['error', 'syntax'],
};

// Missing package - may fail or succeed depending on CTAN
export const PROJECT_MISSING_PACKAGE: TestProject = {
    name: 'missing-package',
    description: 'Document using a non-bundled package',
    files: {
        'document.tex': `\\documentclass{article}
\\usepackage{lipsum}
\\begin{document}
\\lipsum[1-3]
\\end{document}`,
    },
    mainFile: 'document.tex',
    engine: 'pdflatex',
    maxTimeMs: 20000, // May need CTAN fetch
    shouldSucceed: true, // Assuming CTAN is available
    tags: ['ctan', 'slow'],
};

// All test projects
export const ALL_PROJECTS: TestProject[] = [
    PROJECT_HELLO_WORLD,
    PROJECT_MATH_PAPER,
    PROJECT_CROSS_REFS,
    PROJECT_MULTI_FILE,
    PROJECT_CODE_LISTINGS,
    PROJECT_TABLES,
    PROJECT_BEAMER,
    PROJECT_BIBLIOGRAPHY,
    PROJECT_UNICODE,
    PROJECT_XELATEX_FONTS,
    PROJECT_SYNTAX_ERROR,
    PROJECT_MISSING_PACKAGE,
];

// Quick test set (fast tests only)
export const QUICK_PROJECTS = ALL_PROJECTS.filter(
    p => p.tags.includes('fast') || (!p.tags.includes('slow') && p.shouldSucceed)
).slice(0, 5);

// Core test set (essential functionality)
export const CORE_PROJECTS = [
    PROJECT_HELLO_WORLD,
    PROJECT_MATH_PAPER,
    PROJECT_CROSS_REFS,
    PROJECT_TABLES,
    PROJECT_SYNTAX_ERROR,
];
